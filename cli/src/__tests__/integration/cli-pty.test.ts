// CLI interactive integration tests — drives the real binary in a PTY via
// node-pty. Complements the unit tests (which use createScriptedPrompts DI)
// by verifying actual terminal rendering, keystroke processing, and end-to-end
// entry point wiring.

import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import {
  createPtyWorkDir,
  drivePty,
  killHealthServer,
  seedEnv,
  type PtyPrompt,
} from "./pty-harness.js"

// Down arrow in terminal escape sequences
const DOWN = "\x1b[B"

describe("init local", () => {
  it("completes the happy path (decline start)", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")
    onTestFinished(() => killHealthServer(pidFile))

    const prompts: PtyPrompt[] = [
      { match: "How do you want to run", send: "\r", label: "mode → local" },
      {
        match: "Path to your Obsidian vault",
        send: `${vaultDir}\r`,
        label: "vault path",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Any optional settings",
        send: "\r",
        label: "optional settings → skip",
      },
      { match: "Start the server now", send: "n\r", label: "start → no" },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
      env: { DOCKER_SHIM_PID_FILE: pidFile },
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Done.")
    expect(existsSync(pidFile)).toBe(false)

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toContain(`VAULT_PATH=${vaultDir}`)
    expect(envContent).toMatch(/^MCP_AUTH_TOKEN=\S+$/m)
  })

  it("accepts start and passes health check", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")
    onTestFinished(() => killHealthServer(pidFile))

    const prompts: PtyPrompt[] = [
      { match: "How do you want to run", send: "\r", label: "mode → local" },
      {
        match: "Path to your Obsidian vault",
        send: `${vaultDir}\r`,
        label: "vault path",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Any optional settings",
        send: "\r",
        label: "optional settings → skip",
      },
      { match: "Start the server now", send: "y\r", label: "start → yes" },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
      timeoutMs: 45_000,
      env: { DOCKER_SHIM_PID_FILE: pidFile, DOCKER_SHIM_HEALTH_PORT: "8000" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("health check passed")
  })

  it("navigates optional settings with selections", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    // PORT is index 7, TZ is index 8 in the settings list.
    // Navigate: 7× down to PORT, space to select, 1× down to TZ, space to select, enter.
    const downToPort = DOWN.repeat(7)
    const selectPortDownToTz = " " + DOWN
    const selectTzAndSubmit = " \r"

    const prompts: PtyPrompt[] = [
      { match: "How do you want to run", send: "\r", label: "mode → local" },
      {
        match: "Path to your Obsidian vault",
        send: `${vaultDir}\r`,
        label: "vault path",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Any optional settings",
        send: `${downToPort}${selectPortDownToTz}${selectTzAndSubmit}`,
        label: "select PORT + TZ",
      },
      { match: "Host port", send: "9999\r", label: "port → 9999" },
      { match: "IANA timezone", send: "America/Toronto\r", label: "timezone" },
      { match: "Start the server now", send: "n\r", label: "start → no" },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toMatch(/^PORT=9999$/m)
    expect(envContent).toMatch(/^TZ=America\/Toronto$/m)
  })
})

describe("init remote", () => {
  it("completes the happy path (decline start)", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    const prompts: PtyPrompt[] = [
      {
        match: "How do you want to run",
        send: `${DOWN}\r`,
        label: "mode → remote",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Public base URL",
        send: "https://vault.example.com\r",
        label: "public URL",
      },
      {
        match: "Exact name of your Obsidian vault",
        send: "MyVault\r",
        label: "vault name",
      },
      {
        match: "Generate the token now",
        send: "n\r",
        label: "auto-capture → no",
      },
      { match: "end-to-end encryption", send: "n\r", label: "E2E → no" },
      {
        match: "Any optional settings",
        send: "\r",
        label: "optional settings → skip",
      },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Done.")
    expect(result.transcript).toContain("No token yet")

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toContain("PUBLIC_URL=https://vault.example.com")
    expect(envContent).toContain("VAULT_NAME=MyVault")
    expect(envContent).toMatch(/^OBSIDIAN_AUTH_TOKEN=$/m)
  })
})

describe("configure", () => {
  it("toggles READONLY_MODE and writes .env", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    seedEnv(configDir)

    // READONLY_MODE is index 5 in the settings list: 5× down, space, enter
    const navigateToReadonly = DOWN.repeat(5) + " \r"

    const prompts: PtyPrompt[] = [
      {
        match: "Any optional settings",
        send: navigateToReadonly,
        label: "select READONLY_MODE",
      },
      { match: "read-only mode", send: "y\r", label: "readonly → yes" },
      { match: "Restart the container", send: "n\r", label: "restart → no" },
    ]

    const result = await drivePty({
      args: ["configure", "--dir", configDir],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Updated")

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toContain("READONLY_MODE=true")
  })
})

/**
 * Starts a local HTTP server that returns a successful Obsidian signin
 * response. Used with the OBSIDIAN_SIGNIN_URL env var seam in get-sync-token.
 */
const startSigninServer = (
  token: string,
): Promise<{ url: string; server: Server }> =>
  new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ token }))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolvePromise({ url: `http://127.0.0.1:${port}`, server })
    })
  })

