import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildFilesToWrite,
  detectMode,
  patchEnvObsidianToken,
  readEnvBindAddress,
  readEnvInstanceName,
  readEnvObsidianToken,
  readEnvPort,
  readEnvPublicUrl,
  readEnvVaultPath,
  stripEnvQuotedValues,
  validatePublicUrl,
  writeFiles,
} from "../scaffold.js"

const neverOverwrite = async (): Promise<boolean> => false
const alwaysOverwrite = async (): Promise<boolean> => true

describe("buildFilesToWrite", () => {
  it("returns only the .env file with owner-only permissions", () => {
    const files = buildFilesToWrite("MCP_AUTH_TOKEN=abc\n")

    expect(files).toEqual([{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n", mode: 0o600 }])
  })
})

describe("writeFiles", () => {
  it("creates the target directory and writes all files", async () => {
    const targetDir = join(mkdtempSync(join(tmpdir(), "vault-cli-")), "nested", "vault-cortex")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n" }],
      },
      neverOverwrite,
    )

    expect(results).toEqual([{ name: ".env", status: "created" }])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=abc\n")
  })

  it("skips an existing identical file without consulting the conflict resolver", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc\n")
    const failingResolver = async (): Promise<boolean> => {
      throw new Error("resolver must not be called for identical content")
    }

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n" }],
      },
      failingResolver,
    )

    expect(results).toEqual([{ name: ".env", status: "unchanged" }])
  })

  it("keeps a differing existing file untouched when the resolver declines", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n" }],
      },
      neverOverwrite,
    )

    expect(results).toEqual([{ name: ".env", status: "kept" }])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
  })

  it("overwrites a differing existing file when the resolver approves", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n" }],
      },
      alwaysOverwrite,
    )

    expect(results).toEqual([{ name: ".env", status: "overwritten" }])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
  })

  it("resolves conflicts per file — keeps one and creates another in the same run", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [
          { name: "extra.txt", content: "hello\n" },
          { name: ".env", content: "MCP_AUTH_TOKEN=new\n" },
        ],
      },
      neverOverwrite,
    )

    expect(results).toEqual([
      { name: "extra.txt", status: "created" },
      { name: ".env", status: "kept" },
    ])
    expect(existsSync(join(targetDir, "extra.txt"))).toBe(true)
  })
})

describe("readEnvPort", () => {
  it("returns the default 8000 when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvPort(missingPath)).toEqual({ kind: "ok", port: 8000 })
  })

  it("returns the default 8000 when PORT is only present as a comment", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\n# PORT=9000\n")

    expect(readEnvPort(envPath)).toEqual({ kind: "ok", port: 8000 })
  })

  it("returns an uncommented PORT override", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPORT=9000\n")

    expect(readEnvPort(envPath)).toEqual({ kind: "ok", port: 9000 })
  })

  it("strips surrounding double quotes from the port value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nPORT="9000"\n')

    expect(readEnvPort(envPath)).toEqual({ kind: "ok", port: 9000 })
  })

  it("takes the last active PORT line, as docker --env-file does", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "PORT=8000\nMCP_AUTH_TOKEN=abc\nPORT=8001\n")

    expect(readEnvPort(envPath)).toEqual({ kind: "ok", port: 8001 })
  })

  it("reads an empty last PORT line as the default port, not an earlier line's port", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "PORT=9000\nMCP_AUTH_TOKEN=abc\nPORT=\n")

    expect(readEnvPort(envPath)).toEqual({ kind: "ok", port: 8000 })
  })

  it.each([
    { label: "letters", portValue: "abc", reportedValue: "abc" },
    { label: "digits then letters", portValue: "80a", reportedValue: "80a" },
    { label: "zero", portValue: "0", reportedValue: "0" },
    { label: "a number above 65535", portValue: "70000", reportedValue: "70000" },
    { label: "a quoted value padded with spaces", portValue: '" 9000 "', reportedValue: " 9000 " },
  ])(
    "reports $label as an invalid port instead of using the default",
    ({ portValue, reportedValue }) => {
      const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
      const envPath = join(targetDir, ".env")
      writeFileSync(envPath, `PORT=9000\nPORT=${portValue}\n`)

      expect(readEnvPort(envPath)).toEqual({
        kind: "invalid",
        message: `PORT "${reportedValue}" is not a valid port — use a whole number between 1 and 65535.`,
      })
    },
  )
})

