import { join, resolve } from "node:path"

import { buildLocalEnv, buildRemoteEnv } from "./env.js"
import {
  buildLocalConnectMessage,
  buildRemoteConnectMessage,
} from "./messages.js"
import { REMOTE_IMAGE, pollHealth, type DockerRunner } from "./docker.js"
import {
  buildFilesToWrite,
  readEnvPort,
  writeFiles,
  type FileWriteResult,
  type Mode,
} from "./scaffold.js"
import { generateToken } from "./token.js"
import { expandTilde, validateVaultPath } from "./vault.js"
import type { Prompts } from "./prompts.js"

export type InitFlags = {
  mode?: string
  vaultPath?: string
  dir?: string
  yes?: boolean
}

export type InitDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
}

const DEFAULT_TARGET_DIR = "./vault-cortex"

const isMode = (value: string): value is Mode =>
  value === "local" || value === "remote"

const askMode = async (prompts: Prompts): Promise<Mode> => {
  const selected = await prompts.select(
    "How do you want to run Vault Cortex?",
    [
      {
        value: "local",
        label: "Local",
        hint: "Docker on this machine, bind-mounted vault",
      },
      {
        value: "remote",
        label: "Remote",
        hint: "VPS + Obsidian Sync, access from anywhere",
      },
    ],
    "local",
  )
  return isMode(selected) ? selected : "local"
}

const GET_TOKEN_COMMAND = `docker run --rm -it --entrypoint get-token \\
  ${REMOTE_IMAGE}`

/**
 * Offers to run the vault-cortex image's get-token flow in this terminal.
 * Returns true only when it ran to completion (and so printed a token the
 * user can scroll up to). The handoff log exists because the clack UI gives
 * way to raw docker output — image pull, then the tool's own login prompts.
 */
const offerGetTokenRun = async (
  prompts: Prompts,
  docker: DockerRunner,
): Promise<boolean> => {
  const runNow = await prompts.confirm("Run the get-token command now?", true)
  if (!runNow) return false
  prompts.log(
    "Handing the terminal to get-token — it will ask for your Obsidian " +
      "account login and print a token at the end.",
  )
  if (!docker.runGetToken()) {
    prompts.warn(
      "get-token did not complete — you can run it later and edit .env.",
    )
    return false
  }
  return true
}

/**
 * Asks for the vault path, recursing to re-prompt until it gets a usable
 * answer. A path that doesn't exist is a hard error (likely a typo); a
 * directory without .obsidian/ is only a soft warning, because vault-cortex
 * works on any folder of Markdown files — the confirm (defaulting to yes)
 * exists to catch mistyped paths, not to block non-Obsidian folders.
 */
const askVaultPath = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text("Path to your Obsidian vault:", {
    placeholder: "/Users/you/Documents/MyVault",
  })
  const validation = validateVaultPath(answer)
  if (validation.kind === "error") {
    prompts.error(validation.message)
    return askVaultPath(prompts)
  }
  if (validation.kind === "warn") {
    const useAnyway = await prompts.confirm(
      `${validation.message} Use it anyway?`,
      true,
    )
    if (!useAnyway) return askVaultPath(prompts)
  }
  return validation.path
}

