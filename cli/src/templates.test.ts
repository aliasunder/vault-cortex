import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { buildLocalEnv, buildRemoteEnv } from "./env.js"
import { readComposeTemplate } from "./scaffold.js"

const readRepoFile = (repoRelativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../${repoRelativePath}`, import.meta.url)),
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