describe("readEnvBindAddress", () => {
  const writeEnv = (content: string): string => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, content)
    return envPath
  }

  it.each([
    { label: "loopback in local mode", mode: "local" as const, bindAddress: "127.0.0.1" },
    { label: "no address in remote mode", mode: "remote" as const, bindAddress: "" },
  ])("defaults to $label when no .env exists", ({ mode, bindAddress }) => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvBindAddress(missingPath, mode)).toEqual({ kind: "ok", bindAddress })
  })

  it.each([
    { label: "only present as a comment", content: "MCP_AUTH_TOKEN=abc\n# BIND_ADDRESS=0.0.0.0\n" },
    { label: "empty on its last line", content: "BIND_ADDRESS=0.0.0.0\nBIND_ADDRESS=\n" },
  ])("uses the mode's default when BIND_ADDRESS is $label", ({ content }) => {
    const envPath = writeEnv(content)

    expect(readEnvBindAddress(envPath, "local")).toEqual({ kind: "ok", bindAddress: "127.0.0.1" })
    expect(readEnvBindAddress(envPath, "remote")).toEqual({ kind: "ok", bindAddress: "" })
  })

  it.each([
    {
      label: "every address in local mode",
      mode: "local" as const,
      envValue: "0.0.0.0",
      bindAddress: "0.0.0.0",
    },
    {
      label: "loopback in remote mode",
      mode: "remote" as const,
      envValue: "127.0.0.1",
      bindAddress: "127.0.0.1",
    },
    {
      label: "the IPv4 wildcard in remote mode",
      mode: "remote" as const,
      envValue: "0.0.0.0",
      bindAddress: "0.0.0.0",
    },
    {
      label: "a quoted address",
      mode: "local" as const,
      envValue: '"192.168.1.20"',
      bindAddress: "192.168.1.20",
    },
    {
      label: "a bracketed IPv6 address",
      mode: "local" as const,
      envValue: "[::1]",
      bindAddress: "[::1]",
    },
  ])("returns $label set in .env", ({ mode, envValue, bindAddress }) => {
    const envPath = writeEnv(`MCP_AUTH_TOKEN=abc\nBIND_ADDRESS=${envValue}\n`)

    expect(readEnvBindAddress(envPath, mode)).toEqual({ kind: "ok", bindAddress })
  })

  it("takes the last active BIND_ADDRESS line, as docker --env-file does", () => {
    const envPath = writeEnv("BIND_ADDRESS=0.0.0.0\nMCP_AUTH_TOKEN=abc\nBIND_ADDRESS=127.0.0.1\n")

    expect(readEnvBindAddress(envPath, "remote")).toEqual({ kind: "ok", bindAddress: "127.0.0.1" })
  })

  it.each([
    { label: "a hostname", envValue: "localhost", reportedValue: "localhost" },
    { label: "a bare IPv6 address", envValue: "::1", reportedValue: "::1" },
    {
      label: "a zone-scoped IPv6 address",
      envValue: "[fe80::1%eth0]",
      reportedValue: "[fe80::1%eth0]",
    },
    {
      label: "an address with a port",
      envValue: "127.0.0.1:8000",
      reportedValue: "127.0.0.1:8000",
    },
    { label: "an incomplete IPv4 address", envValue: "192.168.1", reportedValue: "192.168.1" },
    {
      label: "a quoted value padded with spaces",
      envValue: '" 127.0.0.1 "',
      reportedValue: " 127.0.0.1 ",
    },
  ])(
    "reports $label as an invalid address instead of using the default",
    ({ envValue, reportedValue }) => {
      const envPath = writeEnv(`BIND_ADDRESS=0.0.0.0\nBIND_ADDRESS=${envValue}\n`)

      expect(readEnvBindAddress(envPath, "local")).toEqual({
        kind: "invalid",
        message: `BIND_ADDRESS "${reportedValue}" is not an address Docker can publish on — use an IPv4 address such as 127.0.0.1 or 0.0.0.0, or an IPv6 address in brackets such as [::1].`,
      })
    },
  )
})

