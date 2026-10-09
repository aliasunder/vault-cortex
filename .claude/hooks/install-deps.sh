#!/usr/bin/env bash
# Prepares the current checkout for a Claude Code session:
# - At session start, puts nvm's Node first on PATH for the session's later
#   Bash commands.
# - Installs the checkout's dependencies (npm ci, sst install) when they are
#   missing, or when package-lock.json changed since the hook's own last
#   install. Fresh cloud clones and fresh git worktrees start without
#   node_modules.
# Registered on SessionStart for startup, resume, and /clear, and on
# PostToolUse for EnterWorktree.
set -euo pipefail

# Logs go to stderr because SessionStart hook stdout enters the model's context.
log() { echo "[install-deps] $*" >&2; }

# A hook's non-interactive shell never sources .bashrc, so nvm is loaded here.
# - Without it, npm can resolve to a system Node (cloud images ship Node 22 at
#   /opt/node22).
# - Sourcing nvm.sh activates the default alias, unless an nvm Node already
#   comes first on PATH, which it keeps active instead. The install below
#   runs on that Node unless the checkout's .nvmrc names an installed version.
# - Cloud setup scripts install nvm with HOME=/root, so nvm can sit under
#   /root even when this hook runs with a different HOME.
for dir in "${HOME}/.nvm" /root/.nvm; do
  if [[ -s "${dir}/nvm.sh" ]]; then
    export NVM_DIR="${dir}"
    # Loading nvm.sh runs nvm use, which can fail and so end the hook under
    # set -eu: for example, when nvm has no default alias and the .nvmrc
    # version is not installed.
    set +eu
    # shellcheck disable=SC1091
    . "${dir}/nvm.sh"
    set -eu
    break
  fi
done

# Stdin can be read only once, so the payload is saved and each field read
# parses the saved copy.
hook_payload="$(cat)"

# Prints one top-level string field of the payload, or nothing on any failure
# (no node, invalid JSON, absent field); callers then fall back or skip.
# In the node -e script, fd 0 is stdin (the payload) and process.argv[1] is
# the field name passed as $1.
read_payload_field() {
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8"))[process.argv[1]]??"")' "$1" <<<"${hook_payload}" 2>/dev/null || true
}

# The payload cwd follows the session into a worktree; CLAUDE_PROJECT_DIR
# stays at the original project root, so it is only the fallback, and the
# hook's own working directory is the last resort.
payload_cwd="$(read_payload_field cwd)"
checkout_lookup_dir="${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}"
checkout="$(git -C "${checkout_lookup_dir}" rev-parse --show-toplevel 2>/dev/null)" || {
  log "no git checkout resolved from '${checkout_lookup_dir}' — skipping"
  exit 0
}

# Puts nvm's Node first on PATH for the session's later Bash commands.
# - Without it, those commands can find another Node first. Cloud images put
#   /opt/node22 on PATH and do not load nvm.
# - Claude Code sources CLAUDE_ENV_FILE before each of those commands, so one
#   PATH line written there covers them all. Local sessions with nvm get the
#   line too.
# - nvm's Node is the checkout's .nvmrc version when nvm has it installed,
#   otherwise nvm's default alias.
persist_node_on_path() {
  # Only SessionStart invocations write the PATH line: Claude Code hands them
  # the session's own env file. A worktree entry (PostToolUse) could inherit
  # a CLAUDE_ENV_FILE the user exported, so writing there would append the
  # PATH line to that file.
  local hook_event
  hook_event="$(read_payload_field hook_event_name)"
  [[ "${hook_event}" == "SessionStart" ]] || return 0
  [[ -n "${CLAUDE_ENV_FILE:-}" ]] || return 0
  command -v nvm >/dev/null 2>&1 || return 0

  # - nvm which reads the nearest .nvmrc at or above the current directory,
  #   hence the cd.
  # - set +u: with no .nvmrc, nvm which reads an unset variable, and under
  #   set -u that ends this subshell before the default alias lookup.
  # - --silent keeps its "Found .nvmrc" notice out of the captured path.
  # - With no .nvmrc, or with its version not installed, nvm which fails and
  #   the default alias is looked up instead.
  local node_path
  node_path="$(
    cd "${checkout}" || exit
    set +u
    nvm which --silent 2>/dev/null || nvm which default 2>/dev/null
  )" || true

  # Both lookups failing leaves node_path empty.
  if [[ ! -x "${node_path}" ]]; then
    log "no nvm Node found for ${checkout} — later commands keep the session's PATH"
    return 0
  fi

  # The line reads export PATH="<nvm Node's bin directory>:$PATH", with $PATH
  # kept literal so it expands when each command runs. A resumed session runs
  # this hook again against the same file, so the line is added only when the
  # file lacks it.
  local path_line
  path_line="export PATH=\"$(dirname "${node_path}"):\$PATH\""
  if ! grep -qxF "${path_line}" "${CLAUDE_ENV_FILE}" 2>/dev/null; then
    # Under set -e a failed write would end the hook before the install below.
    if ! printf '%s\n' "${path_line}" >> "${CLAUDE_ENV_FILE}"; then
      log "could not write ${CLAUDE_ENV_FILE} — later commands keep the session's PATH"
      return 0
    fi
    log "later commands use $("${node_path}" --version) from ${node_path}"
  fi
}

