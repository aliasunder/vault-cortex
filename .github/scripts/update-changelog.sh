#!/usr/bin/env bash
# Update CHANGELOG.md with release notes for a given version.
# Usage: update-changelog.sh <version> <notes-file>
# Replaces [Unreleased] section if present, otherwise inserts after header.

set -euo pipefail

VERSION="${1:?Usage: update-changelog.sh <version> <notes-file>}"
NOTES_FILE="${2:?Usage: update-changelog.sh <version> <notes-file>}"

NOTES=$(cat "$NOTES_FILE")
DATE=$(date +%Y-%m-%d)

python3 - "$VERSION" "$DATE" "$NOTES" << 'PYTHON'
import sys, re, os

version, date, notes = sys.argv[1], sys.argv[2], sys.argv[3]
entry = f"## [{version}] — {date}\n\n{notes}"

changelog_path = "CHANGELOG.md"
if os.path.exists(changelog_path):
    with open(changelog_path) as f:
        text = f.read()
    # Replace [Unreleased] section if present
    if re.search(r'^## \[Unreleased\]', text, re.MULTILINE):
        text = re.sub(
            r'## \[Unreleased\].*?(?=\n## \[|$)',
            entry,
            text, count=1, flags=re.DOTALL
        )
    else:
        # Insert before the first version entry (## [x.y.z])
        lines = text.split('\n')
        insert_at = next(
            (i for i in range(len(lines)) if lines[i].startswith('## [')),
            len(lines)
        )
        lines.insert(insert_at, f"\n{entry}\n")
        text = '\n'.join(lines)
else:
    text = f"# Changelog\n\n{entry}\n"

with open(changelog_path, 'w') as f:
    f.write(text)
PYTHON
