import { spawn, spawnSync } from "node:child_process"

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

export type DockerLogsParams = {
  /** Stream new output until interrupted (`docker logs --follow`). */
  follow: boolean
  /** Passed through to `docker logs --since` (e.g. "10m", "2h", or a timestamp). */
  since?: string
}

/**
 * Container-runtime reachability: "running" (daemon answered), "not-running"
 * (binary exists but the daemon didn't answer), or "not-installed" (no docker
 * binary on PATH) — the split decides whether guidance says "start it" or
 * "install one".
 */
export type DaemonStatus = "running" | "not-running" | "not-installed"

export type DockerRunner = {
  /** Whether the container runtime is reachable, stopped, or absent. */
  daemonStatus: () => DaemonStatus
  /** Runs `docker run -d` with mode-specific flags. */
  dockerRun: (params: DockerRunParams) => boolean
  /** Pulls the latest image from the registry. */
  pullImage: (image: string) => boolean
  /** Stops and removes the vault-cortex container (idempotent). */
  stopAndRemoveContainer: () => boolean
  /** True when a vault-cortex container exists, running or stopped. */
  containerExists: () => boolean
  /**
   * Streams `docker logs` to the terminal; resolves with the docker
   * process's exit code once the stream ends.
   */
  streamLogs: (params: DockerLogsParams) => Promise<number>
  /** Runs the Obsidian login with a volume mount for token auto-capture. */
  runObsidianLogin: (configMountPath: string) => boolean
}

export type ObsidianLoginArgParams = {
  configMountPath: string
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Host UID for --user flag on Linux. */
  uid?: number
  /** Host GID for --user flag on Linux. */
  gid?: number
}

/**
 * Builds the `docker run` args for the Obsidian login with a volume mount
 * that captures the auth token file. Runs `ob login` directly instead of
 * the image's get-sync-token script: the script's additions are locating and
 * printing the token, and the mount makes both unnecessary — the CLI reads
 * the token file itself, and not echoing a credential keeps it out of
 * terminal scrollback. Pure function for testability.
 *
 * On Linux, includes `--user uid:gid` when uid/gid are provided — Node
 * exposes process.getuid/getgid on every POSIX platform, so in practice the
 * flag is always set there — keeping the token file host-user-owned. macOS
 * Docker Desktop translates UIDs automatically, so no flag is needed.
 */