describe("readEnvInstanceName", () => {
  const writeEnv = (content: string): string => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, content)
    return envPath
  }

  it("returns the default name when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvInstanceName(missingPath)).toEqual({ kind: "ok", instanceName: "vault-cortex" })
  })

  it.each([
    { label: "no INSTANCE_NAME line", content: "MCP_AUTH_TOKEN=abc\n" },
    { label: "a commented-out line", content: "# INSTANCE_NAME=work\n" },
    { label: "an empty value", content: "INSTANCE_NAME=\n" },
    { label: "an empty quoted value", content: 'INSTANCE_NAME=""\n' },
  ])("returns the default name for $label", ({ content }) => {
    expect(readEnvInstanceName(writeEnv(content))).toEqual({
      kind: "ok",
      instanceName: "vault-cortex",
    })
  })

  it.each([
    { label: "a plain name", content: "INSTANCE_NAME=work_2\n", expected: "work_2" },
    {
      label: "a double-quoted name",
      content: 'INSTANCE_NAME="work-vault"\n',
      expected: "work-vault",
    },
    {
      label: "a single-quoted name",
      content: "INSTANCE_NAME='work-vault'\n",
      expected: "work-vault",
    },
    { label: "a name with trailing spaces", content: "INSTANCE_NAME=work  \n", expected: "work" },
  ])("returns $label as written, without quotes or spaces", ({ content, expected }) => {
    expect(readEnvInstanceName(writeEnv(content))).toEqual({ kind: "ok", instanceName: expected })
  })

  it("takes the last active line, as docker --env-file does", () => {
    const envPath = writeEnv("INSTANCE_NAME=vault-cortex\nPORT=8001\nINSTANCE_NAME=work\n")

    expect(readEnvInstanceName(envPath)).toEqual({ kind: "ok", instanceName: "work" })
  })

  it.each([
    { label: "a one-character name", value: "a" },
    { label: "uppercase letters", value: "Work" },
    { label: "a space", value: "my vault" },
    { label: "a leading hyphen", value: "-work" },
    { label: "a dot", value: "work.vault" },
  ])("rejects $label with the rule in the message", ({ value }) => {
    const envPath = writeEnv(`INSTANCE_NAME=${value}\n`)

    expect(readEnvInstanceName(envPath)).toEqual({
      kind: "invalid",
      message: `INSTANCE_NAME "${value}" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit.`,
    })
  })
})

describe("readEnvVaultPath", () => {
  it("returns undefined when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvVaultPath(missingPath)).toBeUndefined()
  })

  it("returns undefined when VAULT_PATH is only a comment", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\n# VAULT_PATH=/vault\n")

    expect(readEnvVaultPath(envPath)).toBeUndefined()
  })

  it("returns the vault path from an uncommented line", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/home/user/MyVault\n")

    expect(readEnvVaultPath(envPath)).toBe("/home/user/MyVault")
  })

  it("handles paths with spaces", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/Users/me/My Vault\n")

    expect(readEnvVaultPath(envPath)).toBe("/Users/me/My Vault")
  })

  it("strips surrounding double quotes from the value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nVAULT_PATH="/Users/me/My Vault"\n')

    expect(readEnvVaultPath(envPath)).toBe("/Users/me/My Vault")
  })

  it("strips surrounding single quotes from the value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH='/Users/me/My Vault'\n")

    expect(readEnvVaultPath(envPath)).toBe("/Users/me/My Vault")
  })

  it("returns undefined when the value is an empty pair of quotes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nVAULT_PATH=""\n')

    expect(readEnvVaultPath(envPath)).toBeUndefined()
  })

  it("takes the last active line, as docker --env-file does", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(
      envPath,
      "VAULT_PATH=/Users/me/OldVault\nMCP_AUTH_TOKEN=abc\nVAULT_PATH=/Users/me/NewVault\n",
    )

    expect(readEnvVaultPath(envPath)).toBe("/Users/me/NewVault")
  })
})

