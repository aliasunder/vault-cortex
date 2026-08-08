import { join, resolve } from "node:path"

import {
  CONTAINER_NAME,
  pollHealth,
  probeHealth,
  type DockerRunner,
} from "./docker.js"
import {
  buildDaemonNotRunningMessage,
  buildDockerNotInstalledMessage,
} from "./messages.js"
import {
  detectMode,
  hasEnvPublicUrl,
  readEnvPort,
  readEnvPublicUrl,
  readEnvVaultPath,
  type Mode,
} from "./scaffold.js"
import { expandTilde } from "./vault.js"
import type { Prompts } from "./prompts.js"

export type DownFlags = {
  dir?: string
}

export type LogsFlags = {
  dir?: string
  follow?: boolean
  since?: string
}

export type RestartFlags = {
  dir?: string
}

export type DownDeps = {
  prompts: Prompts
  docker: DockerRunner
}

export type LogsDeps = {
  prompts: Prompts
  docker: DockerRunner
}

export type RestartDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
  /** Override the health-check timeout for testing. */
  healthTimeoutMs?: number
}

/** An init'd deployment on disk, reconstructed from its .env file. */
export type Deployment = {
  mode: Mode
  targetDir: string
  envFilePath: string
  port: number
  /** Present only in local mode. */
  vaultPath?: string
  /** The .env's PUBLIC_URL, when set. */
  publicUrl?: string
}

const DEFAULT_TARGET_DIR = "./vault-cortex"

/**
 * Light gate for commands that operate on an existing deployment without
 * starting a container: resolves --dir and confirms an init'd .env exists.
 * Full start-readiness validation lives in resolveDeployment.
 */
export const requireInitializedDir = (
  dirFlag: string | undefined,
  prompts: Prompts,
): { targetDir: string; envFilePath: string; mode: Mode } | undefined => {
  const targetDir = resolve(expandTilde(dirFlag ?? DEFAULT_TARGET_DIR))
  const envFilePath = join(targetDir, ".env")

  const mode = detectMode(envFilePath)
  if (!mode) {
    prompts.error(
      `No .env found in ${targetDir} — run \`npx vault-cortex@latest init\` first.`,
    )
    return undefined
  }
  return { targetDir, envFilePath, mode }
}

/**
 * Resolves --dir to the on-disk deployment and validates its .env for a
 * container start: mode detection, VAULT_PATH (local), and PUBLIC_URL
 * (local). Reports each failure via prompts.error and returns undefined.
 * Shared by upgrade and restart so their precondition checks can't drift.
 */
export const resolveDeployment = (
  dirFlag: string | undefined,
  prompts: Prompts,
): Deployment | undefined => {
  const initialized = requireInitializedDir(dirFlag, prompts)
  if (!initialized) return undefined
  const { targetDir, envFilePath, mode } = initialized

  const port = readEnvPort(envFilePath)
  const vaultPath = mode === "local" ? readEnvVaultPath(envFilePath) : undefined
  if (mode === "local" && !vaultPath) {
    prompts.error(
      `VAULT_PATH is empty or missing in ${targetDir}/.env — cannot start the container.`,
    )
    return undefined
  }
  if (mode === "local" && !hasEnvPublicUrl(envFilePath)) {
    prompts.error(
      `PUBLIC_URL not found in ${targetDir}/.env — the server requires it.\n` +
        `Add this line to your .env:\n  PUBLIC_URL=http://localhost:${port}`,
    )
    return undefined
  }

  const publicUrl = readEnvPublicUrl(envFilePath)
  return { mode, targetDir, envFilePath, port, vaultPath, publicUrl }
}

/**
 * Verifies the container runtime is reachable, reporting the shared error
 * message when it isn't. Callers early-return on false.
 */
export const ensureDaemonRunning = (
  docker: DockerRunner,
  prompts: Prompts,
): boolean => {
  const daemonStatus = docker.daemonStatus()
  if (daemonStatus === "running") return true
  prompts.error(
    daemonStatus === "not-installed"
      ? buildDockerNotInstalledMessage({ nextStep: "" })
      : buildDaemonNotRunningMessage("."),
  )
  return false
}

