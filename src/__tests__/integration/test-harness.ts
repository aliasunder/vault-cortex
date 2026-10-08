/** Integration test harness — boots a real server as a child process
 *  and connects an MCP SDK Client over HTTP. */

import { spawn } from "node:child_process"
import { mkdtemp, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { ChildProcess } from "node:child_process"

const AUTH_TOKEN = "test-integration-token"
const FIXTURE_VAULT = resolve(import.meta.dirname, "fixtures/vault")
const SERVER_ENTRY = resolve(import.meta.dirname, "../../vault-mcp/server.ts")

type ServerHandle = {
  port: number
  child: ChildProcess
  vaultPath: string
  dataDir: string
  /** Everything the server has logged to stdout so far — the structured
   *  JSON log stream, for asserting a log line's presence or absence. */
  stdout: () => string
  cleanup: () => Promise<void>
}

type SpawnedServer = {
  child: ChildProcess
  vaultPath: string
  dataDir: string
  stdout: () => string
  stderr: () => string
  /** Resolves once this child logs its own "server started" line. Never
   *  rejects: callers race it against the child's exit and a timeout. */
  started: Promise<void>
}

/** Ask the OS for a TCP port that no socket holds right now. Test files run
 *  in parallel and each boots its own servers, so their ports must not
 *  collide. The port is free again between the probe's close and the
 *  server's bind; if a sibling file takes it in that gap, the server exits
 *  on EADDRINUSE and startServer fails rather than let the tests reach the
 *  sibling's server. */
export const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = createServer()
    // The probe never keeps the test process alive, even if left open.
    probe.unref()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()

      // address() is null for an unbound server and a string for a pipe; a
      // TCP listen gives an object carrying the port.
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("port probe did not bind a TCP address"))
        return
      }
      const { port } = address
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolvePort(port)
      })
    })
  })

/** The server's whole environment, built from scratch so a developer's own
 *  settings (VAULT_PATH, READONLY_MODE, …) never reach the server under test.
 *  Only PATH and HOME pass through. */
const buildServerEnv = (
  port: number,
  vaultPath: string,
  dataDir: string,
  overrides: Record<string, string>,
): Record<string, string> => ({
  VAULT_PATH: vaultPath,
  MCP_AUTH_TOKEN: AUTH_TOKEN,
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  INDEX_DB_PATH: join(dataDir, "search.db"),
  EMBEDDING_ENABLED: "false",
  PORT: String(port),
  HOST: "127.0.0.1",
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NODE_ENV: "test",
  ...overrides,
})

/** Copy the fixture vault to a tempdir and spawn the server process. */
const spawnServerProcess = async (
  port: number,
  envOverrides: Record<string, string>,
): Promise<SpawnedServer> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "vc-integ-vault-"))
  await cp(FIXTURE_VAULT, vaultPath, { recursive: true })

  const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-data-"))
  const env = buildServerEnv(port, vaultPath, dataDir, envOverrides)

  // One process, so kill() reaches the server itself. Through `npx tsx`, the
  // signal stops only npx, and the tsx wrapper and the server keep running.
  const child = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Appended as chunks arrive; stderr() reads it at call time.
  let capturedStderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    capturedStderr += chunk.toString()
  })

  // The server's structured "server started" log (stdout) is the only
  // readiness signal that proves THIS process bound the port. A /healthz
  // probe alone can be answered by any server already listening there —
  // if our child then dies with EADDRINUSE, tests silently run against a
  // sibling file's server with a different configuration.
  // The logger writes compact JSON, so a change to its format shows up here
  // as the start timeout.
  const startedLogFragment = '"message":"server started"'
  // Appended as chunks arrive; stdout() reads it at call time.
  let capturedStdout = ""
  const started = new Promise<void>((resolveStarted) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      capturedStdout += chunk.toString()
      if (capturedStdout.includes(startedLogFragment)) resolveStarted()
    })
  })

  return {
    child,
    vaultPath,
    dataDir,
    stdout: () => capturedStdout,
    stderr: () => capturedStderr,
    started,
  }
}

