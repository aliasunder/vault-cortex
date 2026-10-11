#!/usr/bin/env bash
# Stops a test run in a root session and replies with the setpriv prefix that
# runs the same command as the nobody user. Root ignores file permissions, so a
# test that chmods a file or folder to deny access, then expects the access to
# fail, breaks as root, while CI, which runs as a normal user, passes it.
# - Claude Code's cloud sessions run as root. In a non-root session the hook
#   exits at its first check, so it costs nothing on a developer machine.
# - Before replying, it makes the folders a test run writes in the checkout
#   writable for nobody.
# - The prefix it offers matches CI where it can. When nobody's own node has
#   another major version than .nvmrc names, the prefix runs a copy of root's
#   node of that major. When nobody cannot read the file NODE_EXTRA_CA_CERTS
#   names, the prefix unsets the variable.
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
# - bash, sh and zsh with their flags, where a group of one-letter flags that
#   holds o or O takes an argument (`bash -euo pipefail -c`,
#   `bash -O extglob -c`), then the opening quote of the command they run and
#   any spaces after it (`bash -lc 'npm test'`). The split below ignores
#   quotes, so a run or a cd after ; or && inside the quoted text counts too
#   (`bash -c 'npm ci && cd /repo && npm test'`), and a mention there
#   (`bash -c 'echo npm test'`) does not.
# - Each of env, time, timeout and the shells may be named by path
#   (`/usr/bin/env npm test`), as the reply's own prefix names env. exec and
#   command are shell builtins, so they have no path.
# setpriv is not a wrapper here: a run through setpriv is the nobody run the
# reply asks for, so the runner after it never counts.
optional_command_folder='([^[:space:]]*/)?'
timeout_wrapper="${optional_command_folder}timeout${flags_with_optional_argument}[[:space:]]+[0-9][^[:space:]]*"
shell_flags='([[:space:]]+([-+][[:alpha:]]*[oO][[:alpha:]]*[[:space:]]+[^[:space:]]+|[-+][^[:space:]]*))*'
shell_wrapper="${optional_command_folder}(bash|sh|zsh)${shell_flags}[[:space:]]+([\"'][[:space:]]*)?"
wrapper="(${optional_command_folder}(env|time)${flags_without_argument}|exec|command|${timeout_wrapper})[[:space:]]+|${shell_wrapper}"

# shell_keyword matches a shell keyword a command can follow: if
# (`if npm test`), then, do, else, elif, while, until, ! (`! npm test`) and {
# (`{ npm test; }`).
shell_keyword='(if|then|do|else|elif|while|until|!|\{)[[:space:]]+'

command_prefix="(${wrapper}|${shell_keyword}|${variable_setting})*"

# The runner ends at a space, a ), the end of its command, or a closing quote
# followed only by spaces and then a redirection (`bash -c 'npm test' 2>`), a
# ) (`$(bash -c 'npm test')`), a comment or the end. So `npm run testx` and
# `npm run test:cli-pty` are not runs, and neither is the `vitest' src/` that
# `grep -E 'npm test|vitest' src/` splits into. Inside the double quotes,
# `\\)` reaches the regex as `\)`, a literal ).
runner_end="([[:space:]]|\\)|[\"'][[:space:]]*([0-9]*[<>]|\\)|$)|[\"'][[:space:]]+#|$)"

# A command that runs tests starts with the runner, after any prefix. A
# mention elsewhere, as in `grep vitest package.json`, is not a run.
test_run="^[[:space:]]*${command_prefix}(${test_runner})${runner_end}"

# exempt_suite_run matches a run of the remote-boot or cli-pty suite, the two
# exempt suites, by the config flag that names the suite's config file, with
# or without quotes around the name. The file name must end where a runner
# ends, so `vitest.cli-pty.config.ts.bak` does not count.
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
exempt_suite_config="(-c|--config)(=|[[:space:]]+)[\"']?([^[:space:]\"']*/)?vitest\.(remote-boot|cli-pty)\.config\.ts[\"']?${runner_end}"
arguments_before_double_dash='([[:space:]]+(-|-?[^-[:space:]][^[:space:]]*|--[^[:space:]]+))*'
vitest_exempt_suite_run="^[[:space:]]*${command_prefix}(${vitest_runner})${arguments_before_double_dash}[[:space:]]+${exempt_suite_config}"
npm_exempt_suite_run="^[[:space:]]*${command_prefix}(${npm_runner})${arguments_before_double_dash}[[:space:]]+--${arguments_before_double_dash}[[:space:]]+${exempt_suite_config}"
exempt_suite_run="${vitest_exempt_suite_run}|${npm_exempt_suite_run}"

