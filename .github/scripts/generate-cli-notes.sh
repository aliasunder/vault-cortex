#!/usr/bin/env bash
# List the commits since the previous CLI tag that change what a CLI user gets,
# one `- <subject>` line each, newest first.
# Usage: generate-cli-notes.sh <new-tag>
#
# A commit is listed when its diff under cli/ adds or removes a line that none
# of these rules skips:
# - blank lines
# - lines in files under cli/src/__tests__/
# - the "version" line of cli/package.json (the release bump)
# - in .ts files, lines that start, after any indent, with #, //, /* or *:
#   comments, and the comment text of the .env templates in cli/src/env.ts.
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

# Exits 0 when the patch on stdin adds or removes a counted line.
has_counted_change() {
  awk '
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
    END { exit found ? 0 : 1 }
  '
}

CLI_PATHSPEC=(cli/ ':(exclude)cli/src/__tests__/')

# Hex hashes only, so word splitting in the loop below is safe. Merge commits
# are skipped: the commits a merge brings in are checked on their own.
COMMIT_HASHES=$(git log --no-merges --format=%H "$RANGE" -- "${CLI_PATHSPEC[@]}")

for commit_hash in $COMMIT_HASHES; do
  PATCH=$(git diff-tree -p --root --no-commit-id -U0 "$commit_hash" -- "${CLI_PATHSPEC[@]}")
  if has_counted_change <<< "$PATCH"; then
    git show -s --format='- %s' "$commit_hash"
  fi
done
