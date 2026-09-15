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
# A hook killed by timeout can leave the marker even though its orphaned npm ci
# finished the install. A tree that passes npm ls is complete — clear the
# marker and stamp it instead of rebuilding it.
if [[ -d "${checkout}/node_modules" && -f "${marker}" ]]; then
  if npm --prefix "${checkout}" ls --depth=0 >/dev/null 2>&1; then
    rm -f "${marker}"
    # Stamped like the normal success path: the orphaned install was still the
    # hook's own, and leaving it unstamped would disable the lockfile-change
    # guard for this checkout forever.
    if [[ -n "${lockfile_hash}" ]]; then
      printf '%s\n' "${lockfile_hash}" > "${stamp}"
    fi
    log "marker left by an interrupted hook but the dependency tree in ${checkout} is complete — clearing"
    exit 0
  fi
fi

# mkdir is the portable atomic lock (flock is Linux-only). The lock records its
# owner's pid: a live owner means a concurrent install is running — wait for it
# rather than race npm ci; a dead owner (hook killed mid-install) is taken over
# immediately, so the marker's retry is never blocked behind an orphaned lock.
lock="${checkout}/.claude/.install-deps.lock"
if mkdir "${lock}" 2>/dev/null; then
  echo "$$" > "${lock}/pid"
else
  owner="$(cat "${lock}/pid" 2>/dev/null || true)"
  if [[ -n "${owner}" ]] && kill -0 "${owner}" 2>/dev/null; then
    # A live concurrent install: wait for it (bounded well inside the 600s
    # hook budget) so this session starts with dependencies instead of racing
    # a tree npm ci is actively rewriting.
    log "another session (pid ${owner}) is installing in ${checkout} — waiting for it"
    waited=0
    while kill -0 "${owner}" 2>/dev/null && ((waited < 480)); do
      sleep 5
      waited=$((waited + 5))
    done
    if [[ -d "${checkout}/node_modules" && ! -f "${marker}" ]]; then
      log "concurrent install finished in ${checkout} — nothing to do"
      exit 0
    fi
    if ((waited >= 480)); then
      log "concurrent install still running after ${waited}s in ${checkout} — skipping"
      exit 0
    fi
    log "concurrent installer (pid ${owner}) died without finishing in ${checkout}"
  fi
  # Re-read: another session may have taken over the lock while we waited.
  # Without this, a completed takeover (claim already removed) is invisible
  # and this session's mkdir-claim succeeds, leading to two concurrent installs.
  owner="$(cat "${lock}/pid" 2>/dev/null || true)"
  if [[ -n "${owner}" ]] && kill -0 "${owner}" 2>/dev/null; then
    log "another session (pid ${owner}) took over the install in ${checkout} — skipping"
    exit 0
  fi
  # The claim token makes the takeover exclusive: rm-then-mkdir alone is not
  # atomic, so without it a second taker's rm could delete the first taker's
  # fresh lock and both would install. The claim records its taker's pid so a
  # killed takeover is reclaimed immediately; the age check covers only a
  # pidless claim (its taker died between mkdir and the pid write).
  claim="${lock}.claim"
  claim_is_stale() {
    local claim_owner
    claim_owner="$(cat "${claim}/pid" 2>/dev/null || true)"
    if [[ -n "${claim_owner}" ]]; then
      ! kill -0 "${claim_owner}" 2>/dev/null
    else
      [[ -n "$(find "${claim}" -maxdepth 0 -mmin +1 2>/dev/null)" ]]
    fi
  }
  # The second mkdir attempt covers a stale claim this session just cleared —
  # mkdir stays the atomic arbiter both times, so two clearers still produce
  # exactly one taker.
  if ! mkdir "${claim}" 2>/dev/null; then
    if claim_is_stale; then
      log "clearing a stale takeover claim in ${checkout}"
      rm -rf "${claim}"
    fi
    if ! mkdir "${claim}" 2>/dev/null; then
      log "another session is taking over the stale lock in ${checkout} — skipping"
      exit 0
    fi
  fi
  echo "$$" > "${claim}/pid"
  log "install lock owner (pid ${owner:-unknown}) is gone — taking over"
  rm -rf "${lock}"
  if ! mkdir "${lock}" 2>/dev/null; then
    rm -rf "${claim}"
    log "lost the lock to a newly arrived session — skipping"
    exit 0
  fi
  echo "$$" > "${lock}/pid"
  rm -rf "${claim}"
fi
owned_pid="$$"
cleanup() {
  # If npm ci is still running (hook killed while npm continues), leave the
  # lock — its pid targets the live npm process; the takeover logic (above)
  # handles the eventual cleanup once npm exits.
  if [[ -n "${install_pid:-}" ]] && kill -0 "${install_pid}" 2>/dev/null; then
    return
  fi
  # Release only a lock this hook still owns: after this hook's npm exited, a
  # takeover may have replaced the lock, and removing it would unlock a third
  # session against the second's live install.
  if [[ "$(cat "${lock}/pid" 2>/dev/null)" == "${owned_pid}" ]]; then
    rm -rf "${lock}"
  fi
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
owned_pid="${install_pid}"
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
