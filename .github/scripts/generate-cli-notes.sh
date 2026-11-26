#!/usr/bin/env bash
# List the commits since the previous CLI tag that change what a CLI user gets,
# one `- <subject>` line each, newest first. When a listed commit is marked
# breaking, a ⚠ BREAKING CHANGES section comes first and the list follows
# under a Changes heading.
# Usage: generate-cli-notes.sh <new-tag>
#
# A commit is listed when its diff under cli/ adds or removes a line that none
# of these rules skips:
# - blank lines
# - lines in files under any __tests__/ folder in cli/src/
# - the "version" line of cli/package.json (the release bump)
# - in .ts files, lines that start, after any indent, with #, //, /* or *:
#   comments, and the comment text of the .env templates in
#   cli/src/rules/env-templates.ts.
#   A # line shaped like a setting (# KEY=value) still counts: the templates
#   ship optional settings commented out, for the user to uncomment.
#
# A listed commit is breaking when it carries any of these marks:
# - a ! after the type and scope in its subject (feat(cli)!: ...)
# - a BREAKING CHANGE: or BREAKING-CHANGE: footer in its body
# - the same footer in its merged PR's body, or a breaking-change PR label
# Its line takes the PR footer's text, else the commit footer's, else the
# subject. PR lookups need both the gh binary and GH_TOKEN, and a failed lookup
# warns on stderr and falls back to the commit's own marks. generate-notes.sh
# applies the same rule to the server notes, so change both scripts together.

set -euo pipefail

NEW_TAG="${1:?Usage: generate-cli-notes.sh <new-tag>}"
# --match keeps server tags (v0.55.0) out. With no earlier CLI tag, the range
# is every commit reachable from new-tag.
PREV_TAG=$(git describe --tags --abbrev=0 --match "cli-v*" "$NEW_TAG"^ 2> /dev/null || echo "")

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${NEW_TAG}"
else
  RANGE="$NEW_TAG"
fi

