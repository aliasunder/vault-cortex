import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { createVaultSnapshot } from "../search-eval-snapshot.js"

const createTempVault = (): { vaultPath: string; snapshotDir: string } => {
  const rootDir = mkdtempSync(join(tmpdir(), "search-eval-snapshot-"))
  onTestFinished(() => rmSync(rootDir, { recursive: true, force: true }))
  const vaultPath = join(rootDir, "vault")
  mkdirSync(vaultPath, { recursive: true })
  return { vaultPath, snapshotDir: join(rootDir, "snapshot") }
}

const writeVaultFile = (vaultPath: string, notePath: string): void => {
  const absolutePath = join(vaultPath, notePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, `content of ${notePath}\n`)
}

const listSnapshotFiles = (snapshotDir: string): string[] => {
  const entries = readdirSync(snapshotDir, {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(relative(snapshotDir, entry.parentPath), entry.name))
    .toSorted()
}

describe("createVaultSnapshot", () => {
  it("skips files under an excluded prefix but copies a sibling whose name merely starts with it", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, join("sessions", "log.md"))
    writeVaultFile(vaultPath, "sessions-archive.md")
    writeVaultFile(vaultPath, join("notes", "keep.md"))

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: ["sessions"],
    })

    expect(listSnapshotFiles(snapshotDir)).toEqual([
      join("notes", "keep.md"),
      "sessions-archive.md",
    ])
  })

  it("skips files with a hidden segment at any depth", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, join(".obsidian", "app.json"))
    writeVaultFile(vaultPath, join("notes", ".hidden.md"))
    writeVaultFile(vaultPath, join("notes", "keep.md"))

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })

    expect(listSnapshotFiles(snapshotDir)).toEqual([join("notes", "keep.md")])
  })

  it("skips exactly the excluded paths and copies everything else", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, join("research", "judgment-notes.md"))
    writeVaultFile(vaultPath, join("research", "keep.md"))

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [join("research", "judgment-notes.md")],
      excludePrefixes: [],
    })

    expect(listSnapshotFiles(snapshotDir)).toEqual([
      join("research", "keep.md"),
    ])
  })

  it("replaces an existing snapshot so stale files from a prior run cannot survive", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, "current.md")
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, "stale.md"), "from a prior run\n")

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })

    expect(listSnapshotFiles(snapshotDir)).toEqual(["current.md"])
  })
})
