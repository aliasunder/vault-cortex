#!/usr/bin/env bash
# Generate structured release notes from conventional commits between two tags.
# Usage: generate-notes.sh <new-tag> [previous-tag]
# If previous-tag is omitted, uses the tag before new-tag.
#
# Breaking changes are detected from the *merged PR* — a `breaking-change` label
# or a `BREAKING CHANGE:` footer in the PR body — as well as from the commit
# itself (a `!` type marker or a `BREAKING CHANGE:` footer). The PR is the
# reliable source: a squash commit's body is often dropped at merge time
# (e.g. the GitHub mobile app), but PR labels/body always survive. PR lookups
# use `gh` + GH_TOKEN; when `gh` is unavailable (local runs without auth) the
# commit-only signals are used.

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
# NUL-separated, to a temp file. A file (not a pipe) is used because the Python
# program is fed to `python3 -` on stdin via the heredoc. Release commits are
# filtered out in Python.
NOTES_INPUT="$(mktemp)"
trap 'rm -f "$NOTES_INPUT"' EXIT
git log --no-merges --format='%s%x1f%b%x00' "$RANGE" > "$NOTES_INPUT"

python3 - "$NOTES_INPUT" << 'PYTHON'
import sys, re, os, json, shutil, subprocess

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
# Squash subjects end with the PR number, e.g. "… (#142)".
pr_pat = re.compile(r'\(#(\d+)\)\s*$')

GH = shutil.which("gh")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
BREAKING_LABEL = "breaking-change"
_pr_cache = {}

def pr_info(num):
    """Return {labels, body} for a merged PR via `gh`, or None when `gh` is
    unavailable or the lookup fails (so local runs degrade to commit-only)."""
    if not GH:
        return None
    if num in _pr_cache:
        return _pr_cache[num]
    info = None
    try:
        repo_args = ["-R", REPO] if REPO else []
        result = subprocess.run(
            [GH, "pr", "view", num, *repo_args, "--json", "labels,body"],
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            info = {
                "labels": {label["name"] for label in data.get("labels", [])},
                "body": data.get("body") or "",
            }
    except Exception:
        info = None
    _pr_cache[num] = info
    return info

for rec in records:
    subject, _, body = rec.partition("\x1f")
    subject = subject.strip()
    if not subject or release_pat.match(subject):
        continue

    match = pat.match(subject)
    pr_num = pr_pat.search(subject)
    pr = pr_info(pr_num.group(1)) if pr_num else None

    # Categorize from the commit subject.
    if match:
        typ, scope, _bang, desc = match.group(1, 2, 3, 4)
        desc = desc[0].upper() + desc[1:]  # capitalize
        entry = f"- **{scope}:** {desc}" if scope else f"- {desc}"
        (buckets[typ] if typ in buckets else other).append(entry)
    else:
        desc = subject[0].upper() + subject[1:] if subject else subject
        other.append(f"- {desc}")

    # Breaking signals, in preference order for the descriptive line:
    #   PR body footer > commit body footer > subject (when only `!`/label flags).
    commit_footer = breaking_pat.search(body or "")
    pr_footer = breaking_pat.search(pr["body"]) if pr else None
    has_label = bool(pr and BREAKING_LABEL in pr["labels"])
    if (match and match.group(3)) or commit_footer or pr_footer or has_label:
        if pr_footer:
            note = pr_footer.group(1).strip()
        elif commit_footer:
            note = commit_footer.group(1).strip()
        else:
            note = desc
        breaking.append(f"- {note}")

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
