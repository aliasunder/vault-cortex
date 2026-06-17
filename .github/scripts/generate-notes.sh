#!/usr/bin/env bash
# Generate structured release notes from conventional commits between two tags.
# Usage: generate-notes.sh <new-tag> [previous-tag]
# If previous-tag is omitted, uses the tag before new-tag.

set -euo pipefail

NEW_TAG="${1:?Usage: generate-notes.sh <new-tag> [previous-tag]}"
# --match restricts to server tags (v0.16.0) — without it, git describe
# would pick up cli-v* tags from CLI releases and truncate the range.
PREV_TAG="${2:-$(git describe --tags --abbrev=0 --match "v[0-9]*" "$NEW_TAG"^ 2>/dev/null || echo "")}"

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${NEW_TAG}"
else
  RANGE="$NEW_TAG"
fi

# Write one record per non-merge commit as `<subject>\x1f<body>`, records
# NUL-separated, to a temp file. The body is included so BREAKING CHANGE:
# footers are visible. A file (not a pipe) is used because the Python program
# is fed to `python3 -` on stdin via the heredoc — the data must come from
# elsewhere. Release commits are filtered out in Python.
NOTES_INPUT="$(mktemp)"
trap 'rm -f "$NOTES_INPUT"' EXIT
git log --no-merges --format='%s%x1f%b%x00' "$RANGE" > "$NOTES_INPUT"

python3 - "$NOTES_INPUT" << 'PYTHON'
import sys, re

with open(sys.argv[1], "rb") as fh:
    raw = fh.read().decode("utf-8", "replace")
records = [r for r in raw.split("\x00") if r.strip()]

# Category config: (prefix, heading)
categories = [
    ("feat", "Features"),
    ("fix", "Bug Fixes"),
    ("refactor", "Refactoring"),
    ("docs", "Documentation"),
    ("ci", "CI / Infrastructure"),
    ("eval", "Evals"),
    ("chore", "Maintenance"),
]
cat_map = {c[0]: c[1] for c in categories}
cat_order = [c[0] for c in categories]

buckets = {c[0]: [] for c in categories}
other = []
breaking = []

# Pattern: type(scope)!: description — scope and the breaking `!` are optional.
pat = re.compile(r'^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$')
# Release bump commits (server "release:" and CLI "release(cli):") are noise.
release_pat = re.compile(r'^release(\(cli\))?:')
# A BREAKING CHANGE footer — conventional commits allows a space or hyphen.
breaking_pat = re.compile(r'^BREAKING[ -]CHANGE:\s*(.+)$', re.MULTILINE)

for rec in records:
    subject, _, body = rec.partition("\x1f")
    subject = subject.strip()
    if not subject or release_pat.match(subject):
        continue

    m = pat.match(subject)
    footer = breaking_pat.search(body or "")
    is_breaking = bool((m and m.group(3)) or footer)

    if m:
        typ, scope, _, desc = m.group(1), m.group(2), m.group(3), m.group(4)
        desc = desc[0].upper() + desc[1:]  # capitalize
        entry = f"- **{scope}:** {desc}" if scope else f"- {desc}"
        (buckets[typ] if typ in buckets else other).append(entry)
    else:
        desc = subject[0].upper() + subject[1:] if subject else subject
        other.append(f"- {desc}")

    if is_breaking:
        # Prefer the footer's explanatory text; fall back to the subject desc.
        breaking.append(f"- {footer.group(1).strip() if footer else desc}")

# Output — BREAKING CHANGES lead so they're impossible to miss.
out = []
if breaking:
    out += ["### ⚠ BREAKING CHANGES", ""] + breaking

for typ in cat_order:
    if buckets[typ]:
        if out:
            out.append("")
        out += [f"### {cat_map[typ]}", ""] + buckets[typ]

if other:
    if out:
        out.append("")
    out += ["### Other Changes", ""] + other

print("\n".join(out) if out else "No notable changes.")
PYTHON