describe("readEnvPublicUrl", () => {
  it("returns the value of an uncommented PUBLIC_URL line", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://vault.example.com\n")

    expect(readEnvPublicUrl(envPath)).toBe("https://vault.example.com")
  })

  it("takes the last active line, as docker --env-file does", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(
      envPath,
      "PUBLIC_URL=https://old.example.com\nMCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://new.example.com\n",
    )

    expect(readEnvPublicUrl(envPath)).toBe("https://new.example.com")
  })

  it("strips trailing slashes so consumers can append paths cleanly", () => {
    // A hand-edited `https://host/` must not become `https://host//mcp` in
    // the connect message — mirror askPublicUrl's prompt-side normalization.
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://vault.example.com/\n")

    expect(readEnvPublicUrl(envPath)).toBe("https://vault.example.com")
  })

  it("strips a run of trailing slashes, not just one", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPUBLIC_URL=https://vault.example.com///\n")

    expect(readEnvPublicUrl(envPath)).toBe("https://vault.example.com")
  })

  it("returns undefined when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvPublicUrl(missingPath)).toBeUndefined()
  })

  it("returns undefined when PUBLIC_URL is only a comment", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\n# PUBLIC_URL=https://x\n")

    expect(readEnvPublicUrl(envPath)).toBeUndefined()
  })

  it("returns undefined for an empty PUBLIC_URL= line", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPUBLIC_URL=\n")

    expect(readEnvPublicUrl(envPath)).toBeUndefined()
  })

  it("returns undefined for a whitespace-only PUBLIC_URL= line", () => {
    // The regex matches the spaces; the trim must not leak "" past the
    // non-empty contract.
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPUBLIC_URL=   \n")

    expect(readEnvPublicUrl(envPath)).toBeUndefined()
  })

  it("strips surrounding double quotes from the value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nPUBLIC_URL="https://vault.example.com"\n')

    expect(readEnvPublicUrl(envPath)).toBe("https://vault.example.com")
  })

  it("strips quotes then trailing slashes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nPUBLIC_URL="https://vault.example.com/"\n')

    expect(readEnvPublicUrl(envPath)).toBe("https://vault.example.com")
  })

  it("returns undefined when the quotes hold only whitespace", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nPUBLIC_URL="   "\n')

    expect(readEnvPublicUrl(envPath)).toBeUndefined()
  })

  it("trims whitespace inside the quotes before stripping trailing slashes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nPUBLIC_URL=" https://vault.example.com/ "\n')

    expect(readEnvPublicUrl(envPath)).toBe("https://vault.example.com")
  })
})

describe("validatePublicUrl", () => {
  it("accepts a valid https URL", () => {
    expect(validatePublicUrl("https://vault.example.com")).toEqual({
      kind: "ok",
      url: "https://vault.example.com",
    })
  })

  it("accepts a valid http URL with port", () => {
    expect(validatePublicUrl("http://203.0.113.10:8000")).toEqual({
      kind: "ok",
      url: "http://203.0.113.10:8000",
    })
  })

  it("strips a trailing slash", () => {
    expect(validatePublicUrl("https://vault.example.com/")).toEqual({
      kind: "ok",
      url: "https://vault.example.com",
    })
  })

  it("rejects a URL with username and password", () => {
    expect(validatePublicUrl("https://user:pass@vault.example.com")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    })
  })

  it("rejects a URL with username only", () => {
    expect(validatePublicUrl("https://user@vault.example.com")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    })
  })

  it("rejects a URL with password only", () => {
    expect(validatePublicUrl("https://:pass@vault.example.com")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    })
  })

  it("rejects a non-http URL", () => {
    expect(validatePublicUrl("ws://vault.example.com")).toEqual({
      kind: "error",
      message:
        "PUBLIC_URL must be a full http:// or https:// URL (e.g. https://vault.example.com).",
    })
  })

  it("rejects a URL with a trailing /mcp path", () => {
    expect(validatePublicUrl("https://vault.example.com/mcp")).toEqual({
      kind: "error",
      message:
        "Leave /mcp off PUBLIC_URL — it's the base URL and the server adds /mcp itself (e.g. https://vault.example.com).",
    })
  })

  it("rejects invalid syntax", () => {
    expect(validatePublicUrl("not-a-url")).toEqual({
      kind: "error",
      message:
        "PUBLIC_URL must be a full http:// or https:// URL (e.g. https://vault.example.com).",
    })
  })

  it("rejects a URL with a query string", () => {
    expect(validatePublicUrl("https://vault.example.com/?tab=2")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a URL with a hash fragment", () => {
    expect(validatePublicUrl("https://vault.example.com/#section")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a bare trailing query delimiter", () => {
    expect(validatePublicUrl("https://vault.example.com/?")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a bare trailing hash delimiter", () => {
    expect(validatePublicUrl("https://vault.example.com/#")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a URL with a path prefix", () => {
    expect(validatePublicUrl("https://vault.example.com/vault/")).toEqual({
      kind: "error",
      message:
        "PUBLIC_URL must be a bare origin — no path (e.g. https://vault.example.com, not https://vault.example.com/vault/).",
    })
  })

  it("accepts a bare origin with redundant trailing slashes", () => {
    expect(validatePublicUrl("https://vault.example.com//")).toEqual({
      kind: "ok",
      url: "https://vault.example.com",
    })
  })
})

describe("detectMode", () => {
  it("returns undefined when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(detectMode(missingPath)).toBeUndefined()
  })

  it("returns local when OBSIDIAN_AUTH_TOKEN is absent", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/home/user/MyVault\n")

    expect(detectMode(envPath)).toBe("local")
  })

  it("returns local when OBSIDIAN_AUTH_TOKEN is only a comment", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\n# OBSIDIAN_AUTH_TOKEN=token\n")

    expect(detectMode(envPath)).toBe("local")
  })

  it("returns remote when OBSIDIAN_AUTH_TOKEN is present and uncommented", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=token123\nVAULT_NAME=MyVault\n")

    expect(detectMode(envPath)).toBe("remote")
  })

  it("returns remote even when OBSIDIAN_AUTH_TOKEN is empty (deferred fill-in)", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=\n")

    expect(detectMode(envPath)).toBe("remote")
  })
})