# The walk below tells four kinds of directory change apart. The same prefix
# a test run may carry (a wrapper, a shell keyword, a VAR=value setting:
# `{ cd /repo; npm test; }`, `then cd /repo`, `env bash -c 'cd /repo && npm
# test'`) is cut off first, with leading_command_prefix, so the first three
# patterns start at cd or pushd and the path is the second group of their
# match. any_cd accepts that prefix itself for the grep below.
# - cd_to_absolute_path matches an unquoted path that starts with /.
# - cd_to_quoted_absolute_path matches a quoted path that starts with / and
#   holds no $, backtick or ~, so the shell would use it as written.
# - cd_to_relative_path matches an unquoted relative path. Its first
#   character cannot be - (`cd -` or a flag), # (a comment, which leaves a
#   bare `cd`), or ~, $ or a quote, which only the shell can expand.
# - any_cd matches any cd, pushd or popd. The walk tries it last, so it
#   catches the rest: a bare `cd`, with or without a comment after it,
#   `cd -`, popd, and a ~, $ or quoted path the others do not take.
directory_change="^[[:space:]]*(cd|pushd)[[:space:]]+"
cd_to_absolute_path="${directory_change}(/[^[:space:]]*)"
cd_to_quoted_absolute_path="${directory_change}[\"'](/[^\"'\$\`~]*)[\"']"
cd_to_relative_path="${directory_change}([^-~#\"'\$[:space:]][^[:space:]]*)"
leading_command_prefix="^[[:space:]]*${command_prefix}"
any_cd="^[[:space:]]*${command_prefix}(cd|pushd|popd)([[:space:]]|$)"

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
#   - A cd after env, exec or timeout moves it too, though the shell's folder
#     stays put: those commands run a program, and cd is a shell builtin.
#   - npm's --prefix folder is not followed: `npm --prefix /other/checkout
#     test` counts as `npm test`.
session_dir="${payload_cwd:-${CLAUDE_PROJECT_DIR:-.}}"
run_dir="${session_dir}"
current_dir="${session_dir}"

# root_test_runs collects the stopped runs' commands, one per line, so the
# coverage hint at the end can look for a coverage run among them.
root_test_runs=""
while IFS= read -r split_command; do
  cd_candidate="${split_command}"
  if [[ "${split_command}" =~ ${leading_command_prefix} ]]; then
    # Keep the text after the matched prefix: ${var:offset} starts at the
    # match's length.
    cd_candidate="${split_command:${#BASH_REMATCH[0]}}"
  fi
  if [[ "${cd_candidate}" =~ ${cd_to_absolute_path} ]]; then
    current_dir="${BASH_REMATCH[2]}"
    continue
  fi
  if [[ "${cd_candidate}" =~ ${cd_to_quoted_absolute_path} ]]; then
    current_dir="${BASH_REMATCH[2]}"
    continue
  fi
  if [[ "${cd_candidate}" =~ ${cd_to_relative_path} ]]; then
    current_dir="${current_dir}/${BASH_REMATCH[2]}"
    continue
  fi
  if [[ "${cd_candidate}" =~ ${any_cd} ]]; then
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

# By default the prefix runs whichever node nobody finds on the session's
# PATH. nvm installs Node under root's home, which nobody cannot read, so
# nobody's node can be another version than the .nvmrc one CI runs, or
# missing.
# - With no node at all, nobody most likely has no npx either, because npx
#   installs beside node, and the node copy made below holds only node. There
#   is then no command to offer, so the run goes through, as it does without
#   setpriv or a nobody user.
# - The probe searches the PATH Claude Code gives the hook, and env searches
#   it as nobody, as the prefix's env does. setpriv keeps root's capabilities
#   until it starts its command, so a search by setpriv itself reaches a node
#   under root's home that nobody's runs cannot. /usr/bin/env is named in
#   full so setpriv searches no PATH.
nobody_node_version="$(setpriv --reuid="${nobody_uid}" --regid="${nobody_gid}" --clear-groups /usr/bin/env node --version 2>/dev/null)" || nobody_node_version=""

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

# snapshot:update rewrites the tool-surface baseline in this folder, the only
# snapshot folder in the repo. git tracks neither owner nor write bits, so the
# changes below add nothing to a diff.
snapshots_dir="${checkout}/src/vault-mcp/mcp-core/__tests__/__snapshots__"

if [[ -d "${snapshots_dir}" ]]; then
  nobody_writable+=("${snapshots_dir}")
fi

mkdir -p "${nobody_writable[@]}"

