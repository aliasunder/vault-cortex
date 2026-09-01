/** Remote-boot test harness — drives the built `:remote` image through the
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
export const dockerOrThrow = async (argv: string[]): Promise<string> => {
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
      `Remote image "${image}" not found — build it first: npm run build:remote-image (tags vault-cortex:remote-ci; set REMOTE_IMAGE to test another tag)`,
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

/** Start a detached container from the image under test with exactly one
 *  file swapped: the `ob` stub is bind-mounted read-only over the real Sync
 *  client's `cli.js`, so every `ob` call that the init chain makes hits the
 *  stub while the s6 chain, `init-first-sync`, and the volumes stay real.
 *  That single mount is what lets the tests run without Sync credentials.
 *
 *  The returned cleanup removes the container together with its anonymous
 *  volumes (`rm -v`); named volumes passed in `volumes` are removed
 *  explicitly, since `rm -v` leaves those alone. A removal that fails
 *  throws, naming the container or volume, so a leak fails the hook
 *  instead of accumulating silently across local runs. */
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
  // `127.0.0.1::<port>` leaves the host port to Docker; `publishedPort` reads
  // it back, so parallel runs never collide on a fixed port.
  const publishArgs = publishPort ? ["-p", `127.0.0.1::${CONTAINER_PORT}`] : []

  // `--pull=never`: only the image this run just built may boot. Without it,
  // a missing local tag would pull the published `:remote` and the tests
  // would silently run against the released image instead of the branch.
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
    // Sequential on purpose: a named volume is still in use until the
    // container is gone, so its removal only runs once `rm` succeeded.
    await dockerOrThrow(["rm", "-f", "-v", name])
    if (namedVolumes.length > 0) {
      await dockerOrThrow(["volume", "rm", "-f", ...namedVolumes])
    }
  }

  return { name, cleanup }
}

/** Node one-liner that prints how many files the sync state under a config
 *  directory records as present locally — the same query init-first-sync
 *  runs. Prints 0 when no store exists. Takes the config directory as its
 *  argument. */
const COUNT_SYNC_STATE_FILES_SCRIPT = `
  const { readdirSync, existsSync } = require("node:fs")
  const { join } = require("node:path")
  const { DatabaseSync } = require("node:sqlite")
  const syncRoot = join(process.argv[1], "obsidian-headless", "sync")
  const stores = existsSync(syncRoot)
    ? readdirSync(syncRoot).map((vaultId) => join(syncRoot, vaultId, "state.db")).filter(existsSync)
    : []
  const storeCounts = stores.map((file) => {
    const db = new DatabaseSync(file, { readOnly: true })
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE COALESCE(json_extract(data, ?), 0) = 0").get("$.folder")
    db.close()
    return count
  })
  const knownFiles = storeCounts.reduce((total, count) => total + count, 0)
  console.log(knownFiles)
`

/** How many files the device's sync state (under `configDir` inside the
 *  container) records as present locally. */
export const countSyncStateFiles = async ({
  name,
  configDir,
}: {
  name: string
  configDir: string
}): Promise<number> => {
  const output = await dockerOrThrow([
    "exec",
    name,
    "node",
    "--no-warnings",
    "-e",
    COUNT_SYNC_STATE_FILES_SCRIPT,
    configDir,
  ])
  return Number(output.trim())
}

/** Seed a named config volume with sync state recording `knownFiles` local
 *  files before any container mounts it — how a scenario fakes a device
 *  that has synced before. Runs `node` from the image under test with its
 *  entrypoint bypassed, so the s6 init chain never starts and no other image
 *  has to be pulled. */
export const seedSyncState = async ({
  image,
  volume,
  mountPath,
  knownFiles,
}: {
  image: string
  volume: string
  /** Where the volume is mounted for the seeding run. */
  mountPath: string
  knownFiles: number
}): Promise<void> => {
  await dockerOrThrow([
    "run",
    "--rm",
    "--pull=never",
    "--entrypoint",
    "node",
    "-v",
    `${volume}:${mountPath}`,
    image,
    "--no-warnings",
    "-e",
    `
      const { mkdirSync } = require("node:fs")
      const { join } = require("node:path")
      const { DatabaseSync } = require("node:sqlite")
      const stateDir = join(process.argv[1], "obsidian-headless", "sync", "seeded-vault-id")
      mkdirSync(stateDir, { recursive: true })
      const db = new DatabaseSync(join(stateDir, "state.db"))
      db.exec("CREATE TABLE local_files (path TEXT PRIMARY KEY, data TEXT NOT NULL)")
      const insert = db.prepare("INSERT INTO local_files VALUES (?, ?)")
      for (let i = 0; i < Number(process.argv[2]); i += 1) insert.run("note-" + i + ".md", "{}")
      db.close()
    `,
    mountPath,
    String(knownFiles),
  ])
}

/** Seed a named config volume with a Sync token file at the path the Sync
 *  client reads (`<config home>/obsidian-headless/auth_token`) — how a
 *  scenario fakes a device whose token came from the /setup page on an
 *  earlier boot. Runs `node` from the image under test with the entrypoint
 *  bypassed. */
