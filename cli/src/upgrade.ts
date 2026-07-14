import { join, resolve } from "node:path"

import {
  CONTAINER_NAME,
  LOCAL_IMAGE,
  REMOTE_IMAGE,
  pollHealth,
  type DockerRunner,
} from "./docker.js"
import {
  detectMode,
  hasEnvPublicUrl,
  readEnvPort,
  readEnvVaultPath,
} from "./scaffold.js"
import { expandTilde } from "./vault.js"
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

const DEFAULT_TARGET_DIR = "./vault-cortex"

export const runUpgrade = async (
  flags: UpgradeFlags,
  deps: UpgradeDeps,
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro("vault-cortex upgrade")

  const targetDir = resolve(expandTilde(flags.dir ?? DEFAULT_TARGET_DIR))
  const envFilePath = join(targetDir, ".env")

  const mode = detectMode(envFilePath)
  if (!mode) {
    prompts.error(
      `No .env found in ${targetDir} — run \`npx vault-cortex init\` first.`,
    )
    return 1
  }

  const port = readEnvPort(envFilePath)
  const vaultPath = mode === "local" ? readEnvVaultPath(envFilePath) : undefined
  if (mode === "local" && !vaultPath) {
    prompts.error(
      `VAULT_PATH not found in ${targetDir}/.env — cannot start the container.`,
    )
    return 1
  }
  if (mode === "local" && !hasEnvPublicUrl(envFilePath)) {
    prompts.error(
      `PUBLIC_URL not found in ${targetDir}/.env — the server requires it.\n` +
        `Add this line to your .env:\n  PUBLIC_URL=http://localhost:${port}`,
    )
    return 1
  }

  const image = mode === "local" ? LOCAL_IMAGE : REMOTE_IMAGE

  if (!docker.isDaemonRunning()) {
    prompts.error(
      "Docker daemon not running — start your container runtime\n" +
        "(Docker Desktop, Colima, OrbStack, etc.).",
    )
    return 1
  }

  const spinner = prompts.spinner()
  spinner.start(`Pulling ${image}`)
  if (!docker.pullImage(image)) {
    spinner.stop("Image pull failed — see output above.")
    return 1
  }
  spinner.stop("Image pulled.")

  docker.stopAndRemoveContainer()

  prompts.log("Starting container...")
  if (!docker.dockerRun({ mode, envFilePath, port, vaultPath })) {
    prompts.error("docker run failed — see output above.")
    return 1
  }

  spinner.start("Waiting for the server to come up")
  const healthy = await pollHealth(
    {
      url: `http://127.0.0.1:${port}/healthz`,
      timeoutMs: deps.healthTimeoutMs,
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

  prompts.outro("Upgrade complete.")
  return 0
}
