import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import { runsAsRoot } from "../../../../src/__tests__/runs-as-root.js"
import { expandTilde, validateVaultPath } from "../vault.js"

// Creates a temp folder and registers its removal at creation time, so the
// suite self-cleans even when an assertion throws mid-test.
const makeTempDir = (): string => {
  const tempDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
  onTestFinished(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })
  return tempDir
}

describe("expandTilde", () => {
  it("expands a leading ~/ to the home directory", () => {
    const expanded = expandTilde("~/Documents/MyVault", "/Users/somebody")

    expect(expanded).toBe(join("/Users/somebody", "Documents/MyVault"))
  })

  it("expands a bare ~ to the home directory", () => {
    const expanded = expandTilde("~", "/Users/somebody")

    expect(expanded).toBe("/Users/somebody")
  })

  it("leaves absolute paths untouched", () => {
    const expanded = expandTilde("/var/vaults/MyVault", "/Users/somebody")

    expect(expanded).toBe("/var/vaults/MyVault")
  })

  it("leaves a mid-path tilde untouched", () => {
    const expanded = expandTilde("/data/~backup", "/Users/somebody")

    expect(expanded).toBe("/data/~backup")
  })
})

describe("validateVaultPath", () => {
  it("returns an error for an empty answer", () => {
    const validation = validateVaultPath("   ")

    expect(validation).toEqual({
      kind: "error",
      message: "Vault path is required.",
    })
  })

  it("rejects a path containing an asterisk glob character", () => {
    const validation = validateVaultPath("/path/to/my*vault")

    expect(validation).toEqual({
      kind: "error",
      message: "Vault path must not contain glob characters (*, ?, [).",
    })
  })

  it("rejects a path containing a question-mark glob character", () => {
    const validation = validateVaultPath("/path/to/my?vault")

    expect(validation).toEqual({
      kind: "error",
      message: "Vault path must not contain glob characters (*, ?, [).",
    })
  })

  it("rejects a path containing a bracket glob character", () => {
    const validation = validateVaultPath("/path/to/my[vault")

    expect(validation).toEqual({
      kind: "error",
      message: "Vault path must not contain glob characters (*, ?, [).",
    })
  })

  it("returns an error when the path does not exist", () => {
    const missingPath = join(tmpdir(), "vault-cortex-test-does-not-exist")

    const validation = validateVaultPath(missingPath)

    expect(validation).toEqual({
      kind: "error",
      message: `Path does not exist: ${missingPath}`,
    })
  })

  it.each([
    { label: "a line feed", lineBreak: String.fromCodePoint(0x0a) },
    { label: "a carriage return", lineBreak: String.fromCodePoint(0x0d) },
    { label: "a Unicode line separator", lineBreak: String.fromCodePoint(0x2028) },
    { label: "a Unicode paragraph separator", lineBreak: String.fromCodePoint(0x2029) },
  ])("rejects a path containing $label", ({ lineBreak }) => {
    const validation = validateVaultPath(`/home/user/notes${lineBreak}MCP_AUTH_TOKEN=x`)

    expect(validation).toEqual({
      kind: "error",
      message: "Vault path must not contain a line break.",
    })
  })

  it.each([
    { label: "an escape", controlCharacter: String.fromCodePoint(0x1b) },
    { label: "a tab", controlCharacter: String.fromCodePoint(0x09) },
    { label: "a C1 control character", controlCharacter: String.fromCodePoint(0x9b) },
  ])("rejects a path containing $label", ({ controlCharacter }) => {
    expect(validateVaultPath(`/home/user/no${controlCharacter}tes`)).toEqual({
      kind: "error",
      message: "Vault path must not contain a control character.",
    })
  })

  it.skipIf(runsAsRoot)(
    "returns the does-not-exist error for a path behind a folder it cannot open",
    () => {
      const lockedDir = join(makeTempDir(), "locked")
      mkdirSync(lockedDir)
      chmodSync(lockedDir, 0o000)
      const pathBehindLockedDir = join(lockedDir, "MyVault")

      try {
        expect(validateVaultPath(pathBehindLockedDir)).toEqual({
          kind: "error",
          message: `Path does not exist: ${pathBehindLockedDir}`,
        })
      } finally {
        // The temp folder's removal needs the locked folder readable again.
        chmodSync(lockedDir, 0o700)
      }
    },
  )

  it("returns the does-not-exist error for a path that runs through a file", () => {
    const tempDir = makeTempDir()
    const filePath = join(tempDir, "note.md")
    writeFileSync(filePath, "# hi")
    const pathThroughFile = join(filePath, "MyVault")

    const validation = validateVaultPath(pathThroughFile)

    expect(validation).toEqual({
      kind: "error",
      message: `Path does not exist: ${pathThroughFile}`,
    })
  })

  it("returns an error when the path is a file, not a directory", () => {
    const tempDir = makeTempDir()
    const filePath = join(tempDir, "note.md")
    writeFileSync(filePath, "# hi")

    const validation = validateVaultPath(filePath)

    expect(validation).toEqual({
      kind: "error",
      message: `Path is not a directory: ${filePath}`,
    })
  })

  it("warns when the directory has no .obsidian folder", () => {
    const tempDir = makeTempDir()

    const validation = validateVaultPath(tempDir)

    expect(validation).toEqual({
      kind: "warn",
      path: tempDir,
      message: `${tempDir} doesn't look like an Obsidian vault (no .obsidian folder).`,
    })
  })

  it("returns ok for a directory containing .obsidian", () => {
    const tempDir = makeTempDir()
    mkdirSync(join(tempDir, ".obsidian"))

    const validation = validateVaultPath(tempDir)

    expect(validation).toEqual({ kind: "ok", path: tempDir })
  })
})
