/** Remote-boot tier harness — drives the built `:remote` image through the
 *  Docker CLI and connects an MCP SDK Client to the published port.
 *
 *  Every Docker call goes through `execFile` with an argv array, never a
 *  shell string, so container names, env values, and mount paths are passed
 *  verbatim. */

import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { setTimeout as sleep } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const execFileAsync = promisify(execFile)

/** Path of the real obsidian-headless CLI inside the image — the target of
 *  the `.bin/ob` symlink on PATH. Mounting the stub here (not over the
 *  symlink) keeps the override explicit about which file it replaces. */
const OB_CLI_PATH_IN_IMAGE =
  "/opt/obsidian-headless/node_modules/obsidian-headless/cli.js"

const OB_STUB_PATH = resolve(import.meta.dirname, "fixtures/ob")

/** Port the MCP server listens on inside the container (Dockerfile `PORT`). */
const CONTAINER_PORT = 8000

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

/** Run `docker <argv>` and capture the outcome without throwing on a non-zero
 *  exit — callers decide whether a failure is an error or the expected
 *  result (e.g. `test -e` returning 1). */
export const docker = async (argv: string[]): Promise<CommandResult> => {
  try {
    const { stdout, stderr } = await execFileAsync("docker", argv, {
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (!isExecFileError(error)) throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

type ExecFileError = Error & { code: number; stdout: string; stderr: string }

const isExecFileError = (error: unknown): error is ExecFileError =>
  error instanceof Error &&
  typeof Reflect.get(error, "code") === "number" &&
  typeof Reflect.get(error, "stdout") === "string" &&
  typeof Reflect.get(error, "stderr") === "string"

/** Run `docker <argv>` and throw with the captured stderr when it fails. */
const dockerOrThrow = async (argv: string[]): Promise<string> => {
  const result = await docker(argv)
  if (result.code !== 0) {
    throw new Error(
      `docker ${argv.join(" ")} exited ${result.code}: ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

/** Fail fast with a build hint when the image under test is missing —
 *  without this, every container start would fail with Docker's own
 *  "No such image" message buried in a timeout. */
export const assertImagePresent = async (image: string): Promise<void> => {
  const result = await docker(["image", "inspect", image])
  if (result.code !== 0) {
    throw new Error(
      `Remote image "${image}" not found — build it first: docker build --target remote -t ${image} .`,
    )
  }
}

type RunContainerOptions = {
  name: string
  image: string
  env: Record<string, string>
  /** `host-path-or-volume:container-path[:ro]` mount specs. */
  volumes: string[]
  /** Publish the MCP port on an OS-assigned loopback port. */
  publishPort: boolean
}

export type ContainerHandle = {
  name: string
  /** Remove the container and every volume it created. */
  cleanup: () => Promise<void>
}

/** Start a detached container from the image under test with the `ob` stub
 *  mounted over the real CLI. The returned cleanup removes the container
 *  together with its anonymous volumes (`rm -v`); named volumes passed in
 *  `volumes` are removed explicitly, since `rm -v` leaves those alone. */
export const runContainer = async ({
  name,
  image,
  env,
  volumes,
  publishPort,
}: RunContainerOptions): Promise<ContainerHandle> => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ])
  const volumeArgs = volumes.flatMap((spec) => ["-v", spec])
  const publishArgs = publishPort ? ["-p", `127.0.0.1::${CONTAINER_PORT}`] : []

  await dockerOrThrow([
    "run",
    "-d",
    "--pull=never",
    "--name",
    name,
    "-v",
    `${OB_STUB_PATH}:${OB_CLI_PATH_IN_IMAGE}:ro`,
    ...envArgs,
    ...volumeArgs,
    ...publishArgs,
    image,
  ])

  const namedVolumes = volumes.map(namedVolumeOf).filter((volume) => volume)

  const cleanup = async (): Promise<void> => {
    await docker(["rm", "-f", "-v", name])
    if (namedVolumes.length > 0) {
      await docker(["volume", "rm", "-f", ...namedVolumes])
    }
  }

  return { name, cleanup }
}

/** The named-volume half of a `name:/path` mount spec, or "" for a bind
 *  mount (absolute host path) — Docker treats a source without a leading
 *  slash as a volume name. */
const namedVolumeOf = (spec: string): string => {
  const source = spec.split(":")[0] ?? ""
  return source.startsWith("/") ? "" : source
}

/** The loopback port Docker assigned to the container's MCP port. */
export const publishedPort = async (name: string): Promise<number> => {
  const mapping = await dockerOrThrow(["port", name, `${CONTAINER_PORT}/tcp`])
  // `docker port` prints one `host:port` line per address family; the
  // loopback publish yields `127.0.0.1:NNNNN`.
  const firstLine = mapping.split("\n")[0] ?? ""
  const port = Number(firstLine.split(":").at(-1))
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not parse published port from "${mapping.trim()}"`)
  }
  return port
}

const isRunning = async (name: string): Promise<boolean> => {
  const state = await dockerOrThrow([
    "inspect",
    "-f",
    "{{.State.Running}}",
    name,
  ])
  return state.trim() === "true"
}

/** The container's stdout and stderr merged in emission order (init scripts
 *  log progress on stdout and retries/errors on stderr, and tests assert the
 *  interleaving). Merging has to happen at the source — two pipes read back
 *  separately can't be re-interleaved — so this is the one Docker call that
 *  goes through `sh`, with the name passed as a positional argument rather
 *  than spliced into the command string. `since` narrows to lines after a
 *  Docker timestamp, which is how the restart scenario ignores the first
 *  boot's output. */
export const containerLogs = async (
  name: string,
  since?: string,
): Promise<string> => {
  const sinceArgs = since ? ["--since", since] : []
  const { stdout } = await execFileAsync(
    "sh",
    ["-c", 'docker logs "$@" 2>&1', "sh", ...sinceArgs, name],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout
}

/** Poll `/healthz` until it answers 200, failing early — with the container
 *  logs attached — if the container stops first, so an init-chain failure
 *  reads as the script's ERROR line rather than a bare timeout. */
export const waitForHealthz = async ({
  name,
  port,
  deadlineMs,
}: {
  name: string
  port: number
  deadlineMs: number
}): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!(await isRunning(name))) {
      throw new Error(
        `container ${name} stopped before /healthz answered:\n${await containerLogs(name)}`,
      )
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return
    } catch {
      // Connection refused while the server is still booting — keep polling.
    }
    await sleep(500)
  }
  throw new Error(
    `container ${name} did not answer /healthz within ${deadlineMs}ms:\n${await containerLogs(name)}`,
  )
}

/** Wait for the container to stop on its own (an init oneshot failed and
 *  S6_BEHAVIOUR_IF_STAGE2_FAILS=2 halted it). Kills the container at the
 *  deadline so a guard that failed to fire can't hang the suite. */
export const waitForStopped = async ({
  name,
  deadlineMs,
}: {
  name: string
  deadlineMs: number
}): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!(await isRunning(name))) return
    await sleep(500)
  }
  await docker(["kill", name])
  throw new Error(
    `container ${name} was still running after ${deadlineMs}ms:\n${await containerLogs(name)}`,
  )
}

