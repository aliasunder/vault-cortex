#!/usr/bin/env bash
# Stops a test run in a root session and replies with the setpriv prefix that
# runs the same command as the nobody user. Root ignores file permissions, so a
# test that chmods a file or folder to deny access, then expects the access to
# fail, breaks as root, while CI, which runs as a normal user, passes it.
# - Claude Code's cloud sessions run as root. In a non-root session the hook
#   exits at its first check, so it costs nothing on a developer machine.
# - Before replying, it makes the folders a test run writes in the checkout
#   writable for nobody.
# - .claude/settings.json registers the hook on PreToolUse for Bash with a
#   10-second timeout. Claude Code cancels a slower hook and runs the command
#   anyway, so the hook must stay fast.
# - Exit 0 lets the command run. Exit 2 blocks it, and Claude Code passes the
#   hook's stderr text to the model as the reply.
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  exit 0
fi

# Without setpriv or a nobody user there is no command to offer, so the hook
# lets the run through rather than blocking it with no way forward.
if ! command -v setpriv >/dev/null 2>&1 || ! id nobody >/dev/null 2>&1; then
  exit 0
fi

# Claude Code sends the PreToolUse payload as JSON on stdin
# (`{ "tool_input": { "command": ... }, "cwd": ..., ... }`). node prints the
# payload's command and cwd (the session's current folder), each ended by a
# NUL, the one character a shell command cannot hold.
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
  // Buffer.concat runs before toString, because a multi-byte character can span two chunks.
  process.stdin.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    process.stdout.write(`${parsed.tool_input?.command ?? ""}\0${parsed.cwd ?? ""}\0`)
  })
' 2>/dev/null)

# Two patterns match the flags between a command and what it runs.
# - flags_without_argument matches flags that take no argument (`env -i`,
#   `time -p`).
# - flags_with_optional_argument matches flags that may each take one argument
#   (`timeout -k 5`, `npx -p vitest`). A word after such a flag can be read as
#   its argument or as the next part of the command (`npx -y vitest`,
#   `timeout -k 5 600`), and the match takes whichever reading lets the rest
#   of the pattern match.
flags_without_argument='([[:space:]]+-[^[:space:]]*)*'
flags_with_optional_argument='([[:space:]]+-[^[:space:]]*([[:space:]]+[^-[:space:]][^[:space:]]*)?)*'

# Three patterns match a test runner.
# - vitest_runner matches vitest itself, bare or by path
#   (node_modules/.bin/vitest), with or without a version (`vitest@latest`),
#   after npx and its flags (`npx -y vitest`), or as
#   `node node_modules/vitest/vitest.mjs`.
# - npm_exec_runner matches vitest after `npm exec` or `npm x`, each with
#   npm's flags (`npm x -y vitest`).
# - npm_runner matches `npm test`, `npm t`, and `npm run` or `npm run-script`
#   of the scripts test, test:coverage, test:watch and snapshot:update, each
#   after any npm flags (`npm -s test`, `npm run --silent test`). It leaves
#   out test:remote-boot and test:cli-pty, the two suites exempt from this
#   hook because they cannot run as nobody; the exemptions below give each
#   reason.
vitest_binary='([^[:space:]]*/)?vitest(@[^[:space:]]*)?'
vitest_runner="(npx${flags_with_optional_argument}[[:space:]]+)?${vitest_binary}|node[[:space:]]+[^[:space:]]*vitest\.mjs"
npm_exec_runner="npm${flags_with_optional_argument}[[:space:]]+(exec|x)${flags_with_optional_argument}[[:space:]]+${vitest_binary}"
npm_runner="npm${flags_with_optional_argument}[[:space:]]+(test|t|run(-script)?${flags_with_optional_argument}[[:space:]]+(test|test:coverage|test:watch|snapshot:update))"
test_runner="${vitest_runner}|${npm_exec_runner}|${npm_runner}"

# variable_setting matches a VAR=value setting before the command
# (`CI=1 npm test`), with the value in one of three forms.
# - double_quoted matches text in double quotes, with no " inside.
# - single_quoted matches text in single quotes, with no ' inside.
# - unquoted matches text up to the first space, ' or ".
double_quoted='"[^"]*"'
single_quoted="'[^']*'"
unquoted="[^[:space:]'\"]*"
variable_setting="[A-Za-z_][A-Za-z0-9_]*=(${double_quoted}|${single_quoted}|${unquoted})[[:space:]]+"

