import { describe, it, expect, vi, onTestFinished } from "vitest"
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime } from "luxon"

// Every node:fs/promises export becomes a pass-through spy, so a test can
// make the host remove a file at the exact moment the sweep unlinks it.
vi.mock("node:fs/promises", { spy: true })
import { trashSweeper } from "../trash-sweeper.js"
import { readTrashFileState, vaultFs } from "../vault-filesystem.js"
import { createSearchIndex } from "../../search/search-index.js"
import type { TrashEntry, TrashEntryStore } from "../../search/search-index.js"
import { logger } from "../../../logger.js"

/** A temp vault with a .trash/ folder, removed when the test finishes. */
const createTestVault = async (): Promise<string> => {
  const vault = await mkdtemp(join(tmpdir(), "trash-sweep-"))
  await mkdir(join(vault, ".trash"), { recursive: true })
  onTestFinished(() => rm(vault, { recursive: true, force: true }))
  return vault
}

type RecordedTrashFile = { trashPath: string; fileIdentity: string }

/** An identity no real file has (no file is ever given inode 0), for a row
 *  whose file is absent or never compared. */
const ABSENT_FILE_IDENTITY = "0:0:0"

/** Linux stamps inode times from a clock that advances once per scheduler
 *  tick (up to 10 ms), so two changes inside one tick share a change time.
 *  Waiting past a tick makes the next change land a new one. */
const waitPastTimestampTick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

/** The row the server records for the file now at `trashPath`, which must
 *  exist. */
const recordedTrashFileAt = async (
  vault: string,
  trashPath: string,
): Promise<RecordedTrashFile> => {
  const { identity } = await readTrashFileState(join(vault, trashPath))
  return { trashPath, fileIdentity: identity }
}

/** A row for a trash path with no file behind it. */
const recordedAbsentFile = (trashPath: string): RecordedTrashFile => {
  return { trashPath, fileIdentity: ABSENT_FILE_IDENTITY }
}

/** Records an entry stamped at `moment` instead of now. */
const recordEntryAt = (
  index: ReturnType<typeof createSearchIndex>,
  recordedFile: RecordedTrashFile,
  moment: DateTime,
): void => {
  vi.useFakeTimers({ toFake: ["Date"] })
  // A throwing record would otherwise leave Date frozen for the tests after it.
  try {
    vi.setSystemTime(moment.toMillis())
    index.recordTrashEntry(recordedFile)
  } finally {
    vi.useRealTimers()
  }
}

/** The trashedAt the index stored for a row the test has just recorded. */
const trashedAtOf = (index: ReturnType<typeof createSearchIndex>, trashPath: string): number => {
  const recordedEntry = index.getTrashEntry(trashPath)

  if (!recordedEntry) throw new Error(`no trash entry recorded for ${trashPath}`)
  return recordedEntry.trashedAt
}

/** How many days after the real moment the sweeps below run: one more than
 *  their 30-day retention, so entries recorded now have expired. */
const SWEEP_DAYS_LATER = 31

/** Runs a 30-day-retention sweep as if SWEEP_DAYS_LATER days had passed.
 *  Only Date is faked, so the kernel still stamps each file's change time at
 *  the real moment, as it does for the server's own trash move, and a row
 *  recorded now passes the sweep's change-time limit. */
const sweepAfterRetention = async (
  vault: string,
  trashEntryStore: TrashEntryStore,
): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(DateTime.now().plus({ days: SWEEP_DAYS_LATER }).toMillis())

  await trashSweeper.sweepExpiredTrashEntries(
    { vaultPath: vault, retentionDays: 30, trashEntryStore },
    logger,
  )

  vi.useRealTimers()
}

/** The warning the sweep logs for every file it keeps. */
const KEPT_FILE_WARNING =
  "trash entry cannot be matched to the file the server trashed — kept, row dropped"

