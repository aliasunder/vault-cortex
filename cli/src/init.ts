import { join, resolve } from "node:path"

import { buildLocalEnv, buildRemoteEnv } from "./env.js"
import {
  buildLocalConnectMessage,
  buildRemoteConnectMessage,
} from "./messages.js"
import { OBSIDIAN_SYNC_IMAGE, pollHealth, type DockerRunner } from "./docker.js"
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
  // The select only offers mode values; the guard narrows without a cast.
  return isMode(selected) ? selected : "local"
}

const GET_TOKEN_COMMAND = `docker run --rm -it --entrypoint get-token \\
  ${OBSIDIAN_SYNC_IMAGE}`

/**
 * Offers to run the obsidian-headless-sync get-token flow in this terminal.
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
    // Renders as: "<path> doesn't look like an Obsidian vault (no .obsidian
    // folder). Use it anyway? (Y/n)"
    const useAnyway = await prompts.confirm(
      `${validation.message} Use it anyway?`,
      true,
    )
    if (!useAnyway) return askVaultPath(prompts)
  }
  return validation.path
}

/** Trailing-slash run, optionally preceded by the server's own /mcp endpoint
 *  path — stripped so PUBLIC_URL stays the bare origin (the server appends
 *  /mcp itself; keeping it here would yield /mcp/mcp in the connect URL). */
const TRAILING_MCP_OR_SLASH = /(\/mcp)?\/*$/i

/** Re-prompts until the answer is a plausible http(s) URL. */
const askPublicUrl = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text(
    // Base origin only — the server owns the /mcp path, so asking for it here
    // (and normalizing it off below) avoids a re-entered /mcp/mcp.
    "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
    {
      placeholder: "https://vault.example.com or http://203.0.113.10:8000",
    },
  )
  const trimmed = answer.trim()
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    prompts.error("PUBLIC_URL must start with http:// or https://")
    return askPublicUrl(prompts)
  }
  return trimmed.replace(TRAILING_MCP_OR_SLASH, "")
}

/** Re-prompts until non-empty. */
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

/** Non-interactive conflict policy: always keep the existing file. */
const keepExisting = async (): Promise<boolean> => false

/** Interactive conflict policy: ask per differing file, defaulting to keep. */
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
 * Offers to start the scaffolded stack, walking a gate ladder where each
 * failed gate degrades to instructions instead of an error: compose
 * installed → daemon running → user consents → compose up succeeds →
 * health check passes. Returns true only when the server is confirmed up;
 * the caller uses that to pick the right connect message.
 */
const offerComposeUp = async (
  params: { targetDir: string; port: number },
  deps: InitDeps,
): Promise<boolean> => {
  const { targetDir, port } = params
  const { prompts, docker, fetchFn } = deps
  if (!docker.isComposeAvailable()) {
    prompts.warn(
      "Docker Compose not found — install Docker to start the server:\n" +
        "https://docs.docker.com/get-docker/",
    )
    return false
  }
  if (!docker.isDaemonRunning()) {
    prompts.warn(
      "Docker is installed but not running — start Docker Desktop (or the\n" +
        "docker service on Linux), then run: docker compose up -d",
    )
    return false
  }
  const startNow = await prompts.confirm(
    "Start the server now? (docker compose up -d)",
    true,
  )
  if (!startNow) return false
  if (!docker.composeUp(targetDir)) {
    prompts.error("docker compose up failed — see output above.")
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
      "Server did not respond within 2 minutes — check: docker compose logs",
    )
    return false
  }
  spinner.stop("Server is up — health check passed.")
  return true
}