describe("writeFiles permissions", () => {
  it("creates .env owner-only (0600) via the file mode", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))

    await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n", mode: 0o600 }],
      },
      neverOverwrite,
    )

    const fileMode = statSync(join(targetDir, ".env")).mode & 0o777
    expect(fileMode).toBe(0o600)
  })

  it("tightens permissions when overwriting an existing wider-mode file", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })

    await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n", mode: 0o600 }],
      },
      alwaysOverwrite,
    )

    const fileMode = statSync(envPath).mode & 0o777
    expect(fileMode).toBe(0o600)
  })
})

describe("patchEnvObsidianToken", () => {
  it("replaces an existing token value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(
      envPath,
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n",
    )

    const result = patchEnvObsidianToken(envPath, "new-token")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new-token\nVAULT_NAME=MyVault\n",
    )
  })

  it("replaces every active token line, so the last one docker reads is the new token", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(
      envPath,
      "OBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\nOBSIDIAN_AUTH_TOKEN=stale-token\n",
    )

    const result = patchEnvObsidianToken(envPath, "new-token")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "OBSIDIAN_AUTH_TOKEN=new-token\nVAULT_NAME=MyVault\nOBSIDIAN_AUTH_TOKEN=new-token\n",
    )
    expect(readEnvObsidianToken(envPath)).toBe("new-token")
  })

  it("replaces an empty token value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "OBSIDIAN_AUTH_TOKEN=\n")

    const result = patchEnvObsidianToken(envPath, "filled-in")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("OBSIDIAN_AUTH_TOKEN=filled-in\n")
  })

  it("returns false when the file does not exist", () => {
    const result = patchEnvObsidianToken(join(tmpdir(), "vault-cli-no-such-file", ".env"), "token")

    expect(result).toBe(false)
  })

  it("returns false when the file has no OBSIDIAN_AUTH_TOKEN line", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/vault\n")

    const result = patchEnvObsidianToken(envPath, "token")

    expect(result).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_PATH=/vault\n")
  })

  it("writes tokens containing $ patterns literally (no regex interpolation)", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "OBSIDIAN_AUTH_TOKEN=old-token\n")

    const result = patchEnvObsidianToken(envPath, "abc$&def$$1$'end")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("OBSIDIAN_AUTH_TOKEN=abc$&def$$1$'end\n")
  })

  it("preserves surrounding content when patching", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    const original =
      "# Comment\nMCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old\nVAULT_NAME=Test\n# Footer\n"
    writeFileSync(envPath, original)

    patchEnvObsidianToken(envPath, "new")

    expect(readFileSync(envPath, "utf8")).toBe(
      "# Comment\nMCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new\nVAULT_NAME=Test\n# Footer\n",
    )
  })
})