/** Run a command inside the container and report its outcome — non-zero
 *  exits are data here (`test -e` on an absent path), not errors. */
export const execInContainer = (
  name: string,
  argv: string[],
): Promise<CommandResult> => docker(["exec", name, ...argv])

/** Raw bytes of a file inside the container — no trimming, so a stray
 *  trailing newline in a published env value fails an exact assertion. */
export const readContainerFile = ({
  name,
  path,
}: {
  name: string
  path: string
}): Promise<string> => dockerOrThrow(["exec", name, "cat", path])

/** Whether a path exists inside the container, via `test -e`'s exit code
 *  rather than a failed `cat` (which could also mean a permissions error). */
export const pathExistsInContainer = async ({
  name,
  path,
}: {
  name: string
  path: string
}): Promise<boolean> => {
  const result = await execInContainer(name, ["test", "-e", path])
  return result.code === 0
}

/** Sorted regular-file paths under a directory inside the container. */
export const listFilesInContainer = async ({
  name,
  directory,
}: {
  name: string
  directory: string
}): Promise<string[]> => {
  const listing = await dockerOrThrow([
    "exec",
    name,
    "find",
    directory,
    "-type",
    "f",
  ])
  return listing.split("\n").filter(Boolean).sort()
}

/** Connect an MCP SDK Client to the container's published port. */
export const createClient = async (
  port: number,
  token: string,
): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  )
  const client = new Client({ name: "remote-boot-test", version: "1.0.0" })
  // SDK's StreamableHTTPClientTransport.sessionId is `string | undefined` but
  // the Transport interface declares `sessionId?: string` — incompatible under
  // exactOptionalPropertyTypes. Self-cleans when the SDK fixes the type.
  // @ts-expect-error — SDK type misalignment (sessionId optionality)
  await client.connect(transport)
  return client
}
