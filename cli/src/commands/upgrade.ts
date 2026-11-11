import { LOCAL_IMAGE, REMOTE_IMAGE, type DockerRunner } from "../adapters/docker.js"
import type { Prompts } from "../adapters/prompts.js"
import { containerStart } from "../steps/container-start.js"
import { requireDaemonRunning, resolveDeployment } from "../steps/deployment.js"

export type UpgradeFlags = {
  dir?: string
}

export type UpgradeDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
  /** Override the health-check timeout for testing. */
  healthTimeoutMs?: number
}

/**
 * Pulls the latest image, re-creates the container, and verifies health.
 * The only lifecycle command that contacts the registry — restart re-creates
 * from the image already on disk.
 */
export const runUpgrade = async (flags: UpgradeFlags, deps: UpgradeDeps): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro("vault-cortex upgrade")

  const deployment = resolveDeployment(flags.dir, prompts)

  if (!deployment) return 1

  const image = deployment.mode === "local" ? LOCAL_IMAGE : REMOTE_IMAGE

  if (!requireDaemonRunning(docker, prompts)) return 1
  // Checked before the download, which containerStart.recreate's own check follows.
  const instanceContainer = containerStart.classifyInstanceContainer(
    { instanceName: deployment.instanceName, envFilePath: deployment.envFilePath },
    { prompts, docker },
  )

  if (instanceContainer === "foreign") return 1

  const spinner = prompts.spinner()
  spinner.start(`Pulling ${image}`)
  const imagePulled = docker.pullImage(image)

  if (!imagePulled) {
    spinner.stop("Image pull failed — see output above.")
    return 1
  }
  spinner.stop("Image pulled.")

  const exitCode = await containerStart.recreate(
    { deployment, healthTimeoutMs: deps.healthTimeoutMs },
    { prompts, docker, fetchFn },
  )

  if (exitCode !== 0) return exitCode

  prompts.log("Your vault data, search index, and settings are preserved.")
  prompts.outro("Upgrade complete.")
  return 0
}
