import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { freePort } from "../../../__tests__/integration/test-harness.js"
import { startFakeObsidianApi } from "./fake-obsidian-api.js"

// The entry point spawns npx + tsx; 15 s start timeout inside the tests
// needs vitest's own timeout above that so the custom error fires first.
vi.setConfig({ testTimeout: 20_000 })

const SETUP_SERVER_ENTRY = fileURLToPath(
  new URL("../setup-server.ts", import.meta.url),
)
const AUTH_TOKEN = "local-dev-token"

type SetupServerProcess = {
  child: ChildProcess
  port: number
  stdout: () => string
  stderr: () => string
  /** Resolves once the entry point logs that it is listening. */
  started: Promise<void>
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>
}

/** Spawn the real entry point with only the given environment — the test
 *  controls every variable the server reads, so nothing from the runner's
 *  shell leaks in. */
const spawnSetupServer = async (
  env: Record<string, string>,
): Promise<SetupServerProcess> => {
  const port = await freePort()
  const vaultPath = await mkdtemp(join(tmpdir(), "setup-server-vault-"))
  onTestFinished(() => rm(vaultPath, { recursive: true, force: true }))
  const runnerPath = process.env.PATH
  if (!runnerPath) throw new Error("PATH is unset; npx cannot be resolved")
  const child = spawn("npx", ["tsx", SETUP_SERVER_ENTRY], {
    env: {
      PATH: runnerPath,
      VAULT_PATH: vaultPath,
      INDEX_DB_PATH: join(vaultPath, "index.db"),
      EMBEDDING_ENABLED: "false",
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  // Streams are appended to as chunks arrive — accumulating buffers is the
  // only way to read a child's output after the fact.
  let stdoutBuffer = ""
  let stderrBuffer = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
  })
  const started = new Promise<void>((resolve) => {
    child.stdout?.on("data", () => {
      if (stdoutBuffer.includes('"message":"setup server started"')) resolve()
    })
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code))
  })
  // SIGTERM first: `npx` forwards it to the tsx child, which owns the stdio
  // pipes. A SIGKILL to npx alone would orphan that child and `close` would
  // never fire.
  onTestFinished(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    const forceKill = new Promise<void>((resolve) => {
      setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 3_000).unref()
    })
    await Promise.race([exited, forceKill])
  })
  return {
    child,
    port,
    stdout: () => stdoutBuffer,
    stderr: () => stderrBuffer,
    started,
    exited,
  }
}

const waitForStart = async (server: SetupServerProcess): Promise<void> => {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `setup server did not start within 15s\nstderr:\n${server.stderr()}`,
          ),
        ),
      15_000,
    ).unref()
  })
  const earlyExit = async (): Promise<never> => {
    const code = await server.exited
    throw new Error(
      `setup server exited early with code ${code}\nstderr:\n${server.stderr()}`,
    )
  }
  await Promise.race([server.started, earlyExit(), timeout])
}

/** The last line of a stream as parsed JSON — the structured log record. */
const lastLogRecord = (output: string): Record<string, unknown> => {
  const lines = output.trim().split("\n")
  const lastLine = lines.at(-1)
  if (!lastLine) throw new Error("no log output")
  const parsed: unknown = JSON.parse(lastLine)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`last log line is not an object: ${lastLine}`)
  }
  return Object.fromEntries(Object.entries(parsed))
}

const plainVaultListing = {
  vaults: [{ id: "n", name: "Notes", password: "srv" }],
}

const signInThroughBrowser = async (port: number): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: AUTH_TOKEN,
      email: "user@example.com",
      password: "pw",
    }),
  })