/**
 * The URL the post-start probe should check, or undefined when the probe
 * shouldn't run: local's PUBLIC_URL is the derived localhost URL, so probing
 * it would only duplicate the health check the start cycle just ran.
 */
const postStartProbeUrl = (deployment: Deployment): string | undefined => {
  if (deployment.mode !== "remote") return undefined
  return deployment.publicUrl
}

/**
 * One-shot informational probe of the public /healthz after a confirmed
 * container start. Never a gate: a failure warns and the command still
 * succeeds — before HTTPS/ingress access is set up an unreachable public URL
 * is the expected state, and this machine's result doesn't prove the same
 * for other devices (a VPS may not reach its own public address). Returning
 * void keeps the informational contract structural.
 */
export const reportPublicUrlProbe = async (
  publicUrl: string,
  deps: { prompts: Prompts; fetchFn: typeof fetch },
): Promise<void> => {
  const { prompts, fetchFn } = deps
  // A hand-edited .env value may carry a trailing slash; strip it so the
  // probe URL is `${base}/healthz`, never `${base}//healthz`.
  const healthUrl = `${publicUrl.replace(/\/+$/, "")}/healthz`
  const spinner = prompts.spinner()
  spinner.start(`Checking the public URL (${healthUrl})`)
  const publicUrlResponded = await probeHealth({ url: healthUrl }, fetchFn)
  if (publicUrlResponded) {
    spinner.stop(
      `Public URL responds — ${healthUrl} answered from this machine.`,
    )
    return
  }
  spinner.stop(`No answer from ${healthUrl} yet.`)
  prompts.warn(
    "The server is up, but its public URL didn't answer from this machine.\n" +
      "That's expected until HTTPS (or direct port) access is set up — and\n" +
      "some networks keep a server from reaching its own public address even\n" +
      "when other devices can. Once access is set up, check from any device:\n" +
      `  curl ${healthUrl}`,
  )
}

/**
 * Stop-and-remove → docker run → health poll, with the shared messaging.
 * Returns a process exit code. Callers own the daemon check and any
 * image-pull step.
 */
export const recreateContainer = async (
  params: { deployment: Deployment; healthTimeoutMs?: number },
  deps: { prompts: Prompts; docker: DockerRunner; fetchFn: typeof fetch },
): Promise<number> => {
  const { deployment, healthTimeoutMs } = params
  const { prompts, docker, fetchFn } = deps

  // `docker rm -f` on a missing container exits non-zero on engines < 23,
  // so the bare return value can't distinguish "nothing to remove" from a
  // real failure — only treat removal as failed when a container exists.
  // Proceeding after a genuine failure would surface as a confusing
  // "container name already in use" from docker run.
  if (docker.containerExists() && !docker.stopAndRemoveContainer()) {
    prompts.error(
      `Could not remove the existing container — check: docker rm -f ${CONTAINER_NAME}`,
    )
    return 1
  }

  prompts.log("Starting container...")
  const containerStarted = docker.dockerRun({
    mode: deployment.mode,
    envFilePath: deployment.envFilePath,
    port: deployment.port,
    vaultPath: deployment.vaultPath,
  })
  if (!containerStarted) {
    prompts.error("docker run failed — see output above.")
    return 1
  }

  const spinner = prompts.spinner()
  spinner.start("Waiting for the server to come up")
  const healthy = await pollHealth(
    {
      url: `http://127.0.0.1:${deployment.port}/healthz`,
      timeoutMs: healthTimeoutMs,
    },
    fetchFn,
  )
  if (!healthy) {
    spinner.stop(
      `Server did not respond within 2 minutes — check: docker logs ${CONTAINER_NAME}`,
    )
    return 1
  }
  spinner.stop("Server is up — health check passed.")

  // Informational only — the container is confirmed healthy above, so the
  // public-URL result never changes the exit code.
  const probeUrl = postStartProbeUrl(deployment)
  if (probeUrl) {
    await reportPublicUrlProbe(probeUrl, { prompts, fetchFn })
  }
  return 0
}