# wrapper matches these commands, which run the command after them:
# - env and time, with flags that take no argument, because a flag's argument
#   would look the same as the command it runs.
# - exec and command, without flags, so `command -v vitest` is not a run.
# - timeout, whose flags may each take one argument, then the duration
#   (`timeout -s KILL 600 npm test`, `timeout -k 5 600 npm test`).
# - bash, sh and zsh with flags, then the opening quote of the command they
#   run (`bash -lc 'npm test'`). The split below ignores quotes, so a run
#   after ; or && inside the quoted text counts too
#   (`bash -c 'npm ci && npm test'`), and a mention there
#   (`bash -c 'echo npm test'`) does not.
# setpriv is not a wrapper here: a run through setpriv is the nobody run the
# reply asks for, so the runner after it never counts.
timeout_wrapper="timeout${flags_with_optional_argument}[[:space:]]+[0-9][^[:space:]]*"
shell_wrapper="(bash|sh|zsh)${flags_without_argument}[[:space:]]+[\"']?"
wrapper="((env|time)${flags_without_argument}|exec|command|${timeout_wrapper})[[:space:]]+|${shell_wrapper}"

# shell_keyword matches a shell keyword a command can follow: if
# (`if npm test`), then, do, else, elif, while, until, ! (`! npm test`) and {
# (`{ npm test; }`).
shell_keyword='(if|then|do|else|elif|while|until|!|\{)[[:space:]]+'

command_prefix="(${wrapper}|${shell_keyword}|${variable_setting})*"

# The runner ends at a space, a ), a closing quote or the end of its command,
# so `npm run testx` and `npm run test:cli-pty` are not runs.
runner_end="([[:space:]]|\\)|[\"']|$)"

# A command that runs tests starts with the runner, after any prefix. A
# mention elsewhere, as in `grep vitest package.json`, is not a run.
test_run="^[[:space:]]*${command_prefix}(${test_runner})${runner_end}"

# exempt_suite_run matches a run of the remote-boot or cli-pty suite, the two
# exempt suites, by the config flag that names the suite's config file. The
# file name must end at a space, a ), a closing quote or the end of the
# command, so `vitest.cli-pty.config.ts.bak` does not count.
# - arguments_before_double_dash matches words other than a lone `--`. vitest
#   reads no flags after a lone `--`, so
#   `vitest run -- --config vitest.cli-pty.config.ts` runs the main suite.
# - vitest_exempt_suite_run matches the flag anywhere among vitest's arguments
#   before a lone `--` (`vitest run --config vitest.cli-pty.config.ts`).
# - npm_exempt_suite_run matches the flag only after npm's first lone `--`,
#   which hands the flag to vitest, and before a second one. npm itself
#   consumes the flag in `npm test --config x`, and the script runs the main
#   suite.
# - Neither matches a run through `npm exec` or `npm x`. npm reads a flag
#   after the command as its own unless a lone `--` comes first, so vitest
#   never sees the flag in `npm exec vitest run --config
#   vitest.cli-pty.config.ts`. The hook stops every such run rather than
#   track where npm's `--` falls.
exempt_suite_config="(-c|--config)(=|[[:space:]]+)([^[:space:]]*/)?vitest\.(remote-boot|cli-pty)\.config\.ts${runner_end}"
arguments_before_double_dash='([[:space:]]+(-|-?[^-[:space:]][^[:space:]]*|--[^[:space:]]+))*'
vitest_exempt_suite_run="^[[:space:]]*${command_prefix}(${vitest_runner})${arguments_before_double_dash}[[:space:]]+${exempt_suite_config}"
npm_exempt_suite_run="^[[:space:]]*${command_prefix}(${npm_runner})${arguments_before_double_dash}[[:space:]]+--${arguments_before_double_dash}[[:space:]]+${exempt_suite_config}"
exempt_suite_run="${vitest_exempt_suite_run}|${npm_exempt_suite_run}"

