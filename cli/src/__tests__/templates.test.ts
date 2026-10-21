import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

import { loadConfig } from "../../../src/vault-mcp/config.js"
import { instanceVolumeNames, REMOTE_IMAGE } from "../docker.js"
import { buildLocalEnv, buildRemoteEnv } from "../env.js"

const readRepoFile = (repoRelativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${repoRelativePath}`, import.meta.url)), "utf8")

// --- Env var consistency helpers ---

/** Matches compose variable interpolations: `${VAR:-...}` and `${VAR:?...}`. */
const COMPOSE_INTERPOLATION = /\$\{([A-Z_]+):[-?]/g

/** Matches commented env var assignments: `# VAR_NAME=value`. */
const COMMENTED_VAR_LINE = /^# ([A-Z_]+)=/gm

/** Matches active (uncommented) env var assignments: `VAR_NAME=value`. */
const UNCOMMENTED_VAR_LINE = /^([A-Z_]+)=/gm

/** Matches every SYNC_CONFIGS assignment line, commented (`# SYNC_CONFIGS=`) or active. */
const SYNC_CONFIGS_ASSIGNMENT_LINE = /^#? ?SYNC_CONFIGS=.*$/gm

/** The remote .env the CLI writes, for answers that set no conditional var. */
const buildSampleRemoteEnv = (): string => {
  return buildRemoteEnv({
    mcpAuthToken: "t",
    publicUrl: "https://v.example.com",
    obsidianAuthToken: "tok",
    vaultName: "V",
  })
}

/** Extracts deduplicated var names from all `${VAR}` interpolations in compose content. */
const interpolatedVars = (composeContent: string): string[] => [
  ...new Set([...composeContent.matchAll(COMPOSE_INTERPOLATION)].map((match) => match[1])),
]

/** Returns the content after the `# Optional` header (empty string if absent). */
const optionalSection = (content: string): string => {
  const parts = content.split(/^# Optional\b/m)
  return parts.length > 1 ? parts[1] : ""
}

/** Matches env var assignments in the optional section, commented or active. */
const OPTIONAL_VAR_LINE = /^(?:# )?([A-Z_]+)=/gm

/**
 * Extracts var names from the optional section only. Active lines count too:
 * a setting written as `INSTANCE_NAME=vault-cortex` must reach the CLI's
 * generated .env just like a commented one.
 */
const optionalVarNames = (content: string): string[] => [
  ...new Set([...optionalSection(content).matchAll(OPTIONAL_VAR_LINE)].map((match) => match[1])),
]

/**
 * Variables Compose sets itself, so a compose file can read them without the
 * user documenting them: the container name follows the project name through
 * COMPOSE_PROJECT_NAME.
 */
const COMPOSE_PROVIDED_VARS = new Set(["COMPOSE_PROJECT_NAME"])

/** Extracts all var names from a .env.example file (required + optional). */
const allEnvExampleVarNames = (envExampleContent: string): string[] => {
  const required = [...envExampleContent.matchAll(UNCOMMENTED_VAR_LINE)].map((match) => match[1])
  const optional = [...envExampleContent.matchAll(COMMENTED_VAR_LINE)].map((match) => match[1])
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
    plan: string
    healthCheckPath: string
    disk: { mountPath: string; sizeGB: number }
    envVars: RenderEnvVar[]
  }>
}

const readRenderBlueprint = (): RenderBlueprint => parseYaml(readRepoFile("render.yaml"))

type ComposeFile = {
  services: {
    "vault-cortex": { image: string; environment: Record<string, string> }
  }
}

const readComposeService = (composePath: string): ComposeFile["services"]["vault-cortex"] => {
  const composeFile: ComposeFile = parseYaml(readRepoFile(composePath))
  return composeFile.services["vault-cortex"]
}

/** Maps a Blueprint's `envVars` list by key so tests can address one entry. */
const renderEnvVarsByKey = (blueprint: RenderBlueprint): Map<string, RenderEnvVar> =>
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
 * default would silently change behaviour for button deploys only — so the
 * server-side defaults are read from `loadConfig` with an empty environment,
 * not restated here. SYNC_MODE is passed straight to the Obsidian Sync
 * client, whose own default is bidirectional (`deploy/remote/.env.example`
 * documents the same), so it has no server-side source and stays a literal.
 */
const imageDefaults = loadConfig({})
const HOSTED_OPTIONAL_ENV = {
  MEMORY_ENABLED: String(imageDefaults.memoryEnabled),
  EMBEDDING_ENABLED: String(imageDefaults.embeddingEnabled),
  READONLY_MODE: String(imageDefaults.readOnlyMode),
  FILE_TOOLS_ENABLED: String(imageDefaults.fileToolsEnabled),
  SYNC_MODE: "bidirectional",
  CONFLICT_STRATEGY: "merge",
  SYNC_EXCLUDED_FOLDERS: "",
  SYNC_FILE_TYPES: "",
}

/**
 * Derived at boot by `init-derive-env` from STORAGE_ROOT and the platform's
 * own variables — a template that sets one overrides the derivation.
 */
const DERIVED_AT_BOOT = ["LOG_DIR", "PUBLIC_URL", "VAULT_PATH", "INDEX_DB_PATH", "XDG_CONFIG_HOME"]

describe("image constants", () => {
  it("REMOTE_IMAGE matches the image the remote compose template pulls", () => {
    expect(readComposeService("deploy/remote/docker-compose.yml").image).toBe(REMOTE_IMAGE)
  })

  it("REMOTE_IMAGE matches the image the Render blueprint pulls", () => {
    expect(readRenderBlueprint().services[0].image.url).toBe(REMOTE_IMAGE)
  })
})

/** The parts of a compose file that name an install's project, container and volumes. */
type ComposeNaming = {
  name: string
  services: { "vault-cortex": { container_name: string } }
  volumes: Record<string, unknown>
}

describe("instance naming in the compose templates", () => {
  it.each([{ mode: "local" as const }, { mode: "remote" as const }])(
    "$mode names the project and container after INSTANCE_NAME and declares the volumes the CLI mounts",
    ({ mode }) => {
      const composeFile: ComposeNaming = parseYaml(
        readRepoFile(`deploy/${mode}/docker-compose.yml`),
      )
      // Compose prefixes each volume with the project name, so one INSTANCE_NAME
      // gives a CLI install and a Compose install the same data.
      const composeVolumeNames = Object.keys(composeFile.volumes).map((volume) => `work_${volume}`)
      const cliVolumeNames = instanceVolumeNames({ mode, instanceName: "work" })

      expect({
        name: composeFile.name,
        containerName: composeFile.services["vault-cortex"].container_name,
        volumeNames: composeVolumeNames.sort(),
      }).toEqual({
        name: "${INSTANCE_NAME:-vault-cortex}",
        containerName: "${COMPOSE_PROJECT_NAME:-${INSTANCE_NAME:-vault-cortex}}",
        volumeNames: cliVolumeNames.sort(),
      })
    },
  )
})

describe("hosted platform templates", () => {
  describe("render.yaml", () => {
    it("runs the image with the single-volume boot variables fixed", () => {
      const blueprint = readRenderBlueprint()
      const envVars = renderEnvVarsByKey(blueprint)
      const fixedValues = Object.fromEntries(
        Object.keys(HOSTED_FIXED_ENV).map((key) => [key, envVars.get(key)?.value]),
      )
      expect(blueprint.services[0].runtime).toBe("image")
      expect(fixedValues).toEqual(HOSTED_FIXED_ENV)
      expect(envVars.get("TRUST_PROXY_HOPS")?.value).toBe("2")
    })

    it("provisions the Standard instance and a 5 GB disk the guides quote as the cost", () => {
      const blueprint = readRenderBlueprint()
      expect(blueprint.services[0].plan).toBe("standard")
      expect(blueprint.services[0].disk.sizeGB).toBe(5)
    })

    it("mounts the disk at STORAGE_ROOT and health-checks /healthz", () => {
      const blueprint = readRenderBlueprint()
      const envVars = renderEnvVarsByKey(blueprint)
      expect(blueprint.services[0].disk.mountPath).toBe(envVars.get("STORAGE_ROOT")?.value)
      expect(blueprint.services[0].healthCheckPath).toBe("/healthz")
    })

    it("generates MCP_AUTH_TOKEN and accepts optional Sync token, vault name, vault password, and timezone", () => {
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
        Object.keys(HOSTED_OPTIONAL_ENV).map((key) => [key, envVars.get(key)?.value]),
      )
      expect(optionalValues).toEqual(HOSTED_OPTIONAL_ENV)
    })
  })

  describe("CONTRIBUTING.md Railway template definition table", () => {
    /** Parses `| \`KEY\` | \`value\` | …` rows into a key → value map. A
     *  value cell of `_(optional input)_` is an empty value the deploy form
     *  lets the user fill; it maps to "". */
    const definitionTableValues = (): Map<string, string> => {
      const contributing = readRepoFile("CONTRIBUTING.md")
      const sectionStart = contributing.indexOf("## Railway template")

      if (sectionStart === -1) {
        throw new Error("CONTRIBUTING.md has no '## Railway template' section")
      }
      const railwaySection = contributing.slice(sectionStart)
      const tableRows = railwaySection.matchAll(
        /^\| `([A-Z_]+)`\s*\| (?:`([^`]*)`|_\(optional input\)_)\s*\|/gm,
      )
      return new Map([...tableRows].map((row) => [row[1], row[2] ?? ""]))
    }

    it("records the same fixed and optional values as render.yaml, plus the generated token and Railway's own proxy-hop and health-window settings", () => {
      const tableValues = definitionTableValues()
      const expectedValues = {
        ...HOSTED_FIXED_ENV,
        ...HOSTED_OPTIONAL_ENV,
        MCP_AUTH_TOKEN: '${{secret(64, "0123456789abcdef")}}',
        TRUST_PROXY_HOPS: "2",
        RAILWAY_HEALTHCHECK_TIMEOUT_SEC: "900",
      }
      const recordedValues = Object.fromEntries(
        Object.keys(expectedValues).map((key) => [key, tableValues.get(key)]),
      )
      expect(recordedValues).toEqual(expectedValues)
    })

    it("leaves the boot-derived variables to init-derive-env", () => {
      const tableValues = definitionTableValues()
      const derivedKeysSet = DERIVED_AT_BOOT.filter((key) => tableValues.has(key))
      expect(derivedKeysSet).toEqual([])
    })

    it("records the six deploy-form inputs, and the Railway guide's Deploy table lists the same six", () => {
      const contributing = readRepoFile("CONTRIBUTING.md")
      const railwaySection = contributing.slice(contributing.indexOf("## Railway template"))
      const inputRows = railwaySection.matchAll(
        /^\| `([A-Z_]+)`\s*\| _\((required|optional) input\)_/gm,
      )
      const recordedInputs = Object.fromEntries([...inputRows].map((row) => [row[1], row[2]]))
      expect(recordedInputs).toEqual({
        TZ: "optional",
        VAULT_NAME: "required",
        VAULT_PASSWORD: "optional",
        OBSIDIAN_AUTH_TOKEN: "optional",
        SYNC_EXCLUDED_FOLDERS: "optional",
        SYNC_FILE_TYPES: "optional",
      })

      const guide = readRepoFile("deploy/railway/README.md")
      const deploySection = guide.slice(
        guide.indexOf("## Deploy"),
        guide.indexOf("## Your URL and token"),
      )
      const guideInputs = [...deploySection.matchAll(/^\| `([A-Z_]+)`/gm)].map((row) => row[1])
      expect(guideInputs).toEqual(Object.keys(recordedInputs))
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
      buildEnv: buildSampleRemoteEnv,
      conditionalVars: ["VAULT_PASSWORD"],
    },
  ]

  it.each(modes)("$mode: every compose interpolation is documented in .env.example", ({ mode }) => {
    const composeVars = new Set(interpolatedVars(readRepoFile(`deploy/${mode}/docker-compose.yml`)))
    const exampleVars = new Set(allEnvExampleVarNames(readRepoFile(`deploy/${mode}/.env.example`)))

    const undocumented = [...composeVars]
      .filter((varName) => !exampleVars.has(varName) && !COMPOSE_PROVIDED_VARS.has(varName))
      .sort()
    expect(undocumented).toEqual([])
  })

  it.each(modes)("$mode: every .env.example var appears as a compose interpolation", ({ mode }) => {
    const composeVars = new Set(interpolatedVars(readRepoFile(`deploy/${mode}/docker-compose.yml`)))
    const exampleVars = new Set(allEnvExampleVarNames(readRepoFile(`deploy/${mode}/.env.example`)))

    const unconsumed = [...exampleVars].filter((varName) => !composeVars.has(varName)).sort()
    expect(unconsumed).toEqual([])
  })

  it.each(modes)(
    "$mode: CLI optional block vars match .env.example optional vars (fix: npm run sync:cli-env-blocks)",
    ({ mode, buildEnv, conditionalVars }) => {
      const conditionalSet = new Set(conditionalVars)

      const cliOptional = optionalVarNames(buildEnv()).sort()
      const exampleOptional = optionalVarNames(readRepoFile(`deploy/${mode}/.env.example`))
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
      expect(readComposeService(composePath).environment.SYNC_CONFIGS).toBe(
        "${SYNC_CONFIGS:-core-plugin-data,community-plugin-data,app}",
      )
    },
  )

  // These files set SYNC_CONFIGS on an active line, which overrides the
  // compose default — a stale value here ships the old categories to every
  // user who starts from them.
  it.each([
    {
      label: "deploy/remote/.env.example",
      readEnvFile: () => readRepoFile("deploy/remote/.env.example"),
    },
    { label: "the CLI's generated remote .env", readEnvFile: buildSampleRemoteEnv },
  ])("$label sets SYNC_CONFIGS to the compose default", ({ readEnvFile }) => {
    const syncConfigsLines = readEnvFile().match(SYNC_CONFIGS_ASSIGNMENT_LINE)

    expect(syncConfigsLines).toEqual(["SYNC_CONFIGS=core-plugin-data,community-plugin-data,app"])
  })

  // The root template documents the default on a commented line; operators
  // who uncomment it pin whatever it says.
  it("the root .env.example documents the compose default", () => {
    const syncConfigsLines = readRepoFile(".env.example").match(SYNC_CONFIGS_ASSIGNMENT_LINE)

    expect(syncConfigsLines).toEqual(["# SYNC_CONFIGS=core-plugin-data,community-plugin-data,app"])
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

    expect(Object.keys(cliManifest.dependencies)).toEqual(["@clack/prompts", "commander"])
    for (const [dependency, version] of Object.entries(cliManifest.dependencies)) {
      expect(rootManifest.devDependencies[dependency]).toBe(version)
    }
  })
})
