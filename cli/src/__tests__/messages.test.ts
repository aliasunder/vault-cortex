import { describe, expect, it } from "vitest"

import {
  buildLocalConnectMessage,
  buildRemoteConnectMessage,
} from "../messages.js"

// ── Expected rules (mirrors the module-private helpers at RULE_WIDTH = 56) ────
// Tests run in non-TTY, so paint() is a no-op — these are the raw strings.

const RULE_WIDTH = 56

const expectedTopRule = (label: string): string =>
  `╭── ${label} ${"─".repeat(Math.max(0, RULE_WIDTH - label.length - 6))}╮`

const expectedBottomRule = (): string => `╰${"─".repeat(RULE_WIDTH - 2)}╯`

const expectedSectionRule = (label: string): string =>
  `── ${label} ${"─".repeat(Math.max(0, RULE_WIDTH - label.length - 4))}`

// ── Helpers ────────────────────────────────────────────────────────────────────

const localDefaults = {
  targetDir: "/home/user/vault-cortex",
  token: "abc123deadbeef",
  started: false,
  port: 8000,
  tokenWritten: true,
}

const remoteDefaults = {
  targetDir: "/home/user/vault-cortex",
  token: "abc123deadbeef",
  publicUrl: "https://vault.example.com",
  started: false,
  obsidianTokenMissing: false,
  tokenWritten: true,
}

// ── buildLocalConnectMessage ───────────────────────────────────────────────────

describe("buildLocalConnectMessage", () => {
  it("wraps the output in top and bottom box-drawing rules", () => {
    const message = buildLocalConnectMessage(localDefaults)

    const lines = message.split("\n")
    expect(lines[0]).toBe(expectedTopRule("Connect"))
    expect(lines[lines.length - 1]).toBe(expectedBottomRule())
  })

  it("includes MCP client, Non-OAuth, and Settings section dividers", () => {
    const lines = buildLocalConnectMessage(localDefaults).split("\n")

    expect(lines).toContain(expectedSectionRule("MCP client"))
    expect(lines).toContain(expectedSectionRule("Non-OAuth"))
    expect(lines).toContain(expectedSectionRule("Settings"))
  })

  it("builds URLs from the given port", () => {
    const message = buildLocalConnectMessage({ ...localDefaults, port: 9999 })

    expect(message).toContain("http://localhost:9999/mcp")
    expect(message).toContain("http://localhost:9999/healthz")
  })

  it("shows 'The server is running.' when started is true", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      started: true,
    })

    expect(message).toContain("The server is running.")
    expect(message).not.toContain("Start the server:")
  })

  it("shows the start command when started is false", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      started: false,
    })

    expect(message).toContain("Start the server:")
    expect(message).toContain(
      `cd ${localDefaults.targetDir} && docker compose up -d`,
    )
  })

  it("displays the token on its own line when tokenWritten is true", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      tokenWritten: true,
    })

    expect(message).toContain("Auth token:")
    expect(message).toContain(localDefaults.token)
    expect(message).not.toContain("use the existing MCP_AUTH_TOKEN")
  })

  it("points at the existing .env token when tokenWritten is false", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      tokenWritten: false,
    })

    expect(message).toContain(
      `use the existing MCP_AUTH_TOKEN in ${localDefaults.targetDir}/.env`,
    )
  })

  it("includes the targetDir in the settings paragraph", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain(`${localDefaults.targetDir}/.env`)
  })

  it("includes the local docs link", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("deploy/local/README.md")
  })

  it("includes the OAuth connect walkthrough", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("claude mcp add")
    expect(message).toContain("approve the browser consent page")
  })

  it("includes the curl guidance for non-OAuth clients", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain('curl -H "Authorization: Bearer <token>"')
  })

  it("includes the smoke test command", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("Smoke test:")
    expect(message).toContain("curl http://localhost:8000/healthz")
  })
})

// ── buildRemoteConnectMessage ──────────────────────────────────────────────────

describe("buildRemoteConnectMessage", () => {
  it("wraps the output in top and bottom box-drawing rules", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    const lines = message.split("\n")
    expect(lines[0]).toBe(expectedTopRule("Connect"))
    expect(lines[lines.length - 1]).toBe(expectedBottomRule())
  })

  it("includes MCP client, Non-OAuth, and Settings section dividers", () => {
    const lines = buildRemoteConnectMessage(remoteDefaults).split("\n")

    expect(lines).toContain(expectedSectionRule("MCP client"))
    expect(lines).toContain(expectedSectionRule("Non-OAuth"))
    expect(lines).toContain(expectedSectionRule("Settings"))
  })

  it("builds URLs from the given publicUrl", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "https://my-vault.example.com",
    })

    expect(message).toContain("https://my-vault.example.com/mcp")
    expect(message).toContain("https://my-vault.example.com/healthz")
  })

  it("shows 'The server is running.' when started is true", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      started: true,
    })

    expect(message).toContain("The server is running.")
    expect(message).not.toContain("Start the server:")
    expect(message).not.toContain("Fill in OBSIDIAN_AUTH_TOKEN")
  })

  it("shows 'Fill in OBSIDIAN_AUTH_TOKEN' when obsidianTokenMissing and not started", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      started: false,
      obsidianTokenMissing: true,
    })

    expect(message).toContain("Fill in OBSIDIAN_AUTH_TOKEN")
    expect(message).toContain(`${remoteDefaults.targetDir}/.env`)
    expect(message).toContain("docker compose up -d")
  })

  it("shows the start command when not started and obsidian token present", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      started: false,
      obsidianTokenMissing: false,
    })

    expect(message).toContain("Start the server:")
    expect(message).toContain(
      `cd ${remoteDefaults.targetDir} && docker compose up -d`,
    )
  })

  it("shows https guidance when publicUrl is https", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "https://vault.example.com",
    })

    expect(message).toContain("Reachable over https from any MCP client")
    expect(message).not.toContain("only accept https URLs")
  })

  it("shows http guidance when publicUrl is http", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "http://vault.example.com",
    })

    expect(message).toContain("only accept https URLs")
    expect(message).not.toContain("Reachable over https from any MCP client")
  })

  it("handles case-insensitive HTTPS scheme", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "HTTPS://vault.example.com",
    })

    expect(message).toContain("Reachable over https from any MCP client")
  })

  it("displays the token on its own line when tokenWritten is true", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      tokenWritten: true,
    })

    expect(message).toContain("Auth token:")
    expect(message).toContain(remoteDefaults.token)
    expect(message).not.toContain("use the existing MCP_AUTH_TOKEN")
  })

  it("points at the existing .env token when tokenWritten is false", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      tokenWritten: false,
    })

    expect(message).toContain(
      `use the existing MCP_AUTH_TOKEN in ${remoteDefaults.targetDir}/.env`,
    )
  })

  it("includes the remote docs link", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("deploy/remote/README.md#https-access")
  })

  it("includes the OAuth connect walkthrough", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("claude mcp add")
    expect(message).toContain("approve the browser consent page")
  })

  it("includes the curl guidance for non-OAuth clients", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain('curl -H "Authorization: Bearer <token>"')
  })

  it("includes the smoke test command", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("Smoke test:")
    expect(message).toContain("curl https://vault.example.com/healthz")
  })
})
