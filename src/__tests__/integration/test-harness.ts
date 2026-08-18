/** Integration test harness — boots a real server as a child process
 *  and connects an MCP SDK Client over HTTP. */

import { spawn } from "node:child_process"
import { mkdtemp, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomInt } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
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
}

/** Allocate a random port in the dynamic/private range (49152-65535). */
export const randomPort = (): number => randomInt(49152, 65536)

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
    stdio: ["ignore", "ignore", "pipe"],
  })

  let stderrBuf = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  return { child, vaultPath, dataDir, stderr: () => stderrBuf }
}

/** Boot the real server against a copy of the fixture vault. */
export const startServer = async (
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<ServerHandle> => {
  const { child, vaultPath, dataDir, stderr } = await spawnServerProcess(
    port,
    envOverrides,
  )

  try {
    const earlyExit = new Promise<never>((_, reject) => {
      child.once("exit", (code) =>
        reject(new Error(`Server exited early with code ${code}`)),
      )
    })
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
  // exactOptionalPropertyTypes. The SDK types are misaligned; safe to widen.
  await client.connect(transport as unknown as Transport)
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
