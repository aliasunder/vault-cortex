#!/usr/bin/env bash
# Update CHANGELOG.md with release notes for a given version.
# Usage: update-changelog.sh <version> <notes-file>
# The entry goes above the newest version entry, replacing an [Unreleased]
# section if there is one.

set -euo pipefail

VERSION="${1:?Usage: update-changelog.sh <version> <notes-file>}"
NOTES_FILE="${2:?Usage: update-changelog.sh <version> <notes-file>}"

NOTES=$(cat "$NOTES_FILE")
DATE=$(date +%Y-%m-%d)

python3 - "$VERSION" "$DATE" "$NOTES" << 'PYTHON'
import sys, re
from pathlib import Path

version, date, notes = sys.argv[1], sys.argv[2], sys.argv[3]
# rstrip: empty notes would otherwise leave the heading's own blank line
# beside the separators added below.
entry = f"## [{version}] — {date}\n\n{notes}".rstrip()

changelog = Path("CHANGELOG.md")
text = changelog.read_text() if changelog.exists() else ""
# Drop an [Unreleased] section; the new entry takes its place below. Never
# pass the notes to re.sub as the replacement: it reads backslashes as escapes.
text = re.sub(
    r'^## \[Unreleased\].*?(?=^## \[|\Z)',
    '',
    text, count=1, flags=re.DOTALL | re.MULTILINE
)
# Insert before the first version entry (## [x.y.z])
lines = text.split('\n')
insert_at = next(
    (i for i in range(len(lines)) if lines[i].startswith('## [')),
    len(lines)
)
# Exactly one blank line on each side of the new entry, so blank lines
# under the header can't pile up across releases. A missing or empty file
# has no header, so it gets the title.
header = '\n'.join(lines[:insert_at]).rstrip() or "# Changelog"
# rstrip: an [Unreleased] section removed from the end of the file leaves
# its separating blank line behind.
earlier_entries = '\n'.join(lines[insert_at:]).rstrip()
if earlier_entries:
    text = f"{header}\n\n{entry}\n\n{earlier_entries}\n"
else:
    text = f"{header}\n\n{entry}\n"

changelog.write_text(text)
PYTHON