// Local flow: resolve vault path → resolve target dir → generate token →
// write docker-compose.yml + .env → optionally start the stack → print
// connect instructions. Returns a process exit code.
const runLocalInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts } = deps

  // Vault path comes from --vault-path when given and valid; interactive
  // runs fall back to prompting on a bad flag, while --yes must fail hard
  // because there is no prompt to fall back to.
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
  // Interactive: surface a bad flag before falling back to the prompt —
  // otherwise the flag appears silently ignored.
  if (!flags.yes && vaultPathResult?.kind === "error") {
    prompts.error(`--vault-path: ${vaultPathResult.message}`)
  }

  // A warn-level flag path (no .obsidian/) is accepted without the confirm a
  // prompted path gets — passing the flag is already an explicit choice.
  const vaultPath =
    vaultPathResult !== undefined && vaultPathResult.kind !== "error"
      ? vaultPathResult.path
      : await askVaultPath(prompts)

  // expandTilde before resolve: resolve() treats a leading `~` as a literal
  // path segment, so a quoted "~/path" would create a directory named "~".
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

  // Conflict policy: identical existing files are skipped silently;
  // differing ones prompt per file (default keep). --yes never overwrites —
  // any differing file becomes an exit-1 below, leaving it untouched.
  const files = buildFilesToWrite(
    "local",
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

  // When an existing .env was kept, this run's generated token was never
  // saved — the connect message must point at the token (and PORT) actually on disk,
  // or a pasted token fails auth with no hint why.
  const envResult = results.find((result) => result.name === ".env")
  const tokenWritten =
    envResult?.status === "created" || envResult?.status === "overwritten"
  if (tokenWritten) prompts.log("Generated MCP auth token (saved to .env).")
  const port = readEnvPort(join(targetDir, ".env"))

  // --yes is for scripts/CI, so it never starts Docker.
  const started = flags.yes
    ? false
    : await offerComposeUp({ targetDir, port }, deps)
  prompts.print(
    buildLocalConnectMessage({ targetDir, token, started, port, tokenWritten }),
  )
  return 0
}

// Remote flow (VPS + Obsidian Sync): resolve target dir → PUBLIC_URL →
// VAULT_NAME → Obsidian Sync token (optionally running get-token via
// Docker) → optional E2E vault password → generate token → write the
// three-service compose + .env → optionally start → print connect
// instructions. Always interactive — the sync-token step can't be defaulted.
const runRemoteInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts, docker } = deps

  // expandTilde before resolve: resolve() treats a leading `~` as a literal
  // path segment, so a quoted "~/path" would create a directory named "~".
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

  // The Obsidian Sync token comes from an interactive docker run (the
  // get-token entrypoint logs into Obsidian). We print the command, offer to
  // run it when Docker is usable, then ask the user to paste the result —
  // get-token writes to the terminal, so it can't be captured automatically.
  // A blank answer is allowed: the .env is written with an empty
  // OBSIDIAN_AUTH_TOKEN and a fill-this-in comment.
  prompts.note(GET_TOKEN_COMMAND, "Obsidian Sync token — generate once with")
  const getTokenRan =
    docker.isComposeAvailable() && docker.isDaemonRunning()
      ? await offerGetTokenRun(prompts, docker)
      : false
  // "printed above" is only true when get-token actually ran to completion.
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
  const files = buildFilesToWrite("remote", envContent)
  const results = await writeFiles(
    { targetDir, files },
    confirmOverwrite(prompts),
  )
  reportWrites({ targetDir, results }, prompts)

  // Same kept-.env handling as the local flow: the server only reads config
  // from the .env on disk, so when an existing file was kept, this run's
  // generated token was never saved (printing it would fail auth) and PORT
  // may differ from the default — describe the server that will actually
  // run, not the one this run intended to configure.
  const envResult = results.find((result) => result.name === ".env")
  const tokenWritten =
    envResult?.status === "created" || envResult?.status === "overwritten"
  if (tokenWritten) prompts.log("Generated MCP auth token (saved to .env).")
  const port = readEnvPort(join(targetDir, ".env"))

  // Without the sync token the stack can't start (obsidian-sync exits), so
  // only offer compose up when it was provided.
  const started =
    obsidianAuthToken === ""
      ? false
      : await offerComposeUp({ targetDir, port }, deps)
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

  // Mode resolution: explicit --mode wins (validated above, so the guard
  // narrows it); --yes implies local; otherwise ask, defaulting to local —
  // it's the activation path.
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
