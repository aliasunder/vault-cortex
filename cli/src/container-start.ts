import {
  healthPollTimeoutMs,
  healthTimeoutMessage,
  isVaultCortexImage,
  pollHealth,
  probeHealth,
  type DockerRunner,
} from "./docker.js"
import { envFile } from "./env-file.js"
import type { Deployment } from "./deployment.js"
import type { StartStatus } from "./messages.js"
import type { Prompts } from "./prompts.js"

/** Who holds the install's container name: nobody, a Vault Cortex container, or another app. */
type InstanceContainer = "none" | "own" | "foreign"

type ContainerStartDeps = { prompts: Prompts; docker: DockerRunner; fetchFn: typeof fetch }

/**
 * Looks up the container that holds the install's name. One running another
 * image is someone else's, so no command may stop, remove or stream it: this
 * reports the refusal, and callers stop on "foreign".
 */
const checkInstanceContainer = (
  params: { instanceName: string; envFilePath: string },
  deps: { prompts: Prompts; docker: DockerRunner },
): InstanceContainer => {
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
 * One-shot informational probe of the public /healthz after a confirmed
 * container start. Never a gate: a failure warns and the command still
 * succeeds — before HTTPS/ingress access is set up an unreachable public URL
 * is the expected state, and this machine's result doesn't prove the same
 * for other devices (a VPS may not reach its own public address). Returning
 * void keeps the informational contract structural.
 */
const reportPublicUrlProbe = async (
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
 * The start sequence every command shares, run after the caller's daemon and
 * instance-container checks:
 * 1. removes the install's own container, since docker run refuses a name in use;
 * 2. runs a new container from the .env on disk;
 * 3. waits for /healthz on this machine;
 * 4. probes a remote PUBLIC_URL once, informationally.
 * Returns "running" once healthy, "starting" when the container launched but
 * the health wait timed out, and "not-started" when removal or docker run failed.
 */
const start = async (
  params: {
    deployment: Deployment
    instanceContainer: Exclude<InstanceContainer, "foreign">
    healthTimeoutMs?: number
  },
  deps: ContainerStartDeps,
): Promise<StartStatus> => {
  const { deployment, instanceContainer, healthTimeoutMs } = params
  const { prompts, docker, fetchFn } = deps
  const { mode, instanceName, envFilePath, port } = deployment

  // `docker rm -f` on a missing container exits non-zero on engines < 23,
  // so the bare return value can't distinguish "nothing to remove" from a
  // real failure — only treat removal as failed when a container exists.
  // Proceeding after a genuine failure would surface as a confusing
  // "container name already in use" from docker run.
  if (instanceContainer === "own" && !docker.stopAndRemoveContainer(instanceName)) {
    prompts.error(`Could not remove the existing container — check: docker rm -f ${instanceName}`)
    return "not-started"
  }

  envFile.stripQuotedValues(envFilePath)
  prompts.log("Starting container...")
  const containerStarted = docker.dockerRun({
    mode,
    instanceName,
    envFilePath,
    port,
    vaultPath: deployment.vaultPath,
  })

  if (!containerStarted) {
    prompts.error("docker run failed — see output above.")
    return "not-started"
  }

  const spinner = prompts.spinner()
  spinner.start("Waiting for the server to come up")
  const timeoutMs = healthTimeoutMs ?? healthPollTimeoutMs(mode)
  const healthy = await pollHealth({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs }, fetchFn)

  if (!healthy) {
    spinner.stop(healthTimeoutMessage({ mode, timeoutMs, instanceName }))
    return "starting"
  }
  spinner.stop("Server is up — health check passed.")

  // Informational only — the container is confirmed healthy above, so the
  // public-URL result never changes the outcome. A local PUBLIC_URL is the
  // localhost address the health check just reached, so only remote probes it.
  if (mode === "remote") await reportPublicUrlProbe(deployment.publicUrl, { prompts, fetchFn })
  return "running"
}

/**
 * Re-creates the install's container without asking: the instance-container
 * check, then the start sequence. Returns a process exit code, which is 1
 * unless the server came up healthy. Callers own the daemon check and any
 * image-pull step.
 */
const recreate = async (
  params: { deployment: Deployment; healthTimeoutMs?: number },
  deps: ContainerStartDeps,
): Promise<number> => {
  const { deployment, healthTimeoutMs } = params
  const instanceContainer = checkInstanceContainer(
    { instanceName: deployment.instanceName, envFilePath: deployment.envFilePath },
    deps,
  )

  if (instanceContainer === "foreign") return 1
  const startStatus = await start({ deployment, instanceContainer, healthTimeoutMs }, deps)
  return startStatus === "running" ? 0 : 1
}

export const containerStart = { checkInstanceContainer, start, recreate }