describe("setup-server entry point", () => {
  it("writes the token under $HOME/.config when XDG_CONFIG_HOME is unset, then exits 0 for the restart", async () => {
    const api = await startFakeObsidianApi((request) =>
      request.path === "/user/signin"
        ? { body: { token: "sync-tok" } }
        : { body: plainVaultListing },
    )
    onTestFinished(api.close)
    const home = await mkdtemp(join(tmpdir(), "setup-server-home-"))
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    const server = await spawnSetupServer({
      HOME: home,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      VAULT_NAME: "Notes",
      OBSIDIAN_API_URL: api.baseUrl,
    })
    await waitForStart(server)

    const response = await signInThroughBrowser(server.port)
    const html = await response.text()
    const exitCode = await server.exited

    expect(html).toContain("<h1>Setup complete</h1>")
    expect(exitCode).toBe(0)
    await expect(
      readFile(
        join(home, ".config", "obsidian-headless", "auth_token"),
        "utf8",
      ),
    ).resolves.toBe("sync-tok")
  })

  it("writes the token under XDG_CONFIG_HOME when it is set", async () => {
    const api = await startFakeObsidianApi((request) =>
      request.path === "/user/signin"
        ? { body: { token: "sync-tok" } }
        : { body: plainVaultListing },
    )
    onTestFinished(api.close)
    const home = await mkdtemp(join(tmpdir(), "setup-server-home-"))
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    const configHome = join(home, "persist", "config")
    const server = await spawnSetupServer({
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      VAULT_NAME: "Notes",
      OBSIDIAN_API_URL: api.baseUrl,
    })
    await waitForStart(server)

    await signInThroughBrowser(server.port)
    await server.exited

    await expect(
      readFile(join(configHome, "obsidian-headless", "auth_token"), "utf8"),
    ).resolves.toBe("sync-tok")
    await expect(
      readFile(
        join(home, ".config", "obsidian-headless", "auth_token"),
        "utf8",
      ),
    ).rejects.toThrow("ENOENT")
  })

  it("answers /healthz in setup mode and 503 elsewhere with the absolute setup URL from PUBLIC_URL", async () => {
    const server = await spawnSetupServer({
      HOME: tmpdir(),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_URL: "https://vault.example.com",
    })
    await waitForStart(server)

    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    const other = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
    })

    await expect(health.json()).resolves.toEqual({ ok: true, mode: "setup" })
    expect(other.status).toBe(503)
    await expect(other.json()).resolves.toEqual({
      error: "setup required",
      setup_url: "https://vault.example.com/setup",
    })
  })

  it("falls back to a relative setup URL when PUBLIC_URL is unset or unparseable", async () => {
    const server = await spawnSetupServer({
      HOME: tmpdir(),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_URL: "not a url",
    })
    await waitForStart(server)

    const other = await fetch(`http://127.0.0.1:${server.port}/anything`)

    await expect(other.json()).resolves.toEqual({
      error: "setup required",
      setup_url: "/setup",
    })
    expect(lastLogRecord(server.stdout())).toMatchObject({
      message: "setup server started",
      setupUrl: "/setup",
    })

    const browserGet = await fetch(`http://127.0.0.1:${server.port}/anything`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    })

    expect(browserGet.status).toBe(302)
    expect(browserGet.headers.get("location")).toBe("/setup")
  })

  it("redirects browser GET requests to /setup instead of 503 JSON", async () => {
    const server = await spawnSetupServer({
      HOME: tmpdir(),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_URL: "https://vault.example.com",
    })
    await waitForStart(server)

    const browserGet = await fetch(`http://127.0.0.1:${server.port}/anything`, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
    })

    expect(browserGet.status).toBe(302)
    expect(browserGet.headers.get("location")).toBe(
      "https://vault.example.com/setup",
    )
  })

  it("returns 503 JSON for GET with Accept: */* (fetch/curl default)", async () => {
    const server = await spawnSetupServer({
      HOME: tmpdir(),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_URL: "https://vault.example.com",
    })
    await waitForStart(server)

    const fetchDefault = await fetch(`http://127.0.0.1:${server.port}/anything`)

    expect(fetchDefault.status).toBe(503)
    await expect(fetchDefault.json()).resolves.toEqual({
      error: "setup required",
      setup_url: "https://vault.example.com/setup",
    })
  })

  it("returns 503 JSON for POST with Accept: text/html (no redirect on POST)", async () => {
    const server = await spawnSetupServer({
      HOME: tmpdir(),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_URL: "https://vault.example.com",
    })
    await waitForStart(server)

    const browserPost = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    })

    expect(browserPost.status).toBe(503)
    await expect(browserPost.json()).resolves.toEqual({
      error: "setup required",
      setup_url: "https://vault.example.com/setup",
    })
  })

  it("shows the saved-login notice when SETUP_REASON is login-failed", async () => {
    const server = await spawnSetupServer({
      HOME: tmpdir(),
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      SETUP_REASON: "login-failed",
    })
    await waitForStart(server)

    const html = await (
      await fetch(`http://127.0.0.1:${server.port}/setup`)
    ).text()

    expect(html).toContain(
      "Your saved Obsidian login stopped working. Sign in again to replace it.",
    )
  })

  describe("hosting platform detection", () => {
    const signInPage = async (env: Record<string, string>): Promise<string> => {
      const server = await spawnSetupServer({
        HOME: tmpdir(),
        MCP_AUTH_TOKEN: AUTH_TOKEN,
        ...env,
      })
      await waitForStart(server)
      return (await fetch(`http://127.0.0.1:${server.port}/setup`)).text()
    }

    const RENDER_HINT = `<div class="hint">The <code>MCP_AUTH_TOKEN</code> value from the service's Environment tab on Render — it proves this is your server.</div>`
    const RAILWAY_HINT = `<div class="hint">The <code>MCP_AUTH_TOKEN</code> value from the service's Variables tab on Railway — it proves this is your server.</div>`
    const GENERIC_HINT = `<div class="hint">The <code>MCP_AUTH_TOKEN</code> value from your deployment's settings — it proves this is your server.</div>`

    it("names Render's Environment tab when RENDER_EXTERNAL_URL is set", async () => {
      const html = await signInPage({
        RENDER_EXTERNAL_URL: "https://x.onrender.com",
      })

      expect(html).toContain(RENDER_HINT)
    })

    it("names Railway's Variables tab when RAILWAY_PUBLIC_DOMAIN is set", async () => {
      const html = await signInPage({
        RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      })

      expect(html).toContain(RAILWAY_HINT)
    })

    it("prefers Render when both platform variables are set, like the PUBLIC_URL derivation", async () => {
      const html = await signInPage({
        RENDER_EXTERNAL_URL: "https://x.onrender.com",
        RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      })

      expect(html).toContain(RENDER_HINT)
    })

    it("treats a blank RENDER_EXTERNAL_URL as unset", async () => {
      const html = await signInPage({
        RENDER_EXTERNAL_URL: "",
        RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      })

      expect(html).toContain(RAILWAY_HINT)
    })

    it("keeps the generic hint when neither platform variable is set", async () => {
      const html = await signInPage({})

      expect(html).toContain(GENERIC_HINT)
    })
  })

  it("exits 1 with one searchable log line when MCP_AUTH_TOKEN is missing", async () => {
    const server = await spawnSetupServer({ HOME: tmpdir() })

    const exitCode = await server.exited

    expect(exitCode).toBe(1)
    expect(lastLogRecord(server.stderr())).toMatchObject({
      level: "error",
      message: "failed to start setup server",
      error:
        '[EnvVarError]: env-var: "MCP_AUTH_TOKEN" is a required variable, but it was not set',
    })
  })
})