/** Already exited: exitCode is set, or signalCode when a signal ended it.
 *  Nothing is left to stop, and "close" may have fired already, so waiting
 *  for it would stall until the timeout. */
const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null

/** Sends the signal, then resolves true once the child closes, or false when
 *  it is still open after timeoutMs. */
const closesAfterSignal = ({
  child,
  signal,
  timeoutMs,
}: {
  child: ChildProcess
  signal: "SIGTERM" | "SIGKILL"
  timeoutMs: number
}): Promise<boolean> => {
  // Listening before the signal is sent, so a close that follows at once is
  // not missed.
  const closed = new Promise<true>((resolveClosed) => {
    child.once("close", () => resolveClosed(true))
  })
  child.kill(signal)
  return Promise.race([closed, delay(timeoutMs, false, { ref: false })])
}

/** SIGKILL the child and wait for it to close. Temp directories are removed
 *  only after this resolves: `kill()` alone just sends the signal, and a
 *  server still writing into a folder being deleted can make the delete fail
 *  (ENOTEMPTY). The wait ends after 2 s, so a child that never closes cannot
 *  hang the suite. */
export const killChild = async (child: ChildProcess): Promise<void> => {
  if (hasExited(child)) return
  await closesAfterSignal({ child, signal: "SIGKILL", timeoutMs: 2_000 })
}

/** SIGTERM the child, so a server can finish in-flight requests, and wait
 *  for it to close; killChild takes over when it is still open after 3 s. */
export const stopChild = async (child: ChildProcess): Promise<void> => {
  if (hasExited(child)) return

  if (await closesAfterSignal({ child, signal: "SIGTERM", timeoutMs: 3_000 })) return
  await killChild(child)
}

const pollHealthz = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/healthz`
  // let: each failed probe replaces it, so a timeout reports the last refusal.
  let lastProbeError: unknown = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)

      if (response.ok) return
    } catch (probeError) {
      // Not listening yet: keep polling until the deadline.
      lastProbeError = probeError
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs}ms`, {
    cause: lastProbeError,
  })
}