export const buildObsidianLoginArgs = (
  params: ObsidianLoginArgParams,
): string[] => {
  const { configMountPath, platform = process.platform, uid, gid } = params

  const args = [
    "run",
    "--rm",
    "-it",
    "--entrypoint",
    "ob",
    "-v",
    `${configMountPath}:/home/obsidian/.config`,
  ]

  if (platform === "linux" && uid !== undefined && gid !== undefined) {
    args.push("--user", `${uid}:${gid}`)
  }

  args.push(REMOTE_IMAGE, "login")
  return args
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

/**
 * Builds the `docker logs` args array. Pure function — no I/O — so it's
 * testable without spawning processes.
 */
export const buildDockerLogsArgs = (params: DockerLogsParams): string[] => {
  const { follow, since } = params
  return [
    "logs",
    ...(follow ? ["--follow"] : []),
    ...(since ? ["--since", since] : []),
    CONTAINER_NAME,
  ]
}

/**
 * Classifies a `docker info` spawnSync result. ENOENT on the spawn itself
 * means the `docker` binary is absent (not installed); any other failure —
 * non-zero exit, timeout, signal kill — means the binary exists but the
 * daemon isn't answering. `status` alone can't make that call: it is null
 * for ENOENT *and* for timeouts, so the split keys on the error code.
 */
export const classifyDaemonStatus = (spawnResult: {
  status: number | null
  error?: Error
}): DaemonStatus => {
  if (spawnResult.status === 0) return "running"
  const spawnErrorCode =
    spawnResult.error && "code" in spawnResult.error
      ? spawnResult.error.code
      : undefined
  return spawnErrorCode === "ENOENT" ? "not-installed" : "not-running"
}

export const createDockerRunner = (): DockerRunner => ({
  daemonStatus: () =>
    classifyDaemonStatus(spawnSync("docker", ["info"], { timeout: 5_000 })),
  // stdout is discarded: `docker run -d` prints only the container ID there,
  // which lands as a raw hex line between the wizard's prompts. stderr stays
  // inherited — image-pull progress and error output print live, which the
  // "see output above" failure messages rely on. stdin is ignored on purpose:
  // buildDockerRunArgs always runs detached (never -it), and the prompt
  // library owns the terminal's stdin — interactive flows go through
  // runObsidianLogin, which inherits all three streams.
  dockerRun: (params) =>
    spawnSync("docker", buildDockerRunArgs(params), {
      stdio: ["ignore", "ignore", "inherit"],
    }).status === 0,
  pullImage: (image) =>
    spawnSync("docker", ["pull", image], { stdio: "inherit" }).status === 0,
  stopAndRemoveContainer: () =>
    spawnSync("docker", ["rm", "-f", CONTAINER_NAME]).status === 0,
  // `docker rm -f` on a missing container exits 1 on engines < 23 and 0 on
  // >= 23, so stopAndRemoveContainer's status can't distinguish "already
  // gone" from "failed" — callers needing idempotent messaging probe
  // existence first. Output stays piped (discarded): this is a boolean probe.
  containerExists: () =>
    spawnSync("docker", ["container", "inspect", CONTAINER_NAME]).status === 0,
  // Async spawn, not spawnSync: --follow streams until interrupted, and the
  // exit code must be observable after the stream closes.
  streamLogs: (params) =>
    new Promise((resolveExitCode) => {
      const child = spawn("docker", buildDockerLogsArgs(params), {
        stdio: ["ignore", "inherit", "inherit"],
      })
      // ctrl-C delivers SIGINT to the whole foreground process group. Node's
      // default disposition would kill this process before the child's
      // "close" event fires; this no-op keep-alive lets the docker child
      // exit on its own SIGINT, the streams flush, and the exit code
      // propagate. `once` self-removes, so later ctrl-Cs behave normally.
      process.once("SIGINT", () => {})
      child.once("error", (spawnError) => {
        // Event handler, not a catch — but the same "never swallow" rule
        // applies: without this line a spawn failure is a bare exit 1.
        process.stderr.write(
          `vault-cortex: could not run docker logs — ${spawnError.message}\n`,
        )
        resolveExitCode(1)
      })
      // A null code means the child died to a signal — report the shell
      // convention for ctrl-C (128 + SIGINT = 130).
      child.once("close", (code) => resolveExitCode(code ?? 130))
    }),
  runObsidianLogin: (configMountPath) =>
    spawnSync(
      "docker",
      buildObsidianLoginArgs({
        configMountPath,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      }),
      { stdio: "inherit" },
    ).status === 0,
})

/**
 * One-shot health probe: true on an HTTP 2xx, false on any error, non-2xx,
 * or timeout — false IS the handled outcome for a boolean probe, so the
 * catch maps rather than logs. Unlike the localhost poll target (which fails
 * fast with ECONNREFUSED), a public URL behind a dropped firewall rule can
 * black-hole the TCP handshake for minutes — the abort timeout bounds every
 * caller.
 */
export const probeHealth = async (
  params: { url: string; timeoutMs?: number },
  fetchFn: typeof fetch,
): Promise<boolean> => {
  const { url, timeoutMs = 10_000 } = params
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Polls the health endpoint until it responds OK or the timeout elapses.
 * The first `docker run` pulls the image, so the default window is generous.
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

  while (Date.now() < deadline) {
    if (await probeHealth({ url }, fetchFn)) return true
    await new Promise((resolvePause) => setTimeout(resolvePause, intervalMs))
  }
  return false
}
