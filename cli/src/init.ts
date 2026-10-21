import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

import { buildLocalEnv, buildRemoteEnv } from "./env.js"
import { captureObsidianToken } from "./get-sync-token.js"
import {
  buildDaemonNotRunningMessage,
  buildDockerNotInstalledMessage,
  buildLocalConnectMessage,
  buildRemoteConnectMessage,
  startCommand,
  type StartStatus,
} from "./messages.js"
import {
  healthPollTimeoutMs,
  healthTimeoutMessage,
  pollHealth,
  type DockerRunner,
} from "./docker.js"
import { applyInstanceIdentity, resolveInstanceIdentity } from "./instance-identity.js"
import { reportPublicUrlProbe } from "./lifecycle.js"
import {
  applyOptionalSettings,
  askOptionalSettings,
  derivePublicUrlOverride,
  describeStrandedPublicUrl,
} from "./optional-settings.js"
import {
  buildFilesToWrite,
  readEnvInstanceName,
  readEnvObsidianToken,
  readEnvPort,
  readEnvPublicUrl,
  stripEnvQuotedValues,
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
  /** INSTANCE_NAME for this install, skipping the name-in-use prompt. */
  instanceName?: string
  /** Host PORT for this install. */
  port?: string
  yes?: boolean
}

export type InitDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
}

const DEFAULT_TARGET_DIR = "./vault-cortex"

const isMode = (value: string): value is Mode => value === "local" || value === "remote"

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

/**
 * Offers to sign in to the Obsidian account and capture the Sync token.
 * Returns the captured token string, or undefined when the user declines
 * or the capture fails (the caller falls back to any token already in the
 * on-disk .env, or shows get-sync-token guidance).
 */
const offerSyncTokenCapture = async (
  prompts: Prompts,
  fetchFn: typeof fetch,
): Promise<string | undefined> => {
  prompts.log(
    "Your server needs an Obsidian Sync token to access your vault.\n" +
      "You can sign in to your Obsidian account now to generate one.",
  )
  const runNow = await prompts.confirm("Generate the token now?", true)

  if (!runNow) return undefined
  return captureObsidianToken({ prompts, fetchFn })
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
    const useAnyway = await prompts.confirm(`${validation.message} Use it anyway?`, true)

    if (!useAnyway) return askVaultPath(prompts)
  }
  return validation.path
}

/**
 * A trailing `/mcp` path segment, optionally followed by slashes, anchored to
 * the end of a URL's pathname (`/MCP`, `/mcp/` match too via the `i` flag —
 * WHATWG URL preserves path case). The server owns the `/mcp` endpoint and
 * appends it when building the connect URL, so PUBLIC_URL must be the base
 * origin; a re-included `/mcp` is rejected, not silently rewritten.
 */
const TRAILING_MCP_PATH = /\/mcp\/*$/i

/**
 * Parses an http(s) URL with the WHATWG `URL` constructor, returning null for
 * anything it can't be: bad syntax, a missing scheme, or a non-http(s)
 * protocol (`ws:`, `file:`, ...). More robust than a `startsWith` check, which
 * would pass malformed inputs like `https://` or `https://a b.com`.
 */
const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

export type PublicUrlValidation = { kind: "ok"; url: string } | { kind: "error"; message: string }

/** Validates a PUBLIC_URL value: must be a bare http(s) origin — no path, credentials, query, or fragment. */
export const validatePublicUrl = (input: string): PublicUrlValidation => {
  const trimmed = input.trim()
  const url = parseHttpUrl(trimmed)

  if (!url) {
    return {
      kind: "error",
      message:
        "PUBLIC_URL must be a full http:// or https:// URL (e.g. https://vault.example.com).",
    }
  }
  if (url.username || url.password) {
    return {
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    }
  }
  // Raw-string check: url.search/url.hash return "" for bare delimiters
  // (WHATWG spec treats empty-string and null query/fragment identically),
  // so a parsed-property check misses "https://host/?" and "https://host/#".
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return {
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    }
  }
  if (TRAILING_MCP_PATH.test(url.pathname)) {
    return {
      kind: "error",
      message:
        "Leave /mcp off PUBLIC_URL — it's the base URL and the server adds /mcp itself (e.g. https://vault.example.com).",
    }
  }
  if (url.pathname.replace(/\/+$/, "") !== "") {
    return {
      kind: "error",
      message:
        "PUBLIC_URL must be a bare origin — no path (e.g. https://vault.example.com, not https://vault.example.com/vault/).",
    }
  }
  // Trim trailing slashes so the connect URL is `${base}/mcp`, never
  // `${base}//mcp`.
  return { kind: "ok", url: trimmed.replace(/\/+$/, "") }
}

