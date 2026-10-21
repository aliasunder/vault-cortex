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
# - commits that change only `devDependencies` or `overrides` in the root
#   package.json, and in package-lock.json only packages marked `"dev": true`
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
  # First server release: list every commit reachable from NEW_TAG.
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

with open(sys.argv[1], "rb") as log_file:
    log_text = log_file.read().decode("utf-8", "replace")
records = [record for record in log_text.split("\x00") if record.strip()]

# Category config: (commit type, heading)
categories = [
    ("feat", "Features"),
    ("fix", "Bug Fixes"),
    ("refactor", "Refactoring"),
    ("docs", "Documentation"),
    ("ci", "CI / Infrastructure"),
    ("eval", "Evals"),
    ("chore", "Maintenance"),
]
heading_by_type = dict(categories)
type_order = [commit_type for commit_type, _ in categories]

buckets = {commit_type: [] for commit_type in type_order}
other = []
breaking = []

# Pattern: type(scope)!: description — scope and the breaking `!` are optional.
subject_pat = re.compile(
    r'^(?P<type>[a-z]+)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?:\s+(?P<description>.+)$'
)
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
# Set by GitHub Actions. A local run leaves it empty, and `gh` then uses the
# checkout's own remote.
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
# change their tests in src/__tests__/, so a path rule alone would miss them.
CONTRIBUTOR_ONLY_SCOPES = {"deps-dev", "hooks"}

# A commit that changes only these paths changes nothing a user installs.
def is_contributor_only_path(path):
    # The "/" check leaves out dot-folders such as .github/, so CI changes stay
    # in the notes.
    is_root_dotfile = path.startswith(".") and "/" not in path
    return (
        is_root_dotfile
        or path in ("AGENTS.md", "CHANGELOG.md")
        or path.startswith((".claude/", ".devin/", ".husky/"))
    )