# The walk below tells four kinds of directory change apart. The first three
# start with cd or pushd, after any shell keyword (`{ cd /repo; npm test; }`,
# `then cd /repo`), so the path is the fourth group of their match.
# - cd_to_absolute_path matches an unquoted path that starts with /.
# - cd_to_quoted_absolute_path matches a quoted path that starts with / and
#   holds no $, backtick or ~, so the shell would use it as written.
# - cd_to_relative_path matches an unquoted relative path. Its first
#   character cannot be - (`cd -` or a flag), # (a comment, which leaves a
#   bare `cd`), or ~, $ or a quote, which only the shell can expand.
# - any_cd matches any cd, pushd or popd. The walk tries it last, so it
#   catches the rest: a bare `cd`, with or without a comment after it,
#   `cd -`, popd, and a ~, $ or quoted path the others do not take.
directory_change="^[[:space:]]*(${shell_keyword})*(cd|pushd)[[:space:]]+"
cd_to_absolute_path="${directory_change}(/[^[:space:]]*)"
cd_to_quoted_absolute_path="${directory_change}[\"'](/[^\"'\$\`~]*)[\"']"
cd_to_relative_path="${directory_change}([^-~#\"'\$[:space:]][^[:space:]]*)"
any_cd="^[[:space:]]*(${shell_keyword})*(cd|pushd|popd)([[:space:]]|$)"

# The command is split into the commands it runs, one per line, and only the
# cds and test runs the walk below acts on are kept.
# - A command starts at the start of a line, or after ;, &, |, ( or a
#   backtick. The ( also covers $( ).
# - tr maps each of the five characters to a line break, which SC2020 takes
#   for a word replacement. tr, not bash's ${//}, because bash's substitution
#   slows to seconds on a large multi-byte command.
# - grep drops the other commands in one pass. The walk's =~ tests take
#   seconds when they run on each line of a command thousands of lines long.
# - grep exits 1 when it keeps no line, so `|| true` stops set -e and
#   pipefail from ending the hook.
# shellcheck disable=SC2020
cd_or_test_commands="$(printf '%s\n' "${tool_command}" |
  tr ';&|(`' '\n\n\n\n\n' |
  grep -E "${any_cd}|${test_run}")" || true

# The walk checks each command on its own, so an exemption covers only its
# own command, and it tracks the folder the first stopped run runs in.
# - Two kinds of run are exempt.
#   - A run through setpriv never matches test_run, because setpriv is not
#     one of the wrappers above.
#   - Two suites have no permission tests and cannot run as nobody. Their
#     npm scripts never match test_run, and exempt_suite_run drops a run with
#     either suite's config.
#     - remote-boot needs the Docker socket, which nobody cannot open.
#     - cli-pty starts the CLI with npx from a temp folder, so npx downloads
#       tsx into nobody's empty npm cache. Cloud sessions reach the npm
#       registry through a proxy whose CA bundle sits under /root, where
#       nobody cannot read it, so that download fails.
# - The run's folder starts as the session's folder, the first of these that
#   is set: the payload's cwd, CLAUDE_PROJECT_DIR (which Claude Code sets to
#   the project root), and `.`. Claude Code runs the hook in the session's
#   current folder, so `.` and any path built on it resolve against that
#   folder.
#   - Each `cd` or `pushd` before the run moves it: to an absolute path,
#     unquoted or quoted as written (`git pull && cd /other/checkout && npm
#     test`), or relative to the folder so far for an unquoted relative path
#     (`cd /other/checkout && cd src`). For any other cd, and for popd, the
#     session's folder stands in for the target, which the hook does not
#     resolve. A cd after the run does not count.
#   - npm's --prefix folder is not followed: `npm --prefix /other/checkout
#     test` counts as `npm test`.
session_dir="${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}"
run_dir="${session_dir}"
current_dir="${session_dir}"

# root_test_runs collects the stopped runs' commands, one per line, so the
# coverage hint at the end can look for a coverage run among them.
root_test_runs=""
while IFS= read -r split_command; do
  if [[ "${split_command}" =~ ${cd_to_absolute_path} ]]; then
    current_dir="${BASH_REMATCH[4]}"
    continue
  fi
  if [[ "${split_command}" =~ ${cd_to_quoted_absolute_path} ]]; then
    current_dir="${BASH_REMATCH[4]}"
    continue
  fi
  if [[ "${split_command}" =~ ${cd_to_relative_path} ]]; then
    current_dir="${current_dir}/${BASH_REMATCH[4]}"
    continue
  fi
  if [[ "${split_command}" =~ ${any_cd} ]]; then
    current_dir="${session_dir}"
    continue
  fi

  # Every line left is a test run, except the one empty line the here-string
  # passes when grep kept no line.
  [[ "${split_command}" =~ ${test_run} ]] || continue

  if [[ "${split_command}" =~ ${exempt_suite_run} ]]; then
    continue
  fi

  if [[ -z "${root_test_runs}" ]]; then
    run_dir="${current_dir}"
  fi
  root_test_runs+="${split_command}"$'\n'
done <<<"${cd_or_test_commands}"

if [[ -z "${root_test_runs}" ]]; then
  exit 0
