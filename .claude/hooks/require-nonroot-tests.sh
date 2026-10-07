#!/usr/bin/env bash
# Stops a test run in a root session and replies with the setpriv prefix that
# runs the same command as the nobody user. Root ignores file permissions, so a
# test that chmods a file or folder to deny access, then expects the access to
# fail, breaks as root, while CI, which runs as a normal user, passes it.
# - Claude Code's cloud sessions run as root. In a non-root session the hook
#   exits at its first check, so it costs nothing on a developer machine.
# - Before replying, it makes the folders a test run writes in the checkout
#   writable for nobody.
# - Registered on PreToolUse for Bash in .claude/settings.json with a
#   10-second timeout. Claude Code cancels a slower hook and runs the command
#   anyway, so the hook must stay fast.
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  exit 0
fi

# Without setpriv or a nobody user there is no command to offer, so the hook
# lets the run through rather than blocking it with no way forward.
if ! command -v setpriv >/dev/null 2>&1 || ! id nobody >/dev/null 2>&1; then
  exit 0
fi

# The payload is JSON on stdin. node prints the command and the session's
# current folder, each ended by a NUL, the one character a shell command
# cannot hold.
# - Without node, or with a payload node cannot parse, node prints nothing.
#   Each read then fails and leaves its variable empty (`|| true` keeps set -e
#   from ending the hook), and an empty command lets the call through.
# - The script is single-quoted on purpose: its ${...} is JavaScript, not shell.
# shellcheck disable=SC2016
{
  IFS= read -r -d '' tool_command || true
  IFS= read -r -d '' payload_cwd || true
} < <(node -e '
  const chunks = []
  // Decoded once at the end: a multi-byte character can be split across chunks.
  process.stdin.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    process.stdout.write(`${parsed.tool_input?.command ?? ""}\0${parsed.cwd ?? ""}\0`)
  })
' 2>/dev/null)

# A test runner: `vitest`, bare or by path (node_modules/.bin/vitest);
# `npx vitest`; `node node_modules/vitest/vitest.mjs`; `npm test` or `npm t`;
# and the package.json scripts test, test:coverage, test:watch and
# snapshot:update. The scripts test:remote-boot and test:cli-pty are left out;
# the exemptions after the match say why.
test_runner='(npx[[:space:]]+)?([^[:space:];&|]*/)?vitest|node[[:space:]]+[^[:space:]]*vitest\.mjs|npm[[:space:]]+(test|t|run[[:space:]]+(test|test:coverage|test:watch|snapshot:update))'

# A VAR=value setting before the command (`CI=1 npm test`). The value is
# double-quoted, single-quoted, or unquoted up to a space, quote, ;, & or |.
double_quoted='"[^"]*"'
single_quoted="'[^']*'"
unquoted="[^[:space:];&|'\"]*"
variable_setting="[A-Za-z_][A-Za-z0-9_]*=(${double_quoted}|${single_quoted}|${unquoted})[[:space:]]+"

# A wrapper that runs the command after it: env, time, exec, command, or
# timeout. timeout takes flags, then one or more numbers: a flag's numeric
# argument and the duration, as in `timeout -k 5 600 npm test`.
wrapper='(env|time|exec|command|timeout([[:space:]]+-[^[:space:]]*)*([[:space:]]+[0-9][^[:space:]]*)+)[[:space:]]+'

# A shell keyword that a command can follow: `if npm test`, then, do, else,
# elif, `! npm test`, `{ npm test; }`.
shell_keyword='(if|then|do|else|elif|!|\{)[[:space:]]+'

command_prefix="(${wrapper}|${shell_keyword}|${variable_setting})*"

# A command starts at the start of a line or after ;, &, | or ( (which also
# covers $( ). bash's ^ matches only at the start of the whole string, so a
# newline is listed with the separators. A mention elsewhere, as in
# `grep vitest package.json`, is not a run.
line_break=$'\n'
command_start="(^|[;&|(${line_break}])"

# The runner ends at a space, ;, &, |, ) or the end of the command, so
# `npm run testx` and `npm run test:cli-pty` are not runs.
runner_end='([[:space:];&|)]|$)'

runs_tests="${command_start}[[:space:]]*${command_prefix}(${test_runner})${runner_end}"
if [[ ! "${tool_command}" =~ ${runs_tests} ]]; then
  exit 0
fi

# Exemptions:
# - A command that contains setpriv anywhere is taken as already prefixed.
# - Two suites have no permission tests and cannot run as nobody. Their npm
#   scripts never match runs_tests, but a direct vitest run with their config
#   (`npx vitest run --config vitest.cli-pty.config.ts`) does, and goes
#   through here.
#   - remote-boot needs the Docker socket, which nobody cannot open.
#   - cli-pty starts the CLI with npx from a temp folder, so npx downloads tsx
#     into nobody's empty npm cache. Cloud sessions reach the npm registry
#     through a proxy whose CA bundle sits under /root, where nobody cannot
#     read it, so that download fails.
case "${tool_command}" in
  *setpriv* | *remote-boot* | *cli-pty*) exit 0 ;;
esac

# The checkout whose folders get prepared:
# - The payload's cwd is the session's current folder. CLAUDE_PROJECT_DIR,
#   which Claude Code sets to the project root, stands in when the payload
#   has no cwd.
# - A leading `cd` to an absolute path moves the run to that path's checkout
#   (`cd /other/checkout && npm test`).
# - Any other cd target falls back to the current folder's checkout: a
#   relative, ~ or quoted path, which only the shell can resolve, or an
#   absolute path in no checkout. The run is then still stopped rather than
#   let through as root.
session_dir="${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}"
run_dir="${session_dir}"
leading_cd='^[[:space:]]*cd[[:space:]]+(/[^[:space:];&|]*)'
if [[ "${tool_command}" =~ ${leading_cd} ]]; then
  run_dir="${BASH_REMATCH[1]}"
fi
checkout="$(git -C "${run_dir}" rev-parse --show-toplevel 2>/dev/null ||
  git -C "${session_dir}" rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Without node_modules there is nothing to run yet. A folder made under
# node_modules here would also stop the install: install-deps.sh skips npm ci
# in a checkout that has a node_modules folder it did not install.
if [[ ! -d "${checkout}/node_modules" ]]; then
  exit 0
fi

# Folders a test run writes: vitest's caches under node_modules, a fake HOME
# that keeps npm's cache and logs out of root's home, and coverage/ for
# test:coverage's report (gitignored).
nobody_writable=(
  "${checkout}/node_modules/.vite-temp"
  "${checkout}/node_modules/.vitest"
  "${checkout}/node_modules/.nobody-home"
  "${checkout}/coverage"
)
mkdir -p "${nobody_writable[@]}"
# Owned by nobody and closed to other users, because vitest runs code from its
# caches. Recursive, because files a root run left inside would stay
# root-owned.
chown -R "$(id -u nobody):$(id -g nobody)" "${nobody_writable[@]}"
chmod -R go-w "${nobody_writable[@]}"

# snapshot:update rewrites the tool-surface baseline here, the only snapshot
# folder in the repo. Its files are tracked JSON that vitest compares against,
# not code it runs, so they keep their owner and are made writable for every
# user (o+w). git records only the executable bit, so the mode change adds
# nothing to a diff.
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
