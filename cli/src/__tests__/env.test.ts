import { describe, expect, it } from "vitest"

import { GET_TOKEN_IMAGE } from "../docker.js"
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

  it("links to the canonical .env.example and keeps optional settings commented out", () => {
    const env = buildLocalEnv({ mcpAuthToken: "abc123", vaultPath: "/vault" })

    expect(env).toContain("deploy/local/.env.example")
    expect(env).toContain("# TZ=America/New_York")
    expect(env).toContain("# MEMORY_DIR=About Me")
    expect(env).toContain("# PORT=8000")
    expect(env).toContain("# LOG_LEVEL=info")
    expect(env).not.toMatch(/^TZ=/m)
    expect(env).not.toMatch(/^MEMORY_DIR=/m)
  })

  it("tells the user how to override an optional and apply the change", () => {
    const env = buildLocalEnv({ mcpAuthToken: "abc123", vaultPath: "/vault" })

    expect(env).toContain("To override a setting: uncomment it")
    expect(env).toContain(
      '"docker compose up -d" (restart alone does not re-read this file)',
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
    // The guidance must name the actual get-token image, not just the
    // subcommand — "get-token" alone would pass with a stale image name.
    expect(env).toContain(`get-token \\\n#     ${GET_TOKEN_IMAGE}`)
  })

  it("links to the canonical .env.example and keeps optional sync settings commented out", () => {
    const env = buildRemoteEnv(baseAnswers)

    expect(env).toContain("deploy/remote/.env.example")
    expect(env).toContain("# DEVICE_NAME=vault-cortex")
    expect(env).toContain("# CONFLICT_STRATEGY=merge")
    expect(env).toContain("# SYNC_MODE=bidirectional")
    expect(env).toContain("# PUID=1000")
  })

  it("tells the user how to override an optional and apply the change", () => {
    const env = buildRemoteEnv(baseAnswers)

    expect(env).toContain("To override a setting: uncomment it")
    expect(env).toContain(
      '"docker compose up -d" (restart alone does not re-read this file)',
    )
  })
})
