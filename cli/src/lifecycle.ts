import { join, resolve } from "node:path"

import { CONTAINER_NAME, pollHealth, type DockerRunner } from "./docker.js"
import {
  detectMode,
  hasEnvPublicUrl,
  readEnvPort,
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
}

const DEFAULT_TARGET_DIR = "./vault-cortex"

/**
 * Light gate for commands that operate on an existing deployment without
 * starting a container: resolves --dir and confirms an init'd .env exists.
 * Full start-readiness validation lives in resolveDeployment.
 */
const requireInitializedDir = (
  dirFlag: string | undefined,
  prompts: Prompts,
): { targetDir: string; envFilePath: string; mode: Mode } | undefined => {
  const targetDir = resolve(expandTilde(dirFlag ?? DEFAULT_TARGET_DIR))
  const envFilePath = join(targetDir, ".env")

  const mode = detectMode(envFilePath)
  if (!mode) {
    prompts.error(
      `No .env found in ${targetDir} — run \`npx vault-cortex init\` first.`,
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

  return { mode, targetDir, envFilePath, port, vaultPath }
}

/**
 * Verifies the container runtime is reachable, reporting the shared error
 * message when it isn't. Callers early-return on false.
 */
export const ensureDaemonRunning = (
  docker: DockerRunner,
  prompts: Prompts,
): boolean => {
  if (docker.isDaemonRunning()) return true
  prompts.error(
    "Container runtime not running — start Docker Desktop, Colima,\n" +
      "OrbStack, or another Docker-compatible runtime.",
  )
  return false
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

  docker.stopAndRemoveContainer()

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
    `Start again with: npx vault-cortex restart --dir "${initialized.targetDir}"`,
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
      "No vault-cortex container — start it with `npx vault-cortex restart`.",
    )
    return 1
  }

  return await docker.streamLogs({
    follow: Boolean(flags.follow),
    since: flags.since,
  })
}

/**
 * Re-creates the container from the .env on disk and verifies health.
 * Unlike `docker restart`, this applies .env edits (the env-file is only
 * read at container creation); unlike upgrade, it never pulls an image.
 */
export const runRestart = async (
  flags: RestartFlags,
  deps: RestartDeps,
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro("vault-cortex restart")

  const deployment = resolveDeployment(flags.dir, prompts)
  if (!deployment) return 1
  if (!ensureDaemonRunning(docker, prompts)) return 1

  const exitCode = await recreateContainer(
    { deployment, healthTimeoutMs: deps.healthTimeoutMs },
    { prompts, docker, fetchFn },
  )
  if (exitCode !== 0) return exitCode

  prompts.log("Applied the current .env settings.")
  prompts.outro("Restart complete.")
  return 0
}