describe("sweepExpiredTrashEntries", () => {
  it("unlinks an expired entry's file and drops its row; a fresh entry and its file survive", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "old.md"), "expired", "utf8")
    await writeFile(join(vault, ".trash", "new.md"), "fresh", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/old.md"))
    // Recorded a day before the sweep runs, so still inside the retention.
    recordEntryAt(
      index,
      await recordedTrashFileAt(vault, ".trash/new.md"),
      DateTime.now().plus({ days: SWEEP_DAYS_LATER - 1 }),
    )
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "old.md"))).rejects.toThrow(/ENOENT/)
    expect(index.getTrashEntry(".trash/old.md")).toBeNull()
    const freshContent = await readFile(join(vault, ".trash", "new.md"), "utf8")
    expect(freshContent).toBe("fresh")
    expect(index.getTrashEntry(".trash/new.md")?.trashPath).toBe(".trash/new.md")
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 1,
      droppedMissing: 0,
      droppedUnmatched: 0,
    })
  })

  it("drops the row and counts it as missing, without a warning, when the expired file is already gone", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(recordedAbsentFile(".trash/emptied.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    expect(index.getTrashEntry(".trash/emptied.md")).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 0,
      droppedMissing: 1,
      droppedUnmatched: 0,
    })
  })

  it("drops the row when the entry's whole parent folder is gone", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    // The recorded subfolder never exists — realpath on the parent ENOENTs.
    index.recordTrashEntry(recordedAbsentFile(".trash/vanished-folder/x.md"))

    await sweepAfterRetention(vault, index)

    expect(index.getTrashEntry(".trash/vanished-folder/x.md")).toBeNull()
  })

  it("drops the row without a warning when a file now stands where the entry's folder was", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await mkdir(join(vault, ".trash", "replaced"))
    await writeFile(join(vault, ".trash", "replaced", "x.md"), "expired", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/replaced/x.md"))
    // The file now at .trash/replaced still resolves inside .trash/, so the
    // containment gates pass and the identity read fails with ENOTDIR.
    await rm(join(vault, ".trash", "replaced"), { recursive: true })
    await writeFile(join(vault, ".trash", "replaced"), "a file where the folder was", "utf8")
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    expect(index.getTrashEntry(".trash/replaced/x.md")).toBeNull()
    const replacementContent = await readFile(join(vault, ".trash", "replaced"), "utf8")
    expect(replacementContent).toBe("a file where the folder was")
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 0,
      droppedMissing: 1,
      droppedUnmatched: 0,
    })
  })

  it("drops the row when the file vanishes between the identity check and the unlink", async () => {
    // The host owns the bind mount and can empty .trash/ at any moment,
    // including after the identity check has matched the file.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "vanishing.md"), "expired", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/vanishing.md"))
    // The sweep's only unlink call is this file's. The host removes the file
    // first, so the sweep's own unlink then fails with ENOENT.
    vi.mocked(unlink).mockImplementationOnce(async (target) => {
      await rm(target)
      return unlink(target)
    })
    onTestFinished(() => {
      vi.mocked(unlink).mockReset()
    })
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "vanishing.md"))).rejects.toThrow(/ENOENT/)
    expect(index.getTrashEntry(".trash/vanishing.md")).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
    // The file was present for the identity check, so only the unlink's
    // ENOENT can count this row as missing rather than unlinked.
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 0,
      droppedMissing: 1,
      droppedUnmatched: 0,
    })
  })

  it("skips a listed row that was refreshed before its turn — the fresh file survives", async () => {
    // The expired list is a snapshot taken before any lock; a delete can
    // re-trash the same path (refreshing the row) before the sweep reaches
    // it. The in-lock re-read must catch that, or this fresh copy is lost.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "raced.md"), "fresh copy", "utf8")
    // The row holds the file's real identity, so only the in-lock re-read can
    // keep this file.
    const racedFile = await recordedTrashFileAt(vault, ".trash/raced.md")
    index.recordTrashEntry(racedFile)
    const getTrashEntry = vi.fn(index.getTrashEntry)
    const racingStore: TrashEntryStore = {
      listAllTrashEntries: index.listAllTrashEntries,
      listExpiredTrashEntries: (cutoffEpochSeconds: number) => {
        const listed = index.listExpiredTrashEntries(cutoffEpochSeconds)
        // The concurrent delete lands between the snapshot and the per-row
        // lock, refreshing the row to now.
        index.recordTrashEntry(racedFile)
        return listed
      },
      getTrashEntry,
      deleteTrashEntry: index.deleteTrashEntry,
    }
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, racingStore)

    const racedContent = await readFile(join(vault, ".trash", "raced.md"), "utf8")
    expect(racedContent).toBe("fresh copy")
    expect(index.getTrashEntry(".trash/raced.md")?.trashPath).toBe(".trash/raced.md")
    // The sweep re-read the listed row under the lock and unlinked nothing.
    expect(getTrashEntry).toHaveBeenCalledTimes(1)
    expect(getTrashEntry).toHaveBeenCalledWith(".trash/raced.md")
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 0,
      droppedMissing: 0,
      droppedUnmatched: 0,
    })
  })

  it("skips a listed row that a concurrent delete cleared before its turn — the kept file survives", async () => {
    // A "local" delete landing at the path clears the row while the sweep
    // waits for the lock. The in-lock re-read then finds no row.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "cleared.md"), "keep forever", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/cleared.md"))
    const getTrashEntry = vi.fn(index.getTrashEntry)
    const racingStore: TrashEntryStore = {
      listAllTrashEntries: index.listAllTrashEntries,
      listExpiredTrashEntries: (cutoffEpochSeconds: number) => {
        const listed = index.listExpiredTrashEntries(cutoffEpochSeconds)
        index.deleteTrashEntry(".trash/cleared.md")
        return listed
      },
      getTrashEntry,
      deleteTrashEntry: index.deleteTrashEntry,
    }
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, racingStore)

    const clearedContent = await readFile(join(vault, ".trash", "cleared.md"), "utf8")
    expect(clearedContent).toBe("keep forever")
    // The sweep re-read the listed row under the lock and unlinked nothing.
    expect(getTrashEntry).toHaveBeenCalledTimes(1)
    expect(getTrashEntry).toHaveBeenCalledWith(".trash/cleared.md")
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 0,
      droppedMissing: 0,
      droppedUnmatched: 0,
    })
  })

  it("refuses a row that resolves outside the vault — file untouched, row kept", async () => {
    const base = await mkdtemp(join(tmpdir(), "trash-escape-"))
    onTestFinished(() => rm(base, { recursive: true, force: true }))
    const vault = join(base, "vault")
    await mkdir(join(vault, ".trash"), { recursive: true })
    await writeFile(join(base, "escape.md"), "outside the vault", "utf8")
    const index = createSearchIndex(":memory:")
    // The row holds the escape target's real identity, so only the
    // containment gate can keep it.
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/../../escape.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    const escapeContent = await readFile(join(base, "escape.md"), "utf8")
    expect(escapeContent).toBe("outside the vault")
    expect(index.getTrashEntry(".trash/../../escape.md")?.trashPath).toBe(".trash/../../escape.md")
    expect(warnSpy).toHaveBeenCalledWith("trash entry resolves outside .trash — skipped", {
      trashPath: ".trash/../../escape.md",
    })
  })

  it("refuses a row that traverses back into the live vault — the live note survives", async () => {
    // ".trash/../Live/x.md" starts with ".trash/" yet resolves onto a live
    // note — the gate must compare resolved paths, not raw row text.
    const vault = await createTestVault()
    await mkdir(join(vault, "Live"), { recursive: true })
    await writeFile(join(vault, "Live", "x.md"), "live note", "utf8")
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/../Live/x.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    const liveContent = await readFile(join(vault, "Live", "x.md"), "utf8")
    expect(liveContent).toBe("live note")
    expect(warnSpy).toHaveBeenCalledWith("trash entry resolves outside .trash — skipped", {
      trashPath: ".trash/../Live/x.md",
    })
  })

  it("refuses a row whose parent is a directory symlink out of .trash/ — the target survives", async () => {
    // A lexically-clean path can still land outside .trash/ through a
    // symlinked directory; only the realpath gate catches that.
    const vault = await createTestVault()
    await mkdir(join(vault, "RealNotes"), { recursive: true })
    await writeFile(join(vault, "RealNotes", "live.md"), "live note", "utf8")
    await symlink(join(vault, "RealNotes"), join(vault, ".trash", "linkdir"))
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/linkdir/live.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    const liveContent = await readFile(join(vault, "RealNotes", "live.md"), "utf8")
    expect(liveContent).toBe("live note")
    expect(warnSpy).toHaveBeenCalledWith("trash entry parent escapes .trash — skipped", {
      trashPath: ".trash/linkdir/live.md",
    })
  })

  it("keeps the row and warns when realpath fails with a non-ENOENT error", async () => {
    const vault = await createTestVault()
    const lockedDir = join(vault, ".trash", "noaccess")
    await mkdir(lockedDir, { recursive: true })
    await writeFile(join(lockedDir, "stuck.md"), "perm error", "utf8")
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/noaccess/stuck.md"))
    // Remove all permissions from .trash/ so realpath on the parent fails.
    await chmod(join(vault, ".trash"), 0o000)
    onTestFinished(() => chmod(join(vault, ".trash"), 0o755))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    expect(index.getTrashEntry(".trash/noaccess/stuck.md")?.trashPath).toBe(
      ".trash/noaccess/stuck.md",
    )
    expect(warnSpy).toHaveBeenCalledWith("failed to resolve trash entry path", {
      trashPath: ".trash/noaccess/stuck.md",
      error: `[Error]: EACCES: permission denied, realpath '${lockedDir}'`,
    })
  })

  it("keeps the row and warns when unlink fails with a non-ENOENT error", async () => {
    // A permission error during unlink keeps the row so the next sweep
    // retries; one bad row never aborts the sweep.
    const vault = await createTestVault()
    const lockedDir = join(vault, ".trash", "locked")
    await mkdir(lockedDir, { recursive: true })
    await writeFile(join(lockedDir, "stuck.md"), "perm error", "utf8")
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/locked/stuck.md"))
    // Remove write permission from the parent so unlink fails with EACCES.
    await chmod(lockedDir, 0o555)
    onTestFinished(() => chmod(lockedDir, 0o755))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    expect(index.getTrashEntry(".trash/locked/stuck.md")?.trashPath).toBe(".trash/locked/stuck.md")
    const content = await readFile(join(lockedDir, "stuck.md"), "utf8")
    expect(content).toBe("perm error")
    expect(warnSpy).toHaveBeenCalledWith("failed to remove expired trash entry", {
      trashPath: ".trash/locked/stuck.md",
      error: `[Error]: EACCES: permission denied, unlink '${join(lockedDir, "stuck.md")}'`,
    })
  })

  it("an unrecorded delete clears a stale row at its landed path before any sweep runs", async () => {
    // A row can outlive its file in .trash/. A keep-forever "local" delete
    // landing at that path drops the row on the way in, so the sweep never
    // has to tell the new file apart from the one the row recorded.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(recordedAbsentFile(".trash/reused.md"))
    await writeFile(join(vault, "reused.md"), "keep forever", "utf8")
    const deleteResult = await vaultFs.deleteNote(
      {
        vaultPath: vault,
        path: "reused.md",
        protectedPaths: [],
        pruneEmptyFolders: false,
        trashOption: "local",
        clearStaleTrashEntry: index.deleteTrashEntry,
      },
      logger,
    )
    expect(deleteResult.trashLocation).toBe(".trash/reused.md")
    expect(index.getTrashEntry(".trash/reused.md")).toBeNull()

    await sweepAfterRetention(vault, index)

    const keptContent = await readFile(join(vault, ".trash", "reused.md"), "utf8")
    expect(keptContent).toBe("keep forever")
    expect(index.getTrashEntry(".trash/reused.md")).toBeNull()
  })

  it("keeps a file whose change time runs more than 60 seconds past its row's trashedAt", async () => {
    // A row recorded two minutes before the file last changed status stands
    // for a note restored by hand and trashed again a while later: the
    // renames kept its identity and moved only its change time.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "restored.md"), "deleted twice", "utf8")
    recordEntryAt(
      index,
      await recordedTrashFileAt(vault, ".trash/restored.md"),
      DateTime.now().minus({ minutes: 2 }),
    )
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    const restoredContent = await readFile(join(vault, ".trash", "restored.md"), "utf8")
    expect(restoredContent).toBe("deleted twice")
    expect(index.getTrashEntry(".trash/restored.md")).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(KEPT_FILE_WARNING, {
      trashPath: ".trash/restored.md",
      reason: "changed",
    })
  })

  it("unlinks a file whose change time is exactly 60 seconds past its row's trashedAt", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "boundary.md"), "expired", "utf8")
    // Recorded two minutes back, so the file's real change time is past the
    // limit and only the change time reported below can unlink it.
    recordEntryAt(
      index,
      await recordedTrashFileAt(vault, ".trash/boundary.md"),
      DateTime.now().minus({ minutes: 2 }),
    )
    const trashedAt = trashedAtOf(index, ".trash/boundary.md")
    // The sweep's only lstat call is the identity read, here reporting a
    // change time at the very end of the allowance.
    vi.mocked(lstat).mockImplementationOnce(async (target) => {
      const fileStats = await lstat(target, { bigint: true })
      return Object.assign(fileStats, { ctimeNs: BigInt(trashedAt + 60) * 1_000_000_000n })
    })
    onTestFinished(() => {
      vi.mocked(lstat).mockReset()
    })

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "boundary.md"))).rejects.toThrow(/ENOENT/)
    expect(index.getTrashEntry(".trash/boundary.md")).toBeNull()
  })

  it("keeps a file whose change time is one nanosecond past the 60-second allowance", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "boundary.md"), "expired", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/boundary.md"))
    const trashedAt = trashedAtOf(index, ".trash/boundary.md")
    // The sweep's only lstat call is the identity read, here reporting a
    // change time just past the end of the allowance.
    vi.mocked(lstat).mockImplementationOnce(async (target) => {
      const fileStats = await lstat(target, { bigint: true })
      return Object.assign(fileStats, { ctimeNs: BigInt(trashedAt + 60) * 1_000_000_000n + 1n })
    })
    onTestFinished(() => {
      vi.mocked(lstat).mockReset()
    })
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    const keptContent = await readFile(join(vault, ".trash", "boundary.md"), "utf8")
    expect(keptContent).toBe("expired")
    expect(index.getTrashEntry(".trash/boundary.md")).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(KEPT_FILE_WARNING, {
      trashPath: ".trash/boundary.md",
      reason: "changed",
    })
  })

  it("unlinks a file whose change time comes well before its row's trashedAt", async () => {
    // Only a change after the row was recorded shows the file was touched
    // since the server trashed it, so an earlier change time never keeps it.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "early.md"), "expired", "utf8")
    // Recorded ten minutes after the file's change time, and still long
    // enough before the sweep to have expired.
    recordEntryAt(
      index,
      await recordedTrashFileAt(vault, ".trash/early.md"),
      DateTime.now().plus({ minutes: 10 }),
    )
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "early.md"))).rejects.toThrow(/ENOENT/)
    expect(index.getTrashEntry(".trash/early.md")).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("still unlinks a note restored by hand and trashed again within the 60-second allowance", async () => {
    // The allowance covers the gap between the server's rename and its row,
    // so a restore and re-trash inside it cannot be told apart from the
    // server's own move.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, "restored.md"), "deleted twice", "utf8")
    await vaultFs.deleteNote(
      {
        vaultPath: vault,
        path: "restored.md",
        protectedPaths: [],
        pruneEmptyFolders: false,
        trashOption: "system",
        recordTrashEntry: index.recordTrashEntry,
      },
      logger,
    )
    await waitPastTimestampTick()
    await rename(join(vault, ".trash", "restored.md"), join(vault, "restored.md"))
    await rename(join(vault, "restored.md"), join(vault, ".trash", "restored.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "restored.md"))).rejects.toThrow(/ENOENT/)
    expect(index.getTrashEntry(".trash/restored.md")).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("keeps a note Obsidian trashed under a recycled name after .trash/ was emptied by hand", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, "recycled.md"), "server deleted this", "utf8")
    await vaultFs.deleteNote(
      {
        vaultPath: vault,
        path: "recycled.md",
        protectedPaths: [],
        pruneEmptyFolders: false,
        trashOption: "system",
        recordTrashEntry: index.recordTrashEntry,
      },
      logger,
    )
    // Emptying .trash/ by hand while the server runs leaves the row without
    // its file; Obsidian then trashes a new note under the same name.
    await rm(join(vault, ".trash", "recycled.md"))
    await writeFile(join(vault, "recycled.md"), "obsidian trashed this", "utf8")
    await rename(join(vault, "recycled.md"), join(vault, ".trash", "recycled.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    const obsidianCopy = await readFile(join(vault, ".trash", "recycled.md"), "utf8")
    expect(obsidianCopy).toBe("obsidian trashed this")
    expect(index.getTrashEntry(".trash/recycled.md")).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(KEPT_FILE_WARNING, {
      trashPath: ".trash/recycled.md",
      reason: "replaced",
    })
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 0,
      droppedMissing: 0,
      droppedUnmatched: 1,
    })
  })

  it("keeps the file and drops the row for an entry recorded without an identity", async () => {
    // Rows recorded before identities were kept read back with a null
    // identity. Such a row may already point at a file the server never
    // trashed, so it can never authorize a delete.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "legacy.md"), "recorded long ago", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/legacy.md"))
    const withoutIdentity = (entry: TrashEntry): TrashEntry => ({ ...entry, fileIdentity: null })
    const legacyStore: TrashEntryStore = {
      listAllTrashEntries: index.listAllTrashEntries,
      listExpiredTrashEntries: (cutoffEpochSeconds: number) => {
        return index.listExpiredTrashEntries(cutoffEpochSeconds).map(withoutIdentity)
      },
      getTrashEntry: (trashPath: string) => {
        const entry = index.getTrashEntry(trashPath)
        return entry ? withoutIdentity(entry) : null
      },
      deleteTrashEntry: index.deleteTrashEntry,
    }
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, legacyStore)

    const legacyContent = await readFile(join(vault, ".trash", "legacy.md"), "utf8")
    expect(legacyContent).toBe("recorded long ago")
    expect(index.getTrashEntry(".trash/legacy.md")).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(KEPT_FILE_WARNING, {
      trashPath: ".trash/legacy.md",
      reason: "unrecorded",
    })
  })

  it("keeps the row and warns when the identity read fails with a non-ENOENT error", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    const lockedDir = join(vault, ".trash", "nosearch")
    await mkdir(lockedDir)
    await writeFile(join(lockedDir, "stuck.md"), "stays", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/nosearch/stuck.md"))
    // Without search permission the folder itself still resolves, so the
    // containment gate passes, but no entry inside it can be looked up.
    await chmod(lockedDir, 0o600)
    onTestFinished(() => chmod(lockedDir, 0o755))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    expect(index.getTrashEntry(".trash/nosearch/stuck.md")?.trashPath).toBe(
      ".trash/nosearch/stuck.md",
    )
    expect(warnSpy).toHaveBeenCalledWith("failed to read trash entry identity", {
      trashPath: ".trash/nosearch/stuck.md",
      error: `[Error]: EACCES: permission denied, lstat '${join(lockedDir, "stuck.md")}'`,
    })
    await chmod(lockedDir, 0o755)
    const stuckContent = await readFile(join(lockedDir, "stuck.md"), "utf8")
    expect(stuckContent).toBe("stays")
  })

  it("prunes the folders an unlink empties, keeping .trash/ itself", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await mkdir(join(vault, ".trash", "sub", "deep"), { recursive: true })
    await writeFile(join(vault, ".trash", "sub", "deep", "old.md"), "expired", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/sub/deep/old.md"))

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "sub", "deep", "old.md"))).rejects.toThrow(/ENOENT/)
    await expect(stat(join(vault, ".trash", "sub"))).rejects.toThrow(/ENOENT/)
    const trashRootStat = await stat(join(vault, ".trash"))
    expect(trashRootStat.isDirectory()).toBe(true)
  })

  it("keeps an unlinked file's folder when it still holds other files", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await mkdir(join(vault, ".trash", "shared"), { recursive: true })
    await writeFile(join(vault, ".trash", "shared", "old.md"), "expired", "utf8")
    await writeFile(join(vault, ".trash", "shared", "kept.md"), "stays", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/shared/old.md"))

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "shared", "old.md"))).rejects.toThrow(/ENOENT/)
    const keptContent = await readFile(join(vault, ".trash", "shared", "kept.md"), "utf8")
    expect(keptContent).toBe("stays")
  })

  it("warns and moves on to the next row when pruning an unlinked file's folders fails", async () => {
    // A hidden folder segment makes the prune's path check throw. Only a
    // corrupted or hand-edited row can hold one, and it must not end the
    // sweep for the rows listed after it.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await mkdir(join(vault, ".trash", ".stuck"), { recursive: true })
    await writeFile(join(vault, ".trash", ".stuck", "x.md"), "expired", "utf8")
    await writeFile(join(vault, ".trash", "after.md"), "expired too", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/.stuck/x.md"))
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/after.md"))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", ".stuck", "x.md"))).rejects.toThrow(/ENOENT/)
    await expect(stat(join(vault, ".trash", "after.md"))).rejects.toThrow(/ENOENT/)
    expect(warnSpy).toHaveBeenCalledWith("failed to prune emptied trash folders", {
      trashPath: ".trash/.stuck/x.md",
      error: '[Error]: hidden path blocked: ".stuck/x.md" targets a hidden file or folder',
    })
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 2,
      purged: 2,
      droppedMissing: 0,
      droppedUnmatched: 0,
    })
  })

  it("never touches a trash file it has no row for, however old", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    // Obsidian's own trashed file: present on disk, no row. Seeded beside a
    // recorded expired file so a passing test proves the sweep actually ran.
    await writeFile(join(vault, ".trash", "obsidian-own.md"), "obsidian trashed this", "utf8")
    await writeFile(join(vault, ".trash", "recorded.md"), "ours", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/recorded.md"))

    await sweepAfterRetention(vault, index)

    await expect(stat(join(vault, ".trash", "recorded.md"))).rejects.toThrow(/ENOENT/)
    const obsidianOwnContent = await readFile(join(vault, ".trash", "obsidian-own.md"), "utf8")
    expect(obsidianOwnContent).toBe("obsidian trashed this")
  })
})

