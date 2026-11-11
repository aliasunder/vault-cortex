import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { envFile } from "../env-file.js"
import { parseEnvValues, readEnvObsidianToken } from "../../rules/env-values.js"

const neverOverwrite = async (): Promise<boolean> => false
const alwaysOverwrite = async (): Promise<boolean> => true

describe("read", () => {
  it("returns undefined when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(envFile.read(missingPath)).toBeUndefined()
  })

  it("returns the file's text, an empty file included", () => {
    const envPath = join(mkdtempSync(join(tmpdir(), "vault-cli-")), ".env")
    writeFileSync(envPath, "")

    expect(envFile.read(envPath)).toBe("")
  })
})

describe("buildFilesToWrite", () => {
  it("returns only the .env file with owner-only permissions", () => {
    const files = envFile.buildFilesToWrite("MCP_AUTH_TOKEN=abc\n")

    expect(files).toEqual([{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n", mode: 0o600 }])
  })
})

describe("writeFiles", () => {
  it("creates the target directory and writes all files", async () => {
    const targetDir = join(mkdtempSync(join(tmpdir(), "vault-cli-")), "nested", "vault-cortex")

    const results = await envFile.writeFiles(
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

    const results = await envFile.writeFiles(
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

    const results = await envFile.writeFiles(
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

    const results = await envFile.writeFiles(
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

    const results = await envFile.writeFiles(
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

describe("writeFiles permissions", () => {
  it("creates .env owner-only (0600) via the file mode", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))

    await envFile.writeFiles(
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

    await envFile.writeFiles(
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

describe("patchObsidianToken", () => {
  it("replaces an existing token value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(
      envPath,
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n",
    )

    const result = envFile.patchObsidianToken(envPath, "new-token")

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

    const result = envFile.patchObsidianToken(envPath, "new-token")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "OBSIDIAN_AUTH_TOKEN=new-token\nVAULT_NAME=MyVault\nOBSIDIAN_AUTH_TOKEN=new-token\n",
    )
    expect(readEnvObsidianToken(parseEnvValues(readFileSync(envPath, "utf8")))).toBe("new-token")
  })

  it("replaces an empty token value", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "OBSIDIAN_AUTH_TOKEN=\n")

    const result = envFile.patchObsidianToken(envPath, "filled-in")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("OBSIDIAN_AUTH_TOKEN=filled-in\n")
  })

  it("returns false when the file does not exist", () => {
    const result = envFile.patchObsidianToken(
      join(tmpdir(), "vault-cli-no-such-file", ".env"),
      "token",
    )

    expect(result).toBe(false)
  })

  it("returns false when the file has no OBSIDIAN_AUTH_TOKEN line", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_PATH=/vault\n")

    const result = envFile.patchObsidianToken(envPath, "token")

    expect(result).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_PATH=/vault\n")
  })

  it("writes tokens containing $ patterns literally (no regex interpolation)", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "OBSIDIAN_AUTH_TOKEN=old-token\n")

    const result = envFile.patchObsidianToken(envPath, "abc$&def$$1$'end")

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("OBSIDIAN_AUTH_TOKEN=abc$&def$$1$'end\n")
  })

  it("preserves surrounding content when patching", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-patch-"))
    const envPath = join(targetDir, ".env")
    const original =
      "# Comment\nMCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old\nVAULT_NAME=Test\n# Footer\n"
    writeFileSync(envPath, original)

    envFile.patchObsidianToken(envPath, "new")

    expect(readFileSync(envPath, "utf8")).toBe(
      "# Comment\nMCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new\nVAULT_NAME=Test\n# Footer\n",
    )
  })
})

describe("stripQuotedValues", () => {
  it("returns false when the file does not exist", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(envFile.stripQuotedValues(missingPath)).toBe(false)
  })

  it("returns false when no values are quoted", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    const content = "MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n"
    writeFileSync(envPath, content)

    expect(envFile.stripQuotedValues(envPath)).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(content)
  })

  it("strips double quotes from values and writes the file", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\n')

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n")
  })

  it("strips single quotes from values", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_NAME='My Vault'\n")

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n")
  })

  it("strips quotes from multiple values in one pass", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'VAULT_NAME="My Vault"\nSYNC_EXCLUDED_FOLDERS="Folder A,Folder B"\n')

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "VAULT_NAME=My Vault\nSYNC_EXCLUDED_FOLDERS=Folder A,Folder B\n",
    )
  })

  it("preserves comments and unquoted values", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    const content = '# Comment\nMCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\nPORT=8000\n# Footer\n'
    writeFileSync(envPath, content)

    envFile.stripQuotedValues(envPath)

    expect(readFileSync(envPath, "utf8")).toBe(
      "# Comment\nMCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\nPORT=8000\n# Footer\n",
    )
  })

  it("does not strip mismatched quotes", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    const content = "VAULT_NAME=\"My Vault'\n"
    writeFileSync(envPath, content)

    expect(envFile.stripQuotedValues(envPath)).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(content)
  })

  it("preserves inner quotes of a different type", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sanitize-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "VAULT_NAME=\"My 'Cool' Vault\"\n")

    envFile.stripQuotedValues(envPath)

    expect(readFileSync(envPath, "utf8")).toBe("VAULT_NAME=My 'Cool' Vault\n")
  })
})
