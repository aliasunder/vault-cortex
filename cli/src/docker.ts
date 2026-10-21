import { spawn, spawnSync } from "node:child_process"

import type { Mode } from "./scaffold.js"

export const LOCAL_IMAGE = "ghcr.io/aliasunder/vault-cortex:latest"
export const REMOTE_IMAGE = "ghcr.io/aliasunder/vault-cortex:remote"

/**
 * - The image on GHCR and on its Docker Hub mirror, which Docker also reports
 *   without docker.io/.
 * - vault-mcp: the image's name before v0.27.0, which older CLI installs still run.
 */
const VAULT_CORTEX_IMAGE_REPOSITORIES = [
  "ghcr.io/aliasunder/vault-cortex",
  "aliasunder/vault-cortex",
  "docker.io/aliasunder/vault-cortex",
  "ghcr.io/aliasunder/vault-mcp",
]

/** True for any tag or digest of the Vault Cortex image. */
export const isVaultCortexImage = (image: string): boolean => {
  return VAULT_CORTEX_IMAGE_REPOSITORIES.some((repository) => {
    return (
      image === repository ||
      image.startsWith(`${repository}:`) ||
      image.startsWith(`${repository}@`)
    )
  })
}

export type DockerRunParams = {
  mode: Mode
  /** The install's INSTANCE_NAME: the container name and the volume prefix. */
  instanceName: string
  envFilePath: string
  port: number
  /** Host vault path — local mode only (bind mount). */
  vaultPath?: string
}

export type DockerLogsParams = {
  instanceName: string
  /** Stream new output until interrupted (`docker logs --follow`). */
  follow: boolean
  /** Passed through to `docker logs --since` (e.g. "10m", "2h", or a timestamp). */
  since?: string
}

/**
 * Named volumes per mode, mounted in this order. The volume names are
 * `<instance>_<volume>`, the names Compose gives a project's volumes, so a
 * CLI install and a Compose install with the same name share their data.
 */
const VOLUME_MOUNTS: Readonly<Record<Mode, ReadonlyArray<{ volume: string; mountPath: string }>>> =
  {
    local: [{ volume: "mcp_data", mountPath: "/data" }],
    remote: [
      { volume: "vault_data", mountPath: "/vault" },
      { volume: "mcp_data", mountPath: "/data" },
      { volume: "obsidian_config", mountPath: "/home/obsidian/.config" },
    ],
  }

const volumeName = (instanceName: string, volume: string): string => `${instanceName}_${volume}`

/** The named volumes an install of this mode and name mounts. */
export const instanceVolumeNames = (params: { mode: Mode; instanceName: string }): string[] => {
  const { mode, instanceName } = params
  return VOLUME_MOUNTS[mode].map(({ volume }) => volumeName(instanceName, volume))
}

const volumeMountArgs = (mode: Mode, instanceName: string): string[] => {
  return VOLUME_MOUNTS[mode].flatMap(({ volume, mountPath }) => [
    "-v",
    `${volumeName(instanceName, volume)}:${mountPath}`,
  ])
}

/**
 * Container-runtime reachability: "running" (daemon answered), "not-running"
 * (binary exists but the daemon didn't answer), or "not-installed" (no docker
 * binary on PATH) — the split decides whether guidance says "start it" or
 * "install one".
 */
export type DaemonStatus = "running" | "not-running" | "not-installed"

export type PublishedPort = { hostPort: number; containerName: string }

