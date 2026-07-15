// Generates DOCKERHUB.md from README.md with WAF-triggering content stripped.
//
// Cloudflare's WAF sits in front of Docker Hub and blocks PATCH requests whose
// body contains patterns resembling shell injection, auth headers, or security
// terminology. This script produces a "brochure" version safe for the Hub API.
//
// Usage: npm run generate:dockerhub-readme

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const repoRoot = new URL("..", import.meta.url)

const resolvePath = (repoRelative: string): string =>
  fileURLToPath(new URL(repoRelative, repoRoot))

const GITHUB_REPO = "https://github.com/aliasunder/vault-cortex"
const GITHUB_RAW =
  "https://raw.githubusercontent.com/aliasunder/vault-cortex/main"

const HEADER = `<!-- AUTO-GENERATED from README.md — do not edit manually. Run: npm run generate:dockerhub-readme -->\n`

const NOTICE = [
  "",
  `> **Full documentation:** [github.com/aliasunder/vault-cortex](${GITHUB_REPO})`,
  ">",
  "> This is an abbreviated version for Docker Hub. See the full README for quick-start guides, authentication details, and development instructions.",
  "",
]

const QUICKSTART_REDIRECT = [
  "",
  "## Quick Start",
  "",
  `See the [full Quick Start guide](${GITHUB_REPO}#quick-start) for local setup (2 minutes with Docker), remote deployment with Obsidian Sync, and MCP client configuration.`,
  "",
]

const LICENSE_REPLACEMENT = [
  "",
  "## License",
  "",
  `[MIT](${GITHUB_REPO}/blob/main/LICENSE) — see the full [License section](${GITHUB_REPO}#license) for details on bundled components.`,
  "",
]

const EXCLUDED_H2 = new Set([
  "Quick Start",
  "How It Works",
  "Hybrid Search",
  "Memory",
  "Tasks",
  "Data Integrity",
  "Authentication",
  "Development",
  "Companion: obsidian-vault skill",
  "Contributing",
  "Security",
  "Roadmap",
  "Acknowledgments",
])

const REPLACED_H2 = new Set(["License"])

// Sections where we keep only the heading, intro sentence, and tables — strip
// verbose paragraphs that add bulk without adding Docker Hub value
const COMPACT_H2 = new Set([
  "Properties",
  "Configuration",
  "Deployment Options",
])

// Directories that need /tree/ instead of /blob/ in GitHub links
const DIRECTORY_PATHS = ["deploy/local/", "deploy/remote/", "templates/memory/"]

const rewriteUrls = (line: string): string => {
  let result = line

  result = result.replace(/src="\.\/assets\//g, `src="${GITHUB_RAW}/assets/`)

  result = result.replace(/\]\(\.\/assets\//g, `](${GITHUB_RAW}/assets/`)

  for (const dir of DIRECTORY_PATHS) {
    result = result.replace(
      new RegExp(`\\]\\(\\./${dir.replace("/", "\\/")}`, "g"),
      `](${GITHUB_REPO}/tree/main/${dir}`,
    )
  }

  result = result.replace(/\]\(\.\//g, `](${GITHUB_REPO}/blob/main/`)

  result = result.replace(/\]\(#/g, `](${GITHUB_REPO}#`)

  return result
}

const isContentsLine = (line: string): boolean =>
  line.startsWith("**Contents**") || line.startsWith("**Contents** —")

const parseHeading = (
  line: string,
): { level: number; text: string } | undefined => {
  const match = line.match(/^(#{2,3})\s+(.+)$/)
  if (!match?.[1] || !match[2]) return undefined
  return { level: match[1].length, text: match[2] }
}

const generate = (): void => {
  const readme = readFileSync(resolvePath("README.md"), "utf-8")
  const lines = readme.split("\n")
  const output: string[] = [HEADER]

  let insideFence = false
  let insideDetails = false
  let skipSection = false
  let skipLevel = 0
  let insertedNotice = false
  let compactSection = false
  let compactTableDone = false

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!insideFence) {
        insideFence = true
        continue
      }
      insideFence = false
      continue
    }
    if (insideFence) continue

    if (line.trim() === "<details>") {
      insideDetails = true
      continue
    }
    if (line.trim() === "</details>") {
      insideDetails = false
      continue
    }
    if (insideDetails) continue

    if (isContentsLine(line)) continue

    const heading = parseHeading(line)
    if (heading) {
      if (heading.level === 2) {
        if (EXCLUDED_H2.has(heading.text)) {
          skipSection = true
          skipLevel = 2
          if (heading.text === "Quick Start") {
            output.push(...QUICKSTART_REDIRECT)
          }
          continue
        }

        if (REPLACED_H2.has(heading.text)) {
          skipSection = true
          skipLevel = 2
          output.push(...LICENSE_REPLACEMENT)
          continue
        }

        skipSection = false
        skipLevel = 0
        compactSection = COMPACT_H2.has(heading.text)
        compactTableDone = false
      } else if (heading.level === 3) {
        if (skipSection && skipLevel === 2) continue
      }
    }

    if (skipSection) {
      if (heading && heading.level <= skipLevel) {
        skipSection = false
        skipLevel = 0
      } else {
        continue
      }
    }

    // In compact sections, keep heading + intro + tables, drop post-table prose
    if (compactSection && !heading) {
      const isTableRow = line.startsWith("|")
      if (isTableRow) {
        compactTableDone = false
      } else if (compactTableDone) {
        continue
      } else if (line.trim() !== "") {
        const lastTableIdx = output.findLastIndex((l) => l.startsWith("|"))
        const lastHeadingIdx = output.findLastIndex(
          (l) => parseHeading(l) !== undefined,
        )
        if (lastTableIdx > lastHeadingIdx) {
          compactTableDone = true
          continue
        }
      }
    }

    if (!insertedNotice && line.trim() === "</div>") {
      output.push(rewriteUrls(line))
      output.push(...NOTICE)
      insertedNotice = true
      continue
    }

    output.push(rewriteUrls(line))
  }

  // Collapse runs of 3+ blank lines to 2
  const collapsed: string[] = []
  let blankRun = 0
  for (const line of output) {
    if (line.trim() === "") {
      blankRun++
      if (blankRun > 2) continue
    } else {
      blankRun = 0
    }
    collapsed.push(line)
  }

  // Trim trailing blanks, ensure single newline at end
  while (collapsed.length > 0 && collapsed.at(-1)?.trim() === "") {
    collapsed.pop()
  }
  collapsed.push("")

  const content = collapsed.join("\n")
  const byteCount = Buffer.byteLength(content, "utf-8")

  writeFileSync(resolvePath("DOCKERHUB.md"), content, "utf-8")

  console.log(`generated DOCKERHUB.md (${byteCount} bytes)`)
  if (byteCount > 24_000) {
    console.warn(
      `warning: output is ${byteCount} bytes — Docker Hub truncates at 25000`,
    )
  }
}

generate()