persist_node_on_path

# The stamp, marker, and lock (each described below) live in the checkout's
# git directory, which is per-worktree and never tracked. A .claude/ location
# would surface them as untracked files in any checkout whose .gitignore
# predates this hook.
state_dir="$(git -C "${checkout}" rev-parse --absolute-git-dir)"

# The stamp records which package-lock.json the hook's own last install used,
# so a stamped checkout reinstalls after a pull changes the lockfile. An
# unstamped checkout (node_modules installed by the developer, not the hook)
# is trusted as-is — the hook must never wipe an install it does not own.
stamp="${state_dir}/install-deps-lockhash"

# The marker survives an interrupted npm ci (a hook-timeout kill included), so
# a partial node_modules is retried instead of trusted. It holds the hash of
# the package-lock.json that install used, so the interrupted-install recovery
# step further down never stamps a tree built from an older lockfile.
marker="${state_dir}/install-deps-incomplete"

# - git hash-object hashes the working-tree file, and the hook already needs
#   git, so no separate checksum tool is required.
# - Empty when the checkout has no package-lock.json; no stamp is written then.
lockfile_hash="$(git -C "${checkout}" hash-object package-lock.json 2>/dev/null || true)"

# The build:sst npm script typechecks sst.config.ts via tsconfig.sst.json,
# which references this file. sst install generates it, not npm ci.
sst_platform_types="${checkout}/.sst/platform/config.d.ts"

# Succeeds when node_modules needs no install: it exists, no interrupted
# install left the marker, and either the developer installed it (no stamp) or
# the stamp matches the current lockfile.
dependencies_are_current() {
  if [[ ! -d "${checkout}/node_modules" || -f "${marker}" ]]; then
    return 1
  fi

  local stamped
  stamped="$(cat "${stamp}" 2>/dev/null || true)"

  # No stamp means the developer installed node_modules, which is trusted as-is.
  if [[ -z "${stamped}" ]]; then
    return 0
  fi

  [[ "${stamped}" == "${lockfile_hash}" ]]
}

# Records an install the hook itself ran to completion: stamps the lockfile
# hash and clears the marker, so a later lockfile change triggers a reinstall.
# The stamp goes first: a hook killed between the two steps then leaves the
# marker, so the next session re-checks the tree or reinstalls it under the
# lock. The other order leaves no marker and, on a checkout never stamped
# before, no stamp, which reads as a developer-installed tree and turns the
# lockfile-change check off for this checkout.
record_finished_install() {
  if [[ -n "${lockfile_hash}" ]]; then
    printf '%s\n' "${lockfile_hash}" > "${stamp}"
  fi
  rm -f "${marker}"
}

# A transient sst install failure leaves the types missing, so every session
# retries until they land.
install_sst_platform_types() {
  if [[ -f "${sst_platform_types}" ]]; then
    return 0
  fi

  log "installing SST platform types in ${checkout}"
  (cd "${checkout}" && npx sst install >&2) || log "sst install failed — build:sst will not typecheck"
}

# Checked once without the lock, so a ready checkout never waits on another
# session's install; checked again under the lock below.
if dependencies_are_current && [[ -f "${sst_platform_types}" ]]; then
  log "node_modules current in ${checkout} — nothing to do"
  exit 0
fi

# A kernel lock serializes installs across sessions.
# - The lock belongs to the file opened on fd 9, not to a process. npm ci
#   inherits fd 9, so the lock stays held while an orphaned npm ci outlives a
#   killed hook, and the kernel releases it once every holder exits. No stale
#   lock is ever left for a later session to steal.
# - The hook never installs or recovers without the lock: an orphaned npm ci
#   may still be writing, and a half-written tree can pass npm ls. Without
#   perl, a busy lock past the wait, or a lock error, it skips the install.
# - Perl's flock is the one lock call every environment that runs this hook
#   has: macOS lacks flock(1), and macOS, Debian, Ubuntu and the cloud images
#   all ship perl.
# - Perl opens this shell's fd 9 in place (">&=" is C's fdopen, not a dup)
#   and locks the file open on it, so the lock outlives the perl process.
# - Perl exits 0 with the lock held, 75 (EX_TEMPFAIL from sysexits.h) when
#   the wait times out, and 2 when it cannot open or lock fd 9.
exec 9>>"${state_dir}/install-deps.lock"

# Well inside the 600s hook timeout in settings.json, so a timed-out wait
# still exits cleanly.
lock_wait_seconds=480

if ! command -v perl >/dev/null 2>&1; then
  log "perl not found, so the install lock cannot be taken — skipping the install in ${checkout}; run npm ci and npx sst install yourself"
  exit 0
fi