# Exits 0 when the patch on stdin adds or removes a counted line, and
# NO_COUNTED_LINE when it does not. awk exits 2 on its own errors, so the code
# for "no counted line" differs from it, and any other code stops the script
# instead of reading as a commit with nothing to list.
NO_COUNTED_LINE=3
has_counted_change() {
  awk -v no_counted_line="$NO_COUNTED_LINE" '
    # A file header comes before its first @@ line, so a content line such as
    # "--- x" (a removed "-- x") is never read as a header.
    /^diff --git / { in_hunk = 0; path = ""; next }
    /^@@/ { in_hunk = 1; next }
    # Git quotes a name holding special characters and ends the header with a
    # tab when the name holds a space. A /dev/null header (an added or deleted
    # file) fails the match, so path comes from the other header.
    !in_hunk && /^(---|\+\+\+) "?[ab]\// {
      path = $0
      sub(/^(---|\+\+\+) "?[ab]\//, "", path)
      sub(/"?\t?$/, "", path)
      next
    }
    !in_hunk { next }
    /^[+-]/ {
      content = substr($0, 2)
      if (content ~ /^[ \t\r]*$/) next
      if (path == "cli/package.json" && content ~ /^[ \t]*"version"[ \t]*:/) next
      # Before the # skip below, so a commented-out setting (# KEY=value) counts.
      if (path ~ /\.ts$/ && content ~ /^[ \t]*#[ \t]*[A-Z][A-Z0-9_]*=/) { found = 1; exit }
      if (path ~ /\.ts$/ && content ~ /^[ \t]*(#|\/\/|\/\*|\*)/) next
      found = 1
      exit
    }
    END { exit found ? 0 : no_counted_line }
  '
}

# The glob form excludes every __tests__ folder under cli/src/, at any depth.
CLI_PATHSPEC=(cli/ ':(exclude,glob)cli/src/**/__tests__/**')

# Hex hashes only, so word splitting in the loop below is safe. Merge commits
# are skipped: the commits a merge brings in are checked on their own.
COMMIT_HASHES=$(git log --no-merges --format=%H "$RANGE" -- "${CLI_PATHSPEC[@]}")

LISTED_HASHES=()
for commit_hash in $COMMIT_HASHES; do
  PATCH=$(git diff-tree -p --root --no-commit-id -U0 "$commit_hash" -- "${CLI_PATHSPEC[@]}")
  classify_status=0
  has_counted_change <<< "$PATCH" || classify_status=$?
  if [ "$classify_status" -eq "$NO_COUNTED_LINE" ]; then
    continue
  fi
  if [ "$classify_status" -ne 0 ]; then
    echo "generate-cli-notes: could not classify $commit_hash" >&2
    exit 1
  fi
  LISTED_HASHES+=("$commit_hash")
done

# With no listed commit the notes are empty. The check comes before python3,
# because bash before 4.4 treats an empty array as unset under set -u.
if [ "${#LISTED_HASHES[@]}" -eq 0 ]; then
  exit 0
fi

python3 - "${LISTED_HASHES[@]}" << 'PYTHON'
import json, os, re, shutil, subprocess, sys

# One record per commit, in the order given (newest first), as
# `<subject>\x1f<body>`, records NUL-separated. git writes its own errors to
# stderr.
log_result = subprocess.run(
    ["git", "log", "--no-walk=unsorted", "--format=%s%x1f%b%x00", *sys.argv[1:]],
    stdout=subprocess.PIPE, encoding="utf-8", errors="replace",
)
if log_result.returncode != 0:
    sys.exit(log_result.returncode)
# The text after the last NUL is the newline that ends git log's output.
records = log_result.stdout.split("\x00")[:-1]

# Pattern: type(scope)!: description — scope and the breaking `!` are optional.
subject_pat = re.compile(
    r'^(?P<type>[a-z]+)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?:\s+(?P<description>.+)$'
)
# A BREAKING CHANGE footer — conventional commits allows a space or hyphen.
breaking_pat = re.compile(r'^BREAKING[ -]CHANGE:\s*(.+)$', re.MULTILINE)
# Squash subjects end with the PR number, e.g. "… (#142)".
pr_pat = re.compile(r'\(#(\d+)\)\s*$')

# PR lookups need both the `gh` binary and a token. CI passes GH_TOKEN; a local
# run without it skips lookups and falls back to commit-only signals instead of
# firing unauthenticated calls.
GH = shutil.which("gh") if os.environ.get("GH_TOKEN") else None
# Set by GitHub Actions. A local run leaves it empty, and `gh` then uses the
# checkout's own remote.
REPO = os.environ.get("GITHUB_REPOSITORY", "")
BREAKING_LABEL = "breaking-change"
_pr_cache = {}

def warn(message):
    print(f"generate-cli-notes: {message}", file=sys.stderr)

def pr_info(pr_number):
    """Return {labels, body} for a merged PR via `gh`, or None when lookups are
    disabled (no `gh`/token) or the lookup fails. A failed lookup warns on
    stderr — a silent None could drop a breaking change that lives only in the
    PR body/label from the release notes."""
    if not GH:
        return None
    if pr_number in _pr_cache:
        return _pr_cache[pr_number]
    info = None
    try:
        repo_args = ["-R", REPO] if REPO else []
        result = subprocess.run(
            [GH, "pr", "view", pr_number, *repo_args, "--json", "labels,body"],
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            info = {
                "labels": {label["name"] for label in data.get("labels", [])},
                "body": data.get("body") or "",
            }
        else:
            warn(f"gh pr view #{pr_number} failed (exit {result.returncode}): "
                 f"{result.stderr.strip()} — falling back to commit-only signals")
    except Exception as error:
        warn(f"gh pr view #{pr_number} errored: {error} — "
             f"falling back to commit-only signals")
    _pr_cache[pr_number] = info
    return info

change_lines = []
breaking = []
for record in records:
    subject, _, body = record.partition("\x1f")
    # Every record after the first starts with the newline git log writes after
    # each NUL terminator.
    subject = subject.lstrip("\n")
    change_lines.append(f"- {subject}")

    match = subject_pat.match(subject)
    pr_match = pr_pat.search(subject)
    pr = pr_info(pr_match.group(1)) if pr_match else None

    # Breaking signals, in preference order for the descriptive line:
    #   PR body footer > commit body footer > subject (when only `!`/label flags).
    commit_footer = breaking_pat.search(body)
    pr_footer = breaking_pat.search(pr["body"]) if pr else None
    has_label = bool(pr and BREAKING_LABEL in pr["labels"])
    has_breaking_marker = bool(match and match["breaking"])
    if has_breaking_marker or commit_footer or pr_footer or has_label:
        if pr_footer:
            note = pr_footer.group(1).strip()
        elif commit_footer:
            note = commit_footer.group(1).strip()
        else:
            note = subject
        breaking.append(f"- {note}")

# Collapse identical breaking lines. A follow-up PR (a docs PR documenting the
# change, or a revert) can carry the same BREAKING CHANGE footer that another PR
# in the range already contributed. dict.fromkeys preserves first-seen order.
breaking = list(dict.fromkeys(breaking))

output_lines = []
if breaking:
    output_lines += ["### ⚠ BREAKING CHANGES", "", *breaking, "", "### Changes", ""]
output_lines += change_lines
print("\n".join(output_lines))
PYTHON
