import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { envFile } from "../env-file.js"

// Spy mode keeps the real fs, so a test can delete the .env right after the
// adapter reads it.
vi.mock("node:fs", { spy: true })

// A test that fails before the adapter's fs call leaves its once-implementation
// queued; mockReset drops it and puts the real function back.
afterEach(() => {
  vi.mocked(readFileSync).mockReset()
  vi.mocked(chmodSync).mockReset()
})

const neverOverwrite = async (): Promise<boolean> => false
const alwaysOverwrite = async (): Promise<boolean> => true

// Creates a temp dir and registers its removal at creation time, so the
// suite self-cleans even when an assertion throws mid-test.
const makeTempDir = (): string => {
  const tempDir = mkdtempSync(join(tmpdir(), "vault-cli-env-file-"))
  onTestFinished(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })
  return tempDir
}

// Simulates another process removing the .env between the adapter's read and
// its write. The once-implementation is used up before it runs, so the inner
// readFileSync call reaches the real fs.
const deleteEnvAfterNextRead = (envPath: string): void => {
  vi.mocked(readFileSync).mockImplementationOnce((...readArgs) => {
    const envText = readFileSync(...readArgs)
    unlinkSync(envPath)
    return envText
  })
}

describe("read", () => {
  it("returns undefined when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(envFile.read(missingPath)).toBeUndefined()
  })

  it("returns the file's text, an empty file included", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, "")

    expect(envFile.read(envPath)).toBe("")
  })
})

describe("write", () => {
  it("creates the target directory and writes .env", async () => {
    const targetDir = join(makeTempDir(), "nested", "vault-cortex")

    const writeStatus = await envFile.write(
      { targetDir, envContent: "MCP_AUTH_TOKEN=abc\n" },
      neverOverwrite,
    )

    expect(writeStatus).toBe("created")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=abc\n")
  })

  it("skips an existing identical .env without consulting the conflict resolver", async () => {
    const targetDir = makeTempDir()
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc\n")
    const failingResolver = async (): Promise<boolean> => {
      throw new Error("resolver must not be called for identical content")
    }

    const writeStatus = await envFile.write(
      { targetDir, envContent: "MCP_AUTH_TOKEN=abc\n" },
      failingResolver,
    )

    expect(writeStatus).toBe("unchanged")
  })

  it("keeps a differing existing .env untouched when the resolver declines", async () => {
    const targetDir = makeTempDir()
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const writeStatus = await envFile.write(
      { targetDir, envContent: "MCP_AUTH_TOKEN=new\n" },
      neverOverwrite,
    )

    expect(writeStatus).toBe("kept")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
  })

  it("overwrites a differing existing .env when the resolver approves", async () => {
    const targetDir = makeTempDir()
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const writeStatus = await envFile.write(
      { targetDir, envContent: "MCP_AUTH_TOKEN=new\n" },
      alwaysOverwrite,
    )

    expect(writeStatus).toBe("overwritten")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
  })
})

describe("write permissions", () => {
  it("creates .env owner-only (0600)", async () => {
    const targetDir = makeTempDir()

    await envFile.write({ targetDir, envContent: "MCP_AUTH_TOKEN=abc\n" }, neverOverwrite)

    const fileMode = statSync(join(targetDir, ".env")).mode & 0o777
    expect(fileMode).toBe(0o600)
  })

  it("tightens permissions when overwriting an existing wider-mode .env", async () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })

    await envFile.write({ targetDir, envContent: "MCP_AUTH_TOKEN=new\n" }, alwaysOverwrite)

    const fileMode = statSync(envPath).mode & 0o777
    expect(fileMode).toBe(0o600)
  })

  it("recreates .env owner-only, before the chmod, when it is deleted while the resolver decides", async () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    const deleteThenApprove = async (): Promise<boolean> => {
      unlinkSync(envPath)
      return true
    }
    // The chmod that follows the write would hide a wider mode, so record the
    // mode the token was written with before letting the real chmod run.
    const modesBeforeChmod: number[] = []
    vi.mocked(chmodSync).mockImplementationOnce((chmodPath, chmodMode) => {
      modesBeforeChmod.push(statSync(chmodPath).mode & 0o777)
      chmodSync(chmodPath, chmodMode)
    })

    const writeStatus = await envFile.write(
      { targetDir, envContent: "MCP_AUTH_TOKEN=new\n" },
      deleteThenApprove,
    )

    expect(writeStatus).toBe("overwritten")
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(modesBeforeChmod).toEqual([0o600])
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })
})

describe("replace", () => {
  it("rewrites an existing .env and keeps its owner-only permissions", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it("creates a missing .env owner-only", () => {
    const envPath = join(makeTempDir(), ".env")

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it("tightens an existing .env with wider permissions to owner-only", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })
    expect(statSync(envPath).mode & 0o777).toBe(0o644)

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })
})

describe("stripQuotedValues", () => {
  it("returns false when the file does not exist", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(envFile.stripQuotedValues(missingPath)).toBe(false)
  })

  it("returns false when no values are quoted", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    const content = "MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n"
    writeFileSync(envPath, content)

    expect(envFile.stripQuotedValues(envPath)).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(content)
  })

  it("strips double quotes from values and writes the file", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\n')

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n")
  })

  it("tightens a wider-mode file to owner-only when it strips quotes", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, 'MCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\n', { mode: 0o644 })
    expect(statSync(envPath).mode & 0o777).toBe(0o644)

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it("strips single quotes from values", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nVAULT_NAME='My Vault'\n")

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\n")
  })

  it("strips quotes from multiple values in one pass", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, 'VAULT_NAME="My Vault"\nSYNC_EXCLUDED_FOLDERS="Folder A,Folder B"\n')

    expect(envFile.stripQuotedValues(envPath)).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe(
      "VAULT_NAME=My Vault\nSYNC_EXCLUDED_FOLDERS=Folder A,Folder B\n",
    )
  })

  it("preserves comments and unquoted values", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    const content = '# Comment\nMCP_AUTH_TOKEN=abc\nVAULT_NAME="My Vault"\nPORT=8000\n# Footer\n'
    writeFileSync(envPath, content)

    envFile.stripQuotedValues(envPath)

    expect(readFileSync(envPath, "utf8")).toBe(
      "# Comment\nMCP_AUTH_TOKEN=abc\nVAULT_NAME=My Vault\nPORT=8000\n# Footer\n",
    )
  })

  it("does not strip mismatched quotes", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    const content = "VAULT_NAME=\"My Vault'\n"
    writeFileSync(envPath, content)

    expect(envFile.stripQuotedValues(envPath)).toBe(false)
    expect(readFileSync(envPath, "utf8")).toBe(content)
  })

  it("preserves inner quotes of a different type", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "VAULT_NAME=\"My 'Cool' Vault\"\n")

    envFile.stripQuotedValues(envPath)

    expect(readFileSync(envPath, "utf8")).toBe("VAULT_NAME=My 'Cool' Vault\n")
  })
})

describe("stripQuotedValues permissions", () => {
  it("recreates .env owner-only when it is deleted after the read", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, 'VAULT_NAME="My Vault"\n', { mode: 0o600 })
    deleteEnvAfterNextRead(envPath)

    const result = envFile.stripQuotedValues(envPath)

    expect(result).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("VAULT_NAME=My Vault\n")
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })
})
