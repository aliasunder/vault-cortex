#!/usr/bin/env bash
# Ensures the current checkout's dependencies are installed. Registered on
# SessionStart and on PostToolUse for EnterWorktree, because fresh cloud clones
# and fresh git worktrees start without node_modules.
set -euo pipefail

# Logs go to stderr because SessionStart hook stdout enters the model's context.
log() { echo "[install-deps] $*" >&2; }

# A hook's non-interactive shell never sources .bashrc, so nvm must be loaded
# here; without it, npm can resolve to a system Node (cloud images ship
# Node 22 at /opt/node22). Sourcing nvm.sh activates the default alias.
# Cloud setup scripts run with HOME=/root, hence the second candidate.
for dir in "${HOME}/.nvm" /root/.nvm; do
  if [[ -s "${dir}/nvm.sh" ]]; then
    export NVM_DIR="${dir}"
    # shellcheck disable=SC1091
    . "${dir}/nvm.sh"
    break
  fi
done

# The payload cwd follows the session into a worktree; CLAUDE_PROJECT_DIR
# stays at the original project root, so it is only the fallback.
payload_cwd="$(node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).cwd??""))' 2>/dev/null || true)"
checkout="$(git -C "${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}" rev-parse --show-toplevel 2>/dev/null)" || {
  log "no git checkout resolved from '${payload_cwd:-<empty>}' — skipping"
  exit 0
}

# The marker, stamp, and lock live in the checkout's git directory, which is
# per-worktree and never tracked. A .claude/ location would surface them as
# untracked files in any checkout whose .gitignore predates this hook.
state_dir="$(git -C "${checkout}" rev-parse --absolute-git-dir)"

# The marker survives an interrupted npm ci (a hook-timeout kill included), so
# a partial node_modules is retried instead of trusted. It holds the hash of
# the package-lock.json that install used, so recovery never stamps a tree
# built from an older lockfile.
marker="${state_dir}/install-deps-incomplete"

# The stamp records which package-lock.json the hook's own last install used,
# so a stamped checkout reinstalls after a pull changes the lockfile. An
# unstamped checkout (node_modules installed by the developer, not the hook)
# is trusted as-is — the hook must never wipe an install it does not own.
stamp="${state_dir}/install-deps-lockhash"
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
#   flock(1), and Linux, which lacks lockf(1). Perl locks this shell's fd 9,
#   so the lock outlives the perl process.
# - The 480s wait sits well inside the 600s hook timeout in settings.json.
#   Perl exits 75 when that wait times out.
exec 9>>"${state_dir}/install-deps.lock"
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
  if ((lock_status != 0)); then
    log "could not take the install lock in ${checkout} (perl exit ${lock_status}) — installing without it"
  fi
else
  log "perl not found — installing in ${checkout} without the install lock"
fi

# The session that held the lock may have just installed this lockfile, or
# only the SST platform types are missing.
if dependencies_are_current; then
  log "node_modules current in ${checkout}"
  install_sst_platform_types
  exit 0
fi

# A hook killed by timeout can leave the marker even though its orphaned npm ci
# finished the install. A tree that passes npm ls is complete, so this clears
# the marker and stamps the tree instead of rebuilding it.
# - Holding the lock guarantees no orphaned npm ci is still writing, because
#   that npm ci would still hold fd 9.
# - The marker's lockfile hash must match the current one. A tree built from
#   an older lockfile passes npm ls whenever package.json ranges still hold,
#   and stamping it would hide the lockfile change forever.
marker_lockfile_hash="$(cat "${marker}" 2>/dev/null || true)"
if [[ -d "${checkout}/node_modules" && -f "${marker}" && "${marker_lockfile_hash}" == "${lockfile_hash}" ]]; then
  if npm --prefix "${checkout}" ls --depth=0 >/dev/null 2>&1; then
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
# stay on the default alias — a hook must never download a Node version.
command -v nvm >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true
log "installing dependencies in ${checkout} (node $(node --version 2>/dev/null || echo unknown))"

# On linux/x64, onnxruntime-node's postinstall downloads GPU binaries whose
# extractor (adm-zip) is stubbed out, so ONNXRUNTIME_NODE_INSTALL=skip is
# required there. npm's stdout goes to stderr too, because SessionStart hook
# stdout enters the model's context.
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
exit 0
