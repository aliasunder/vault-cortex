import { spawnSync } from "node:child_process"

import type { Mode } from "./scaffold.js"

export const LOCAL_IMAGE = "ghcr.io/aliasunder/vault-cortex:latest"
export const REMOTE_IMAGE = "ghcr.io/aliasunder/vault-cortex:remote"
export const CONTAINER_NAME = "vault-cortex"

export type DockerRunParams = {
  mode: Mode
  envFilePath: string
  port: number
  /** Host vault path — local mode only (bind mount). */
  vaultPath?: string
}

export type DockerRunner = {
  /** True when the Docker daemon is reachable. */
  isDaemonRunning: () => boolean
  /** Runs `docker run -d` with mode-specific flags. */
  dockerRun: (params: DockerRunParams) => boolean
  /** Pulls the latest image from the registry. */
  pullImage: (image: string) => boolean
  /** Stops and removes the vault-cortex container (idempotent). */
  stopAndRemoveContainer: () => boolean
  /** Runs the vault-cortex get-token flow with inherited stdio. */
  runGetToken: () => boolean
}

/**
 * Container-internal env vars that must override the user's .env values.
 * VAULT_PATH in .env is the host path (for the -v mount); the container
 * must see /vault. PORT/HOST/INDEX_DB_PATH are hardcoded infrastructure.
 */
const CONTAINER_ENV_OVERRIDES = [
  "VAULT_PATH=/vault",
  "PORT=8000",
  "HOST=0.0.0.0",
  "INDEX_DB_PATH=/data/index.db",
]

/** Node one-liner matching the compose healthcheck — exits 0 on HTTP 200. */
const HEALTH_CMD =
  "node -e \"fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""

/**
 * Builds the `docker run` args array. Pure function — no I/O — so it's
 * testable without spawning processes.
 */
export const buildDockerRunArgs = (params: DockerRunParams): string[] => {
  const { mode, envFilePath, port, vaultPath } = params
  const image = mode === "local" ? LOCAL_IMAGE : REMOTE_IMAGE

  const args = [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "--env-file",
    envFilePath,
    ...CONTAINER_ENV_OVERRIDES.flatMap((override) => ["-e", override]),
    "-p",
    `${port}:8000`,
  ]

  if (mode === "local") {
    if (!vaultPath) {
      throw new Error("vaultPath is required for local mode")
    }
    args.push("-v", `${vaultPath}:/vault:rw`)
    args.push("-v", "vault-cortex_mcp_data:/data")
    args.push("--health-cmd", HEALTH_CMD)
    args.push("--health-interval", "15s")
    args.push("--health-timeout", "5s")
    args.push("--health-retries", "3")
    args.push("--health-start-period", "20s")
  } else {
    args.push("--hostname", CONTAINER_NAME)
    args.push("-v", "vault-cortex_vault_data:/vault")
    args.push("-v", "vault-cortex_mcp_data:/data")
    args.push("-v", "vault-cortex_obsidian_config:/home/obsidian/.config")
    args.push("--health-cmd", HEALTH_CMD)
    args.push("--health-interval", "15s")
    args.push("--health-timeout", "5s")
    args.push("--health-retries", "5")
    args.push("--health-start-period", "60s")
    args.push("--log-driver", "json-file")
    args.push("--log-opt", "max-size=10m")
    args.push("--log-opt", "max-file=3")
  }

  args.push(image)
  return args
}

export const createDockerRunner = (): DockerRunner => ({
  isDaemonRunning: () =>
    spawnSync("docker", ["info"], { timeout: 5_000 }).status === 0,
  dockerRun: (params) =>
    spawnSync("docker", buildDockerRunArgs(params), { stdio: "inherit" })
      .status === 0,
  pullImage: (image) =>
    spawnSync("docker", ["pull", image], { stdio: "inherit" }).status === 0,
  stopAndRemoveContainer: () =>
    spawnSync("docker", ["rm", "-f", CONTAINER_NAME]).status === 0,
  runGetToken: () =>
    spawnSync(
      "docker",
      ["run", "--rm", "-it", "--entrypoint", "get-token", REMOTE_IMAGE],
      { stdio: "inherit" },
    ).status === 0,
})

/**
 * Polls the health endpoint until it responds OK or the timeout elapses.
 * The first `docker run` pulls a ~150MB image, so the default window
 * is generous.
 *
 * Native Date.now() rather than the server's Luxon convention: the published
 * CLI deliberately keeps its dependency set to two packages, and this is an
 * elapsed-time deadline, not date manipulation.
 */
export const pollHealth = async (
  params: { url: string; timeoutMs?: number; intervalMs?: number },
  fetchFn: typeof fetch,
): Promise<boolean> => {
  const { url, timeoutMs = 120_000, intervalMs = 2_000 } = params
  const deadline = Date.now() + timeoutMs

  const isHealthy = async (): Promise<boolean> => {
    try {
      const response = await fetchFn(url)
      return response.ok
    } catch {
      return false
    }
  }

  while (Date.now() < deadline) {
    if (await isHealthy()) return true
    await new Promise((resolvePause) => setTimeout(resolvePause, intervalMs))
  }
  return false
}
