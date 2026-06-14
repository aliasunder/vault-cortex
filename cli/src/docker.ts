import { spawnSync } from "node:child_process"

export type DockerRunner = {
  isComposeAvailable: () => boolean
  /** True when the Docker daemon is reachable — compose can be installed while Docker Desktop is closed. */
  isDaemonRunning: () => boolean
  /** Runs `docker compose up -d` in cwd with inherited stdio. */
  composeUp: (cwd: string) => boolean
  /** Runs the obsidian-headless-sync get-token flow with inherited stdio. */
  runGetToken: () => boolean
}

/** The image whose `get-token` entrypoint issues Obsidian Sync auth tokens. */
export const OBSIDIAN_SYNC_IMAGE =
  "ghcr.io/aliasunder/obsidian-headless-sync-docker:latest"

export const createDockerRunner = (): DockerRunner => ({
  isComposeAvailable: () =>
    spawnSync("docker", ["compose", "version"]).status === 0,
  isDaemonRunning: () =>
    spawnSync("docker", ["info"], { timeout: 5_000 }).status === 0,
  composeUp: (cwd) =>
    spawnSync("docker", ["compose", "up", "-d"], { cwd, stdio: "inherit" })
      .status === 0,
  runGetToken: () =>
    spawnSync(
      "docker",
      ["run", "--rm", "-it", "--entrypoint", "get-token", OBSIDIAN_SYNC_IMAGE],
      {
        stdio: "inherit",
      },
    ).status === 0,
})

/**
 * Polls the health endpoint until it responds OK or the timeout elapses.
 * The first `docker compose up` pulls a ~150MB image, so the default window
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
