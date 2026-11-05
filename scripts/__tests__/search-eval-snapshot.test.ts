import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { createVaultSnapshot, snapshotMatchesProvenance } from "../search-eval-snapshot.js"
import { resolveEvalRunPlan } from "../search-eval-plan.js"

// Test-owned copy of the marker name the snapshot writes — drift between
// this and the module's constant should fail these tests.
const SNAPSHOT_MARKER = ".search-eval-snapshot"
const INDEX_CACHE_FILES = [
  "search-eval.db",
  "search-eval.db-wal",
  "search-eval.db-shm",
  "search-eval-enriched.db",
  "search-eval-enriched.db-wal",
  "search-eval-enriched.db-shm",
]

const createTempVault = (): { vaultPath: string; snapshotDir: string } => {
  const rootDir = mkdtempSync(join(tmpdir(), "search-eval-snapshot-"))
  onTestFinished(() => rmSync(rootDir, { recursive: true, force: true }))
  const vaultPath = join(rootDir, "vault")
  mkdirSync(vaultPath, { recursive: true })
  return { vaultPath, snapshotDir: join(rootDir, "snapshot") }
}

const writeVaultFile = ({ vaultPath, notePath }: { vaultPath: string; notePath: string }): void => {
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
  it("preserves the source note's historical modification time", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    const notePath = join("notes", "historical.md")
    writeVaultFile({ vaultPath, notePath })
    const sourcePath = join(vaultPath, notePath)
    const historicalTimeSeconds = 946684800
    utimesSync(sourcePath, historicalTimeSeconds, historicalTimeSeconds)

    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })

    expect(statSync(sourcePath).mtimeMs).toBe(946684800000)
    expect(statSync(join(snapshotDir, notePath)).mtimeMs).toBe(statSync(sourcePath).mtimeMs)
  })

  it("skips files under an excluded prefix but copies a sibling whose name merely starts with it", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile({ vaultPath, notePath: join("sessions", "log.md") })
    writeVaultFile({ vaultPath, notePath: "sessions-archive.md" })
    writeVaultFile({ vaultPath, notePath: join("notes", "keep.md") })

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
    writeVaultFile({ vaultPath, notePath: join("Sessions", "log.md") })
    writeVaultFile({ vaultPath, notePath: join("notes", "keep.md") })

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
    writeVaultFile({ vaultPath, notePath: join(".obsidian", "app.json") })
    writeVaultFile({ vaultPath, notePath: join("notes", ".hidden.md") })
    writeVaultFile({ vaultPath, notePath: join("notes", "keep.md") })

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
    writeVaultFile({ vaultPath, notePath: join("research", "judgment-notes.md") })
    writeVaultFile({ vaultPath, notePath: join("research", "keep.md") })

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
    writeVaultFile({ vaultPath, notePath: "current.md" })
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

  it("invalidates only the known index caches before a refreshed snapshot can be reused", () => {
    const { vaultPath } = createTempVault()
    const workDir = dirname(vaultPath)
    const snapshotDir = join(workDir, "vault-snapshot")
    writeVaultFile({ vaultPath, notePath: "current.md" })
    createVaultSnapshot({ vaultPath, snapshotDir, excludePaths: [], excludePrefixes: [] })
    for (const cacheFile of INDEX_CACHE_FILES) {
      writeFileSync(join(workDir, cacheFile), "index of the old corpus")
    }
    writeFileSync(join(workDir, "custom.db"), "not an eval cache")
    mkdirSync(join(workDir, "models"))
    writeFileSync(join(workDir, "models", "model.onnx"), "cached model")
    writeFileSync(join(vaultPath, "current.md"), "new corpus")

    createVaultSnapshot({ vaultPath, snapshotDir, excludePaths: [], excludePrefixes: [] })

    expect(readFileSync(join(snapshotDir, "current.md"), "utf8")).toBe("new corpus")
    expect(readdirSync(workDir).toSorted()).toEqual([
      "custom.db",
      "models",
      "vault",
      "vault-snapshot",
    ])
    expect(readFileSync(join(workDir, "custom.db"), "utf8")).toBe("not an eval cache")
    expect(readFileSync(join(workDir, "models", "model.onnx"), "utf8")).toBe("cached model")
    const reusePlan = resolveEvalRunPlan({
      judgment: join(workDir, "judgment.json"),
      limits: "20",
      "enrich-metadata": false,
      "work-dir": workDir,
      "reuse-snapshot": true,
      "reuse-index": true,
    })

    expect(reusePlan).toEqual({
      judgmentPath: join(workDir, "judgment.json"),
      limits: [20],
      fileLegWeight: undefined,
      workDir,
      snapshotDir,
      indexDbPath: join(workDir, "search-eval.db"),
      snapshotReused: true,
      indexReused: false,
    })
  })

  it("records provenance a matching reuse accepts, in any exclusion order", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile({ vaultPath, notePath: "current.md" })

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

  it("reports a mismatch for different exclusions", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile({ vaultPath, notePath: "current.md" })

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
  })

  it("reports a mismatch for a marker without provenance", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    mkdirSync(snapshotDir)

    writeFileSync(join(snapshotDir, SNAPSHOT_MARKER), "")
    expect(
      snapshotMatchesProvenance(snapshotDir, {
        vaultPath,
        excludePaths: [],
        excludePrefixes: [],
      }),
    ).toBe(false)
  })

  it("reports a mismatch when the recorded vault path differs", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile({ vaultPath, notePath: "current.md" })

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
    writeVaultFile({ vaultPath, notePath: "current.md" })
    createVaultSnapshot({
      vaultPath,
      snapshotDir,
      excludePaths: [],
      excludePrefixes: [],
    })
    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER, "current.md"])
  })

  it("invalidates both index caches even when refreshing the snapshot fails", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile({ vaultPath, notePath: "old.md" })
    createVaultSnapshot({ vaultPath, snapshotDir, excludePaths: [], excludePrefixes: [] })
    for (const cacheFile of INDEX_CACHE_FILES) {
      writeFileSync(join(dirname(snapshotDir), cacheFile), "index of the old corpus")
    }
    const missingVault = join(dirname(vaultPath), "missing-vault")

    expect(() =>
      createVaultSnapshot({
        vaultPath: missingVault,
        snapshotDir,
        excludePaths: [],
        excludePrefixes: [],
      }),
    ).toThrow(/ENOENT/)

    expect(readdirSync(dirname(snapshotDir)).toSorted()).toEqual(["snapshot", "vault"])
    expect(listSnapshotFiles(snapshotDir)).toEqual([SNAPSHOT_MARKER])
    expect(readFileSync(join(snapshotDir, SNAPSHOT_MARKER), "utf8")).toBe("")
  })

  it("refuses to delete a directory that is not a harness snapshot", () => {
    const { vaultPath, snapshotDir } = createTempVault()
    writeVaultFile({ vaultPath, notePath: "current.md" })
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, "operator-data.md"), "not ours to delete\n")
    for (const cacheFile of INDEX_CACHE_FILES) {
      writeFileSync(join(dirname(snapshotDir), cacheFile), "untouched cache")
    }

    expect(() => {
      createVaultSnapshot({
        vaultPath,
        snapshotDir,
        excludePaths: [],
        excludePrefixes: [],
      })
    }).toThrow(
      new Error(
        `${snapshotDir} exists but is not a harness snapshot — remove it or choose another --work-dir`,
      ),
    )
    expect(readFileSync(join(snapshotDir, "operator-data.md"), "utf8")).toBe("not ours to delete\n")
    expect(
      INDEX_CACHE_FILES.map((cacheFile) =>
        readFileSync(join(dirname(snapshotDir), cacheFile), "utf8"),
      ),
    ).toEqual([
      "untouched cache",
      "untouched cache",
      "untouched cache",
      "untouched cache",
      "untouched cache",
      "untouched cache",
    ])
  })
})
