import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

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

// --- Hosted platform template helpers ---

type RenderEnvVar = {
  key: string
  value?: string
  generateValue?: boolean
  sync?: boolean
}

type RenderBlueprint = {
  services: Array<{
    runtime: string
    image: { url: string }
    healthCheckPath: string
    disk: { mountPath: string }
    envVars: RenderEnvVar[]
  }>
}

const readRenderBlueprint = (): RenderBlueprint =>
  parseYaml(readRepoFile("render.yaml"))

/** Maps a Blueprint's `envVars` list by key so tests can address one entry. */
const renderEnvVarsByKey = (
  blueprint: RenderBlueprint,
): Map<string, RenderEnvVar> =>
  new Map(blueprint.services[0].envVars.map((envVar) => [envVar.key, envVar]))

/** Values every hosted template fixes so the image boots in single-volume mode. */
const HOSTED_FIXED_ENV = {
  PORT: "8000",
  STORAGE_ROOT: "/persist",
  DEVICE_NAME: "vault-cortex",
}

/**
 * Optional settings every hosted template pre-fills with the image's own
 * defaults, so users change them in the platform's dashboard instead of
 * creating variables by hand. A template value that drifts from the image
 * default would silently change behaviour for button deploys only.
 */
const HOSTED_OPTIONAL_ENV = {
  MEMORY_ENABLED: "true",
  EMBEDDING_ENABLED: "true",
  READONLY_MODE: "false",
  FILE_TOOLS_ENABLED: "true",
  SYNC_MODE: "bidirectional",
}

/**
 * Derived at boot by `init-derive-env` from STORAGE_ROOT and the platform's
 * own variables — a template that sets one overrides the derivation.
 */
const DERIVED_AT_BOOT = [
  "LOG_DIR",
  "PUBLIC_URL",
  "VAULT_PATH",
  "INDEX_DB_PATH",
  "XDG_CONFIG_HOME",
]

describe("image constants", () => {
  it("REMOTE_IMAGE matches the image the remote compose template pulls", () => {
    expect(readRepoFile("deploy/remote/docker-compose.yml")).toContain(
      `image: ${REMOTE_IMAGE}`,
    )
  })

  it("REMOTE_IMAGE matches the image the Render blueprint pulls", () => {
    expect(readRenderBlueprint().services[0].image.url).toBe(REMOTE_IMAGE)
  })
})

describe("hosted platform templates", () => {
  describe("render.yaml", () => {
    it("runs the image with the single-volume boot variables fixed", () => {
      const blueprint = readRenderBlueprint()
      const envVars = renderEnvVarsByKey(blueprint)
      const fixedValues = Object.fromEntries(
        Object.keys(HOSTED_FIXED_ENV).map((key) => [
          key,
          envVars.get(key)?.value,
        ]),
      )
      expect(blueprint.services[0].runtime).toBe("image")
      expect(fixedValues).toEqual(HOSTED_FIXED_ENV)
      expect(envVars.get("TRUST_PROXY_HOPS")?.value).toBe("2")
    })

    it("mounts the disk at STORAGE_ROOT and health-checks /healthz", () => {
      const blueprint = readRenderBlueprint()
      const envVars = renderEnvVarsByKey(blueprint)
      expect(blueprint.services[0].disk.mountPath).toBe(
        envVars.get("STORAGE_ROOT")?.value,
      )
      expect(blueprint.services[0].healthCheckPath).toBe("/healthz")
    })

    it("generates MCP_AUTH_TOKEN and prompts for the Sync token, vault name, vault password, and timezone", () => {
      const envVars = renderEnvVarsByKey(readRenderBlueprint())
      expect(envVars.get("MCP_AUTH_TOKEN")).toEqual({
        key: "MCP_AUTH_TOKEN",
        generateValue: true,
      })
      expect(envVars.get("OBSIDIAN_AUTH_TOKEN")).toEqual({
        key: "OBSIDIAN_AUTH_TOKEN",
        sync: false,
      })
      expect(envVars.get("VAULT_NAME")).toEqual({
        key: "VAULT_NAME",
        sync: false,
      })
      expect(envVars.get("VAULT_PASSWORD")).toEqual({
        key: "VAULT_PASSWORD",
        sync: false,
      })
      expect(envVars.get("TZ")).toEqual({ key: "TZ", sync: false })
    })

    it("leaves the boot-derived variables to init-derive-env", () => {
      const envVars = renderEnvVarsByKey(readRenderBlueprint())
      const derivedKeysSet = DERIVED_AT_BOOT.filter((key) => envVars.has(key))
      expect(derivedKeysSet).toEqual([])
    })

    it("pre-fills the optional settings with the image defaults", () => {
      const envVars = renderEnvVarsByKey(readRenderBlueprint())
      const optionalValues = Object.fromEntries(
        Object.keys(HOSTED_OPTIONAL_ENV).map((key) => [
          key,
          envVars.get(key)?.value,
        ]),
      )
      expect(optionalValues).toEqual(HOSTED_OPTIONAL_ENV)
    })
  })

  describe("deploy/railway/README.md definition table", () => {
    /** Parses `| \`KEY\` | \`value\` | …` rows into a key → value map. */
    const definitionTableValues = (): Map<string, string> => {
      const guide = readRepoFile("deploy/railway/README.md")
      const tableRows = guide.matchAll(/^\| `([A-Z_]+)`\s*\| `([^`]*)`\s*\|/gm)
      return new Map([...tableRows].map((row) => [row[1], row[2]]))
    }

    it("records the same fixed and optional values as render.yaml", () => {
      const tableValues = definitionTableValues()
      const expectedValues = { ...HOSTED_FIXED_ENV, ...HOSTED_OPTIONAL_ENV }
      const recordedValues = Object.fromEntries(
        Object.keys(expectedValues).map((key) => [key, tableValues.get(key)]),
      )
      expect(recordedValues).toEqual(expectedValues)
    })
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

describe("SYNC_CONFIGS default", () => {
  it.each(["deploy/remote/docker-compose.yml", "docker-compose.yml"])(
    "%s defaults SYNC_CONFIGS to the categories the server reads",
    (composePath) => {
      // Exact-form pin: the colon interpolation form keeps default-on
      // semantics (unset OR empty → the default categories); disabling is
      // the explicit "none" sentinel handled by the init script, never an
      // empty/unset value.
      expect(readRepoFile(composePath)).toContain(
        "SYNC_CONFIGS: ${SYNC_CONFIGS:-core-plugin-data,community-plugin-data}",
      )
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
