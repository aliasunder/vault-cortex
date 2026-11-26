/** A PR as `gh pr view --json labels,body` returns it. */
export type PullRequestStub = { labels?: string[]; body: string }

/** A gh stand-in for the release-notes scripts. It answers
 *  `gh pr view <number> --json labels,body` for the given PRs, with
 *  `-R <repo>` after the number when repo is given, and fails any other call,
 *  so a lookup of the wrong PR shows up on stderr. */
export const ghAnsweringPullRequests = (
  pullRequests: Record<number, PullRequestStub>,
  { repo }: { repo?: string } = {},
): string => {
  const repoArgs = repo ? ` -R ${repo}` : ""
  const caseArms = Object.entries(pullRequests).flatMap(([prNumber, { labels = [], body }]) => {
    const prJson = JSON.stringify({ labels: labels.map((name) => ({ name })), body })
    return [
      `  "pr view ${prNumber}${repoArgs} --json labels,body")`,
      "    cat <<'JSON'",
      prJson,
      "JSON",
      "    ;;",
    ]
  })
  return [
    "#!/bin/sh",
    'case "$*" in',
    ...caseArms,
    "  *)",
    '    echo "unexpected gh call: $*" >&2',
    "    exit 64",
    "    ;;",
    "esac",
    "",
  ].join("\n")
}

/** GH_TOKEN turns the scripts' PR lookups on; the stub gh never reads its value. */
export const WITH_GH_TOKEN = { GH_TOKEN: "fixture-token" }