const TRAILING_MCP_PATH = /\/mcp\/*$/i

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

const askPublicUrl = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text(
    "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
    {
      placeholder: "https://vault.example.com or http://203.0.113.10:8000",
    },
  )
  const trimmed = answer.trim()
  const url = parseHttpUrl(trimmed)
  if (url === null) {
    prompts.error(
      "PUBLIC_URL must be a full http:// or https:// URL (e.g. https://vault.example.com).",
    )
    return askPublicUrl(prompts)
  }
  if (TRAILING_MCP_PATH.test(url.pathname)) {
    prompts.error(
      "Leave /mcp off PUBLIC_URL — it's the base URL and the server adds /mcp itself (e.g. https://vault.example.com).",
    )
    return askPublicUrl(prompts)
  }
  return trimmed.replace(/\/+$/, "")
}

const askVaultName = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text(
    "Exact name of your Obsidian vault (case-sensitive):",
  )
  if (answer.trim() === "") {
    prompts.error(
      "VAULT_NAME is required — it must match your vault name in Obsidian Sync.",
    )
    return askVaultName(prompts)
  }
  return answer.trim()
}

const keepExisting = async (): Promise<boolean> => false

const confirmOverwrite =
  (prompts: Prompts) =>
  (name: string): Promise<boolean> =>
    prompts.confirm(`${name} already exists and differs — overwrite?`, false)

const reportWrites = (
  params: { targetDir: string; results: FileWriteResult[] },
  prompts: Prompts,
): void => {
  const { targetDir, results } = params
  for (const result of results) {
    const verb = {
      created: "created",
      unchanged: "unchanged (already up to date)",
      overwritten: "overwritten",
      kept: "kept existing file (new content NOT written)",
    }[result.status]
    prompts.log(`${targetDir}/${result.name} — ${verb}`)
  }
}

/**
 * Offers to start the container, walking a gate ladder where each failed
 * gate degrades to instructions instead of an error: daemon running → user
 * consents → docker run succeeds → health check passes. Returns true only
 * when the server is confirmed up.
 */
const offerDockerRun = async (
  params: { targetDir: string; port: number; mode: Mode; vaultPath?: string },
  deps: InitDeps,
): Promise<boolean> => {
  const { targetDir, port, mode, vaultPath } = params
  const { prompts, docker, fetchFn } = deps
  if (!docker.isDaemonRunning()) {
    prompts.warn(
      "Docker daemon not running — start your container runtime\n" +
        "(Docker Desktop, Colima, OrbStack, etc.), then run:\n" +
        `  npx vault-cortex upgrade --dir "${targetDir}"`,
    )
    return false
  }
  const startNow = await prompts.confirm("Start the server now?", true)
  if (!startNow) return false
  if (
    !docker.dockerRun({
      mode,
      envFilePath: join(targetDir, ".env"),
      port,
      vaultPath,
    })
  ) {
    prompts.error("docker run failed — see output above.")
    return false
  }

  const spinner = prompts.spinner()
  spinner.start(
    "Waiting for the server to come up (first run pulls a ~150MB image)",
  )
  const healthy = await pollHealth(
    { url: `http://127.0.0.1:${port}/healthz` },
    fetchFn,
  )
  if (!healthy) {
    spinner.stop(
      "Server did not respond within 2 minutes — check: docker logs vault-cortex",
    )
    return false
  }
  spinner.stop("Server is up — health check passed.")
  return true
}

// Local flow: resolve vault path → resolve target dir → generate token →
// write .env → optionally start the container → print connect instructions.
const runLocalInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts } = deps

  const vaultPathResult =
    flags.vaultPath === undefined
      ? undefined
      : validateVaultPath(flags.vaultPath)
  if (flags.yes) {
    if (vaultPathResult === undefined || vaultPathResult.kind === "error") {
      prompts.error(vaultPathResult?.message ?? "--yes requires --vault-path.")
      return 1
    }
  }
  if (!flags.yes && vaultPathResult?.kind === "error") {
    prompts.error(`--vault-path: ${vaultPathResult.message}`)
  }

  const vaultPath =
    vaultPathResult !== undefined && vaultPathResult.kind !== "error"
      ? vaultPathResult.path
      : await askVaultPath(prompts)

  const targetDir = resolve(
    expandTilde(
      flags.dir ??
        (flags.yes
          ? DEFAULT_TARGET_DIR
          : await prompts.text("Where should I put the config files?", {
              defaultValue: DEFAULT_TARGET_DIR,
              placeholder: DEFAULT_TARGET_DIR,
            })),
    ),
  )

  const token = generateToken()

  const files = buildFilesToWrite(
    buildLocalEnv({ mcpAuthToken: token, vaultPath }),
  )
  const resolveConflict = flags.yes ? keepExisting : confirmOverwrite(prompts)
  const results = await writeFiles({ targetDir, files }, resolveConflict)
  reportWrites({ targetDir, results }, prompts)

  const keptConflicts = results.filter((result) => result.status === "kept")
  if (flags.yes && keptConflicts.length > 0) {
    prompts.error(
      `Existing files differ (${keptConflicts.map((result) => result.name).join(", ")}) — refusing to overwrite in --yes mode.`,
    )
    return 1
  }

  const envResult = results.find((result) => result.name === ".env")
  const tokenWritten =
    envResult?.status === "created" || envResult?.status === "overwritten"
  if (tokenWritten) prompts.log("Generated MCP auth token (saved to .env).")
  const port = readEnvPort(join(targetDir, ".env"))

  const started = flags.yes
    ? false
    : await offerDockerRun({ targetDir, port, mode: "local", vaultPath }, deps)
  prompts.print(
    buildLocalConnectMessage({ targetDir, token, started, port, tokenWritten }),
  )
  return 0
}