export type DockerRunner = {
  /** Whether the container runtime is reachable, stopped, or absent. */
  daemonStatus: () => DaemonStatus
  /** Runs `docker run -d` with mode-specific flags. */
  dockerRun: (params: DockerRunParams) => boolean
  /** Pulls the latest image from the registry. */
  pullImage: (image: string) => boolean
  /** Stops and removes the named container (idempotent). */
  stopAndRemoveContainer: (instanceName: string) => boolean
  /**
   * The image the container with this exact name was created from, running
   * or stopped, or undefined when no container has the name.
   */
  containerImage: (instanceName: string) => string | undefined
  /** True when a named volume exists. */
  volumeExists: (volumeName: string) => boolean
  /**
   * Host ports that existing containers publish, stopped ones included: one
   * entry per container and port. Empty when the runtime can't list them.
   */
  publishedHostPorts: () => ReadonlyArray<PublishedPort>
  /**
   * Streams `docker logs` to the terminal; resolves with the docker
   * process's exit code once the stream ends.
   */
  streamLogs: (params: DockerLogsParams) => Promise<number>
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
  const { mode, instanceName, envFilePath, port, vaultPath } = params
  const image = mode === "local" ? LOCAL_IMAGE : REMOTE_IMAGE

  const args = [
    "run",
    "-d",
    "--name",
    instanceName,
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
    args.push(...volumeMountArgs(mode, instanceName))
    args.push("--health-cmd", HEALTH_CMD)
    args.push("--health-interval", "15s")
    args.push("--health-timeout", "5s")
    args.push("--health-retries", "3")
    args.push("--health-start-period", "20s")
  } else {
    // The init chain names the Sync device after the hostname when the .env
    // sets no DEVICE_NAME; a fixed name keeps it from being a container ID.
    args.push("--hostname", instanceName)
    args.push(...volumeMountArgs(mode, instanceName))
    args.push("--health-cmd", HEALTH_CMD)
    args.push("--health-interval", "15s")
    args.push("--health-timeout", "5s")
    args.push("--health-retries", "5")
    // 180s: the remote image's init chain runs the first vault sync to
    // completion before the MCP server boots, so /healthz appears late on
    // fresh deploys.
    args.push("--health-start-period", "180s")
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
  const { instanceName, follow, since } = params
  return [
    "logs",
    ...(follow ? ["--follow"] : []),
    ...(since ? ["--since", since] : []),
    instanceName,
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
    spawnResult.error && "code" in spawnResult.error ? spawnResult.error.code : undefined
  return spawnErrorCode === "ENOENT" ? "not-installed" : "not-running"
}

/**
 * Whether `docker container inspect --format {{.Name}}` printed this name.
 * Docker prints it with a leading slash; Podman and nerdctl print it bare.
 */
export const isContainerNamed = (params: {
  inspectedName: string
  instanceName: string
}): boolean => {
  const { inspectedName, instanceName } = params
  return inspectedName.trim().replace(/^\//, "") === instanceName
}

/** Go template that prints a container's name and image: "/work ghcr.io/aliasunder/vault-cortex:latest". */
const NAME_AND_IMAGE_FORMAT = "{{.Name}} {{.Config.Image}}"

/** Reads NAME_AND_IMAGE_FORMAT output into the image, or undefined when it names another container. */
export const parseContainerImage = (params: {
  inspectOutput: string
  instanceName: string
}): string | undefined => {
  const [inspectedName = "", image] = params.inspectOutput.trim().split(" ")

  if (!image || !isContainerNamed({ inspectedName, instanceName: params.instanceName })) {
    return undefined
  }
  return image
}

/**
 * Go template that prints a container's name, then each host port it
 * publishes: "/work 8001". PortBindings is the container's run setting, so a
 * stopped container's ports print too.
 */
const PUBLISHED_PORTS_FORMAT =
  "{{.Name}}{{range $containerPort, $bindings := .HostConfig.PortBindings}}{{range $bindings}} {{.HostPort}}{{end}}{{end}}"

/** A published host port; an empty HostPort means the runtime picks one at start. */
const HOST_PORT_PATTERN = /^\d+$/

/**
 * Reads PUBLISHED_PORTS_FORMAT output into one entry per container and port,
 * so a port two containers publish keeps both.
 */
export const parsePublishedHostPorts = (inspectOutput: string): ReadonlyArray<PublishedPort> => {
  return inspectOutput.split("\n").flatMap((line) => {
    const [inspectedName, ...hostPorts] = line.trim().split(/\s+/)

    if (!inspectedName) return []
    // Docker prints the name with a leading slash; Podman and nerdctl print it bare.
    const containerName = inspectedName.replace(/^\//, "")
    return hostPorts
      .filter((hostPort) => HOST_PORT_PATTERN.test(hostPort))
      .map((hostPort) => ({ hostPort: Number(hostPort), containerName }))
  })
}

export const createDockerRunner = (): DockerRunner => ({
  daemonStatus: () => classifyDaemonStatus(spawnSync("docker", ["info"], { timeout: 5_000 })),
  // stdout is discarded: `docker run -d` prints only the container ID there,
  // which lands as a raw hex line between the wizard's prompts. stderr stays
  // inherited — image-pull progress and error output print live, which the
  // "see output above" failure messages rely on.
  dockerRun: (params) => {
    return (
      spawnSync("docker", buildDockerRunArgs(params), {
        stdio: ["ignore", "ignore", "inherit"],
      }).status === 0
    )
  },
  pullImage: (image) => spawnSync("docker", ["pull", image], { stdio: "inherit" }).status === 0,
  stopAndRemoveContainer: (instanceName) => {
    return spawnSync("docker", ["rm", "-f", instanceName]).status === 0
  },
  // The printed name is compared because Docker falls back to container-ID
  // prefixes, so an all-hex name ("2025") could match another container.
  containerImage: (instanceName) => {
    const inspectResult = spawnSync(
      "docker",
      ["container", "inspect", "--format", NAME_AND_IMAGE_FORMAT, instanceName],
      { encoding: "utf8" },
    )

    if (inspectResult.status !== 0) return undefined
    return parseContainerImage({ inspectOutput: inspectResult.stdout, instanceName })
  },
  volumeExists: (volumeName) => {
    return spawnSync("docker", ["volume", "inspect", volumeName]).status === 0
  },
  publishedHostPorts: () => {
    const listResult = spawnSync("docker", ["container", "ls", "-aq"], { encoding: "utf8" })

    if (listResult.status !== 0) return []
    const containerIds = listResult.stdout.split("\n").filter(Boolean)

    if (containerIds.length === 0) return []
    const inspectResult = spawnSync(
      "docker",
      ["container", "inspect", "--format", PUBLISHED_PORTS_FORMAT, ...containerIds],
      { encoding: "utf8" },
    )

    if (inspectResult.error) return []
    // Read whatever the exit status: a container removed after the listing
    // makes inspect exit 1, but it still prints the others.
    return parsePublishedHostPorts(inspectResult.stdout)
  },
  // Async spawn, not spawnSync: --follow streams until interrupted, and the
  // exit code must be observable after the stream closes.
  streamLogs: (params) => {
    return new Promise((resolveExitCode) => {
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
        process.stderr.write(`vault-cortex: could not run docker logs — ${spawnError.message}\n`)
        resolveExitCode(1)
      })
      // A null code means the child died to a signal — report the shell
      // convention for ctrl-C (128 + SIGINT = 130).
      child.once("close", (code) => resolveExitCode(code ?? 130))
    })
  },
})

/** Default bound on a single health request (shared by probe and poll). */
const PROBE_TIMEOUT_MS = 10_000

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
  const { url, timeoutMs = PROBE_TIMEOUT_MS } = params
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
 * Health-poll budget by deployment mode. Remote gets a longer window because
 * the container's init chain runs the first vault sync to completion before
 * the server boots — /healthz can legitimately take minutes to appear on a
 * fresh deploy (matches the 180s container health start period plus boot
 * margin).
 */
export const healthPollTimeoutMs = (mode: Mode): number => {
  return mode === "remote" ? 240_000 : 120_000
}

/** Health-poll failure message with the duration derived from the actual
 *  timeout, so mode-specific budgets can't drift out of the copy. Remote
 *  adds a first-sync hint: the container's init chain retries the first
 *  sync with no upper time bound, so an expired poll does not mean the
 *  server failed — it may flip healthy after the CLI stops waiting. */
export const healthTimeoutMessage = (params: {
  mode: Mode
  timeoutMs: number
  instanceName: string
}): string => {
  const { mode, timeoutMs, instanceName } = params
  const baseMessage = `Server did not respond within ${timeoutMs / 60_000} minutes — check: docker logs ${instanceName}`

  if (mode === "remote") {
    return `${baseMessage} (a long first sync may still be running — the container keeps starting in the background)`
  }
  return baseMessage
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

  // Each attempt is bounded by the per-request cap AND the remaining budget
  // (a bare remaining-budget bound would let one black-holed request consume
  // the whole window with no retries), and the pause never sleeps past the
  // deadline — so the loop can't overshoot timeoutMs and the caller's
  // "did not respond within N minutes" message stays accurate.
  while (Date.now() < deadline) {
    const attemptTimeoutMs = Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())

    if (await probeHealth({ url, timeoutMs: attemptTimeoutMs }, fetchFn)) {
      return true
    }
    const pauseMs = Math.min(intervalMs, deadline - Date.now())

    if (pauseMs > 0) {
      await new Promise((resolvePause) => setTimeout(resolvePause, pauseMs))
    }
  }
  return false
}