fi

# The hook prepares the checkout that holds the run's folder.
# - When the run's folder is in no checkout, the session's folder's checkout
#   stands in, and the run is still stopped rather than let through as root.
# - When neither folder is in a checkout, there are no folders to prepare,
#   and the run is let through.
checkout="$(git -C "${run_dir}" rev-parse --show-toplevel 2>/dev/null ||
  git -C "${session_dir}" rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Without node_modules there is nothing to run yet. A folder made under
# node_modules here would also stop the install: install-deps.sh skips npm ci
# in a checkout that has a node_modules folder it did not install.
if [[ ! -d "${checkout}/node_modules" ]]; then
  exit 0
fi

nobody_uid="$(id -u nobody)"
nobody_gid="$(id -g nobody)"

# The prefix runs whichever node nobody finds on PATH. nobody cannot read
# root's home, where nvm installs Node, so that node can be another version
# than the .nvmrc one CI runs, or missing. Without one there is no command to
# offer, so the run goes through, as it does without setpriv or a nobody user.
nobody_node_version="$(setpriv --reuid="${nobody_uid}" --regid="${nobody_gid}" --clear-groups node --version 2>/dev/null)" || nobody_node_version=""

if [[ -z "${nobody_node_version}" ]]; then
  exit 0
fi

# A test run writes in these folders: vitest's caches under node_modules, a
# fake HOME that keeps npm's cache and logs out of root's home, and coverage/
# for test:coverage's report (gitignored).
nobody_writable=(
  "${checkout}/node_modules/.vite-temp"
  "${checkout}/node_modules/.vitest"
  "${checkout}/node_modules/.nobody-home"
  "${checkout}/coverage"
)
mkdir -p "${nobody_writable[@]}"

# snapshot:update rewrites the tool-surface baseline in this folder, the only
# snapshot folder in the repo. git tracks neither owner nor write bits, so the
# changes below add nothing to a diff.
snapshots_dir="${checkout}/src/vault-mcp/mcp-core/__tests__/__snapshots__"

if [[ -d "${snapshots_dir}" ]]; then
  nobody_writable+=("${snapshots_dir}")
fi

# The folders go to nobody and are not writable by group or other users,
# because vitest runs code from its caches and checks test output against the
# snapshots. Both commands recurse, so the files a root run left inside also
# go to nobody and lose group and other write access.
chown -R "${nobody_uid}:${nobody_gid}" "${nobody_writable[@]}"
chmod -R go-w "${nobody_writable[@]}"

# %q quotes the HOME path for the shell, so the prefix still works when the
# checkout's path holds a space. A path of plain characters prints unchanged.
printf -v nobody_home_for_shell '%q' "${checkout}/node_modules/.nobody-home"

cat >&2 <<EOF
Tests do not run as root in this repo: root reads the files the permission tests make unreadable, so those tests fail here but pass in CI.
Run the same test command as the nobody user, with this prefix in front of the test command itself (after any cd):
  setpriv --reuid=${nobody_uid} --regid=${nobody_gid} --clear-groups env HOME=${nobody_home_for_shell}
The folders nobody needs to write in ${checkout} are ready.
EOF

# The major versions are compared only when .nvmrc names a number (24 or
# v24.1.0), not an alias such as lts/*. Only the file's first word counts, so
# a CRLF line end or a comment after the version does not hide it.
nvmrc_version="$(cat "${checkout}/.nvmrc" 2>/dev/null)" || nvmrc_version=""
nvmrc_version="${nvmrc_version%%[[:space:]]*}"
nvmrc_major="${nvmrc_version#v}"
nvmrc_major="${nvmrc_major%%.*}"
nobody_node_major="${nobody_node_version#v}"
nobody_node_major="${nobody_node_major%%.*}"

if [[ "${nvmrc_major}" =~ ^[0-9]+$ && "${nobody_node_major}" != "${nvmrc_major}" ]]; then
  echo "nobody's node is ${nobody_node_version}, not the ${nvmrc_version} that .nvmrc names and CI runs, so a result can differ from CI's." >&2
fi

# vitest deletes coverage/ before a coverage run, and deleting it needs write
# access to the checkout root, so the run must keep the folder instead.
if [[ "${root_test_runs}" == *test:coverage* || "${root_test_runs}" == *--coverage* ]]; then
  echo "For a coverage run, also pass --coverage.clean=false (after -- for npm run): vitest otherwise deletes coverage/ first, which nobody cannot do in a root-owned checkout." >&2
fi

exit 2
