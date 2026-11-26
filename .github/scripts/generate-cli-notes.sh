#!/usr/bin/env bash
# List the commits since the previous CLI tag that change what a CLI user gets,
# one `- <subject>` line each, newest first.
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
  git show -s --format='- %s' "$commit_hash"
done