/** Boot the real server against a copy of the fixture vault. */
export const startServer = async (
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<ServerHandle> => {
  const { child, vaultPath, dataDir, stdout, stderr, started } = await spawnServerProcess(
    port,
    envOverrides,
  )

  // Each boot step gets this long: the "server started" line, then /healthz.
  const bootStepTimeoutMs = 15_000

  // Boot fails as soon as the child exits, or when the "server started" line
  // is late.
  const earlyExit = Promise.withResolvers<never>()
  const rejectOnExit = (code: number | null): void => {
    earlyExit.reject(new Error(`Server exited early with code ${code}`))
  }
  child.once("exit", rejectOnExit)
  const startTimeout = Promise.withResolvers<never>()
  const startTimeoutTimer = setTimeout(() => {
    startTimeout.reject(
      new Error(
        `Server on port ${port} did not log "server started" within ${bootStepTimeoutMs}ms`,
      ),
    )
  }, bootStepTimeoutMs)
  startTimeoutTimer.unref()

  try {
    await Promise.race([started, earlyExit.promise, startTimeout.promise])
    clearTimeout(startTimeoutTimer)
    // "server started" proves this child bound the port; /healthz confirms
    // it also answers HTTP requests.
    await Promise.race([pollHealthz(port, bootStepTimeoutMs), earlyExit.promise])
  } catch (bootError) {
    // A server that never finished booting has no requests to drain, so it
    // gets SIGKILL rather than cleanup's SIGTERM.
    await killChild(child)
    await rm(vaultPath, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
    const reason = bootError instanceof Error ? bootError.message : String(bootError)
    throw new Error(`${reason}\n\nServer stderr:\n${stderr()}`, { cause: bootError })
  } finally {
    // The timer and the exit listener guard boot only; removing them here
    // keeps either from firing later (cleanup's own kill would trigger the
    // listener).
    clearTimeout(startTimeoutTimer)
    child.off("exit", rejectOnExit)
  }

  const cleanup = async (): Promise<void> => {
    await stopChild(child)
    await rm(vaultPath, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }

  return { port, child, vaultPath, dataDir, stdout, cleanup }
}

/** Spawn server expecting it to fail — returns exit code and stderr.
 *  exitCode is null when a signal ended the server, including the SIGKILL
 *  sent to one still running after 10 s. */
export const startServerExpectingFailure = async (
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number | null; stderr: string }> => {
  const { child, vaultPath, dataDir, stderr } = await spawnServerProcess(port, envOverrides)

  const closed = new Promise<number | null>((resolveExitCode) => {
    child.once("close", (code) => resolveExitCode(code))
  })
  // 10 s, plus killChild's 2 s wait, stays under the 15 s test timeout the
  // callers set, so a server that boots instead of failing fails the exitCode
  // assertion rather than timing the test out.
  const timedOut = delay(10_000, "timed out" as const, { ref: false })
  const exitCodeOrTimeout = await Promise.race([closed, timedOut])

  if (exitCodeOrTimeout === "timed out") await killChild(child)
  await rm(vaultPath, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })

  const exitCode = exitCodeOrTimeout === "timed out" ? null : exitCodeOrTimeout
  return { exitCode, stderr: stderr() }
}

/** Connect an MCP SDK Client to the running server. */
export const createTestClient = async (port: number): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    },
  })
  const client = new Client({ name: "integration-test", version: "1.0.0" })
  // SDK's StreamableHTTPClientTransport.sessionId is `string | undefined` but
  // the Transport interface declares `sessionId?: string` — incompatible under
  // exactOptionalPropertyTypes. Once the SDK fixes the type, the directive
  // below fails the build as unused, flagging it for deletion.
  // @ts-expect-error — SDK type misalignment (sessionId optionality)
  await client.connect(transport)
  return client
}

/** Sorted tool names from a connected client. */
export const toolNames = async (client: Client): Promise<string[]> => {
  const result = await client.listTools()
  return result.tools.map((tool) => tool.name).sort()
}

/** Sorted prompt names from a connected client. */
export const promptNames = async (client: Client): Promise<string[]> => {
  const result = await client.listPrompts()
  return result.prompts.map((prompt) => prompt.name).sort()
}

// ── Shared tool-call helpers ────────────────────────────────────

type SdkCallToolResult = Awaited<ReturnType<Client["callTool"]>>

/** The content branch of callTool's result union. The other branch is the
 *  `{ toolResult }` shape of protocol version 2024-10-07. */
export type ToolResult = Extract<SdkCallToolResult, { content: unknown[] }>

const isContentResult = (result: SdkCallToolResult): result is ToolResult =>
  Array.isArray(result.content)

/** Call a tool and return the content-based result. */
export const callTool = async ({
  client,
  name,
  args = {},
}: {
  client: Client
  name: string
  args?: Record<string, unknown>
}): Promise<ToolResult> => {
  const result = await client.callTool({ name, arguments: args })

  if (!isContentResult(result)) {
    throw new Error("unexpected toolResult response — server returned no content array")
  }
  return result
}

/** Join all text blocks from a tool result into a single string. */
export const textContent = (result: ToolResult): string =>
  result.content
    // The type check narrows each block to the text variant, which has .text.
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")

/** Send an MCP initialize request with optional auth, return the HTTP status. */
export const mcpInitStatus = async (port: number, authHeader?: string): Promise<number> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (authHeader) headers["Authorization"] = authHeader

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        // A version the SDK supports; callers assert only the HTTP status.
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  })
  return response.status
}
