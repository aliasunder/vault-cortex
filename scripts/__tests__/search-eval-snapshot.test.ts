import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { createVaultSnapshot, snapshotMatchesProvenance } from "../search-eval-snapshot.js"

// Test-owned copy of the marker name the snapshot writes — drift between
// this and the module's constant should fail these tests.
const SNAPSHOT_MARKER = ".search-eval-snapshot"

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
      SNAPSHOT_MARKER,
      join("notes", "keep.md"),
      "sessions-archive.md",
    ])
  })

  it("matches exclusions case-insensitively for case-insensitive vault mounts", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, join("Sessions", "log.md"))
    writeVaultFile(vaultPath, join("notes", "keep.md"))

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: ["sessions"],
    })

    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER, join("notes", "keep.md")])
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

    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER, join("notes", "keep.md")])
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

    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER, join("research", "keep.md")])
  })

  it("replaces an existing harness snapshot so stale files from a prior run cannot survive", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, "current.md")
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, SNAPSHOT_MARKER), "")
    writeFileSync(join(snapshotDir, "stale.md"), "from a prior run\n")

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })

    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER, "current.md"])
  })

  it("records provenance a matching reuse accepts, in any exclusion order", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, "current.md")

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: ["a.md", "b.md"],
      excludePrefixes: ["sessions"],
    })

    expect(
      snapshotMatchesProvenance(snapshotDir, {
        vaultPath,
        excludePaths: ["b.md", "a.md"],
        excludePrefixes: ["sessions"],
      }),
    ).toBe(true)
  })

  it("reports a mismatch for different exclusions and for a pre-provenance marker", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, "current.md")

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: ["sessions"],
    })
    expect(
      snapshotMatchesProvenance(snapshotDir, {
        vaultPath,
        excludePaths: ["newly-excluded.md"],
        excludePrefixes: ["sessions"],
      }),
    ).toBe(false)

    // A marker from before provenance was recorded must read as mismatch.
    writeFileSync(join(snapshotDir, SNAPSHOT_MARKER), "")
    expect(
      snapshotMatchesProvenance(snapshotDir, {
        vaultPath,
        excludePaths: [],
        excludePrefixes: ["sessions"],
      }),
    ).toBe(false)
  })

  it("reports a mismatch when the recorded vault path differs", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, "current.md")

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })

    expect(
      snapshotMatchesProvenance(snapshotDir, {
        vaultPath: join(vaultPath, "..", "other-vault"),
        excludePaths: [],
        excludePrefixes: [],
      }),
    ).toBe(false)
  })

  it("never certifies an interrupted copy as a reusable snapshot", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    const missingVault = join(vaultPath, "..", "does-not-exist")

    // cpSync throws on the missing source after the ownership marker is
    // written, freezing the aborted-copy state this test exercises.
    expect(() => {
      createVaultSnapshot({
        vaultPath: missingVault,
        snapshotDir,
        excludePaths: [],
        excludePrefixes: [],
      })
    }).toThrow(/ENOENT/)
    expect(
      snapshotMatchesProvenance(snapshotDir, {
        vaultPath: missingVault,
        excludePaths: [],
        excludePrefixes: [],
      }),
    ).toBe(false)

    // The ownership marker lets a plain re-run rebuild in place.
    writeVaultFile(vaultPath, "current.md")
    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })
    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER, "current.md"])
  })

  it("refuses to delete a directory that is not a harness snapshot", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile(vaultPath, "current.md")
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, "operator-data.md"), "not ours to delete\n")

    expect(() => {
      createVaultSnapshot({
        vaultPath,
        snapshotDir,
        excludePaths: [],
        excludePrefixes: [],
      })
    }).toThrow(
      `${snapshotDir} exists but is not a harness snapshot — remove it or choose another --work-dir`,
    )
    expect(readFileSync(join(snapshotDir, "operator-data.md"), "utf8")).toBe("not ours to delete\n")
  })
})