describe("readEnvObsidianToken", () => {
  it("returns undefined when the file does not exist", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvObsidianToken(missingPath)).toBeUndefined()
  })

  it("returns the token value from an existing .env", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=my-token\nVAULT_NAME=Test\n")

    expect(readEnvObsidianToken(envPath)).toBe("my-token")
  })

  it("returns undefined when the line exists but the value is empty", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=\nVAULT_NAME=Test\n")

    expect(readEnvObsidianToken(envPath)).toBeUndefined()
  })

  it("returns undefined when the value is an empty pair of quotes", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, 'OBSIDIAN_AUTH_TOKEN=old-token\nOBSIDIAN_AUTH_TOKEN=""\n')

    expect(readEnvObsidianToken(envPath)).toBeUndefined()
  })

  it("keeps the quotes around a quoted token", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, 'OBSIDIAN_AUTH_TOKEN="my-token"\n')

    expect(readEnvObsidianToken(envPath)).toBe('"my-token"')
  })

  it("takes the last active line, as docker --env-file does", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(
      envPath,
      "OBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=Test\nOBSIDIAN_AUTH_TOKEN=new-token\n",
    )

    expect(readEnvObsidianToken(envPath)).toBe("new-token")
  })

  it("returns undefined when the file has no OBSIDIAN_AUTH_TOKEN line", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_NAME=Test\n")

    expect(readEnvObsidianToken(envPath)).toBeUndefined()
  })

  it("trims whitespace from the token value", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, "OBSIDIAN_AUTH_TOKEN=  spaced-token  \n")

    expect(readEnvObsidianToken(envPath)).toBe("spaced-token")
  })
})

describe("stripEnvQuotedValues", () => {
  it("returns false when the file does not exist", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(stripEnvQuotedValues(missingPath)).toBe(false)
  })

  it("returns false when no values are quoted", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    const content = "MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n"
    writeFileSync(envPath, content)

    expect(stripEnvQuotedValues(envPath)).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(content)
  })

  it("strips double quotes from values and writes the file", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\n')

    expect(stripEnvQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n")
  })

  it("strips single quotes from values", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_NAME='My Vault'\n")

    expect(stripEnvQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n")
  })

  it("strips quotes from multiple values in one pass", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'VAULT_NAME="My Vault"\nSYNC_EXCLUDED_FOLDERS="Folder A,Folder B"\n')

    expect(stripEnvQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "VAULT_NAME=My Vault\nSYNC_EXCLUDED_FOLDERS=Folder A,Folder B\n",
    )
  })

  it("preserves comments and unquoted values", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    const content = '# Comment\nMCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\nPORT=8000\n# Footer\n'
    writeFileSync(envPath, content)

    stripEnvQuotedValues(envPath)

    expect(readFileSync(envPath, "utf8")).toBe(
      "# Comment\nMCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\nPORT=8000\n# Footer\n",
    )
  })

  it("does not strip mismatched quotes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    const content = "VAULT_NAME=\"My Vault'\n"
    writeFileSync(envPath, content)

    expect(stripEnvQuotedValues(envPath)).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(content)
  })

  it("preserves inner quotes of a different type", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "VAULT_NAME=\"My 'Cool' Vault\"\n")

    stripEnvQuotedValues(envPath)

    expect(readFileSync(envPath, "utf8")).toBe("VAULT_NAME=My 'Cool' Vault\n")
  })
})

describe("value readers with an empty last line", () => {
  it.each([
    {
      label: "VAULT_PATH",
      envContent: "VAULT_PATH=/Users/me/OldVault\nVAULT_PATH=\n",
      readValue: readEnvVaultPath,
    },
    {
      label: "PUBLIC_URL",
      envContent: "PUBLIC_URL=https://old.example.com\nPUBLIC_URL=\n",
      readValue: readEnvPublicUrl,
    },
    {
      label: "OBSIDIAN_AUTH_TOKEN",
      envContent: "OBSIDIAN_AUTH_TOKEN=old-token\nOBSIDIAN_AUTH_TOKEN=\n",
      readValue: readEnvObsidianToken,
    },
  ])(
    "read an empty last $label line as unset, as docker --env-file does",
    ({ envContent, readValue }) => {
      const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
      writeFileSync(envPath, envContent)

      expect(readValue(envPath)).toBeUndefined()
    },
  )
})
