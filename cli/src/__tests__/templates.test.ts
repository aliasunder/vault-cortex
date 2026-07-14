import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { REMOTE_IMAGE } from "../docker.js"
import { buildLocalEnv, buildRemoteEnv } from "../env.js"

const readRepoFile = (repoRelativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../${repoRelativePath}`, import.meta.url)),
    "utf8",
  )

// --- Env var consistency helpers ---

/** Matches compose variable interpolations: `${VAR:-...}` and `${VAR:?...}`. */
const COMPOSE_INTERPOLATION = /\$\{([A-Z_]+):[-?]/g

/** Matches commented env var assignments: `# VAR_NAME=value`. */
const COMMENTED_VAR_LINE = /^# ([A-Z_]+)=/gm

/** Matches active (uncommented) env var assignments: `VAR_NAME=value`. */
const UNCOMMENTED_VAR_LINE = /^([A-Z_]+)=/gm

/** Extracts deduplicated var names from all `${VAR}` interpolations in compose content. */
const interpolatedVars = (composeContent: string): string[] => [
  ...new Set(
    [...composeContent.matchAll(COMPOSE_INTERPOLATION)].map(
      (match) => match[1],
    ),
  ),
]

/** Returns the content after the `# Optional` header (empty string if absent). */
const optionalSection = (content: string): string => {
  const parts = content.split(/^# Optional\b/m)
  return parts.length > 1 ? parts[1] : ""
}

/** Extracts commented var names from the optional section only. */
const optionalVarNames = (content: string): string[] => [
  ...new Set(
    [...optionalSection(content).matchAll(COMMENTED_VAR_LINE)].map(
      (match) => match[1],
    ),
  ),
]

/** Extracts all var names from a .env.example file (required + optional). */
const allEnvExampleVarNames = (envExampleContent: string): string[] => {
  const required = [...envExampleContent.matchAll(UNCOMMENTED_VAR_LINE)].map(
    (match) => match[1],
  )
  const optional = [...envExampleContent.matchAll(COMMENTED_VAR_LINE)].map(
    (match) => match[1],
  )
  return [...new Set([...required, ...optional])]
}

describe("image constants", () => {
  it("REMOTE_IMAGE matches the image the remote compose template pulls", () => {
    expect(readRepoFile("deploy/remote/docker-compose.yml")).toContain(
      `image: ${REMOTE_IMAGE}`,
    )
  })
})

describe("env var consistency across deploy surfaces", () => {
  const modes = [
    {
      mode: "local" as const,
      buildEnv: () => buildLocalEnv({ mcpAuthToken: "t", vaultPath: "/v" }),
      conditionalVars: [] as string[],
    },
    {
      mode: "remote" as const,
      buildEnv: () =>
        buildRemoteEnv({
          mcpAuthToken: "t",
          publicUrl: "https://v.example.com",
          obsidianAuthToken: "tok",
          vaultName: "V",
        }),
      conditionalVars: ["VAULT_PASSWORD"],
    },
  ]

  it.each(modes)(
    "$mode: every compose interpolation is documented in .env.example",
    ({ mode }) => {
      const composeVars = new Set(
        interpolatedVars(readRepoFile(`deploy/${mode}/docker-compose.yml`)),
      )
      const exampleVars = new Set(
        allEnvExampleVarNames(readRepoFile(`deploy/${mode}/.env.example`)),
      )

      const undocumented = [...composeVars]
        .filter((varName) => !exampleVars.has(varName))
        .sort()
      expect(undocumented).toEqual([])
    },
  )

  it.each(modes)(
    "$mode: every .env.example var appears as a compose interpolation",
    ({ mode }) => {
      const composeVars = new Set(
        interpolatedVars(readRepoFile(`deploy/${mode}/docker-compose.yml`)),
      )
      const exampleVars = new Set(
        allEnvExampleVarNames(readRepoFile(`deploy/${mode}/.env.example`)),
      )

      const unconsumed = [...exampleVars]
        .filter((varName) => !composeVars.has(varName))
        .sort()
      expect(unconsumed).toEqual([])
    },
  )

  it.each(modes)(
    "$mode: CLI optional block vars match .env.example optional vars (fix: npm run sync:cli-env-blocks)",
    ({ mode, buildEnv, conditionalVars }) => {
      const conditionalSet = new Set(conditionalVars)

      const cliOptional = optionalVarNames(buildEnv()).sort()
      const exampleOptional = optionalVarNames(
        readRepoFile(`deploy/${mode}/.env.example`),
      )
        .filter((varName) => !conditionalSet.has(varName))
        .sort()

      expect(cliOptional).toEqual(exampleOptional)
    },
  )
})

describe("cli dependency pinning", () => {
  it("cli dependencies match the root devDependencies versions (single install for dev, real deps for npx)", () => {
    const cliManifest = JSON.parse(readRepoFile("cli/package.json")) as {
      dependencies: Record<string, string>
    }
    const rootManifest = JSON.parse(readRepoFile("package.json")) as {
      devDependencies: Record<string, string>
    }

    expect(Object.keys(cliManifest.dependencies)).toEqual([
      "@clack/prompts",
      "commander",
    ])
    for (const [dependency, version] of Object.entries(
      cliManifest.dependencies,
    )) {
      expect(rootManifest.devDependencies[dependency]).toBe(version)
    }
  })
})
