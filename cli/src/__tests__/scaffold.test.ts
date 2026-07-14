import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildFilesToWrite,
  detectMode,
  patchEnvObsidianToken,
  readEnvPort,
  readEnvVaultPath,
  writeFiles,
} from "../scaffold.js"

const neverOverwrite = async (): Promise<boolean> => false
const alwaysOverwrite = async (): Promise<boolean> => true

describe("buildFilesToWrite", () => {
  it("returns only the .env file with owner-only permissions", () => {
    const files = buildFilesToWrite("MCP_AUTH_TOKEN=abc\n")

    expect(files).toEqual([
      { name: ".env", content: "MCP_AUTH_TOKEN=abc\n", mode: 0o600 },
    ])
  })
})

describe("writeFiles", () => {
  it("creates the target directory and writes all files", async () => {
    const targetDir = join(
      mkdtempSync(join(tmpdir(), "vault-cli-")),
      "nested",
      "vault-cortex",
    )

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n" }],
      },
      neverOverwrite,
    )

    expect(results).toEqual([{ name: ".env", status: "created" }])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\n",
    )
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=old\n",
    )
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=new\n",
    )
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

    expect(readEnvPort(missingPath)).toBe(8000)
  })

  it("returns the default 8000 when PORT is only present as a comment", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\n# PORT=9000\n")

    expect(readEnvPort(envPath)).toBe(8000)
  })

  it("returns an uncommented PORT override", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPORT=9000\n")

    expect(readEnvPort(envPath)).toBe(9000)
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
    writeFileSync(
      envPath,
      "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/home/user/MyVault\n",
    )

    expect(readEnvVaultPath(envPath)).toBe("/home/user/MyVault")
  })

  it("handles paths with spaces", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(
      envPath,
      "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/Users/me/My Vault\n",
    )

    expect(readEnvVaultPath(envPath)).toBe("/Users/me/My Vault")
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
    writeFileSync(
      envPath,
      "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/home/user/MyVault\n",
    )

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
    writeFileSync(
      envPath,
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=token123\nVAULT_NAME=MyVault\n",
    )

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

  it("replaces an empty token value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "OBSIDIAN_AUTH_TOKEN=\n")

    const result = patchEnvObsidianToken(envPath, "filled-in")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "OBSIDIAN_AUTH_TOKEN=filled-in\n",
    )
  })

  it("returns false when the file does not exist", () => {
    const result = patchEnvObsidianToken(
      join(tmpdir(), "vault-cli-no-such-file", ".env"),
      "token",
    )

    expect(result).toBe(false)
  })

  it("returns false when the file has no OBSIDIAN_AUTH_TOKEN line", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/vault\n")

    const result = patchEnvObsidianToken(envPath, "token")

    expect(result).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/vault\n",
    )
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