describe("get-sync-token", () => {
  it("signs in and prints the token", async () => {
    const { vaultDir } = createPtyWorkDir()
    const { url, server } = await startSigninServer("pty-test-token")
    onTestFinished(() => {
      server.close()
    })

    const prompts: PtyPrompt[] = [
      {
        match: "Obsidian account email",
        send: "user@example.com\r",
        label: "email",
      },
      { match: "Password", send: "secret123\r", label: "password" },
    ]

    const result = await drivePty({
      args: ["get-sync-token"],
      workDir: vaultDir,
      prompts,
      env: { OBSIDIAN_SIGNIN_URL: url },
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("pty-test-token")
    expect(result.transcript).toContain("Done.")
  })

  it("writes the token to .env with --dir", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const { url, server } = await startSigninServer("pty-dir-token")
    onTestFinished(() => {
      server.close()
    })

    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, ".env"),
      "MCP_AUTH_TOKEN=test-token\nOBSIDIAN_AUTH_TOKEN=\nVAULT_NAME=TestVault\nPUBLIC_URL=http://localhost:8000\n",
    )

    const prompts: PtyPrompt[] = [
      {
        match: "Obsidian account email",
        send: "user@example.com\r",
        label: "email",
      },
      { match: "Password", send: "secret123\r", label: "password" },
    ]

    const result = await drivePty({
      args: ["get-sync-token", "--dir", configDir],
      workDir: vaultDir,
      prompts,
      env: { OBSIDIAN_SIGNIN_URL: url },
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Token written to")
    expect(result.transcript).toContain("npx vault-cortex start")
    expect(result.transcript).toContain("Done.")

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toContain("OBSIDIAN_AUTH_TOKEN=pty-dir-token")
  })
})

describe("non-interactive commands", () => {
  it("upgrade pulls and starts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")
    onTestFinished(() => killHealthServer(pidFile))
    seedEnv(configDir)

    const result = await drivePty({
      args: ["upgrade", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_PID_FILE: pidFile, DOCKER_SHIM_HEALTH_PORT: "8000" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("Upgrade complete")
  })

  it("down reports no container when none exists", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    seedEnv(configDir)

    const result = await drivePty({
      args: ["down", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_NO_CONTAINER: "1" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("No vault-cortex container found")
  })

  it("down stops and removes an existing container", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    seedEnv(configDir)

    const result = await drivePty({
      args: ["down", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
    })

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("Container stopped and removed")
  })

  it("restart completes the full cycle", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")
    onTestFinished(() => killHealthServer(pidFile))
    seedEnv(configDir)

    const result = await drivePty({
      args: ["restart", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_PID_FILE: pidFile, DOCKER_SHIM_HEALTH_PORT: "8000" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("Restart complete")
  })

  it("reports docker run failure", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    seedEnv(configDir)

    const result = await drivePty({
      args: ["restart", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_RUN_FAIL: "1" },
    })

    expect(result.exitCode).toBe(1)
    expect(result.transcript).toContain("docker run failed")
  })
})

describe("input validation re-prompts", () => {
  it("rejects glob characters in vault path and re-prompts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    const prompts: PtyPrompt[] = [
      { match: "How do you want to run", send: "\r", label: "mode → local" },
      {
        match: "Path to your Obsidian vault",
        send: "/path/to/*vault\r",
        label: "vault path → glob (rejected)",
      },
      {
        match: "glob characters",
        send: `${vaultDir}\r`,
        label: "re-prompt → valid path",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Any optional settings",
        send: "\r",
        label: "optional settings → skip",
      },
      { match: "Start the server now", send: "n\r", label: "start → no" },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain(
      "Vault path must not contain glob characters",
    )
  })

  it("rejects credentials in PUBLIC_URL and re-prompts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    const prompts: PtyPrompt[] = [
      {
        match: "How do you want to run",
        send: `${DOWN}\r`,
        label: "mode → remote",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Public base URL",
        send: "https://user:pass@vault.example.com\r",
        label: "PUBLIC_URL → credentials (rejected)",
      },
      {
        match: "credentials",
        send: "https://vault.example.com\r",
        label: "re-prompt → valid URL",
      },
      {
        match: "Exact name of your Obsidian vault",
        send: "TestVault\r",
        label: "vault name",
      },
      {
        match: "Generate the token now",
        send: "n\r",
        label: "auto-capture → no",
      },
      { match: "end-to-end encryption", send: "n\r", label: "E2E → no" },
      {
        match: "Any optional settings",
        send: "\r",
        label: "optional settings → skip",
      },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain(
      "PUBLIC_URL must not contain credentials",
    )
  })

  it("rejects a query string in PUBLIC_URL and re-prompts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    const prompts: PtyPrompt[] = [
      {
        match: "How do you want to run",
        send: `${DOWN}\r`,
        label: "mode → remote",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Public base URL",
        send: "https://vault.example.com/?tab=2\r",
        label: "PUBLIC_URL → query string (rejected)",
      },
      {
        match: "query string",
        send: "https://vault.example.com\r",
        label: "re-prompt → valid URL",
      },
      {
        match: "Exact name of your Obsidian vault",
        send: "TestVault\r",
        label: "vault name",
      },
      {
        match: "Generate the token now",
        send: "n\r",
        label: "auto-capture → no",
      },
      { match: "end-to-end encryption", send: "n\r", label: "E2E → no" },
      {
        match: "Any optional settings",
        send: "\r",
        label: "optional settings → skip",
      },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("no query string")
  })

  it("rejects traversal in MEMORY_DIR and re-prompts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    // MEMORY_DIR is index 1 in the settings list: 1× down, space, enter
    const selectMemoryDir = DOWN + " \r"

    const prompts: PtyPrompt[] = [
      { match: "How do you want to run", send: "\r", label: "mode → local" },
      {
        match: "Path to your Obsidian vault",
        send: `${vaultDir}\r`,
        label: "vault path",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Any optional settings",
        send: selectMemoryDir,
        label: "select MEMORY_DIR",
      },
      {
        match: "Vault folder for the memory files",
        send: "../secret\r",
        label: "memory dir → traversal (rejected)",
      },
      {
        match: "Path traversal",
        send: "My Notes\r",
        label: "re-prompt → valid folder",
      },
      { match: "Start the server now", send: "n\r", label: "start → no" },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Path traversal (..) is not allowed")
  })

  it("rejects digits outside brackets in DAILY_NOTES_FORMAT and re-prompts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    // DAILY_NOTES_FORMAT is index 3 in the settings list: 3× down, space, enter
    const selectFormat = DOWN.repeat(3) + " \r"

    const prompts: PtyPrompt[] = [
      { match: "How do you want to run", send: "\r", label: "mode → local" },
      {
        match: "Path to your Obsidian vault",
        send: `${vaultDir}\r`,
        label: "vault path",
      },
      {
        match: "Where should I put the config",
        send: `${configDir}\r`,
        label: "config dir",
      },
      {
        match: "Any optional settings",
        send: selectFormat,
        label: "select DAILY_NOTES_FORMAT",
      },
      {
        match: "Filename date format",
        send: "2024-MM-DD\r",
        label: "format → digits (rejected)",
      },
      {
        match: "Moment tokens",
        send: "YYYY-MM-DD\r",
        label: "re-prompt → valid format",
      },
      { match: "Start the server now", send: "n\r", label: "start → no" },
    ]

    const result = await drivePty({
      args: ["init"],
      workDir: vaultDir,
      prompts,
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Date format should use Moment tokens")
  })
})