// Remote flow (VPS + Obsidian Sync): resolve target dir → PUBLIC_URL →
// VAULT_NAME → Obsidian Sync token (optionally running get-token via
// Docker) → optional E2E vault password → generate token → write .env →
// optionally start → print connect instructions. Always interactive.
const runRemoteInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts, docker } = deps

  const targetDir = resolve(
    expandTilde(
      flags.dir ??
        (await prompts.text("Where should I put the config files?", {
          defaultValue: DEFAULT_TARGET_DIR,
          placeholder: DEFAULT_TARGET_DIR,
        })),
    ),
  )

  const publicUrl = await askPublicUrl(prompts)
  const vaultName = await askVaultName(prompts)

  prompts.note(GET_TOKEN_COMMAND, "Obsidian Sync token — generate once with")
  const getTokenRan = docker.isDaemonRunning()
    ? await offerGetTokenRun(prompts, docker)
    : false
  const pastePrompt = getTokenRan
    ? "Paste the Obsidian Sync token printed above (leave blank to fill in .env later):"
    : "Paste the Obsidian Sync token (leave blank to fill in .env later):"
  const obsidianAuthToken = (
    await prompts.text(pastePrompt, { defaultValue: "" })
  ).trim()

  const usesEncryption = await prompts.confirm(
    "Does your vault use end-to-end encryption?",
    false,
  )
  const vaultPassword = usesEncryption
    ? await prompts.password("Vault encryption password:")
    : undefined

  const token = generateToken()

  const envContent = buildRemoteEnv({
    mcpAuthToken: token,
    publicUrl,
    obsidianAuthToken,
    vaultName,
    vaultPassword,
  })
  const files = buildFilesToWrite(envContent)
  const results = await writeFiles(
    { targetDir, files },
    confirmOverwrite(prompts),
  )
  reportWrites({ targetDir, results }, prompts)

  const envResult = results.find((result) => result.name === ".env")
  const tokenWritten =
    envResult?.status === "created" || envResult?.status === "overwritten"
  if (tokenWritten) prompts.log("Generated MCP auth token (saved to .env).")
  const port = readEnvPort(join(targetDir, ".env"))

  const started =
    obsidianAuthToken === ""
      ? false
      : await offerDockerRun({ targetDir, port, mode: "remote" }, deps)
  prompts.print(
    buildRemoteConnectMessage({
      targetDir,
      token,
      publicUrl,
      started,
      obsidianTokenMissing: obsidianAuthToken === "",
      tokenWritten,
    }),
  )
  return 0
}

export const runInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts } = deps

  if (flags.mode !== undefined && !isMode(flags.mode)) {
    prompts.error(
      `Unknown mode "${flags.mode}" — expected "local" or "remote".`,
    )
    return 1
  }
  if (flags.yes && flags.mode === "remote") {
    prompts.error(
      "--yes only supports local mode — remote setup needs interactive token prompts.",
    )
    return 1
  }
  if (flags.yes && flags.vaultPath === undefined) {
    prompts.error("--yes requires --vault-path.")
    return 1
  }

  prompts.intro("vault-cortex init")

  const mode: Mode =
    flags.mode !== undefined && isMode(flags.mode)
      ? flags.mode
      : flags.yes
        ? "local"
        : await askMode(prompts)

  const exitCode =
    mode === "local"
      ? await runLocalInit(flags, deps)
      : await runRemoteInit(flags, deps)
  if (exitCode === 0) prompts.outro("Done.")
  return exitCode
}
