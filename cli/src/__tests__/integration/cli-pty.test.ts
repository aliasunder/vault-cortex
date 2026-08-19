// CLI interactive integration tests — drives the real binary in a PTY via
// node-pty. Complements the unit tests (which use createScriptedPrompts DI)
// by verifying actual terminal rendering, keystroke processing, and end-to-end
// entry point wiring.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import {
  createPtyWorkDir,
  drivePty,
  killHealthServer,
  type PtyPrompt,
} from "./pty-harness.js"

vi.setConfig({ testTimeout: 60_000 })

// Down arrow in terminal escape sequences
const DOWN = "\x1b[B"

describe("init local", () => {
  it("completes the happy path (decline start)", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

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
    })

    expect(result.exitCode).toBe(0)
    expect(result.promptsAnswered).toBe(result.totalPrompts)
    expect(result.transcript).toContain("Done.")

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toContain(`VAULT_PATH=${vaultDir}`)
    expect(envContent).toContain("MCP_AUTH_TOKEN=")
  })

  it("accepts start and passes health check", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")

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

    killHealthServer(pidFile)

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
    expect(envContent).toContain("PORT=9999")
    expect(envContent).toContain("TZ=America/Toronto")
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
      {
        match: "Paste the Obsidian Sync token",
        send: "fake-sync-token-abc123\r",
        label: "paste token",
      },
      { match: "end-to-end encryption", send: "n\r", label: "E2E → no" },
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
    expect(result.transcript).toContain("Done.")

    const envContent = readFileSync(join(configDir, ".env"), "utf8")
    expect(envContent).toContain("PUBLIC_URL=https://vault.example.com")
    expect(envContent).toContain("VAULT_NAME=MyVault")
    expect(envContent).toContain("OBSIDIAN_AUTH_TOKEN=fake-sync-token-abc123")
  })
})

describe("configure", () => {
  it("toggles READONLY_MODE and writes .env", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    // Seed a minimal .env so configure finds an initialized deployment
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, ".env"),
      "MCP_AUTH_TOKEN=test-token\nVAULT_PATH=/tmp/vault\nPUBLIC_URL=http://localhost:8000\n",
    )

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

describe("non-interactive commands", () => {
  it("upgrade pulls and starts", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")

    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, ".env"),
      "MCP_AUTH_TOKEN=test-token\nVAULT_PATH=/tmp/vault\nPUBLIC_URL=http://localhost:8000\n",
    )

    const result = await drivePty({
      args: ["upgrade", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_PID_FILE: pidFile, DOCKER_SHIM_HEALTH_PORT: "8000" },
    })

    killHealthServer(pidFile)

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("Upgrade complete")
  })

  it("down reports no container when none exists", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()

    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, ".env"),
      "MCP_AUTH_TOKEN=test-token\nVAULT_PATH=/tmp/vault\nPUBLIC_URL=http://localhost:8000\n",
    )

    const result = await drivePty({
      args: ["down", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_NO_CONTAINER: "1" },
    })

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("No vault-cortex container found")
  })

  it("restart completes the full cycle", async () => {
    const { vaultDir, configDir } = createPtyWorkDir()
    const pidFile = join(configDir, "health-server.pid")

    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, ".env"),
      "MCP_AUTH_TOKEN=test-token\nVAULT_PATH=/tmp/vault\nPUBLIC_URL=http://localhost:8000\n",
    )

    const result = await drivePty({
      args: ["restart", "--dir", configDir],
      workDir: vaultDir,
      prompts: [],
      env: { DOCKER_SHIM_PID_FILE: pidFile, DOCKER_SHIM_HEALTH_PORT: "8000" },
    })

    killHealthServer(pidFile)

    expect(result.exitCode).toBe(0)
    expect(result.transcript).toContain("Restart complete")
  })
})
