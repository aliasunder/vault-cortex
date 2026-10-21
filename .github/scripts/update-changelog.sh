#!/usr/bin/env bash
# Update CHANGELOG.md in the current directory with release notes for a
# given version.
# Usage: update-changelog.sh <version> <notes-file>
# The entry goes above the newest version entry, replacing an [Unreleased]
# section if there is one.

set -euo pipefail

VERSION="${1:?Usage: update-changelog.sh <version> <notes-file>}"
NOTES_FILE="${2:?Usage: update-changelog.sh <version> <notes-file>}"

DATE=$(date +%Y-%m-%d)

python3 - "$VERSION" "$DATE" "$NOTES_FILE" << 'PYTHON'
import sys, re
from pathlib import Path

# From an "## [Unreleased]" heading up to the next "## [" heading or the end
# of the file, the section's trailing blank lines included.
UNRELEASED_SECTION = re.compile(
    r'^## \[Unreleased\].*?(?=^## \[|\Z)', re.DOTALL | re.MULTILINE
)
# An entry heading: any line starting "## [".
ENTRY_HEADING = re.compile(r'^## \[', re.MULTILINE)

version, date, notes_file = sys.argv[1:]
notes = Path(notes_file).read_text()

changelog = Path("CHANGELOG.md")
text = changelog.read_text() if changelog.exists() else ""
# Remove an [Unreleased] section, and insert the entry at that spot separately:
# re.sub reads backslashes in a replacement string as escapes.
text = UNRELEASED_SECTION.sub('', text, count=1)

first_entry = ENTRY_HEADING.search(text)
header_end = first_entry.start() if first_entry else len(text)

# With no text above the first entry, the title becomes the header.
header = text[:header_end].rstrip() or "# Changelog"
entry = f"## [{version}] — {date}\n\n{notes}".rstrip()
earlier_entries = text[header_end:].rstrip()

# Every part is rstripped, so the join leaves exactly one blank line between
# parts and a single newline at the end of the file.
parts = [header, entry, earlier_entries]
changelog.write_text("\n\n".join(part for part in parts if part) + "\n")
PYTHON