export const seedSyncToken = async ({
  image,
  volume,
  mountPath,
  configDir,
  token,
}: {
  image: string
  volume: string
  /** Where the volume is mounted for the seeding run — the same path the
   *  scenario mounts it at. */
  mountPath: string
  /** The Sync client's config home inside that mount (XDG_CONFIG_HOME). */
  configDir: string
  token: string
}): Promise<void> => {
  await dockerOrThrow([
    "run",
    "--rm",
    "--pull=never",
    "--entrypoint",
    "node",
    "-v",
    `${volume}:${mountPath}`,
    image,
    "--no-warnings",
    "-e",
    `
      const { mkdirSync, writeFileSync } = require("node:fs")
      const { join } = require("node:path")
      const tokenDir = join(process.argv[1], "obsidian-headless")
      mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(tokenDir, "auth_token"), process.argv[2], { mode: 0o600 })
    `,
    configDir,
    token,
  ])
}

/** Port the in-container stand-in for api.obsidian.md listens on; the
 *  setup-mode scenarios point OBSIDIAN_API_URL at it. */
export const FAKE_OBSIDIAN_API_PORT = 9797

/** Credentials the stand-in accepts, and the token it hands out. Deliberately
 *  low-entropy so secret scanners never flag them. */
export const FAKE_OBSIDIAN_ACCOUNT = {
  email: "ci@example.test",
  password: "ci-password",
  token: "fake-sync-token-from-setup-page",
  name: "CI User",
}

/** Node one-liner for the stand-in: /user/signin answers the fake account's
 *  token, /vault/list answers one unencrypted vault named by argv[1]. */
const FAKE_OBSIDIAN_API_SCRIPT = `
  const http = require("node:http")
  const vaultName = process.argv[1]
  const account = JSON.parse(process.argv[2])
  http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}")
      response.setHeader("content-type", "application/json")
      if (request.url === "/user/signin") {
        const accepted = parsed.email === account.email && parsed.password === account.password
        response.end(JSON.stringify(accepted
          ? { token: account.token, name: account.name, email: account.email }
          : { error: "Invalid email or password" }))
        return
      }
      if (request.url === "/vault/list") {
        response.end(JSON.stringify({ vaults: [{ id: "v1", name: vaultName, password: "srv" }], shared: [] }))
        return
      }
      response.statusCode = 404
      response.end("{}")
    })
  }).listen(${FAKE_OBSIDIAN_API_PORT}, "127.0.0.1")
`

/** Start the api.obsidian.md stand-in inside the container (detached) and
 *  wait until it answers, so the setup server's sign-in call has somewhere
 *  to go without any host networking assumptions. */
export const startFakeObsidianApiInContainer = async ({
  name,
  vaultName,
}: {
  name: string
  vaultName: string
}): Promise<void> => {
  await dockerOrThrow([
    "exec",
    "-d",
    "--user",
    "obsidian",
    name,
    "node",
    "--no-warnings",
    "-e",
    FAKE_OBSIDIAN_API_SCRIPT,
    vaultName,
    JSON.stringify(FAKE_OBSIDIAN_ACCOUNT),
  ])
  const probeScript = `fetch("http://127.0.0.1:${FAKE_OBSIDIAN_API_PORT}/vault/list", { method: "POST", body: "{}" }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = await execInContainer(name, ["node", "-e", probeScript])
    if (probe.code === 0) return
    await sleep(250)
  }
  throw new Error(`fake Obsidian API in ${name} did not start`)
}

/** The exit code Docker recorded for a stopped container. */
export const containerExitCode = async (name: string): Promise<number> => {
  const output = await dockerOrThrow([
    "inspect",
    "-f",
    "{{.State.ExitCode}}",
    name,
  ])
  return Number(output.trim())
}

/** `docker start` on a stopped container — the same container, the same
 *  volumes, a fresh boot; how the tests stand in for a platform's restart
 *  policy. */
export const startContainer = async (name: string): Promise<void> => {
  await dockerOrThrow(["start", name])
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

/** The container's stdout and stderr merged in emission order. Init scripts
 *  log progress on stdout and retries/errors on stderr, and tests assert the
 *  interleaving. Two pipes read back separately cannot be re-interleaved, so
 *  this is the one Docker call that goes through `sh`, with the name passed
 *  as a positional argument rather than spliced into the command string.
 *
 *  `since` narrows to lines after a Docker timestamp, which is how the
 *  restart scenarios ignore the first boot's output. */
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

const HEALTHZ_ATTEMPT_TIMEOUT_MS = 5_000

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
    // Each attempt is capped at the shorter of 5 s and the remaining budget:
    // a server that accepts the connection but never answers would otherwise
    // hold `fetch` open past the deadline and the failure would surface as a
    // bare hook timeout with no logs attached.
    const attemptTimeoutMs = Math.max(
      0,
      Math.min(HEALTHZ_ATTEMPT_TIMEOUT_MS, deadline - Date.now()),
    )
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(attemptTimeoutMs),
      })
      if (response.ok) return
    } catch {
      // Connection refused while the server is still booting, or an attempt
      // that timed out — keep polling.
    }
    await sleep(500)
  }
  throw new Error(
    `container ${name} did not answer /healthz within ${deadlineMs}ms:\n${await containerLogs(name)}`,
  )
}

/** Wait for the container to stop on its own (a one-shot init script failed
 *  and S6_BEHAVIOUR_IF_STAGE2_FAILS=2 halted the container). Kills the
 *  container at the deadline so a check that failed to fire cannot hang the
 *  suite. */
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
 *  trailing newline in a `container_environment` value fails an exact
 *  assertion. */
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
