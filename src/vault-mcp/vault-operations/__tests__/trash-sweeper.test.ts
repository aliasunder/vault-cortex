import { describe, it, expect, vi, onTestFinished } from "vitest"
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime } from "luxon"
import { trashSweeper } from "../trash-sweeper.js"
import { vaultFs } from "../vault-filesystem.js"
import { createSearchIndex } from "../../search/search-index.js"
import { logger } from "../../../logger.js"

/** A temp vault with a .trash/ folder, removed when the test finishes. */
const createTestVault = async (): Promise<string> => {
  const vault = await mkdtemp(join(tmpdir(), "trash-sweep-"))
  await mkdir(join(vault, ".trash"), { recursive: true })
  onTestFinished(() => rm(vault, { recursive: true, force: true }))
  return vault
}

/** Records an entry stamped `daysAgo` in the past — the sweeper reads real
 *  time, so back-dating the record is how a test makes an entry expired. */
const recordEntryDaysAgo = (
  index: ReturnType<typeof createSearchIndex>,
  trashPath: string,
  daysAgo: number,
): void => {
  vi.useFakeTimers()
  vi.setSystemTime(DateTime.now().minus({ days: daysAgo }).toMillis())
  index.recordTrashEntry(trashPath)
  vi.useRealTimers()
}