describe("startTrashSweepSchedule", () => {
  it("runs a sweep immediately", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "startup.md"), "expired", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/startup.md"))
    // Only Date moves forward, as in sweepAfterRetention, so the row has
    // expired while the file's change time still meets the limit.
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(DateTime.now().plus({ days: SWEEP_DAYS_LATER }).toMillis())

    trashSweeper.startTrashSweepSchedule(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    await vi.waitFor(() => {
      expect(index.getTrashEntry(".trash/startup.md")).toBeNull()
    })
    await expect(stat(join(vault, ".trash", "startup.md"))).rejects.toThrow(/ENOENT/)
  })

  it("logs the failure and re-arms the daily chain when a sweep throws", async () => {
    const vault = await createTestVault()
    // The daily re-arm is the contract under test, so fake timers drive the
    // clock; outcomes are asserted after advancing it, not the tick schedule.
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())
    const listExpiredTrashEntries = vi.fn(() => {
      throw new Error("index unavailable")
    })
    const throwingStore: TrashEntryStore = {
      listAllTrashEntries: () => [],
      listExpiredTrashEntries,
      getTrashEntry: () => null,
      deleteTrashEntry: (): void => undefined,
    }

    trashSweeper.startTrashSweepSchedule(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: throwingStore },
      logger,
    )

    // Flush the rejected sweep's catch/finally microtasks.
    await vi.advanceTimersByTimeAsync(0)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith("trash retention sweep failed", {
      error: "[Error]: index unavailable",
    })

    // The finally re-armed the chain: one day later the sweep runs again.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(listExpiredTrashEntries).toHaveBeenCalledTimes(2)
  })
})

