import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { GET_TOKEN_IMAGE } from "../docker.js"
import { buildLocalEnv, buildRemoteEnv } from "../env.js"
import { readComposeTemplate } from "../scaffold.js"

const readRepoFile = (repoRelativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../${repoRelativePath}`, import.meta.url)),
    "utf8",
  )

/** Matches required-variable markers like `${MCP_AUTH_TOKEN:?...}` in compose files. */
const REQUIRED_COMPOSE_VAR = /\$\{([A-Z_]+):\?/g

const requiredVars = (composeContent: string): string[] => [
  ...new Set(
    [...composeContent.matchAll(REQUIRED_COMPOSE_VAR)].map((match) => match[1]),
  ),
]

describe("bundled compose templates", () => {
  const scenarios = [
    { mode: "local", canonical: "deploy/local/docker-compose.yml" },
    { mode: "remote", canonical: "deploy/remote/docker-compose.yml" },
  ] as const

  it.each(scenarios)(
    "cli/templates/$mode/docker-compose.yml is byte-identical to $canonical (fix: npm run sync:cli-templates)",
    ({ mode, canonical }) => {
      expect(readComposeTemplate(mode)).toBe(readRepoFile(canonical))
    },
  )

  it("local env builder covers every required variable in the local compose template", () => {
    const env = buildLocalEnv({ mcpAuthToken: "token", vaultPath: "/vault" })
    const required = requiredVars(readComposeTemplate("local"))

    expect(required).toEqual(["MCP_AUTH_TOKEN", "VAULT_PATH"])
    for (const variable of required) {
      expect(env).toMatch(new RegExp(`^${variable}=`, "m"))
    }
  })

  it("remote env builder covers every required variable in the remote compose template", () => {
    const env = buildRemoteEnv({
      mcpAuthToken: "token",
      publicUrl: "https://vault.example.com",
      obsidianAuthToken: "sync-token",
      vaultName: "MyVault",
    })
    const required = requiredVars(readComposeTemplate("remote"))

    expect(required).toEqual([
      "OBSIDIAN_AUTH_TOKEN",
      "VAULT_NAME",
      "MCP_AUTH_TOKEN",
      "PUBLIC_URL",
    ])
    for (const variable of required) {
      expect(env).toMatch(new RegExp(`^${variable}=`, "m"))
    }
  })

  it("get-token image constant matches the image the remote compose template pulls", () => {
    // GET_TOKEN_IMAGE drives the get-token command shown to every remote
    // user — if it drifts from the compose image, users are told to pull a
    // different image than the one they deploy.
    expect(readComposeTemplate("remote")).toContain(`image: ${GET_TOKEN_IMAGE}`)
  })
})

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
    "$mode: CLI optional block vars match .env.example optional vars (fix: npm run sync:cli-templates)",
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
