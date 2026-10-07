#!/usr/bin/env bash
# Stops test runs in a session that runs as root, as cloud sessions do, and
# replies with the setpriv prefix that runs the same command as nobody. Root
# reads files the permission tests make unreadable, so those tests fail as
# root while CI, which runs as a normal user, passes them.
# Registered on PreToolUse for Bash. A non-root session exits at the first
# check, so the hook costs nothing on a developer machine.
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  exit 0
fi

# Without setpriv or a nobody user there is no command to offer, so the hook
# lets the run through rather than blocking it with no way forward.
if ! command -v setpriv >/dev/null 2>&1 || ! id nobody >/dev/null 2>&1; then
  exit 0
fi

# The payload is JSON on stdin. node prints the command and the session's cwd
# separated by a NUL, because a command can hold any other character. A payload
# node cannot parse yields an empty command, which lets the call through.
# The script is single-quoted on purpose: its ${...} is JavaScript, not shell.
# shellcheck disable=SC2016
{
  IFS= read -r -d '' tool_command || true
  IFS= read -r -d '' payload_cwd || true
} < <(node -e '
  let payload = ""
  process.stdin.on("data", (chunk) => (payload += chunk)).on("end", () => {
    const parsed = JSON.parse(payload)
    process.stdout.write(`${parsed.tool_input?.command ?? ""}\0${parsed.cwd ?? ""}\0`)
  })
' 2>/dev/null)

# A test runner at a command position: the start of the line or after ;, &, |,
# ( or $(. A mention elsewhere, as in `grep vitest package.json`, is not a run.
# test:remote-boot is left out because it needs the Docker socket, which
# nobody cannot open.
test_runner='(npx[[:space:]]+)?([^[:space:];&|]*/)?vitest|node[[:space:]]+[^[:space:]]*vitest\.mjs|npm[[:space:]]+(test|t|run[[:space:]]+(test|test:coverage|test:watch|test:cli-pty|snapshot:update))'
runs_tests="(^|[;&|(]|\\\$\\()[[:space:]]*(${test_runner})([[:space:];&|)]|\$)"
if [[ ! "${tool_command}" =~ ${runs_tests} || "${tool_command}" == *setpriv* ]]; then
  exit 0
fi

checkout="$(git -C "${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}" rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Before dependencies are installed there is nothing to run, and a folder made
# under node_modules would let install-deps.sh take the checkout as installed.
if [[ ! -d "${checkout}/node_modules" ]]; then
  exit 0
fi

# Folders vitest writes: its caches under node_modules, and coverage/ for
# test:coverage's report (gitignored). The fake HOME keeps npm's cache and
# logs out of root's home. Snapshot files are tracked and root-owned, so
# snapshot:update needs them writable; git records only the executable bit, so
# opening them adds nothing to a diff.
nobody_writable=(
  "${checkout}/node_modules/.vite-temp"
  "${checkout}/node_modules/.vitest"
  "${checkout}/node_modules/.nobody-home"
  "${checkout}/coverage"
)
mkdir -p "${nobody_writable[@]}"
# Recursive, because files a root run left inside would stay root-owned.
chmod -R 777 "${nobody_writable[@]}"
snapshots="${checkout}/src/vault-mcp/mcp-core/__tests__/__snapshots__"
if [[ -d "${snapshots}" ]]; then
  chmod -R o+w "${snapshots}"
fi

cat >&2 <<EOF
Tests do not run as root in this repo: root reads the files the permission tests make unreadable, so those tests fail here but pass in CI.
Run the same test command as the nobody user, with this prefix in front of the test command itself (after any cd):
  setpriv --reuid=$(id -u nobody) --regid=$(id -g nobody) --clear-groups env HOME=${checkout}/node_modules/.nobody-home
The folders nobody needs to write in ${checkout} are ready.
EOF
# vitest deletes coverage/ before a coverage run, and deleting it needs write
# access to the checkout root, so the run must keep the folder instead.
if [[ "${tool_command}" == *test:coverage* || "${tool_command}" == *--coverage* ]]; then
  echo "For a coverage run, also pass --coverage.clean=false (after -- for npm run): vitest otherwise deletes coverage/ first, which nobody cannot do in a root-owned checkout." >&2
fi
exit 2
