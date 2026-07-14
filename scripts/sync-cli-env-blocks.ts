// Syncs the optional env blocks from deploy/<mode>/.env.example into the
// CLI's env.ts constants. The deploy/ .env.example files are the single
// source of truth for optional variable documentation.
//
// cli/src/templates.test.ts fails CI when these drift; this script is
// the one-command fix.
//
// Usage: npm run sync:cli-env-blocks

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const repoRoot = new URL("..", import.meta.url)

const resolvePath = (repoRelative: string): string =>
  fileURLToPath(new URL(repoRelative, repoRoot))

// --- Optional env block sync (extract + embed) -------------------------------

/** Header prepended to each optional block in the CLI-generated .env. */
const CLI_OPTIONAL_HEADER = `# Optional ──────────────────────────────────────────────────
# To override a setting: uncomment it, set a value, then apply with
# "npx vault-cortex upgrade" (restart alone does not re-read this file).

`

/**
 * Extracts the optional section from a .env.example file — everything after
 * the `# Optional ──────` header line. Returns the content without the header
 * itself (the CLI prepends its own instruction-enriched header).
 */
const extractOptionalSection = (envExampleContent: string): string => {
  const headerPattern = /^# Optional\b[^\n]*/m
  const match = headerPattern.exec(envExampleContent)
  if (!match) {
    throw new Error("could not find '# Optional' header in .env.example")
  }
  const afterHeader = envExampleContent.slice(match.index + match[0].length)
  return afterHeader.replace(/^\n+/, "")
}

/**
 * Removes the VAULT_PASSWORD entry block from the remote optional section.
 * VAULT_PASSWORD is handled conditionally in buildRemoteEnv's required section,
 * not in the optional block.
 */
const removeVaultPasswordBlock = (optionalContent: string): string => {
  const blocks = optionalContent.split("\n\n")
  const filtered = blocks.filter((block) => !block.includes("VAULT_PASSWORD"))
  return filtered.join("\n\n")
}

/**
 * Replaces content between sync markers in env.ts. Markers are line comments
 * like `// sync:local-optional:begin` and `// sync:local-optional:end`.
 */
const replaceSyncBlock = (
  fileContent: string,
  blockName: string,
  newContent: string,
): string => {
  const beginMarker = `// sync:${blockName}:begin`
  const endMarker = `// sync:${blockName}:end`

  const beginIndex = fileContent.indexOf(beginMarker)
  const endIndex = fileContent.indexOf(endMarker)
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(`sync markers for '${blockName}' not found in env.ts`)
  }

  const beforeBlock = fileContent.slice(0, beginIndex + beginMarker.length)
  const afterBlock = fileContent.slice(endIndex)

  return `${beforeBlock}\n${newContent}\n${afterBlock}`
}

const envSources = [
  {
    envExample: "deploy/local/.env.example",
    blockName: "local-optional",
    constName: "LOCAL_OPTIONAL_BLOCK",
    transform: (section: string): string => section,
  },
  {
    envExample: "deploy/remote/.env.example",
    blockName: "remote-optional",
    constName: "REMOTE_OPTIONAL_BLOCK",
    transform: removeVaultPasswordBlock,
  },
]

const envTsPath = resolvePath("cli/src/env.ts")
// Mutable — each loop iteration replaces a different sync block in the file content
let envTsContent = readFileSync(envTsPath, "utf8")

for (const { envExample, blockName, constName, transform } of envSources) {
  const exampleContent = readFileSync(resolvePath(envExample), "utf8")
  const optionalSection = extractOptionalSection(exampleContent)
  const transformedSection = transform(optionalSection)

  const escapedSection = transformedSection.replaceAll("`", "\\`")

  const blockContent = `const ${constName} = \`${CLI_OPTIONAL_HEADER}${escapedSection}\`
`

  envTsContent = replaceSyncBlock(envTsContent, blockName, blockContent)
  console.log(`synced ${envExample} optional section -> env.ts ${constName}`)
}

writeFileSync(envTsPath, envTsContent)