describe("purgeOrphanedTrashEntries", () => {
  it("drops rows for missing files; existing files and their rows survive untouched", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "present.md"), "still here", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/present.md"))
    index.recordTrashEntry(recordedAbsentFile(".trash/gone.md"))
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/gone.md")).toBeNull()
    expect(index.getTrashEntry(".trash/present.md")?.trashPath).toBe(".trash/present.md")
    const presentContent = await readFile(join(vault, ".trash", "present.md"), "utf8")
    expect(presentContent).toBe("still here")
    expect(infoSpy).toHaveBeenCalledWith("orphaned trash entries purged", {
      checked: 2,
      purged: 1,
    })
  })

  it("no log when the table is empty", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    const purgeCalls = infoSpy.mock.calls.filter(
      ([message]) => message === "orphaned trash entries purged",
    )
    expect(purgeCalls).toEqual([])
  })

  it("no log when all entries have files on disk", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "a.md"), "content", "utf8")
    await writeFile(join(vault, ".trash", "b.md"), "content", "utf8")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/a.md"))
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/b.md"))
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    const purgeCalls = infoSpy.mock.calls.filter(
      ([message]) => message === "orphaned trash entries purged",
    )
    expect(purgeCalls).toEqual([])
    expect(index.getTrashEntry(".trash/a.md")?.trashPath).toBe(".trash/a.md")
    expect(index.getTrashEntry(".trash/b.md")?.trashPath).toBe(".trash/b.md")
  })

  it("skips a row refreshed between listing and processing", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    // Back-date the original so the refresh (recorded at "now") gets a
    // different trashedAt — both within the same second would match.
    recordEntryAt(index, recordedAbsentFile(".trash/raced.md"), DateTime.now().minus({ days: 1 }))
    // A control orphan, dropped whenever the purge runs, proves it ran.
    index.recordTrashEntry(recordedAbsentFile(".trash/control-orphan.md"))
    const racingStore: TrashEntryStore = {
      listAllTrashEntries: () => {
        const listed = index.listAllTrashEntries()
        // A concurrent trash move refreshes the row between the snapshot
        // and the per-row lock.
        index.recordTrashEntry(recordedAbsentFile(".trash/raced.md"))
        return listed
      },
      listExpiredTrashEntries: index.listExpiredTrashEntries,
      getTrashEntry: index.getTrashEntry,
      deleteTrashEntry: index.deleteTrashEntry,
    }

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: racingStore },
      logger,
    )

    expect(index.getTrashEntry(".trash/raced.md")?.trashPath).toBe(".trash/raced.md")
    expect(index.getTrashEntry(".trash/control-orphan.md")).toBeNull()
  })

  it.each([
    {
      label: "another file's record at the same path",
      replacement: { trashPath: ".trash/raced.md", fileIdentity: "1:1:1" },
    },
    {
      label: "a case alias's record",
      replacement: { trashPath: ".trash/RACED.md", fileIdentity: ABSENT_FILE_IDENTITY },
    },
  ])("skips a row replaced within the same second by $label", async ({ replacement }) => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    // Both records share one moment, so their trashedAt values are equal.
    const recordedMoment = DateTime.now().minus({ days: 1 })
    recordEntryAt(index, recordedAbsentFile(".trash/raced.md"), recordedMoment)
    // A control orphan, dropped whenever the purge runs, proves it ran.
    index.recordTrashEntry(recordedAbsentFile(".trash/control-orphan.md"))
    const racingStore: TrashEntryStore = {
      listAllTrashEntries: () => {
        const listed = index.listAllTrashEntries()
        // A concurrent trash move replaces the row between the snapshot and
        // the per-row lock.
        recordEntryAt(index, replacement, recordedMoment)
        return listed
      },
      listExpiredTrashEntries: index.listExpiredTrashEntries,
      getTrashEntry: index.getTrashEntry,
      deleteTrashEntry: index.deleteTrashEntry,
    }

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: racingStore },
      logger,
    )

    // No file is on disk at either spelling, so only the re-read's comparison
    // can keep the replacement's row.
    expect(index.getTrashEntry(".trash/raced.md")).toEqual({
      ...replacement,
      trashedAt: recordedMoment.toUnixInteger(),
    })
    expect(index.getTrashEntry(".trash/control-orphan.md")).toBeNull()
  })

  it("skips a row deleted between listing and lock acquisition", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(recordedAbsentFile(".trash/deleted-mid-flight.md"))
    // A control orphan, dropped whenever the purge runs, proves it ran.
    index.recordTrashEntry(recordedAbsentFile(".trash/control-orphan.md"))
    const racingStore: TrashEntryStore = {
      listAllTrashEntries: () => {
        const listed = index.listAllTrashEntries()
        // A concurrent sweep (or manual cleanup) deletes the row between
        // the snapshot and the per-row lock.
        index.deleteTrashEntry(".trash/deleted-mid-flight.md")
        return listed
      },
      listExpiredTrashEntries: index.listExpiredTrashEntries,
      getTrashEntry: index.getTrashEntry,
      deleteTrashEntry: index.deleteTrashEntry,
    }
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: racingStore },
      logger,
    )

    // The deleted-mid-flight row was skipped; the control orphan was purged.
    expect(infoSpy).toHaveBeenCalledWith("orphaned trash entries purged", {
      checked: 2,
      purged: 1,
    })
    expect(index.getTrashEntry(".trash/control-orphan.md")).toBeNull()
  })

  it("drops a row when the parent folder is gone", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(recordedAbsentFile(".trash/vanished-folder/x.md"))

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/vanished-folder/x.md")).toBeNull()
  })

  it("logs checked and purged counts when orphans are found", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(recordedAbsentFile(".trash/a.md"))
    index.recordTrashEntry(recordedAbsentFile(".trash/b.md"))
    index.recordTrashEntry(recordedAbsentFile(".trash/c.md"))
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    expect(infoSpy).toHaveBeenCalledWith("orphaned trash entries purged", {
      checked: 3,
      purged: 3,
    })
  })

  it("keeps the row and warns when stat fails with a non-ENOENT error", async () => {
    const vault = await createTestVault()
    const lockedDir = join(vault, ".trash", "locked")
    await mkdir(lockedDir, { recursive: true })
    await writeFile(join(lockedDir, "stuck.md"), "perm error", "utf8")
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/locked/stuck.md"))
    // Remove traverse permission from the parent so stat fails with EACCES.
    await chmod(lockedDir, 0o000)
    onTestFinished(() => chmod(lockedDir, 0o755))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/locked/stuck.md")?.trashPath).toBe(".trash/locked/stuck.md")
    expect(warnSpy).toHaveBeenCalledWith("failed to stat trash entry", {
      trashPath: ".trash/locked/stuck.md",
      error: `[Error]: EACCES: permission denied, lstat '${join(lockedDir, "stuck.md")}'`,
    })
  })

  it("retains a traversal-path row when the target exists outside .trash/", async () => {
    const base = await mkdtemp(join(tmpdir(), "trash-traversal-"))
    onTestFinished(() => rm(base, { recursive: true, force: true }))
    const vault = join(base, "vault")
    await mkdir(join(vault, ".trash"), { recursive: true })
    await mkdir(join(vault, "Live"), { recursive: true })
    await writeFile(join(vault, "Live", "note.md"), "live note", "utf8")
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/../Live/note.md"))
    // A control orphan, dropped whenever the purge runs, proves it ran.
    index.recordTrashEntry(recordedAbsentFile(".trash/control-orphan.md"))

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/../Live/note.md")?.trashPath).toBe(".trash/../Live/note.md")
    const liveContent = await readFile(join(vault, "Live", "note.md"), "utf8")
    expect(liveContent).toBe("live note")
    expect(index.getTrashEntry(".trash/control-orphan.md")).toBeNull()
  })

  it("retains a dangling symlink's row — lstat sees the link itself", async () => {
    const vault = await createTestVault()
    await symlink(join(vault, "nonexistent-target"), join(vault, ".trash", "dangling.md"))
    const index = createSearchIndex(":memory:")
    index.recordTrashEntry(await recordedTrashFileAt(vault, ".trash/dangling.md"))
    // A control orphan, dropped whenever the purge runs, proves it ran.
    index.recordTrashEntry(recordedAbsentFile(".trash/control-orphan.md"))

    await trashSweeper.purgeOrphanedTrashEntries(
      { vaultPath: vault, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/dangling.md")?.trashPath).toBe(".trash/dangling.md")
    expect(index.getTrashEntry(".trash/control-orphan.md")).toBeNull()
  })
})
