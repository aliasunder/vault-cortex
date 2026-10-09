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
#   comes first on PATH, which it keeps active instead.
# - Cloud setup scripts install nvm with HOME=/root, so nvm can sit under
#   /root even when this hook runs with a different HOME.
for dir in "${HOME}/.nvm" /root/.nvm; do
  if [[ -s "${dir}/nvm.sh" ]]; then
    export NVM_DIR="${dir}"
    # Loading nvm.sh runs nvm use, which under set -eu can end the hook (no
    # default alias and an uninstalled .nvmrc version, for one).
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
read_payload_field() {
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8"))[process.argv[1]]??"")' "$1" <<<"${hook_payload}" 2>/dev/null || true
}

# The payload cwd follows the session into a worktree; CLAUDE_PROJECT_DIR
# stays at the original project root, so it is only the fallback.
payload_cwd="$(read_payload_field cwd)"
checkout="$(git -C "${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}" rev-parse --show-toplevel 2>/dev/null)" || {
  log "no git checkout resolved from '${payload_cwd:-<empty>}' — skipping"
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
  # Only SessionStart runs write: Claude Code hands them the session's own env
  # file. A worktree entry (PostToolUse) could inherit a CLAUDE_ENV_FILE the
  # user exported, so writing there would append the PATH line to that file.
  local hook_event
  hook_event="$(read_payload_field hook_event_name)"
  [[ "${hook_event}" == "SessionStart" ]] || return 0
  [[ -n "${CLAUDE_ENV_FILE:-}" ]] || return 0
  command -v nvm >/dev/null 2>&1 || return 0

  # - nvm which reads .nvmrc from the current directory, hence the cd.
  # - --silent keeps its "Found .nvmrc" notice out of the captured path.
  # - With no .nvmrc, or with its version not installed, nvm which fails and
  #   the default alias is looked up instead.
  # - set +u: with no .nvmrc, nvm which reads an unset variable, and under
  #   set -u that ends this subshell before the default alias lookup.
  local node_path
  node_path="$(cd "${checkout}" && set +u && { nvm which --silent 2>/dev/null || nvm which default 2>/dev/null; })" || true

  # Both lookups failing leaves node_path empty.
  if [[ ! -x "${node_path}" ]]; then
    log "no nvm Node found for ${checkout} — later commands keep the session's PATH"
    return 0
  fi

  # $PATH stays literal so it expands when each command runs. A resumed
  # session runs this hook again against the same file, so the line is added
  # only when the file lacks it.
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

# The marker, stamp, and lock (each described further down) live in the
# checkout's git directory, which is per-worktree and never tracked. A .claude/
# location would surface them as untracked files in any checkout whose
# .gitignore predates this hook.
state_dir="$(git -C "${checkout}" rev-parse --absolute-git-dir)"

# The marker survives an interrupted npm ci (a hook-timeout kill included), so
# a partial node_modules is retried instead of trusted. It holds the hash of
# the package-lock.json that install used, so the later step that clears a
# leftover marker never stamps a tree built from an older lockfile.
marker="${state_dir}/install-deps-incomplete"

# The stamp records which package-lock.json the hook's own last install used,
# so a stamped checkout reinstalls after a pull changes the lockfile. An
# unstamped checkout (node_modules installed by the developer, not the hook)
# is trusted as-is — the hook must never wipe an install it does not own.
stamp="${state_dir}/install-deps-lockhash"

# Empty when the checkout has no package-lock.json; no stamp is written then.
lockfile_hash="$(git -C "${checkout}" hash-object package-lock.json 2>/dev/null || true)"

# build:sst typechecks sst.config.ts via tsconfig.sst.json, which references
# this file. sst install generates it, not npm ci.
sst_platform_types="${checkout}/.sst/platform/config.d.ts"

dependencies_are_current() {
  local stamped
  stamped="$(cat "${stamp}" 2>/dev/null || true)"
  if [[ ! -d "${checkout}/node_modules" || -f "${marker}" ]]; then
    return 1
  fi

  # No stamp means the developer installed node_modules, which is trusted
  # as-is; a stamped tree must match the current lockfile.
  [[ -z "${stamped}" || "${stamped}" == "${lockfile_hash}" ]]
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

if dependencies_are_current && [[ -f "${sst_platform_types}" ]]; then
  log "node_modules present in ${checkout} — nothing to do"
  exit 0
fi

# A kernel lock serializes installs across sessions.
# - The lock belongs to the file opened on fd 9, not to a process. npm ci
#   inherits fd 9, so the lock stays held while an orphaned npm ci outlives a
#   killed hook, and the kernel releases it once every holder exits. No stale
#   lock is ever left for a later session to steal.
# - Perl's flock is the lock call available on both macOS, which lacks
#   flock(1), and Linux, which lacks lockf(1).
# - Perl opens this shell's fd 9 in place (">&=" is C's fdopen, not a dup)
#   and locks the file open on it, so the lock outlives the perl process.
# - The 480s wait sits well inside the 600s hook timeout in settings.json.
#   Perl exits 75 when that wait times out.
exec 9>>"${state_dir}/install-deps.lock"
lock_held=false
if command -v perl >/dev/null 2>&1; then
  lock_status=0
  perl -MFcntl=:flock -e '
    open(my $lock, ">&=", 9) or exit 2;
    exit 0 if flock($lock, LOCK_EX | LOCK_NB);
    print STDERR "[install-deps] another session is installing in $ARGV[0] — waiting for it\n";
    $SIG{ALRM} = sub { exit 75 };
    alarm 480;
    flock($lock, LOCK_EX) or exit 2;
    exit 0;
  ' "${checkout}" || lock_status=$?

  if ((lock_status == 75)); then
    log "concurrent install still running after 480s in ${checkout} — skipping"
    exit 0
  fi
  if ((lock_status == 0)); then
    lock_held=true
  else
    log "could not take the install lock in ${checkout} (perl exit ${lock_status}) — installing without it"
  fi
else
  log "perl not found — installing in ${checkout} without the install lock"
fi

# Dependencies can be current here for two reasons: they already were and only
# the SST platform types are missing, or the session that held the lock just
# installed this lockfile.
if dependencies_are_current; then
  log "node_modules current in ${checkout}"
  install_sst_platform_types
  exit 0
fi

# A hook killed by timeout can leave the marker even though its orphaned npm ci
# finished the install. A tree whose dependencies all resolve at every depth
# (npm ls --all) is taken as complete, so this clears the marker and stamps
# the tree instead of rebuilding it.
# - Only with the lock held: then no orphaned npm ci is still writing, because
#   that npm ci would still hold fd 9. Without the lock a half-written tree
#   can pass npm ls while npm ci is still adding to it, so the tree is rebuilt
#   instead.
# - The marker's lockfile hash must match the current one. A tree built from
#   an older lockfile passes npm ls whenever package.json ranges still hold,
#   and stamping it would hide the lockfile change forever.
# - npm writes node_modules/.package-lock.json only once an install finishes,
#   install scripts included, and npm ci deletes the old one first. It must be
#   newer than the marker: a tree that npm ci never touched has an older one,
#   and a tree whose npm ci was killed mid-build (SIGKILL skips npm's
#   rollback) has none, yet both can pass npm ls.
marker_lockfile_hash="$(cat "${marker}" 2>/dev/null || true)"
if [[ "${lock_held}" == true && -f "${marker}" && "${marker_lockfile_hash}" == "${lockfile_hash}" && "${checkout}/node_modules/.package-lock.json" -nt "${marker}" ]]; then
  if npm --prefix "${checkout}" ls --all >/dev/null 2>&1; then
    rm -f "${marker}"

    # The orphaned install was still the hook's own, so it is stamped like the
    # normal success path. Leaving it unstamped would disable the
    # lockfile-change guard for this checkout forever.
    if [[ -n "${lockfile_hash}" ]]; then
      printf '%s\n' "${lockfile_hash}" > "${stamp}"
    fi
    log "marker left by an interrupted hook but the dependency tree in ${checkout} is complete — clearing"
    install_sst_platform_types
    exit 0
  fi
fi

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
  rm -f "${marker}"
  if [[ -n "${lockfile_hash}" ]]; then
    printf '%s\n' "${lockfile_hash}" > "${stamp}"
  fi
  log "install complete"
  install_sst_platform_types
else
  log "npm ci failed — the session continues without dependencies; the marker forces a retry next session"
fi

# A failed install exits 0 too: it is logged above, and the marker makes the
# next session retry it.
exit 0
