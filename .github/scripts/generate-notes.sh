#!/usr/bin/env bash
# Generate structured release notes from conventional commits between two tags.
# Usage: generate-notes.sh <new-tag> [previous-tag]
# If previous-tag is omitted, uses the tag before new-tag.
#
# Left out of the notes:
# - release bump commits
# - dev-dependency bumps and Claude Code hook changes (scopes `deps-dev`, `hooks`)
# - commits that change only AGENTS.md, CHANGELOG.md, dotfiles at the repository
#   root (.gitignore, .trivyignore), or files under .claude/, .devin/ or .husky/
# - commits that change only the root package.json and package-lock.json and
#   move only dev dependencies
#
# Breaking changes are detected from the *merged PR* — a `breaking-change` label
# or a `BREAKING CHANGE:` footer in the PR body — as well as from the commit
# itself (a `!` type marker or a `BREAKING CHANGE:` footer). The PR is the
# reliable source: a squash commit's body is often dropped at merge time
# (e.g. the GitHub mobile app), but PR labels/body always survive. PR lookups
# need both the `gh` binary and GH_TOKEN; when either is missing (local runs
# without auth) the commit-only signals are used. A lookup that fails despite
# being enabled warns on stderr rather than silently dropping the signal.

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

# Write one record per non-merge commit as `<hash>\x1f<subject>\x1f<body>`,
# records NUL-separated, to a temp file. A file (not a pipe) is used because the
# Python program is fed to `python3 -` on stdin via the heredoc. Commits left
# out of the notes are filtered in Python.
NOTES_INPUT="$(mktemp)"
trap 'rm -f "$NOTES_INPUT"' EXIT
git log --no-merges --format='%H%x1f%s%x1f%b%x00' "$RANGE" > "$NOTES_INPUT"

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

# PR lookups need both the `gh` binary and a token. CI passes GH_TOKEN; a local
# run without it skips lookups and falls back to commit-only signals (the
# documented offline behavior) instead of firing unauthenticated calls.
GH = shutil.which("gh") if os.environ.get("GH_TOKEN") else None
REPO = os.environ.get("GITHUB_REPOSITORY", "")
BREAKING_LABEL = "breaking-change"
_pr_cache = {}

def warn(message):
    print(f"generate-notes: {message}", file=sys.stderr)

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

# Commits with these scopes change nothing a user installs. Hook commits also
# change their tests, so a path rule alone would miss them.
CONTRIBUTOR_ONLY_SCOPES = {"deps-dev", "hooks"}

# A commit that changes only these paths changes nothing a user installs.
# .github/ is not listed: CI changes stay in the notes.
def is_contributor_only_path(path):
    is_root_dotfile = path.startswith(".") and "/" not in path
    return (
        is_root_dotfile
        or path in ("AGENTS.md", "CHANGELOG.md")
        or path.startswith((".claude/", ".devin/", ".husky/"))
    )

def changed_paths(commit_hash):
    result = subprocess.run(
        ["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit_hash],
        capture_output=True, text=True, check=True,
    )
    return [path for path in result.stdout.split("\x00") if path]

ROOT_MANIFESTS = {"package.json", "package-lock.json"}

def read_json_at(revision, path):
    result = subprocess.run(["git", "show", f"{revision}:{path}"], capture_output=True, text=True)
    return json.loads(result.stdout) if result.returncode == 0 else None

def changed_entries(old_mapping, new_mapping):
    keys = old_mapping.keys() | new_mapping.keys()
    return [key for key in keys if old_mapping.get(key) != new_mapping.get(key)]

# Security updates and overrides can use the `deps` scope even when every package
# they move is a dev dependency. The lockfile marks a package that only
# devDependencies reach with `"dev": true`. Anything unreadable counts as a user
# change.
def changes_only_dev_dependencies(commit_hash, paths):
    if not paths or not set(paths) <= ROOT_MANIFESTS:
        return False
    parent = f"{commit_hash}^"
    old_manifest = read_json_at(parent, "package.json")
    new_manifest = read_json_at(commit_hash, "package.json")
    old_lock = read_json_at(parent, "package-lock.json")
    new_lock = read_json_at(commit_hash, "package-lock.json")
    if None in (old_manifest, new_manifest, old_lock, new_lock):
        return False
    if not set(changed_entries(old_manifest, new_manifest)) <= {"devDependencies", "overrides"}:
        return False
    old_packages, new_packages = old_lock.get("packages", {}), new_lock.get("packages", {})
    for package_path in changed_entries(old_packages, new_packages):
        # "" is the project itself; its entry mirrors package.json's dependency lists.
        if package_path == "":
            root_fields = changed_entries(old_packages.get("", {}), new_packages.get("", {}))
            if not set(root_fields) <= {"devDependencies"}:
                return False
            continue
        versions = [packages[package_path] for packages in (old_packages, new_packages) if package_path in packages]
        if not all(version.get("dev") is True for version in versions):
            return False
    return True

for rec in records:
    commit_hash, _, rest = rec.partition("\x1f")
    subject, _, body = rest.partition("\x1f")
    subject = subject.strip()
    if not subject or release_pat.match(subject):
        continue

    match = pat.match(subject)
    has_contributor_only_scope = bool(match) and match.group(2) in CONTRIBUTOR_ONLY_SCOPES
    paths = changed_paths(commit_hash.strip())
    changes_only_contributor_files = bool(paths) and all(
        is_contributor_only_path(path) for path in paths
    )
    if has_contributor_only_scope or changes_only_contributor_files:
        continue
    if changes_only_dev_dependencies(commit_hash.strip(), paths):
        continue

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

# Collapse identical breaking lines. A follow-up PR (a docs PR documenting the
# change, or a revert) can carry the same BREAKING CHANGE footer that another PR
# in the range already contributed; without this, the same line is listed twice.
# dict.fromkeys preserves first-seen order.
breaking = list(dict.fromkeys(breaking))

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