# The folders go to nobody and are not writable by group or other users,
# because vitest runs code from its caches and checks test output against the
# snapshots. Both commands recurse, so the files a root run left inside also
# go to nobody and lose group and other write access.
chown -R "${nobody_uid}:${nobody_gid}" "${nobody_writable[@]}"
chmod -R go-w "${nobody_writable[@]}"

# node_major_differs is true when .nvmrc names a number (24 or v24.1.0), not
# an alias such as lts/*, and nobody's node has another major version.
nvmrc_version="$(cat "${checkout}/.nvmrc" 2>/dev/null)" || nvmrc_version=""
# Cut the text at its first space, tab or line break, so a CRLF line end or a
# comment after the version does not hide it.
nvmrc_version="${nvmrc_version%%[[:space:]]*}"
nvmrc_major="${nvmrc_version#v}"
nvmrc_major="${nvmrc_major%%.*}"
nobody_node_major="${nobody_node_version#v}"
nobody_node_major="${nobody_node_major%%.*}"
node_major_differs=false

if [[ "${nvmrc_major}" =~ ^[0-9]+$ && "${nobody_node_major}" != "${nvmrc_major}" ]]; then
  node_major_differs=true
fi

# When node_major_differs, the prefix runs a copy of a node root has
# installed whose major version .nvmrc names. nobody cannot run the original,
# because nvm installs it under root's home.
# - The hook checks its own node first. Claude Code starts hooks with its own
#   PATH, not the session's, so in a cloud container that node is often the
#   container's. The hook then looks where nvm keeps its versions ($NVM_DIR,
#   then ~/.nvm, often the same folder) and takes the newest of that major in
#   the first folder that has one.
# - The copy sits in a folder named by version, so a later run reuses it and a
#   different version gets its own folder. cp -L copies the binary a symlink
#   points to.
# - The folder stays root's, outside the folders handed to nobody: root never
#   writes where nobody could plant a symlink, and nobody can run the copy but
#   not replace it.
# - The prefix puts the copy's folder first on PATH. nobody's runs then find
#   the copy, and so do the npx and tsx scripts a run starts, whose
#   `#!/usr/bin/env node` lines look node up on PATH. npx and npm themselves
#   still come from the session's PATH.
nobody_node_dir=""

if [[ "${node_major_differs}" == true ]]; then
  nvmrc_node_path=""
  nvmrc_node_version=""
  hook_node_version="$(node --version 2>/dev/null)" || hook_node_version=""
  hook_node_major="${hook_node_version#v}"
  hook_node_major="${hook_node_major%%.*}"

  if [[ "${hook_node_major}" == "${nvmrc_major}" ]]; then
    # node names the binary it runs from. The node on PATH can be a version
    # manager's shim (asdf, mise, volta) that starts it, and a copy of the
    # shim fails as nobody, who cannot read the version manager's files.
    nvmrc_node_path="$(node -p process.execPath 2>/dev/null)" || nvmrc_node_path=""
    nvmrc_node_version="${hook_node_version}"
  else
    for nvm_dir in "${NVM_DIR:-}" "${HOME}/.nvm"; do
      [[ -n "${nvm_dir}" && -d "${nvm_dir}/versions/node" ]] || continue
      # nvm keeps each node three folders below versions/node, in a folder
      # named by its version: <nvm_dir>/versions/node/v24.11.0/bin/node.
      # find runs from inside versions/node, so -path sees only those three
      # folders: a v24. elsewhere in the nvm folder's own path cannot match.
      # sort -V orders v24.9.0 before v24.10.0, so the last line is the newest.
      # -L enters a versions/node or version folder that is a symlink.
      # find exits non-zero on a folder it cannot read or a symlink loop that
      # -L walks into, while still listing the nodes it reached, so || true
      # keeps that list rather than let set -e end the hook, which would let
      # the run through as root.
      newest_node="$(cd "${nvm_dir}/versions/node" && find -L . -mindepth 3 -maxdepth 3 -path "./v${nvmrc_major}.*/bin/node" 2>/dev/null | sort -V | tail -n 1)" || true
      [[ -n "${newest_node}" ]] || continue
      nvmrc_node_path="${nvm_dir}/versions/node/${newest_node#./}"
      nvmrc_node_version="$(basename "$(dirname "$(dirname "${nvmrc_node_path}")")")"
      break
    done
  fi

  if [[ -n "${nvmrc_node_path}" ]]; then
    node_copies_dir="${checkout}/node_modules/.nobody-node"
    nobody_node_dir="${node_copies_dir}/node-${nvmrc_node_version}"

    # A node already at this name is reused. Only the mv below puts one
    # there, so it is a whole copy.
    if [[ ! -x "${nobody_node_dir}/node" ]]; then
      mkdir -p "${nobody_node_dir}"
      # 755 whatever root's umask, so nobody can reach and run the copy.
      chmod 755 "${node_copies_dir}" "${nobody_node_dir}"
      # cp makes its file executable before writing it, so a copy cut short by
      # the hook's timeout, or one a concurrent hook is still writing, would
      # pass the -x check above. The copy gets a temporary name, and mv's
      # rename puts only a whole binary at the name later runs reuse.
      # A failed cp (a full disk) ends the hook as set -e would, after
      # removing its partial file, which would otherwise hold the space.
      cp -L "${nvmrc_node_path}" "${nobody_node_dir}/node.$$" || {
        rm -f "${nobody_node_dir}/node.$$"
        exit 1
      }
      chmod 755 "${nobody_node_dir}/node.$$"
      mv -f "${nobody_node_dir}/node.$$" "${nobody_node_dir}/node"
    fi
  fi