/**
 * Stops and removes the container. Vault data, the search index, and .env
 * settings all live outside the container (bind mount, named volumes, host
 * file), so this is always safe.
 */
export const runDown = async (
  flags: DownFlags,
  deps: DownDeps,
): Promise<number> => {
  const { prompts, docker } = deps

  prompts.intro("vault-cortex down")

  // Teardown only needs to confirm this is an init'd directory — the full
  // .env validation (VAULT_PATH, PUBLIC_URL) guards container starts.
  const initialized = requireInitializedDir(flags.dir, prompts)
  if (!initialized) return 1
  if (!ensureDaemonRunning(docker, prompts)) return 1

  if (!docker.containerExists()) {
    prompts.log("No vault-cortex container found — nothing to stop.")
    prompts.outro("Done.")
    return 0
  }

  if (!docker.stopAndRemoveContainer()) {
    prompts.error(
      `Could not remove the container — check: docker rm -f ${CONTAINER_NAME}`,
    )
    return 1
  }

  prompts.log(
    "Container stopped and removed. Your vault data, search index, and settings are untouched.",
  )
  prompts.outro(
    `Start again with: npx vault-cortex@latest start --dir "${initialized.targetDir}"`,
  )
  return 0
}

/**
 * Streams `docker logs` for the vault-cortex container. The stream's exit
 * code passes through as the command's exit code; no outro follows the raw
 * docker output.
 */
export const runLogs = async (
  flags: LogsFlags,
  deps: LogsDeps,
): Promise<number> => {
  const { prompts, docker } = deps

  prompts.intro("vault-cortex logs")

  const initialized = requireInitializedDir(flags.dir, prompts)
  if (!initialized) return 1
  if (!ensureDaemonRunning(docker, prompts)) return 1

  if (!docker.containerExists()) {
    prompts.error(
      `No vault-cortex container — start it with: npx vault-cortex@latest start --dir "${initialized.targetDir}"`,
    )
    return 1
  }

  return await docker.streamLogs({
    follow: Boolean(flags.follow),
    since: flags.since,
  })
}

/**
 * Shared start/restart cycle: re-create the container from the .env on disk
 * and verify health. One implementation, two command names — the labels are
 * the only divergence, phrased for the intent each name serves.
 */
const runRecreateFromEnv = async (
  flags: RestartFlags,
  deps: RestartDeps,
  labels: { introTitle: string; successLog: string; outroMessage: string },
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro(labels.introTitle)

  const deployment = resolveDeployment(flags.dir, prompts)
  if (!deployment) return 1
  if (!ensureDaemonRunning(docker, prompts)) return 1

  const exitCode = await recreateContainer(
    { deployment, healthTimeoutMs: deps.healthTimeoutMs },
    { prompts, docker, fetchFn },
  )
  if (exitCode !== 0) return exitCode

  prompts.log(labels.successLog)
  prompts.outro(labels.outroMessage)
  return 0
}

/**
 * Starts the server from the saved .env — the command name users reach for
 * when nothing is running yet (after `down`, or an init that skipped the
 * start offer). Same cycle as restart: if a container is already running it
 * is safely replaced, and `docker run` pulls the image when it's missing.
 */
export const runStart = async (
  flags: RestartFlags,
  deps: RestartDeps,
): Promise<number> => {
  return runRecreateFromEnv(flags, deps, {
    introTitle: "vault-cortex start",
    successLog: "Started with the settings from .env.",
    outroMessage: "Start complete.",
  })
}

/**
 * Re-creates the container from the .env on disk and verifies health.
 * Unlike `docker restart`, this applies .env edits (the env-file is only
 * read at container creation); unlike upgrade, it never replaces an image
 * you already have (`docker run` still pulls when none exists locally).
 */
export const runRestart = async (
  flags: RestartFlags,
  deps: RestartDeps,
): Promise<number> => {
  return runRecreateFromEnv(flags, deps, {
    introTitle: "vault-cortex restart",
    successLog: "Applied the current .env settings.",
    outroMessage: "Restart complete.",
  })
}
