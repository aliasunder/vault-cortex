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
if [[ -d "${checkout}/node_modules" && ! -f "${marker}" ]]; then
  log "node_modules present in ${checkout} — nothing to do"
  exit 0
fi

# mkdir is the portable atomic lock (flock is Linux-only). A held lock means a
# concurrent session is installing — skip rather than race npm ci. A lock older
# than 30 minutes was left by a killed hook: take it over instead of blocking
# installs forever.
lock="${checkout}/.claude/.install-deps.lock"
if ! mkdir "${lock}" 2>/dev/null; then
  if [[ -n "$(find "${lock}" -maxdepth 0 -mmin +30 2>/dev/null)" ]]; then
    log "stale install lock (>30 min) in ${checkout} — taking over"
  else
    log "another session is installing in ${checkout} — skipping"
    exit 0
  fi
fi
trap 'rmdir "${lock}" 2>/dev/null || true' EXIT

cd "${checkout}"
touch "${marker}"
# Honor the checkout's .nvmrc when that Node is already installed; otherwise
# stay on the default alias — a hook must never download a Node version.
command -v nvm >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true
log "installing dependencies in ${checkout} (node $(node --version 2>/dev/null || echo unknown))"
# ONNXRUNTIME_NODE_INSTALL=skip: onnxruntime-node's postinstall would download
# GPU binaries whose extractor (adm-zip) is stubbed out — required on linux/x64.
if ONNXRUNTIME_NODE_INSTALL=skip npm ci; then
  rm -f "${marker}"
  log "install complete"
else
  log "npm ci failed — the session continues without dependencies; the marker forces a retry next session"
fi
exit 0
