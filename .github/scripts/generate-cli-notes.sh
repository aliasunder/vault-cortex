#!/usr/bin/env bash
# List the commits between two CLI tags that change what a CLI user gets, one
# `- <subject>` line each, newest first.
# Usage: generate-cli-notes.sh <new-tag> [previous-tag]
# If previous-tag is omitted, uses the CLI tag before new-tag; with no earlier
# CLI tag, lists every commit reachable from new-tag.
#
# A commit is listed when its diff under cli/ adds or removes a line that none
# of these rules skips:
# - blank lines
# - lines in files under cli/src/__tests__/
# - the "version" line of cli/package.json (the release bump)
# - in .ts files, lines that start, after any indent, with #, //, /*, * or */;
#   the rule reads only how a line starts, so it skips comment lines, the .env
#   template's # lines in cli/src/env.ts (they stay comments in the .env the
#   CLI writes), and any code line that starts the same way
# In files other than .ts, cli/README.md included, every non-blank line
# counts: npm shows the README.

set -euo pipefail

NEW_TAG="${1:?Usage: generate-cli-notes.sh <new-tag> [previous-tag]}"
# --match restricts to CLI tags (cli-v0.16.0), so server tags (v0.55.0) never
# end the range. Any describe failure leaves PREV_TAG empty: that is meant for
# a new-tag with no earlier CLI tag, and a new-tag git cannot resolve stops the
# script at git log below.
PREV_TAG="${2:-$(git describe --tags --abbrev=0 --match "cli-v*" "$NEW_TAG"^ 2> /dev/null || echo "")}"

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${NEW_TAG}"
else
  RANGE="$NEW_TAG"
fi

# Exits 0 when the patch on stdin adds or removes a counted line.
has_counted_change() {
  awk '
    # The headers of a file come before its first @@ line, so a content line
    # such as "--- x" (a removed "-- x") is never read as a header.
    /^diff --git / { in_hunk = 0; path = ""; next }
    /^@@/ { in_hunk = 1; next }
    # - Git wraps a name holding special characters in quotes, and ends the
    #   header with a tab when the name holds a space.
    # - The /dev/null header of an added or deleted file fails the a/ or b/
    #   match, so path comes from the other header.
    !in_hunk && /^(---|\+\+\+) "?[ab]\// {
      path = $0
      sub(/^(---|\+\+\+) "?[ab]\//, "", path)
      sub(/"?\t?$/, "", path)
      next
    }
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

CLI_PATHSPEC=(cli/ ':(exclude)cli/src/__tests__/')

# Hex hashes only, so word splitting in the loop below is safe. Merge commits
# are left out: the commits they merge are listed on their own.
COMMIT_HASHES=$(git log --no-merges --format=%H "$RANGE" -- "${CLI_PATHSPEC[@]}")

for commit_hash in $COMMIT_HASHES; do
  # - --no-renames: a moved file shows as removed and re-added, so a move
  #   counts as a change.
  # - --text: a binary file prints its content as lines, so its change can
  #   count.
  # diff-tree is plumbing, so diff.noprefix and the prefix settings never
  # change the a/ and b/ headers has_counted_change reads.
  PATCH=$(git diff-tree -p --root --no-commit-id --no-renames --text -U0 \
    "$commit_hash" -- "${CLI_PATHSPEC[@]}")
  if has_counted_change <<< "$PATCH"; then
    git show -s --format='- %s' "$commit_hash"
  fi
done
