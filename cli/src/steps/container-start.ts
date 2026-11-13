import { pollHealth, probeHealth, type DockerRunner } from "../adapters/docker.js"
import { envFile } from "../adapters/env-file.js"
import type { Prompts } from "../adapters/prompts.js"
import {
  buildContainerRemovalFailedMessage,
  healthPollTimeoutMs,
  healthTimeoutMessage,
  type StartStatus,
} from "../rules/messages.js"
import { classifyInstanceContainer, type Deployment, type InstanceContainer } from "./deployment.js"

type ContainerStartDeps = { prompts: Prompts; docker: DockerRunner; fetchFn: typeof fetch }

const DEFAULT_HEALTH_WAIT_LABEL = "Waiting for the server to come up"

/**
 * One-shot informational probe of the public /healthz after a confirmed
 * container start. Never a gate: a failure warns and the command still
 * succeeds — before HTTPS/ingress access is set up an unreachable public URL
 * is the expected state, and this machine's result doesn't prove the same
 * for other devices (a VPS may not reach its own public address). It returns
 * void, so no caller can let the result change the command's outcome.
 */
const reportPublicUrlProbe = async (
  publicUrl: string,
  deps: { prompts: Prompts; fetchFn: typeof fetch },
): Promise<void> => {
  const { prompts, fetchFn } = deps
  const healthUrl = `${publicUrl}/healthz`
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
 * healthWaitLabel, when given, replaces the health-wait spinner's default text.
 */
const start = async (
  params: {
    deployment: Deployment
    instanceContainer: Exclude<InstanceContainer, "foreign">
    healthWaitLabel?: string
  },
  deps: ContainerStartDeps,
): Promise<StartStatus> => {
  const { deployment, instanceContainer, healthWaitLabel = DEFAULT_HEALTH_WAIT_LABEL } = params
  const { prompts, docker, fetchFn } = deps
  const { mode, instanceName, envFilePath, port } = deployment

  // `docker rm -f` on a missing container exits non-zero on engines < 23,
  // so the bare return value can't distinguish "nothing to remove" from a
  // real failure — only treat removal as failed when a container exists.
  // Proceeding after a genuine failure would surface as a confusing
  // "container name already in use" from docker run.
  if (instanceContainer === "own" && !docker.stopAndRemoveContainer(instanceName)) {
    prompts.error(buildContainerRemovalFailedMessage(instanceName))
    return "not-started"
  }

  // docker run --env-file keeps quotes as part of a value, so the .env's
  // quoted values are unquoted in place first.
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
  spinner.start(healthWaitLabel)
  const timeoutMs = healthPollTimeoutMs(mode)
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
  params: { deployment: Deployment },
  deps: ContainerStartDeps,
): Promise<number> => {
  const { deployment } = params
  const instanceContainer = classifyInstanceContainer(
    { instanceName: deployment.instanceName, envFilePath: deployment.envFilePath },
    deps,
  )

  if (instanceContainer === "foreign") return 1
  const startStatus = await start({ deployment, instanceContainer }, deps)
  return startStatus === "running" ? 0 : 1
}

export const containerStart = { start, recreate }
