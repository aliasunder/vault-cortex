/** Integration test harness — boots a real server as a child process
 *  and connects an MCP SDK Client over HTTP. */

import { spawn } from "node:child_process"
import { mkdtemp, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

/** Boot the real server against a copy of the fixture vault. */
export const startServer = async (
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<ServerHandle> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "vc-integ-vault-"))
  await cp(FIXTURE_VAULT, vaultPath, { recursive: true })

  const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-data-"))

  const env: Record<string, string> = {
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
    ...envOverrides,
  }

  const child = spawn("npx", ["tsx", SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  await pollHealthz(port, 15_000)

  const cleanup = async (): Promise<void> => {
    child.kill("SIGTERM")
    await new Promise<void>((res) => {
      child.on("exit", () => res())
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
  const vaultPath = await mkdtemp(join(tmpdir(), "vc-integ-vault-"))
  await cp(FIXTURE_VAULT, vaultPath, { recursive: true })
  const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-data-"))

  const env: Record<string, string> = {
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
    ...envOverrides,
  }

  const child = spawn("npx", ["tsx", SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((res) => {
    child.on("exit", (code) => res(code))
    setTimeout(() => {
      child.kill("SIGKILL")
      res(null)
    }, 10_000).unref()
  })

  await rm(vaultPath, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })

  return { exitCode, stderr }
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