fi

# %q quotes the HOME path for the shell, so the prefix still works when the
# checkout's path holds a space. A path of plain characters prints unchanged.
printf -v nobody_home_for_shell '%q' "${checkout}/node_modules/.nobody-home"

# env's arguments, joined with spaces in the reply. The -u option goes first,
# because env reads options only before its first NAME=value setting.
env_arguments=()

# Claude Code's cloud containers point NODE_EXTRA_CA_CERTS at a file under
# root's home. Every node nobody starts then prints a warning that it cannot
# read the file, which breaks tests that check a child process's exact stderr.
# The suites this prefix runs make no network calls, so the prefix unsets the
# variable.
# - /bin/sh is named in full so setpriv searches no PATH.
# - The script's $1 is single-quoted on purpose: the inner shell expands it,
#   not this one. The `sh` after the script is the inner shell's $0, so the
#   file's path lands in $1.
# shellcheck disable=SC2016
if [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]] &&
  ! setpriv --reuid="${nobody_uid}" --regid="${nobody_gid}" --clear-groups /bin/sh -c 'test -r "$1"' sh "${NODE_EXTRA_CA_CERTS}"; then
  env_arguments+=(-u NODE_EXTRA_CA_CERTS)
fi

env_arguments+=("HOME=${nobody_home_for_shell}")

# $PATH stays literal, so the shell running the prefix expands it to the
# session's PATH, which env searches after the copy's folder. A folder there
# that nobody cannot read is skipped.
# - The double quotes keep that PATH one argument when a folder in it holds a
#   space, as Windows folders on WSL's PATH do. Unquoted, the shell would
#   split it, and env would take the text after the space as its command.
if [[ -n "${nobody_node_dir}" ]]; then
  printf -v nobody_node_dir_for_shell '%q' "${nobody_node_dir}"
  env_arguments+=("PATH=${nobody_node_dir_for_shell}:\"\$PATH\"")
fi

# The prefix names /usr/bin/env in full for the reason the probe above does:
# setpriv still has root's capabilities when it searches PATH, so a bare env
# could resolve to one nobody's own search would never reach.
cat >&2 <<EOF
Tests do not run as root in this repo: root reads the files the permission tests make unreadable, so those tests fail here but pass in CI.
Run the same test command as the nobody user, with this prefix in front of the test command itself (after any cd):
  setpriv --reuid=${nobody_uid} --regid=${nobody_gid} --clear-groups /usr/bin/env ${env_arguments[*]}
The folders nobody needs to write in ${checkout} are ready.
EOF

if [[ -n "${nobody_node_dir}" ]]; then
  echo "nobody's own node is ${nobody_node_version}, so the prefix runs a copy of node ${nvmrc_node_version}, whose major version .nvmrc names and CI runs." >&2
elif [[ "${node_major_differs}" == true ]]; then
  # The majors differ, but root has no node of the .nvmrc major to copy.
  echo "nobody's node is ${nobody_node_version}, not the ${nvmrc_version} that .nvmrc names and CI runs, so a result can differ from CI's." >&2
fi

# vitest deletes coverage/ before a coverage run, and deleting it needs write
# access to the checkout root, so the run must keep the folder instead.
if [[ "${root_test_runs}" == *test:coverage* || "${root_test_runs}" == *--coverage* ]]; then
  echo "For a coverage run, also pass --coverage.clean=false (after -- for npm run): vitest otherwise deletes coverage/ first, which nobody cannot do in a root-owned checkout." >&2
fi

exit 2