# Starting at 0 and assigning only on failure records perl's exit status
# without set -e ending the hook.
lock_status=0
perl -MFcntl=:flock -e '
  my ($checkout, $wait_seconds) = @ARGV;
  open(my $lock, ">&=", 9) or exit 2;
  exit 0 if flock($lock, LOCK_EX | LOCK_NB);
  print STDERR "[install-deps] another session is installing in $checkout — waiting for it\n";
  $SIG{ALRM} = sub { exit 75 };
  alarm $wait_seconds;
  flock($lock, LOCK_EX) or exit 2;
  exit 0;
' "${checkout}" "${lock_wait_seconds}" || lock_status=$?

if ((lock_status == 75)); then
  log "concurrent install still running after ${lock_wait_seconds}s in ${checkout} — skipping"
  exit 0
fi
if ((lock_status != 0)); then
  log "could not take the install lock in ${checkout} (perl exit ${lock_status}) — skipping the install"
  exit 0
fi

# Dependencies can be current here for two reasons: they already were and only
# the SST platform types are missing, or the session that held the lock just
# installed this lockfile.
if dependencies_are_current; then
  log "node_modules current in ${checkout}"
  install_sst_platform_types
  exit 0
fi

# Succeeds when an interrupted hook's orphaned npm ci finished the install
# anyway, so the tree can be kept instead of rebuilt. A hook killed by timeout
# leaves the marker behind even when that npm ci later completes. The hook
# holds the lock by now, so no orphaned npm ci is still writing: it would
# still hold fd 9.
orphaned_install_finished() {
  # No marker means no install was interrupted: node_modules is missing or
  # stamped from an older lockfile. The marker hash check below cannot rule
  # this out alone, because a missing marker reads as "" and so does the hash
  # of a checkout with no package-lock.json.
  if [[ ! -f "${marker}" ]]; then
    return 1
  fi

  # A tree built from an older lockfile passes npm ls whenever package.json
  # ranges still hold, and stamping it would hide the lockfile change forever.
  local marker_lockfile_hash
  marker_lockfile_hash="$(cat "${marker}" 2>/dev/null || true)"
  if [[ "${marker_lockfile_hash}" != "${lockfile_hash}" ]]; then
    return 1
  fi

  # - The hook writes the marker immediately before npm ci starts (the install
  #   step below), and writes it again when npm ci fails.
  # - npm ci deletes node_modules/.package-lock.json first and writes a new one
  #   once every dependency is installed, their install scripts included. Only
  #   the project's own lifecycle scripts, such as prepare, run after it.
  # - So only an npm ci that got that far leaves it newer than the marker. A
  #   tree npm ci never touched has an older one, and a tree whose npm ci was
  #   killed mid-build (SIGKILL skips npm's rollback) has none, yet both can
  #   pass npm ls.
  if [[ ! "${checkout}/node_modules/.package-lock.json" -nt "${marker}" ]]; then
    return 1
  fi

  # Every dependency must resolve at every depth.
  npm --prefix "${checkout}" ls --all >/dev/null 2>&1
}

if orphaned_install_finished; then
  # The orphaned install was still the hook's own, so it is stamped like the
  # normal success path. Leaving it unstamped would disable the
  # lockfile-change guard for this checkout forever.
  record_finished_install
  log "marker left by an interrupted hook but the dependency tree in ${checkout} is complete — clearing"
  install_sst_platform_types
  exit 0
fi

# nvm use below reads the nearest .nvmrc at or above the current directory,
# and npm ci installs into it.
cd "${checkout}"
printf '%s\n' "${lockfile_hash}" > "${marker}"

# Honor the checkout's .nvmrc when that Node is already installed; otherwise
# stay on the Node that loading nvm activated — a hook must never download a
# Node version.
if command -v nvm >/dev/null 2>&1; then
  # With no .nvmrc, nvm use reads an unset variable, which under set -u
  # would end the hook before the install.
  set +u
  nvm use >/dev/null 2>&1 || true
  set -u
fi
log "installing dependencies in ${checkout} (node $(node --version 2>/dev/null || echo unknown))"

# - On linux/x64, onnxruntime-node's postinstall downloads GPU binaries and
#   fails, because package.json's overrides stub out its extractor (adm-zip).
#   ONNXRUNTIME_NODE_INSTALL=skip turns that download off. macOS and arm64
#   Linux skip it on their own, so the variable changes nothing there.
# - npm's stdout goes to stderr too, because SessionStart hook stdout enters
#   the model's context.
if ONNXRUNTIME_NODE_INSTALL=skip npm ci >&2; then
  record_finished_install
  log "install complete"
  install_sst_platform_types
else
  # npm ci writes node_modules/.package-lock.json before the project's own
  # lifecycle scripts run, so one of them failing leaves it newer than the
  # marker. Writing the marker again keeps the recovery step from stamping
  # that tree next session.
  printf '%s\n' "${lockfile_hash}" > "${marker}"
  log "npm ci failed — the session continues without dependencies; the marker forces a retry next session"
fi

# A failed install exits 0 too: it is logged above, and the marker makes the
# next session retry it.
exit 0