const askTargetDir = async (prompts: Prompts): Promise<string> => {
  return await prompts.text("Where should I put the config files?", {
    defaultValue: DEFAULT_TARGET_DIR,
    placeholder: DEFAULT_TARGET_DIR,
  })
}

/** Re-prompts until the answer is a valid base http(s) URL (no /mcp path). */
const askPublicUrl = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text(
    "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
    {
      placeholder: "https://vault.example.com or http://203.0.113.10:8000",
    },
  )
  const result = validatePublicUrl(answer)

  if (result.kind === "error") {
    prompts.error(result.message)
    return askPublicUrl(prompts)
  }
  return result.url
}

/** Re-prompts until non-empty. */
const askVaultName = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text("Exact name of your Obsidian vault (case-sensitive):")

  if (answer.trim() === "") {
    prompts.error("VAULT_NAME is required — it must match your vault name in Obsidian Sync.")
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

/**
 * Re-init guard, fired the moment the target dir is known (prompt answer or
 * --dir flag): an existing .env there means a live deployment, so the flow
 * checks intent before any further questions are spent — re-running init over
 * a deployment is usually an accident, and settings changes belong to
 * `configure`. Declining (the default) backs out with pointers; accepting
 * continues, still protected by the per-file overwrite confirms at write time.
 */
const confirmReinitOverExistingEnv = async (
  targetDir: string,
  prompts: Prompts,
): Promise<boolean> => {
  if (!existsSync(join(targetDir, ".env"))) return true
  prompts.log(`Found an existing deployment in ${targetDir}.`)
  const reinitAnyway = await prompts.confirm("Re-run setup for this directory anyway?", false)

  if (reinitAnyway) return true
  // No outro here: declining still exits 0, and the runInit wrapper owns the
  // closing outro (mirroring configure's declined-restart path).
  prompts.log(
    `Nothing changed. To adjust settings instead: npx vault-cortex@latest configure --dir "${targetDir}"`,
  )
  return false
}

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
 * Reads the instance name from the .env on disk, which may be a kept file
 * whose INSTANCE_NAME differs from this run's. Reports an invalid value and
 * returns undefined, so init never starts or prints commands for a bad name.
 */
const readInstanceFromDisk = (
  targetDir: string,
  prompts: Prompts,
): { instanceName: string; port: number } | undefined => {
  const envFilePath = join(targetDir, ".env")
  const instanceNameRead = readEnvInstanceName(envFilePath)
  const portRead = readEnvPort(envFilePath)

  if (instanceNameRead.kind === "invalid") {
    prompts.error(`${instanceNameRead.message} Fix it in ${targetDir}/.env.`)
    return undefined
  }
  if (portRead.kind === "invalid") {
    prompts.error(`${portRead.message} Fix it in ${targetDir}/.env.`)
    return undefined
  }
  return { instanceName: instanceNameRead.instanceName, port: portRead.port }
}

/**
 * Offers to start the container, walking a gate ladder where each failed
 * gate degrades to instructions instead of an error: daemon running → user
 * consents → any container with this name is removed → docker run succeeds
 * → health check passes. Returns "running"
 * when the server is confirmed up, "starting" when the container launched
 * but the health check timed out, or "not-started" when a gate failed.
 */
const offerDockerRun = async (
  params: { targetDir: string; instanceName: string; port: number; mode: Mode; vaultPath?: string },
  deps: InitDeps,
): Promise<StartStatus> => {
  const { targetDir, instanceName, port, mode, vaultPath } = params
  const { prompts, docker, fetchFn } = deps
  const daemonStatus = docker.daemonStatus()

  if (daemonStatus !== "running") {
    const startHint = startCommand(targetDir)
    prompts.warn(
      daemonStatus === "not-installed"
        ? buildDockerNotInstalledMessage({
            nextStep: `\nThen start the server with:\n  ${startHint}`,
          })
        : buildDaemonNotRunningMessage(`, then run:\n  ${startHint}`),
    )
    return "not-started"
  }
  // docker run refuses a name an existing container already holds, so a yes
  // replaces that container the way `start` does, and the question says so.
  const containerExists = docker.containerExists(instanceName)
  const startQuestion = containerExists
    ? `Start the server now? This stops and replaces the existing "${instanceName}" container. Its data volumes are kept.`
    : "Start the server now?"
  const startNow = await prompts.confirm(startQuestion, true)

  if (!startNow) return "not-started"
  if (containerExists && !docker.stopAndRemoveContainer(instanceName)) {
    prompts.error(`Could not remove the existing container — check: docker rm -f ${instanceName}`)
    return "not-started"
  }
  const envFilePath = join(targetDir, ".env")
  stripEnvQuotedValues(envFilePath)
  const containerStarted = docker.dockerRun({
    mode,
    instanceName,
    envFilePath,
    port,
    vaultPath,
  })

  if (!containerStarted) {
    prompts.error("docker run failed — see output above.")
    return "not-started"
  }

  const spinner = prompts.spinner()
  spinner.start("Waiting for the server to come up (first run may take a moment)")
  const timeoutMs = healthPollTimeoutMs(mode)
  const healthy = await pollHealth({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs }, fetchFn)

  if (!healthy) {
    spinner.stop(healthTimeoutMessage({ mode, timeoutMs, instanceName }))
    return "starting"
  }
  spinner.stop("Server is up — health check passed.")
  return "running"
}

// Local flow: resolve vault path → resolve target dir → generate token →
// write .env → optionally start the container → print connect instructions.
// Returns a process exit code.
const runLocalInit = async (flags: InitFlags, deps: InitDeps): Promise<number> => {
  const { prompts } = deps

  // Vault path comes from --vault-path when given and valid; interactive
  // runs fall back to prompting on a bad flag, while --yes must fail hard
  // because there is no prompt to fall back to.
  const vaultPathResult =
    flags.vaultPath === undefined ? undefined : validateVaultPath(flags.vaultPath)

  if (flags.yes) {
    if (!vaultPathResult || vaultPathResult.kind === "error") {
      // runInit rejects --yes without --vault-path before calling this, so the
      // fallback message is unreachable; it covers vaultPathResult's undefined type.
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
    vaultPathResult && vaultPathResult.kind !== "error"
      ? vaultPathResult.path
      : await askVaultPath(prompts)

  const requestedTargetDir =
    flags.dir ?? (flags.yes ? DEFAULT_TARGET_DIR : await askTargetDir(prompts))
  // expandTilde before resolve: resolve() treats a leading `~` as a literal
  // path segment, so a quoted "~/path" would create a directory named "~".
  const targetDir = resolve(expandTilde(requestedTargetDir))

  // --yes skips the guard: it's non-interactive by contract, and its own
  // conflict policy (refuse to overwrite, exit 1) already protects the dir.
  if (!flags.yes) {
    const continueReinit = await confirmReinitOverExistingEnv(targetDir, prompts)

    if (!continueReinit) return 0
  }

  const identityResult = await resolveInstanceIdentity({ mode: "local", targetDir, flags }, deps)

  if (identityResult.kind === "exit") return 1

  const token = generateToken()

  // Guided optional settings: the chooser reads current values from the
  // generated defaults; enter with nothing picked keeps them all. --yes
  // skips the chooser (non-interactive by contract). An existing .env does
  // NOT skip it: every interactive path here passed the re-init guard, so the
  // user asked for a full re-run — the answers land in the regenerated file
  // when they overwrite at the conflict prompt (keeping it discards them,
  // which the write report states). In-place edits stay configure's job.
  const generatedEnvContent = applyInstanceIdentity(
    buildLocalEnv({ mcpAuthToken: token, vaultPath }),
    identityResult.identity,
  )
  const optionalOverrides = flags.yes
    ? {}
    : await askOptionalSettings({ mode: "local", envContent: generatedEnvContent }, prompts)
  const appliedOverrides = derivePublicUrlOverride(generatedEnvContent, optionalOverrides)
  const envContent = applyOptionalSettings(generatedEnvContent, appliedOverrides)
  const publicUrlWarning = describeStrandedPublicUrl({
    envContent: generatedEnvContent,
    pickedOverrides: optionalOverrides,
    appliedOverrides,
  })

  // Conflict policy: identical existing files are skipped silently;
  // differing ones prompt per file (default keep). --yes never overwrites —
  // any differing file becomes an exit-1 below, leaving it untouched.
  const files = buildFilesToWrite(envContent)
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
  // saved — the connect message must point at the token (and PORT) actually
  // on disk, or a pasted token fails auth with no hint why.
  const envResult = results.find((result) => result.name === ".env")
  const tokenWritten = envResult?.status === "created" || envResult?.status === "overwritten"

  if (tokenWritten) prompts.log("Generated MCP auth token (saved to .env).")
  // Only a written .env carries the picked port, so a kept one needs no warning.
  if (tokenWritten && publicUrlWarning) prompts.warn(publicUrlWarning)
  const instanceOnDisk = readInstanceFromDisk(targetDir, prompts)

  if (!instanceOnDisk) return 1
  const { instanceName, port } = instanceOnDisk

  // --yes is for scripts/CI, so it never starts Docker.
  const startStatus: StartStatus = flags.yes
    ? "not-started"
    : await offerDockerRun({ targetDir, instanceName, port, mode: "local", vaultPath }, deps)
  prompts.print(
    buildLocalConnectMessage({
      targetDir,
      instanceName,
      token,
      startStatus,
      port,
      tokenWritten,
    }),
  )
  return 0
}

// Remote flow (VPS + Obsidian Sync): resolve target dir → PUBLIC_URL →
// VAULT_NAME → Obsidian Sync token (sign in via the Obsidian API) → optional
// E2E vault password → generate token → write .env → optionally start → print
// connect instructions. Always interactive — the sync-token step can't be
// defaulted.
const runRemoteInit = async (flags: InitFlags, deps: InitDeps): Promise<number> => {
  const { prompts, fetchFn } = deps

  const requestedTargetDir = flags.dir ?? (await askTargetDir(prompts))
  // expandTilde before resolve: resolve() treats a leading `~` as a literal
  // path segment, so a quoted "~/path" would create a directory named "~".
  const targetDir = resolve(expandTilde(requestedTargetDir))

  const continueReinit = await confirmReinitOverExistingEnv(targetDir, prompts)

  if (!continueReinit) return 0

  // Before the public URL prompt, so a second install's port is chosen before
  // the user types the URL that reaches it.
  const identityResult = await resolveInstanceIdentity({ mode: "remote", targetDir, flags }, deps)

  if (identityResult.kind === "exit") return 1

  const publicUrl = await askPublicUrl(prompts)
  const vaultName = await askVaultName(prompts)

  // Sign in to Obsidian and capture the Sync token directly via the API.
  // When the user declines or capture fails, fall back to any token already
  // in the on-disk .env (a re-init over an existing deployment). Only show
  // the sign-in guidance when neither source has a token.
  const capturedToken = await offerSyncTokenCapture(prompts, fetchFn)
  const existingEnvToken = readEnvObsidianToken(join(targetDir, ".env"))
  const hasSyncToken = Boolean(capturedToken ?? existingEnvToken)

  if (!hasSyncToken) {
    prompts.log(
      "No Sync token in .env — sign in on the server's sign-in page once it starts, or add a token with:\n" +
        `  npx vault-cortex@latest get-sync-token --dir "${targetDir}"`,
    )
  }

  const usesEncryption = await prompts.confirm("Does your vault use end-to-end encryption?", false)
  const vaultPassword = usesEncryption
    ? await prompts.password("Vault encryption password:")
    : undefined

  const token = generateToken()

  // Guided optional settings, mirroring the local flow — remote also offers
  // SYNC_MODE. Remote init is always interactive (no --yes), and any existing
  // .env passed the re-init guard — a consented re-run gets the full setup,
  // chooser included (see the local flow's comment for the overwrite/keep
  // semantics).
  const generatedEnvContent = applyInstanceIdentity(
    buildRemoteEnv({
      mcpAuthToken: token,
      publicUrl,
      obsidianAuthToken: capturedToken ?? existingEnvToken,
      vaultName,
      vaultPassword,
    }),
    identityResult.identity,
  )
  const optionalOverrides = await askOptionalSettings(
    { mode: "remote", envContent: generatedEnvContent },
    prompts,
  )
  const appliedOverrides = derivePublicUrlOverride(generatedEnvContent, optionalOverrides)
  const envContent = applyOptionalSettings(generatedEnvContent, appliedOverrides)
  const publicUrlWarning = describeStrandedPublicUrl({
    envContent: generatedEnvContent,
    pickedOverrides: optionalOverrides,
    appliedOverrides,
  })
  const files = buildFilesToWrite(envContent)
  const results = await writeFiles({ targetDir, files }, confirmOverwrite(prompts))
  reportWrites({ targetDir, results }, prompts)

  // Same kept-.env handling as the local flow: the server only reads config
  // from the .env on disk, so when an existing file was kept, this run's
  // generated token was never saved (printing it would fail auth) and PORT
  // may differ from the default.
  const envResult = results.find((result) => result.name === ".env")
  const tokenWritten = envResult?.status === "created" || envResult?.status === "overwritten"

  if (tokenWritten) prompts.log("Generated MCP auth token (saved to .env).")
  if (tokenWritten && publicUrlWarning) prompts.warn(publicUrlWarning)
  const instanceOnDisk = readInstanceFromDisk(targetDir, prompts)

  if (!instanceOnDisk) return 1
  const { instanceName, port } = instanceOnDisk
  // Like PORT above, PUBLIC_URL comes from the .env actually on disk — a kept
  // existing file may hold a different URL than this run's prompt, and the
  // server only reads the file. The prompted value is the fallback for a kept
  // legacy .env that predates PUBLIC_URL.
  const effectivePublicUrl = readEnvPublicUrl(join(targetDir, ".env")) ?? publicUrl

  // Started without a Sync token in .env, the container keeps a login saved
  // on its volume, or serves its sign-in page; the closing message covers both.
  const startStatus = await offerDockerRun({ targetDir, instanceName, port, mode: "remote" }, deps)

  // The container check above hit localhost on this machine; the public URL
  // is the ingress path clients actually use — probe it too, informationally.
  if (startStatus === "running") {
    await reportPublicUrlProbe(effectivePublicUrl, {
      prompts,
      fetchFn: deps.fetchFn,
    })
  }
  prompts.print(
    buildRemoteConnectMessage({
      targetDir,
      instanceName,
      token,
      publicUrl: effectivePublicUrl,
      startStatus,
      obsidianTokenMissing: !hasSyncToken,
      tokenWritten,
    }),
  )
  return 0
}

export const runInit = async (flags: InitFlags, deps: InitDeps): Promise<number> => {
  const { prompts } = deps

  if (flags.mode !== undefined && !isMode(flags.mode)) {
    prompts.error(`Unknown mode "${flags.mode}" — expected "local" or "remote".`)
    return 1
  }
  if (flags.yes && flags.mode === "remote") {
    prompts.error("--yes only supports local mode — remote setup needs interactive token prompts.")
    return 1
  }
  if (flags.yes && flags.vaultPath === undefined) {
    prompts.error("--yes requires --vault-path.")
    return 1
  }

  prompts.intro("vault-cortex init")

  // Mode resolution: explicit --mode wins; --yes implies local; otherwise
  // ask, defaulting to local — it's the simpler activation path.
  const flagMode = flags.mode && isMode(flags.mode) ? flags.mode : undefined
  const mode: Mode = flagMode ?? (flags.yes ? "local" : await askMode(prompts))

  const exitCode =
    mode === "local" ? await runLocalInit(flags, deps) : await runRemoteInit(flags, deps)

  if (exitCode === 0) prompts.outro("Done.")
  return exitCode
}
