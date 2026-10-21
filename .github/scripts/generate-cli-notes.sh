#!/usr/bin/env bash
# List the commits between two CLI tags that change what a CLI user gets, one
# `- <subject>` line each, newest first.
# Usage: generate-cli-notes.sh <new-tag> [previous-tag]
# If previous-tag is omitted, uses the CLI tag before new-tag; with no earlier
# CLI tag, lists every commit reachable from new-tag.
#
# A commit is listed when its diff under cli/ adds or removes at least one line
# that is not blank and not a comment. Not counted:
# - files under cli/src/__tests__/
# - the "version" line of cli/package.json (the release bump)
# - in .ts files, lines starting with #, //, /*, * or */ (the # lines are the
#   .env template text in cli/src/env.ts)
# Every other non-blank line counts, cli/README.md included: npm shows it.

set -euo pipefail

NEW_TAG="${1:?Usage: generate-cli-notes.sh <new-tag> [previous-tag]}"
# --match restricts to CLI tags (cli-v0.16.0), so server tags (v0.55.0) never
# end the range.
PREV_TAG="${2:-$(git describe --tags --abbrev=0 --match "cli-v*" "$NEW_TAG"^ 2> /dev/null || echo "")}"

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${NEW_TAG}"
else
  RANGE="$NEW_TAG"
fi

# Exits 0 when the patch on stdin adds or removes a counted line. Headers come
# before a file's first @@ line, so a content line such as "--- x" (a removed
# "-- x") is never read as a header.
has_counted_change() {
  awk '
    /^diff --git / { in_hunk = 0; next }
    /^@@/ { in_hunk = 1; next }
    !in_hunk && /^--- a\// { path = substr($0, 7); next }
    !in_hunk && /^\+\+\+ b\// { path = substr($0, 7); next }
    !in_hunk { next }
    /^[+-]/ {
      content = substr($0, 2)
      if (content ~ /^[ \t]*$/) next
      if (path == "cli/package.json" && content ~ /^[ \t]*"version"[ \t]*:/) next
      if (path ~ /\.ts$/ && content ~ /^[ \t]*(#|\/\/|\/\*|\*)/) next
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  '
}

# Hex hashes only, so word splitting in the loop below is safe.
COMMIT_HASHES=$(git log --no-merges --format=%H "$RANGE" -- cli/)

for commit_hash in $COMMIT_HASHES; do
  # Fixed prefixes keep the header match independent of diff.noprefix and
  # diff.mnemonicPrefix; --text keeps a binary change countable.
  PATCH=$(git diff-tree -p --root --no-commit-id --no-renames --text -U0 \
    --src-prefix=a/ --dst-prefix=b/ "$commit_hash" -- cli/ ':(exclude)cli/src/__tests__/')
  if has_counted_change <<< "$PATCH"; then
    git show -s --format='- %s' "$commit_hash"
  fi
done