describe("sweepExpiredTrashEntries", () => {
  it("purges an expired entry's file and drops its row; a fresh entry and its file survive", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "old.md"), "expired", "utf8")
    await writeFile(join(vault, ".trash", "new.md"), "fresh", "utf8")
    recordEntryDaysAgo(index, ".trash/old.md", 31)
    index.recordTrashEntry(".trash/new.md")
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    await expect(stat(join(vault, ".trash", "old.md"))).rejects.toThrow(
      /ENOENT/,
    )
    expect(index.getTrashEntry(".trash/old.md")).toBeNull()
    const freshContent = await readFile(join(vault, ".trash", "new.md"), "utf8")
    expect(freshContent).toBe("fresh")
    expect(index.getTrashEntry(".trash/new.md")?.trashPath).toBe(
      ".trash/new.md",
    )
    expect(infoSpy).toHaveBeenCalledWith("trash retention sweep complete", {
      retentionDays: 30,
      expired: 1,
      purged: 1,
      droppedMissing: 0,
    })
  })

  it("drops the row without throwing when the expired file is already gone", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    recordEntryDaysAgo(index, ".trash/emptied.md", 31)

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/emptied.md")).toBeNull()
  })

  it("drops the row when the entry's whole parent folder is gone", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    // The recorded subfolder never exists — realpath on the parent ENOENTs.
    recordEntryDaysAgo(index, ".trash/vanished-folder/x.md", 31)

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/vanished-folder/x.md")).toBeNull()
  })

  it("skips a listed row that was refreshed before its turn — the fresh file survives", async () => {
    // The expired list is a snapshot taken before any lock; a delete can
    // re-trash the same path (refreshing the row) before the sweep reaches
    // it. The in-lock re-read must catch that, or this fresh copy is lost.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "raced.md"), "fresh copy", "utf8")
    recordEntryDaysAgo(index, ".trash/raced.md", 31)
    const racingStore = {
      listExpiredTrashEntries: (cutoffEpochSeconds: number) => {
        const listed = index.listExpiredTrashEntries(cutoffEpochSeconds)
        // The concurrent delete lands between the snapshot and the per-row
        // lock: the row is refreshed to now.
        index.recordTrashEntry(".trash/raced.md")
        return listed
      },
      getTrashEntry: index.getTrashEntry,
      deleteTrashEntry: index.deleteTrashEntry,
    }

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: racingStore },
      logger,
    )

    const racedContent = await readFile(
      join(vault, ".trash", "raced.md"),
      "utf8",
    )
    expect(racedContent).toBe("fresh copy")
    expect(index.getTrashEntry(".trash/raced.md")?.trashPath).toBe(
      ".trash/raced.md",
    )
  })

  it("refuses a row that resolves outside the vault — file untouched, row kept", async () => {
    const base = await mkdtemp(join(tmpdir(), "trash-escape-"))
    onTestFinished(() => rm(base, { recursive: true, force: true }))
    const vault = join(base, "vault")
    await mkdir(join(vault, ".trash"), { recursive: true })
    await writeFile(join(base, "escape.md"), "outside the vault", "utf8")
    const index = createSearchIndex(":memory:")
    recordEntryDaysAgo(index, ".trash/../../escape.md", 31)
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    const escapeContent = await readFile(join(base, "escape.md"), "utf8")
    expect(escapeContent).toBe("outside the vault")
    expect(index.getTrashEntry(".trash/../../escape.md")?.trashPath).toBe(
      ".trash/../../escape.md",
    )
    expect(warnSpy).toHaveBeenCalledWith(
      "trash entry resolves outside .trash — skipped",
      { trashPath: ".trash/../../escape.md" },
    )
  })

  it("refuses a row that traverses back into the live vault — the live note survives", async () => {
    // ".trash/../Live/x.md" starts with ".trash/" yet resolves onto a live
    // note — the gate must compare resolved paths, not raw row text.
    const vault = await createTestVault()
    await mkdir(join(vault, "Live"), { recursive: true })
    await writeFile(join(vault, "Live", "x.md"), "live note", "utf8")
    const index = createSearchIndex(":memory:")
    recordEntryDaysAgo(index, ".trash/../Live/x.md", 31)
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    const liveContent = await readFile(join(vault, "Live", "x.md"), "utf8")
    expect(liveContent).toBe("live note")
    expect(warnSpy).toHaveBeenCalledWith(
      "trash entry resolves outside .trash — skipped",
      { trashPath: ".trash/../Live/x.md" },
    )
  })

  it("refuses a row whose parent is a directory symlink out of .trash/ — the target survives", async () => {
    // A lexically-clean path can still land outside .trash/ through a
    // symlinked directory; only the realpath gate catches that.
    const vault = await createTestVault()
    await mkdir(join(vault, "RealNotes"), { recursive: true })
    await writeFile(join(vault, "RealNotes", "live.md"), "live note", "utf8")
    await symlink(join(vault, "RealNotes"), join(vault, ".trash", "linkdir"))
    const index = createSearchIndex(":memory:")
    recordEntryDaysAgo(index, ".trash/linkdir/live.md", 31)
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    const liveContent = await readFile(
      join(vault, "RealNotes", "live.md"),
      "utf8",
    )
    expect(liveContent).toBe("live note")
    expect(warnSpy).toHaveBeenCalledWith(
      "trash entry parent escapes .trash — skipped",
      { trashPath: ".trash/linkdir/live.md" },
    )
  })

  it("keeps the row and warns when unlink fails with a non-ENOENT error", async () => {
    // A permission error during unlink keeps the row so the next sweep
    // retries; one bad row never aborts the sweep.
    const vault = await createTestVault()
    const lockedDir = join(vault, ".trash", "locked")
    await mkdir(lockedDir, { recursive: true })
    await writeFile(join(lockedDir, "stuck.md"), "perm error", "utf8")
    const index = createSearchIndex(":memory:")
    recordEntryDaysAgo(index, ".trash/locked/stuck.md", 31)
    // Remove write permission from the parent so unlink fails with EACCES.
    await chmod(lockedDir, 0o555)
    onTestFinished(() => chmod(lockedDir, 0o755))
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    expect(index.getTrashEntry(".trash/locked/stuck.md")?.trashPath).toBe(
      ".trash/locked/stuck.md",
    )
    const content = await readFile(join(lockedDir, "stuck.md"), "utf8")
    expect(content).toBe("perm error")
    expect(warnSpy).toHaveBeenCalledWith(
      "failed to remove expired trash entry",
      {
        trashPath: ".trash/locked/stuck.md",
        error: expect.stringMatching(/EACCES.*stuck\.md/),
      },
    )
  })

  it("never unlinks an unrecorded delete that landed at a stale row's path", async () => {
    // A stale row can outlive its file (the user emptied .trash between
    // sweeps). A keep-forever "local" delete that then lands at that path
    // clears the row on the way in — otherwise this sweep would treat the
    // fresh copy as the row's expired occupant and unlink it.
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    recordEntryDaysAgo(index, ".trash/reused.md", 31)
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

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    const keptContent = await readFile(
      join(vault, ".trash", "reused.md"),
      "utf8",
    )
    expect(keptContent).toBe("keep forever")
    expect(index.getTrashEntry(".trash/reused.md")).toBeNull()
  })

  it("prunes the folder skeleton a purge empties, keeping .trash/ itself", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await mkdir(join(vault, ".trash", "sub", "deep"), { recursive: true })
    await writeFile(
      join(vault, ".trash", "sub", "deep", "old.md"),
      "expired",
      "utf8",
    )
    recordEntryDaysAgo(index, ".trash/sub/deep/old.md", 31)

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    await expect(
      stat(join(vault, ".trash", "sub", "deep", "old.md")),
    ).rejects.toThrow(/ENOENT/)
    await expect(stat(join(vault, ".trash", "sub"))).rejects.toThrow(/ENOENT/)
    const trashRootStat = await stat(join(vault, ".trash"))
    expect(trashRootStat.isDirectory()).toBe(true)
  })

  it("keeps a purged file's folder when it still holds other files", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await mkdir(join(vault, ".trash", "shared"), { recursive: true })
    await writeFile(
      join(vault, ".trash", "shared", "old.md"),
      "expired",
      "utf8",
    )
    await writeFile(join(vault, ".trash", "shared", "kept.md"), "stays", "utf8")
    recordEntryDaysAgo(index, ".trash/shared/old.md", 31)

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    await expect(
      stat(join(vault, ".trash", "shared", "old.md")),
    ).rejects.toThrow(/ENOENT/)
    const keptContent = await readFile(
      join(vault, ".trash", "shared", "kept.md"),
      "utf8",
    )
    expect(keptContent).toBe("stays")
  })

  it("never touches a trash file it has no row for, however old", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    // Obsidian's own trashed file: present on disk, no row. Seeded beside a
    // recorded expired file so a passing test proves the sweep actually ran.
    await writeFile(
      join(vault, ".trash", "obsidian-own.md"),
      "obsidian trashed this",
      "utf8",
    )
    await writeFile(join(vault, ".trash", "recorded.md"), "ours", "utf8")
    recordEntryDaysAgo(index, ".trash/recorded.md", 31)

    await trashSweeper.sweepExpiredTrashEntries(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    await expect(stat(join(vault, ".trash", "recorded.md"))).rejects.toThrow(
      /ENOENT/,
    )
    const obsidianOwnContent = await readFile(
      join(vault, ".trash", "obsidian-own.md"),
      "utf8",
    )
    expect(obsidianOwnContent).toBe("obsidian trashed this")
  })
})

describe("startTrashSweepSchedule", () => {
  it("runs a sweep immediately", async () => {
    const vault = await createTestVault()
    const index = createSearchIndex(":memory:")
    await writeFile(join(vault, ".trash", "startup.md"), "expired", "utf8")
    recordEntryDaysAgo(index, ".trash/startup.md", 31)

    trashSweeper.startTrashSweepSchedule(
      { vaultPath: vault, retentionDays: 30, trashEntryStore: index },
      logger,
    )

    await vi.waitFor(() => {
      expect(index.getTrashEntry(".trash/startup.md")).toBeNull()
    })
    await expect(stat(join(vault, ".trash", "startup.md"))).rejects.toThrow(
      /ENOENT/,
    )
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
    const throwingStore = {
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
