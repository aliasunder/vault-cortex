import { execFileSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  fchownSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { runsAsRoot } from "../../../../src/__tests__/runs-as-root.js"
import { envFile } from "../env-file.js"

// Spy mode keeps the real fs, so a test can delete the .env right after the
// adapter reads it.
vi.mock("node:fs", { spy: true })

// A test that fails before the adapter's fs call leaves its once-implementation
// queued; mockReset drops it and puts the real function back. restoreAllMocks
// puts back process.getuid.
afterEach(() => {
  vi.mocked(readFileSync).mockReset()
  vi.mocked(writeFileSync).mockReset()
  vi.mocked(renameSync).mockReset()
  vi.mocked(fchownSync).mockReset()
  vi.mocked(lchownSync).mockReset()
  vi.mocked(closeSync).mockClear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

  it("returns undefined for a path that runs through a file", () => {
    const filePath = join(makeTempDir(), "note.md")
    writeFileSync(filePath, "")

    expect(envFile.read(join(filePath, ".env"))).toBeUndefined()
  })

  it.skipIf(runsAsRoot)("returns undefined for a .env behind a folder it cannot open", () => {
    const lockedDir = join(makeTempDir(), "locked")
    mkdirSync(lockedDir)
    chmodSync(lockedDir, 0o000)

    try {
      expect(envFile.read(join(lockedDir, ".env"))).toBeUndefined()
    } finally {
      // The temp folder's removal needs the locked folder readable again.
      chmodSync(lockedDir, 0o700)
    }
  })

  it("throws a read failure other than a missing file", () => {
    const directoryPath = makeTempDir()

    // Node's error carries errno fields, so the whole message is matched instead.
    expect(() => envFile.read(directoryPath)).toThrow(
      /^EISDIR: illegal operation on a directory, read$/,
    )
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

  it("recreates .env owner-only when it is deleted while the resolver decides", async () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    const deleteThenApprove = async (): Promise<boolean> => {
      unlinkSync(envPath)
      return true
    }

    const writeStatus = await envFile.write(
      { targetDir, envContent: "MCP_AUTH_TOKEN=new\n" },
      deleteThenApprove,
    )

    expect(writeStatus).toBe("overwritten")
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it("writes a new file in place of the old one, leaving no temporary file", async () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })
    const earlierReader = openSync(envPath, "r")
    onTestFinished(() => {
      closeSync(earlierReader)
    })

    await envFile.write({ targetDir, envContent: "MCP_AUTH_TOKEN=new\n" }, alwaysOverwrite)

    expect(readFileSync(earlierReader, "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(readdirSync(targetDir)).toEqual([".env"])
  })
})

describe("write edge cases", () => {
  it("replaces a linked .env with a regular file, leaving the linked file as it was", () => {
    const installDir = makeTempDir()
    const linkedDir = makeTempDir()
    const linkedEnvPath = join(linkedDir, "shared.env")
    writeFileSync(linkedEnvPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })
    const envPath = join(installDir, ".env")
    symlinkSync(linkedEnvPath, envPath)

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(lstatSync(envPath).isFile()).toBe(true)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(linkedEnvPath, "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
    expect(readdirSync(installDir)).toEqual([".env"])
  })

  it("removes the part-written new file when the write fails, keeping the old .env", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    // Writes the first line, then fails as a full disk would. The
    // once-implementation is used up before it runs, so the inner call reaches the real fs.
    vi.mocked(writeFileSync).mockImplementationOnce((file, _data, options) => {
      writeFileSync(file, "MCP_AUTH", options)
      throw new Error("ENOSPC: no space left on device")
    })
    // Writing the old .env above closed a file too.
    vi.mocked(closeSync).mockClear()

    expect(() => envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")).toThrow(
      new Error("ENOSPC: no space left on device"),
    )
    expect(closeSync).toHaveBeenCalledTimes(1)
    expect(readdirSync(targetDir)).toEqual([".env"])
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
  })

  it("removes the new file when renaming it over .env fails", () => {
    const targetDir = makeTempDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EBUSY: resource busy or locked")
    })

    expect(() => envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")).toThrow(
      new Error("EBUSY: resource busy or locked"),
    )
    expect(readdirSync(targetDir)).toEqual([".env"])
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
  })

  // Root ignores folder permissions, so the folder would not stop it.
  it.skipIf(runsAsRoot)(
    "fails with the folder's error, leaving a linked .env's file as it was, when its folder allows no new file",
    () => {
      const targetDir = makeTempDir()
      const linkedEnvPath = join(makeTempDir(), "shared.env")
      writeFileSync(linkedEnvPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })
      symlinkSync(linkedEnvPath, join(targetDir, ".env"))
      chmodSync(targetDir, 0o500)
      onTestFinished(() => {
        chmodSync(targetDir, 0o700)
      })

      expect(() => envFile.replace(join(targetDir, ".env"), "MCP_AUTH_TOKEN=new\n")).toThrow(
        /^EACCES: permission denied, open '.*\.env\.[0-9a-f-]{36}\.tmp'$/,
      )
      expect(readFileSync(linkedEnvPath, "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
      expect(statSync(linkedEnvPath).mode & 0o777).toBe(0o644)
    },
  )

  // Root ignores folder permissions, so the folder would not stop it.
  it.skipIf(runsAsRoot)(
    "fails with the folder's error, leaving .env as it was, when its folder allows no new file",
    () => {
      const targetDir = makeTempDir()
      const envPath = join(targetDir, ".env")
      writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
      chmodSync(targetDir, 0o500)
      onTestFinished(() => {
        chmodSync(targetDir, 0o700)
      })

      expect(() => envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")).toThrow(
        /^EACCES: permission denied, open '.*\.env\.[0-9a-f-]{36}\.tmp'$/,
      )
      expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=old\n")
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "creates a new install folder without the ACL entries its parent passes down",
    async () => {
      const parentDir = makeTempDir()
      execFileSync("/bin/chmod", [
        "+a",
        "everyone allow read,list,file_inherit,directory_inherit",
        parentDir,
      ])
      const targetDir = join(parentDir, "vault-cortex")
      const listAcl = (listedPath: string): string[] => {
        return execFileSync("/bin/ls", ["-led", listedPath], { encoding: "utf8" })
          .trimEnd()
          .split("\n")
          .slice(1)
      }
      // Without the CLI's step, a folder made here takes the parent's entries.
      const plainFolder = join(parentDir, "plain")
      mkdirSync(plainFolder)
      expect(listAcl(plainFolder)).toEqual([
        " 0: group:everyone inherited allow list,file_inherit,directory_inherit",
      ])

      await envFile.write({ targetDir, envContent: "MCP_AUTH_TOKEN=new\n" }, neverOverwrite)

      expect(listAcl(targetDir)).toEqual([])
      expect(listAcl(join(targetDir, ".env"))).toEqual([])
    },
  )

  it("creates a new install folder owner-only whatever the umask", async () => {
    const targetDir = join(makeTempDir(), "vault-cortex")
    const previousUmask = process.umask(0o000)
    onTestFinished(() => {
      process.umask(previousUmask)
    })

    await envFile.write({ targetDir, envContent: "MCP_AUTH_TOKEN=new\n" }, neverOverwrite)

    expect(statSync(targetDir).mode & 0o777).toBe(0o700)
  })

  it("gives each folder it creates under sudo to the user who ran sudo", async () => {
    const parentDir = makeTempDir()
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.stubEnv("SUDO_UID", "4242")
    vi.stubEnv("SUDO_GID", "4343")
    // Only root may hand a file to another user, so these calls are skipped.
    vi.mocked(lchownSync).mockImplementation(() => undefined)
    vi.mocked(fchownSync).mockImplementation(() => undefined)

    await envFile.write(
      { targetDir: join(parentDir, "apps", "vault-cortex"), envContent: "MCP_AUTH_TOKEN=new\n" },
      neverOverwrite,
    )

    expect(lchownSync).toHaveBeenCalledTimes(2)
    expect(lchownSync).toHaveBeenNthCalledWith(1, join(parentDir, "apps"), 4242, 4343)
    expect(lchownSync).toHaveBeenNthCalledWith(
      2,
      join(parentDir, "apps", "vault-cortex"),
      4242,
      4343,
    )
  })

  it("gives the new file to the user who ran sudo, not to the owner of the .env path", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.stubEnv("SUDO_UID", "4242")
    vi.stubEnv("SUDO_GID", "4343")
    // Only root may hand a file to another user, so the call itself is skipped.
    vi.mocked(fchownSync).mockImplementationOnce(() => undefined)

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(fchownSync).toHaveBeenCalledTimes(1)
    expect(fchownSync).toHaveBeenCalledWith(expect.any(Number), 4242, 4343)
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
  })

  it.each([
    { label: "no SUDO_UID", sudoUid: "", sudoGid: "20" },
    { label: "a SUDO_GID that is not a number", sudoUid: "501", sudoGid: "staff" },
  ])("leaves a root-run file with root when sudo gives $label", ({ sudoUid, sudoGid }) => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.stubEnv("SUDO_UID", sudoUid)
    vi.stubEnv("SUDO_GID", sudoGid)

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(fchownSync).not.toHaveBeenCalled()
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
  })

  // Root ignores folder permissions, so the folder would not stop it.
  it.skipIf(runsAsRoot)(
    "reports the failed create, not a failed cleanup, in a folder it cannot search",
    () => {
      const targetDir = makeTempDir()
      chmodSync(targetDir, 0o600)
      onTestFinished(() => {
        chmodSync(targetDir, 0o700)
      })

      expect(() => envFile.replace(join(targetDir, ".env"), "MCP_AUTH_TOKEN=new\n")).toThrow(
        /^EACCES: permission denied, open '.*\.env\.[0-9a-f-]{36}\.tmp'$/,
      )
    },
  )

  it("leaves the owner alone when the CLI runs as a normal user", () => {
    const envPath = join(makeTempDir(), ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
    vi.spyOn(process, "getuid").mockReturnValue(501)

    envFile.replace(envPath, "MCP_AUTH_TOKEN=new\n")

    expect(fchownSync).not.toHaveBeenCalled()
    expect(readFileSync(envPath, "utf8")).toBe("MCP_AUTH_TOKEN=new\n")
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

describe("folderOwnership", () => {
  it("returns the owner and permission bits of an existing folder", () => {
    const folderPath = makeTempDir()
    chmodSync(folderPath, 0o750)
    const { uid } = statSync(folderPath)

    expect(envFile.folderOwnership(folderPath)).toEqual({
      ownerUid: uid,
      mode: 0o40750,
      aclAllowsAccess: false,
    })
  })

  it.skipIf(process.platform !== "darwin")(
    "reports an ACL entry that lets someone into the folder",
    () => {
      const folderPath = makeTempDir()
      execFileSync("/bin/chmod", ["+a", "everyone allow add_file", folderPath])

      expect(envFile.folderOwnership(folderPath)?.aclAllowsAccess).toBe(true)
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "reports an ACL entry the folder's .env kept after the folder was cleared",
    () => {
      const folderPath = makeTempDir()
      execFileSync("/bin/chmod", ["+a", "everyone allow read,file_inherit", folderPath])
      writeFileSync(join(folderPath, ".env"), "MCP_AUTH_TOKEN=old\n", { mode: 0o600 })
      execFileSync("/bin/chmod", ["-N", folderPath])

      expect(envFile.folderOwnership(folderPath)?.aclAllowsAccess).toBe(true)
    },
  )

  it.skipIf(process.platform !== "darwin")("does not count an ACL entry that only denies", () => {
    const folderPath = makeTempDir()
    execFileSync("/bin/chmod", ["+a", "everyone deny add_file", folderPath])

    expect(envFile.folderOwnership(folderPath)?.aclAllowsAccess).toBe(false)
  })

  it("returns undefined for a folder that does not exist", () => {
    expect(envFile.folderOwnership(join(makeTempDir(), "missing"))).toBeUndefined()
  })
})

describe("trustedOwnerIds", () => {
  it("trusts root and the user running the CLI", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501)

    expect(envFile.trustedOwnerIds()).toEqual([0, 501])
  })

  it("trusts root and the user who ran sudo, under sudo", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.stubEnv("SUDO_UID", "501")
    vi.stubEnv("SUDO_GID", "20")

    expect(envFile.trustedOwnerIds()).toEqual([0, 501])
  })

  it("trusts only root when running as root without sudo ids", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.stubEnv("SUDO_UID", "")

    expect(envFile.trustedOwnerIds()).toEqual([0, 0])
  })

  it("returns undefined where processes have no Unix user id", () => {
    // Windows has no process.getuid at all.
    const realGetuid = process.getuid
    process.getuid = undefined
    onTestFinished(() => {
      process.getuid = realGetuid
    })

    expect(envFile.trustedOwnerIds()).toBeUndefined()
  })
})
