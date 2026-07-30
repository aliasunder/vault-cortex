import { LOCAL_IMAGE, REMOTE_IMAGE, type DockerRunner } from "./docker.js"
import {
  ensureDaemonRunning,
  recreateContainer,
  resolveDeployment,
} from "./lifecycle.js"
import type { Prompts } from "./prompts.js"

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
export const runUpgrade = async (
  flags: UpgradeFlags,
  deps: UpgradeDeps,
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro("vault-cortex upgrade")

  const deployment = resolveDeployment(flags.dir, prompts)
  if (!deployment) return 1

  const image = deployment.mode === "local" ? LOCAL_IMAGE : REMOTE_IMAGE

  if (!ensureDaemonRunning(docker, prompts)) return 1

  const spinner = prompts.spinner()
  spinner.start(`Pulling ${image}`)
  const imagePulled = docker.pullImage(image)
  if (!imagePulled) {
    spinner.stop("Image pull failed — see output above.")
    return 1
  }
  spinner.stop("Image pulled.")

  const exitCode = await recreateContainer(
    { deployment, healthTimeoutMs: deps.healthTimeoutMs },
    { prompts, docker, fetchFn },
  )
  if (exitCode !== 0) return exitCode

  prompts.log("Your vault data, search index, and settings are preserved.")
  prompts.outro("Upgrade complete.")
  return 0
}
