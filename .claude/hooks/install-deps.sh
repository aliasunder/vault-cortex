#!/usr/bin/env bash
# Ensures the current checkout's dependencies are installed. Registered on
# SessionStart and on PostToolUse for EnterWorktree: fresh cloud clones and
# fresh git worktrees start without node_modules.
set -euo pipefail

# stderr only: SessionStart hook stdout is injected into the model's context.
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

# The marker survives an interrupted npm ci (a hook-timeout kill included), so
# a partial node_modules is retried instead of trusted. It lives outside
# node_modules because npm ci deletes that directory before installing.
marker="${checkout}/.claude/.install-deps-incomplete"
# The stamp records which package-lock.json the hook's own last install used,
# so a stamped checkout reinstalls after a pull changes the lockfile. An
# unstamped checkout (node_modules installed by the developer, not the hook)
# is trusted as-is — the hook must never wipe an install it does not own.
stamp="${checkout}/.claude/.install-deps-lockhash"
lockfile_hash="$(git -C "${checkout}" hash-object package-lock.json 2>/dev/null || true)"
if [[ -d "${checkout}/node_modules" && ! -f "${marker}" ]]; then
  stamped="$(cat "${stamp}" 2>/dev/null || true)"
  if [[ -z "${stamped}" || "${stamped}" == "${lockfile_hash}" ]]; then
    log "node_modules present in ${checkout} — nothing to do"
    exit 0
  fi
  log "package-lock.json changed since the hook's last install in ${checkout} — reinstalling"
fi

# mkdir is the portable atomic lock (flock is Linux-only). The lock records its
# owner's pid: a live owner means a concurrent install is running — skip rather
# than race npm ci; a dead owner (hook killed mid-install) is taken over
# immediately, so the marker's retry is never blocked behind an orphaned lock.
lock="${checkout}/.claude/.install-deps.lock"
if mkdir "${lock}" 2>/dev/null; then
  echo "$$" > "${lock}/pid"
else
  owner="$(cat "${lock}/pid" 2>/dev/null || true)"
  if [[ -n "${owner}" ]] && kill -0 "${owner}" 2>/dev/null; then
    log "another session (pid ${owner}) is installing in ${checkout} — skipping"
    exit 0
  fi
  log "install lock owner (pid ${owner:-unknown}) is gone — taking over"
  rm -rf "${lock}"
  mkdir "${lock}" 2>/dev/null || {
    log "lost the takeover race to another session — skipping"
    exit 0
  }
  echo "$$" > "${lock}/pid"
fi
cleanup() {
  # If npm ci is still running (hook killed while npm continues), leave the
  # lock — its pid targets the live npm process; the takeover logic (above)
  # handles the eventual cleanup once npm exits.
  if [[ -n "${install_pid:-}" ]] && kill -0 "${install_pid}" 2>/dev/null; then
    return
  fi
  rm -rf "${lock}"
}
trap cleanup EXIT

cd "${checkout}"
touch "${marker}"
# Honor the checkout's .nvmrc when that Node is already installed; otherwise
# stay on the default alias — a hook must never download a Node version.
command -v nvm >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true
log "installing dependencies in ${checkout} (node $(node --version 2>/dev/null || echo unknown))"
# ONNXRUNTIME_NODE_INSTALL=skip: onnxruntime-node's postinstall would download
# GPU binaries whose extractor (adm-zip) is stubbed out — required on linux/x64.
# npm's stdout goes to stderr too: SessionStart hook stdout enters the model's context.
ONNXRUNTIME_NODE_INSTALL=skip npm ci >&2 &
install_pid=$!
# The lock's liveness target becomes the npm process itself: if the hook shell
# is killed but its npm ci survives, the lock stays respected until the process
# actually mutating node_modules is gone.
echo "${install_pid}" > "${lock}/pid"
if wait "${install_pid}"; then
  rm -f "${marker}"
  if [[ -n "${lockfile_hash}" ]]; then
    printf '%s\n' "${lockfile_hash}" > "${stamp}"
  fi
  log "install complete"
else
  log "npm ci failed — the session continues without dependencies; the marker forces a retry next session"
fi
exit 0
