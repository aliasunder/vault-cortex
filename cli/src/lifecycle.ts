import { join, resolve } from "node:path"

import {
  healthPollTimeoutMs,
  healthTimeoutMessage,
  isVaultCortexImage,
  pollHealth,
  probeHealth,
  type DockerRunner,
} from "./docker.js"
import { buildDaemonNotRunningMessage, buildDockerNotInstalledMessage } from "./messages.js"
import {
  detectMode,
  readEnvInstanceName,
  readEnvPort,
  readEnvPublicUrl,
  readEnvVaultPath,
  stripEnvQuotedValues,
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
  /** The .env's INSTANCE_NAME: the container this deployment owns and its volume prefix. */
  instanceName: string
  targetDir: string
  envFilePath: string
  port: number
  /** Present only in local mode. */
  vaultPath?: string
  publicUrl: string
}

const DEFAULT_TARGET_DIR = "./vault-cortex"

/**
 * Light gate for commands that use an existing deployment without starting a container:
 * - resolves --dir and confirms an init'd .env exists;
 * - reads INSTANCE_NAME, so an invalid name stops every command before it touches Docker.
 * Full start-readiness validation lives in resolveDeployment.
 */
export const requireInitializedDir = (
  dirFlag: string | undefined,
  prompts: Prompts,
): { targetDir: string; envFilePath: string; mode: Mode; instanceName: string } | undefined => {
  const targetDir = resolve(expandTilde(dirFlag ?? DEFAULT_TARGET_DIR))
  const envFilePath = join(targetDir, ".env")

  const mode = detectMode(envFilePath)

  if (!mode) {
    prompts.error(`No .env found in ${targetDir} — run \`npx vault-cortex@latest init\` first.`)
    return undefined
  }
  const instanceNameRead = readEnvInstanceName(envFilePath)

  if (instanceNameRead.kind === "invalid") {
    prompts.error(`${instanceNameRead.message} Fix it in ${targetDir}/.env.`)
    return undefined
  }
  return { targetDir, envFilePath, mode, instanceName: instanceNameRead.instanceName }
}

/** A local PUBLIC_URL is this machine's own address; a remote one is the user's domain. */
const missingPublicUrlFix = (mode: Mode, port: number): string => {
  if (mode === "local") return `Set this line in your .env:\n  PUBLIC_URL=http://localhost:${port}`
  return "Set it to the address your MCP clients reach this server at, for example:\n  PUBLIC_URL=https://vault.example.com"
}

/**
 * Resolves --dir to the on-disk deployment and validates its .env for a
 * container start: mode detection, PORT, VAULT_PATH (local), and PUBLIC_URL.
 * Reports each failure via prompts.error and returns undefined.
 * Shared by init, start, restart, upgrade and configure so their precondition checks can't drift.
 */
export const resolveDeployment = (
  dirFlag: string | undefined,
  prompts: Prompts,
): Deployment | undefined => {
  const initialized = requireInitializedDir(dirFlag, prompts)

  if (!initialized) return undefined
  const { targetDir, envFilePath, mode, instanceName } = initialized

  const portRead = readEnvPort(envFilePath)

  if (portRead.kind === "invalid") {
    prompts.error(`${portRead.message} Fix it in ${targetDir}/.env.`)
    return undefined
  }
  const { port } = portRead
  const vaultPath = mode === "local" ? readEnvVaultPath(envFilePath) : undefined

  if (mode === "local" && !vaultPath) {
    prompts.error(
      `VAULT_PATH is empty or missing in ${targetDir}/.env — cannot start the container.`,
    )
    return undefined
  }
  const publicUrl = readEnvPublicUrl(envFilePath)

  if (!publicUrl) {
    prompts.error(
      `PUBLIC_URL is empty or missing in ${targetDir}/.env — the server requires it.\n` +
        missingPublicUrlFix(mode, port),
    )
    return undefined
  }
  return { mode, instanceName, targetDir, envFilePath, port, vaultPath, publicUrl }
}

/**
 * Verifies the container runtime is reachable, reporting the shared error
 * message when it isn't. Callers early-return on false.
 */
export const ensureDaemonRunning = (docker: DockerRunner, prompts: Prompts): boolean => {
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
    spinner.stop(`Public URL responds — ${healthUrl} answered from this machine.`)
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
 * Looks up the container that holds the install's name. One running another
 * image is someone else's, so no command may stop, remove or stream it: this
 * reports the refusal, and callers stop on "foreign".
 */
export const checkInstanceContainer = (
  params: { instanceName: string; envFilePath: string },
  deps: { prompts: Prompts; docker: DockerRunner },
): "none" | "own" | "foreign" => {
  const { instanceName, envFilePath } = params
  const image = deps.docker.containerImage(instanceName)

  if (!image) return "none"
  if (isVaultCortexImage(image)) return "own"
  deps.prompts.error(
    `A container named "${instanceName}" runs ${image}, not Vault Cortex, so this command leaves it alone.\n` +
      `To keep this install's data, rename that container: docker rename ${instanceName} <new-name>\n` +
      `Or change INSTANCE_NAME in ${envFilePath}: the install then starts on new, empty volumes.`,
  )
  return "foreign"
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
  const { instanceName } = deployment
  const instanceContainer = checkInstanceContainer(
    { instanceName, envFilePath: deployment.envFilePath },
    { prompts, docker },
  )

  if (instanceContainer === "foreign") return 1
  // `docker rm -f` on a missing container exits non-zero on engines < 23,
  // so the bare return value can't distinguish "nothing to remove" from a
  // real failure — only treat removal as failed when a container exists.
  // Proceeding after a genuine failure would surface as a confusing
  // "container name already in use" from docker run.
  if (instanceContainer === "own" && !docker.stopAndRemoveContainer(instanceName)) {
    prompts.error(`Could not remove the existing container — check: docker rm -f ${instanceName}`)
    return 1
  }

  stripEnvQuotedValues(deployment.envFilePath)
  prompts.log("Starting container...")
  const containerStarted = docker.dockerRun({
    mode: deployment.mode,
    instanceName,
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
  const timeoutMs = healthTimeoutMs ?? healthPollTimeoutMs(deployment.mode)
  const healthy = await pollHealth(
    {
      url: `http://127.0.0.1:${deployment.port}/healthz`,
      timeoutMs,
    },
    fetchFn,
  )

  if (!healthy) {
    spinner.stop(healthTimeoutMessage({ mode: deployment.mode, timeoutMs, instanceName }))
    return 1
  }
  spinner.stop("Server is up — health check passed.")

  // Informational only — the container is confirmed healthy above, so the
  // public-URL result never changes the exit code. A local PUBLIC_URL is the
  // localhost address the health check just reached, so only remote probes it.
  if (deployment.mode === "remote") {
    await reportPublicUrlProbe(deployment.publicUrl, { prompts, fetchFn })
  }
  return 0
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
  const instanceContainer = checkInstanceContainer(
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
  const instanceContainer = checkInstanceContainer(
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
