import { containerStart } from "./container-start.js"
import { ensureDaemonRunning, requireInitializedDir, resolveDeployment } from "./deployment.js"
import type { DockerRunner } from "./docker.js"
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

/**
 * Stops and removes the container. Vault data, the search index, and .env
 * settings all live outside the container (bind mount, named volumes, host
 * file), so this is always safe.
 */
export const runDown = async (flags: DownFlags, deps: DownDeps): Promise<number> => {
  const { prompts, docker } = deps

  prompts.intro("vault-cortex down")

  // Teardown only needs to confirm this is an init'd directory — the full
  // .env validation (PORT, VAULT_PATH, PUBLIC_URL) guards container starts.
  const initialized = requireInitializedDir(flags.dir, prompts)

  if (!initialized) return 1
  if (!ensureDaemonRunning(docker, prompts)) return 1
  const { instanceName, envFilePath, targetDir } = initialized
  const instanceContainer = containerStart.checkInstanceContainer(
    { instanceName, envFilePath },
    { prompts, docker },
  )

  if (instanceContainer === "foreign") return 1
  if (instanceContainer === "none") {
    prompts.log(`No ${instanceName} container found — nothing to stop.`)
    prompts.outro("Done.")
    return 0
  }

  if (!docker.stopAndRemoveContainer(instanceName)) {
    prompts.error(`Could not remove the container — check: docker rm -f ${instanceName}`)
    return 1
  }

  prompts.log(
    "Container stopped and removed. Your vault data, search index, and settings are untouched.",
  )
  prompts.outro(`Start again with: npx vault-cortex@latest start --dir "${targetDir}"`)
  return 0
}

/**
 * Streams `docker logs` for the deployment's container. The stream's exit
 * code passes through as the command's exit code; no outro follows the raw
 * docker output.
 */
export const runLogs = async (flags: LogsFlags, deps: LogsDeps): Promise<number> => {
  const { prompts, docker } = deps

  prompts.intro("vault-cortex logs")

  const initialized = requireInitializedDir(flags.dir, prompts)

  if (!initialized) return 1
  if (!ensureDaemonRunning(docker, prompts)) return 1
  const { instanceName, envFilePath, targetDir } = initialized
  const instanceContainer = containerStart.checkInstanceContainer(
    { instanceName, envFilePath },
    { prompts, docker },
  )

  if (instanceContainer === "foreign") return 1
  if (instanceContainer === "none") {
    prompts.error(
      `No ${instanceName} container — start it with: npx vault-cortex@latest start --dir "${targetDir}"`,
    )
    return 1
  }

  return await docker.streamLogs({
    instanceName,
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

  const exitCode = await containerStart.recreate(
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
export const runStart = async (flags: RestartFlags, deps: RestartDeps): Promise<number> => {
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
export const runRestart = async (flags: RestartFlags, deps: RestartDeps): Promise<number> => {
  return runRecreateFromEnv(flags, deps, {
    introTitle: "vault-cortex restart",
    successLog: "Applied the current .env settings.",
    outroMessage: "Restart complete.",
  })
}