# No paths keeps the commit listed, so a failed lookup lists it with a warning.
def changed_paths(commit_hash):
    result = subprocess.run(
        ["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit_hash],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        warn(f"git diff-tree {commit_hash} failed (exit {result.returncode}): "
             f"{result.stderr.strip()} — listing the commit")
        return []
    return [path for path in result.stdout.split("\x00") if path]

ROOT_MANIFESTS = {"package.json", "package-lock.json"}
DEV_ONLY_MANIFEST_FIELDS = {"devDependencies", "overrides"}

def read_json_at(revision, path):
    result = subprocess.run(["git", "show", f"{revision}:{path}"], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        json_value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        warn(f"{path} at {revision} is not valid JSON ({error}) — listing the commit")
        return None
    if not isinstance(json_value, dict):
        warn(f"{path} at {revision} is not a JSON object — listing the commit")
        return None
    return json_value

def changed_keys(old_mapping, new_mapping):
    keys = old_mapping.keys() | new_mapping.keys()
    return [key for key in keys if old_mapping.get(key) != new_mapping.get(key)]

# Security updates and overrides can use the `deps` scope even when every package
# they move is a dev dependency. The lockfile marks a package that only
# devDependencies reach with `"dev": true`. A manifest missing or unreadable at
# either revision counts as a user change.
def changes_only_dev_dependencies(commit_hash, paths):
    changes_only_manifests = bool(paths) and set(paths) <= ROOT_MANIFESTS
    if not changes_only_manifests:
        return False

    parent = f"{commit_hash}^"
    old_manifest = read_json_at(parent, "package.json")
    new_manifest = read_json_at(commit_hash, "package.json")
    old_lock = read_json_at(parent, "package-lock.json")
    new_lock = read_json_at(commit_hash, "package-lock.json")
    if None in (old_manifest, new_manifest, old_lock, new_lock):
        return False
    if not set(changed_keys(old_manifest, new_manifest)) <= DEV_ONLY_MANIFEST_FIELDS:
        return False

    # The lockfile's `packages` map keys each installed package by its install
    # path (`node_modules/foo`). Its "" entry is the project itself, which
    # copies fields from package.json.
    old_packages = old_lock.get("packages")
    new_packages = new_lock.get("packages")
    has_package_maps = isinstance(old_packages, dict) and isinstance(new_packages, dict)

    # A lockfile without that map (npm 6's lockfileVersion 1) counts as a user change.
    if not has_package_maps:
        return False
    for install_path in changed_keys(old_packages, new_packages):
        if install_path == "":
            root_fields = changed_keys(old_packages.get("", {}), new_packages.get("", {}))
            if not set(root_fields) <= DEV_ONLY_MANIFEST_FIELDS:
                return False
            continue
        lock_entries = [
            packages[install_path]
            for packages in (old_packages, new_packages)
            if install_path in packages
        ]
        if not all(lock_entry.get("dev") is True for lock_entry in lock_entries):
            return False
    return True

for record in records:
    commit_hash, _, rest = record.partition("\x1f")
    # Every record after the first starts with the newline git log writes after
    # each NUL terminator.
    commit_hash = commit_hash.strip()
    subject, _, body = rest.partition("\x1f")
    subject = subject.strip()
    if not subject or release_pat.match(subject):
        continue

    match = subject_pat.match(subject)
    has_contributor_only_scope = bool(match) and match["scope"] in CONTRIBUTOR_ONLY_SCOPES
    # The scope check comes first: a failed path lookup warns that the commit
    # is listed.
    if has_contributor_only_scope:
        continue
    paths = changed_paths(commit_hash)
    # An empty commit has no paths, and all() of nothing is True; keep it listed.
    changes_only_contributor_files = bool(paths) and all(
        is_contributor_only_path(path) for path in paths
    )
    if changes_only_contributor_files:
        continue
    if changes_only_dev_dependencies(commit_hash, paths):
        continue

    pr_match = pr_pat.search(subject)
    pr = pr_info(pr_match.group(1)) if pr_match else None

    # Categorize from the commit subject.
    if match:
        commit_type, scope, description = match.group("type", "scope", "description")
        description = description[0].upper() + description[1:]
        entry = f"- **{scope}:** {description}" if scope else f"- {description}"
        buckets.get(commit_type, other).append(entry)
    else:
        description = subject[0].upper() + subject[1:]
        other.append(f"- {description}")

    # Breaking signals, in preference order for the descriptive line:
    #   PR body footer > commit body footer > description (when only `!`/label flags).
    commit_footer = breaking_pat.search(body)
    pr_footer = breaking_pat.search(pr["body"]) if pr else None
    has_label = bool(pr and BREAKING_LABEL in pr["labels"])
    has_breaking_marker = bool(match and match["breaking"])
    if has_breaking_marker or commit_footer or pr_footer or has_label:
        if pr_footer:
            note = pr_footer.group(1).strip()
        elif commit_footer:
            note = commit_footer.group(1).strip()
        else:
            note = description
        breaking.append(f"- {note}")

# Collapse identical breaking lines. A follow-up PR (a docs PR documenting the
# change, or a revert) can carry the same BREAKING CHANGE footer that another PR
# in the range already contributed; without this, the same line is listed twice.
# dict.fromkeys preserves first-seen order.
breaking = list(dict.fromkeys(breaking))

# Output — BREAKING CHANGES lead so they're impossible to miss.
output_lines = []
if breaking:
    output_lines += ["### ⚠ BREAKING CHANGES", ""] + breaking

for commit_type in type_order:
    if buckets[commit_type]:
        if output_lines:
            output_lines.append("")
        output_lines += [f"### {heading_by_type[commit_type]}", ""] + buckets[commit_type]

if other:
    if output_lines:
        output_lines.append("")
    output_lines += ["### Other Changes", ""] + other

print("\n".join(output_lines) if output_lines else "No notable changes.")
PYTHON
