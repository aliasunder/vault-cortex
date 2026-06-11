import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { expandTilde, validateVaultPath } from "../vault.js"

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

  it("returns an error when the path does not exist", () => {
    const missingPath = join(tmpdir(), "vault-cortex-test-does-not-exist")

    const validation = validateVaultPath(missingPath)

    expect(validation.kind).toBe("error")
  })

  it("returns an error when the path is a file, not a directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const filePath = join(tempDir, "note.md")
    writeFileSync(filePath, "# hi")

    const validation = validateVaultPath(filePath)

    expect(validation.kind).toBe("error")
  })

  it("warns when the directory has no .obsidian folder", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vault-cli-"))

    const validation = validateVaultPath(tempDir)

    expect(validation.kind).toBe("warn")
    if (validation.kind === "warn") {
      expect(validation.path).toBe(tempDir)
      expect(validation.message).toContain(".obsidian")
    }
  })

  it("returns ok for a directory containing .obsidian", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    mkdirSync(join(tempDir, ".obsidian"))

    const validation = validateVaultPath(tempDir)

    expect(validation).toEqual({ kind: "ok", path: tempDir })
  })
})
