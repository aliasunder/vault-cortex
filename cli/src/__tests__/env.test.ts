import { describe, expect, it } from "vitest"

import { buildLocalEnv, buildRemoteEnv } from "../env.js"

describe("buildLocalEnv", () => {
  it("produces the full expected .env from the given answers", () => {
    const env = buildLocalEnv({
      mcpAuthToken: "abc123",
      vaultPath: "/Users/you/My Vault",
    })

    const lines = env.split("\n")
    expect(lines).toContain("MCP_AUTH_TOKEN=abc123")
    expect(lines).toContain("VAULT_PATH=/Users/you/My Vault")
  })

  it("states defaulted optional settings as uncommented lines", () => {
    const env = buildLocalEnv({ mcpAuthToken: "abc123", vaultPath: "/vault" })
    const lines = env.split("\n")

    expect(lines).toContain("MEMORY_DIR=About Me")
    expect(lines).toContain("PORT=8000")
    expect(lines).toContain("LOG_LEVEL=info")
  })

  it("links to the canonical .env.example and keeps settings with no universal default commented out", () => {
    const env = buildLocalEnv({ mcpAuthToken: "abc123", vaultPath: "/vault" })

    expect(env).toContain("deploy/local/.env.example")
    expect(env).toContain("# TZ=America/New_York")
    expect(env).toContain("# LOG_DIR=/data/logs")
    expect(env).not.toMatch(/^TZ=/m)
    expect(env).not.toMatch(/^LOG_DIR=/m)
  })

  it("tells the user how to change a setting and apply it", () => {
    const env = buildLocalEnv({ mcpAuthToken: "abc123", vaultPath: "/vault" })

    expect(env).toContain("To change a setting: edit its value")
    expect(env).toContain(
      'then apply with "npx vault-cortex upgrade" (restart alone does not\n# re-read this file).',
    )
  })
})

describe("buildRemoteEnv", () => {
  const baseAnswers = {
    mcpAuthToken: "abc123",
    publicUrl: "https://vault.example.com",
    obsidianAuthToken: "sync-token-xyz",
    vaultName: "MyVault",
  }

  it("fills in all four required values as uncommented lines", () => {
    const env = buildRemoteEnv(baseAnswers)
    const lines = env.split("\n")

    expect(lines).toContain("MCP_AUTH_TOKEN=abc123")
    expect(lines).toContain("PUBLIC_URL=https://vault.example.com")
    expect(lines).toContain("OBSIDIAN_AUTH_TOKEN=sync-token-xyz")
    expect(lines).toContain("VAULT_NAME=MyVault")
  })

  it("keeps VAULT_PASSWORD commented out when the vault has no encryption", () => {
    const env = buildRemoteEnv(baseAnswers)

    expect(env).toContain("# VAULT_PASSWORD=")
    expect(env).not.toMatch(/^VAULT_PASSWORD=/m)
  })

  it("writes VAULT_PASSWORD as a real line when provided", () => {
    const env = buildRemoteEnv({ ...baseAnswers, vaultPassword: "hunter2" })
    const lines = env.split("\n")

    expect(lines).toContain("VAULT_PASSWORD=hunter2")
  })

  it("writes an empty OBSIDIAN_AUTH_TOKEN line with a fill-this-in warning when the token was skipped", () => {
    const env = buildRemoteEnv({ ...baseAnswers, obsidianAuthToken: "" })

    expect(env).toMatch(/^OBSIDIAN_AUTH_TOKEN=$/m)
    expect(env).toContain("FILL THIS IN")
    expect(env).toContain("npx vault-cortex get-sync-token")
  })

  it("states defaulted sync settings as uncommented lines", () => {
    const env = buildRemoteEnv(baseAnswers)
    const lines = env.split("\n")

    expect(lines).toContain("DEVICE_NAME=vault-cortex")
    expect(lines).toContain("CONFLICT_STRATEGY=merge")
    expect(lines).toContain("SYNC_MODE=bidirectional")
    expect(lines).toContain("PUID=1000")
  })

  it("links to the canonical .env.example and keeps settings with no universal default commented out", () => {
    const env = buildRemoteEnv(baseAnswers)

    expect(env).toContain("deploy/remote/.env.example")
    expect(env).toContain("# TZ=America/New_York")
    expect(env).toContain("# PROTECTED_PATHS=About Me,Daily Notes")
    expect(env).not.toMatch(/^TZ=/m)
    expect(env).not.toMatch(/^PROTECTED_PATHS=/m)
  })

  it("tells the user how to change a setting and apply it", () => {
    const env = buildRemoteEnv(baseAnswers)

    expect(env).toContain("To change a setting: edit its value")
    expect(env).toContain(
      'then apply with "npx vault-cortex upgrade" (restart alone does not\n# re-read this file).',
    )
  })
})
