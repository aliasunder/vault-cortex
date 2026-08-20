/** Integration test harness — boots a real server as a child process
 *  and connects an MCP SDK Client over HTTP. */

import { spawn } from "node:child_process"
import { mkdtemp, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { ChildProcess } from "node:child_process"

const AUTH_TOKEN = "test-integration-token"
const FIXTURE_VAULT = resolve(import.meta.dirname, "fixtures/vault")
const SERVER_ENTRY = resolve(
  import.meta.dirname,
  "../../../src/vault-mcp/server.ts",
)

type ServerHandle = {
  port: number
  process: ChildProcess
  vaultPath: string
  dataDir: string
  cleanup: () => Promise<void>
}

type SpawnedServer = {
  child: ChildProcess
  vaultPath: string
  dataDir: string
  stderr: () => string
  /** Resolves once this child logs its own "server started" line. */
  started: Promise<void>
}

/** Ask the OS for a currently free TCP port. Test files run in parallel and
 *  each boots its own servers, so a port drawn from a fixed random range can
 *  collide with a sibling file's live server; an OS-assigned ephemeral port
 *  does not repeat while the allocator cycles. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
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
        resolve(port)
      })
    })
  })

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

  const child = spawn("npx", ["tsx", SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stderrBuf = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  // The server's structured "server started" log (stdout) is the only
  // readiness signal that proves THIS process bound the port. A /healthz
  // probe alone can be answered by any server already listening there —
  // if our child then dies with EADDRINUSE, tests silently run against a
  // sibling file's server with a different configuration.
  const started = new Promise<void>((resolve) => {
    let stdoutBuf = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      if (stdoutBuf.includes('"message":"server started"')) resolve()
    })
  })

  return { child, vaultPath, dataDir, stderr: () => stderrBuf, started }
}

/** Boot the real server against a copy of the fixture vault. */
export const startServer = async (
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<ServerHandle> => {
  const { child, vaultPath, dataDir, stderr, started } =
    await spawnServerProcess(port, envOverrides)

  try {
    const earlyExit = new Promise<never>((_, reject) => {
      child.once("exit", (code) =>
        reject(new Error(`Server exited early with code ${code}`)),
      )
    })
    const startTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Server on port ${port} did not log "server started" within 15000ms`,
            ),
          ),
        15_000,
      ).unref(),
    )
    await Promise.race([started, earlyExit, startTimeout])
    await Promise.race([pollHealthz(port, 15_000), earlyExit])
  } catch (err) {
    child.kill("SIGKILL")
    await rm(vaultPath, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${reason}\n\nServer stderr:\n${stderr()}`, { cause: err })
  }

  const cleanup = async (): Promise<void> => {
    child.kill("SIGTERM")
    await new Promise<void>((res) => {
      child.on("close", () => res())
      setTimeout(() => {
        child.kill("SIGKILL")
        res()
      }, 3_000).unref()
    })
    await rm(vaultPath, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }

  return { port, process: child, vaultPath, dataDir, cleanup }
}

/** Spawn server expecting it to fail — returns exit code and stderr. */
export const startServerExpectingFailure = async (
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number | null; stderr: string }> => {
  const { child, vaultPath, dataDir, stderr } = await spawnServerProcess(
    port,
    envOverrides,
  )

  const exitCode = await new Promise<number | null>((res) => {
    child.on("close", (code) => res(code))
    setTimeout(() => {
      child.kill("SIGKILL")
      res(null)
    }, 10_000).unref()
  })

  await rm(vaultPath, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })

  return { exitCode, stderr: stderr() }
}

/** Connect an MCP SDK Client to the running server. */
export const createTestClient = async (port: number): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      },
    },
  )
  const client = new Client({ name: "integration-test", version: "1.0.0" })
  // SDK's StreamableHTTPClientTransport.sessionId is `string | undefined` but
  // the Transport interface declares `sessionId?: string` — incompatible under
  // exactOptionalPropertyTypes. Self-cleans when the SDK fixes the type.
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

/** Content-response branch of the SDK's CallToolResult union. */
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
    throw new Error(
      "unexpected toolResult response — server returned no content array",
    )
  }
  return result
}

/** Join all text blocks from a tool result into a single string. */
export const textContent = (result: ToolResult): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")

/** Send an MCP initialize request with optional auth, return the HTTP status. */
export const mcpInitStatus = async (
  port: number,
  authHeader?: string,
): Promise<number> => {
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
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  })
  return response.status
}

const pollHealthz = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/healthz`
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Server not ready yet
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error(
    `Server on port ${port} did not become healthy within ${timeoutMs}ms`,
  )
}
