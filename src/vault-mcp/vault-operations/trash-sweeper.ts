/** Trash bookkeeping — retention sweep (unlink expired files) and orphan
 *  purge (drop rows whose files are gone). Both operate on trash_entries
 *  rows and never walk the .trash/ folder. The sweep unlinks a file only
 *  while it still has the identity its row recorded (inode number, size,
 *  modification time, and inode change time), so Obsidian's own trash entries
 *  and hand-placed files are out of reach, even under a name the server once
 *  used. */

import { unlink } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { DateTime } from "luxon"
import { describeError } from "../../utils/describe-error.js"
import { isMissingPathError, lstatOrNull, realpathOrNull } from "../../utils/fs.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { withFileLock } from "../../utils/file-write-lock.js"
import { pruneEmptyParents, readTrashFileIdentity, trashDomainLockKey } from "./vault-filesystem.js"
import type { TrashEntryStore } from "../search/search-index.js"
import type { Logger } from "../../logger.js"

/** Sweep cadence. An expired file can outlive TRASH_RETENTION_DAYS by up to
 *  one interval before the next sweep deletes it. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

type SweepParams = {
  vaultPath: string
  retentionDays: number
  trashEntryStore: TrashEntryStore
}

type SweepRowOutcome = "unlinked" | "missing" | "unmatched" | "skipped"

type IdentityCheck = "matches" | "differs" | "missing" | "unreadable"

/** Compares the file now at a trash entry's path with the identity recorded
 *  when the server trashed it. A row without a recorded identity never
 *  matches. A read failure other than a missing file is logged and reported
 *  as "unreadable". */
const checkRecordedFileIdentity = async (
  params: { fullPath: string; trashPath: string; recordedIdentity: string | null },
  logger: Logger,
): Promise<IdentityCheck> => {
  try {
    const currentIdentity = await readTrashFileIdentity(params.fullPath)
    // A null recordedIdentity never equals a read identity, so it "differs".
    return currentIdentity === params.recordedIdentity ? "matches" : "differs"
  } catch (error) {
    if (isMissingPathError(error)) return "missing"
    logger.warn("failed to read trash entry identity", {
      trashPath: params.trashPath,
      error: describeError(error),
    })
    return "unreadable"
  }
}

/** Re-validates one expired row, checks that it stays inside .trash/ and
 *  still holds the recorded file, then unlinks the file, drops the row, and
 *  prunes the folders the unlink emptied. Runs under the shared trash-domain
 *  lock (the caller holds it), so no trash move can land a fresh file at this
 *  row's path mid-decision. */
const sweepOneEntry = async (
  params: {
    vaultPath: string
    /** The row's recorded path — vault-relative, expected to start with
     *  ".trash/". The containment gates below verify that rather than
     *  trust it. */
    trashPath: string
    cutoffEpochSeconds: number
    trashEntryStore: TrashEntryStore
  },
  logger: Logger,
): Promise<SweepRowOutcome> => {
  const { vaultPath, trashPath, trashEntryStore } = params

  // Re-read the row under the lock, because the expired list is a snapshot
  // from before any lock was taken, and a delete can refresh a listed row (the
  // same path re-trashed) before this row's turn — its file is then fresh,
  // and unlinking it would destroy the copy retention exists to keep.
  const currentEntry = trashEntryStore.getTrashEntry(trashPath)

  if (!currentEntry) return "skipped"

  // The lookup folds case, so currentEntry can be a case alias that replaced
  // the listed row during this sweep. Such a row was recorded after the sweep
  // began, so it is not expired and returns here; past this check,
  // currentEntry is the listed row and trashPath is its spelling.
  const rowStillExpired = currentEntry.trashedAt < params.cutoffEpochSeconds

  if (!rowStillExpired) return "skipped"

  // Containment gate 1, lexical — the row must resolve inside .trash/. A
  // prefix check on the raw row text is not enough, because
  // ".trash/../Notes/x.md" starts with ".trash/" yet resolves into the live
  // vault. Rows only fail this when the DB was corrupted or hand-edited;
  // the file is left alone and the row kept as evidence.
  const trashRoot = join(resolve(vaultPath), ".trash")
  const resolvedPath = resolve(vaultPath, trashPath)

  // + sep prevents ".trash-backup/" from matching ".trash" as a prefix
  if (!resolvedPath.startsWith(trashRoot + sep)) {
    logger.warn("trash entry resolves outside .trash — skipped", {
      trashPath,
    })
    return "skipped"
  }

  // Containment gate 2, physical — realpath the file's parent directory and
  // require it inside the real .trash root, because a directory symlink
  // planted inside .trash/ would redirect a lexically-clean path onto live
  // notes. The final component itself is never followed (unlink removes a
  // symlink, not its target). A missing parent (nothing there, or a file
  // where a folder should be) means .trash/ was emptied outside the server,
  // so the row is dropped.
  try {
    const realTrashRoot = await realpathOrNull(trashRoot)
    const realParent = await realpathOrNull(dirname(resolvedPath))

    if (!realTrashRoot || !realParent) {
      trashEntryStore.deleteTrashEntry(trashPath)
      return "missing"
    }

    // Equal when the file sits directly in .trash/, not in a subfolder.
    const parentInsideTrashRoot =
      realParent === realTrashRoot || realParent.startsWith(realTrashRoot + sep)

    if (!parentInsideTrashRoot) {
      logger.warn("trash entry parent escapes .trash — skipped", {
        trashPath,
      })
      return "skipped"
    }
  } catch (error) {
    // A realpath failure other than a missing path (EACCES, EIO), or a failed
    // row delete in the missing-parent branch, keeps the row so the next
    // sweep retries; one bad row never aborts the sweep.
    logger.warn("failed to resolve trash entry path", {
      trashPath,
      error: describeError(error),
    })
    return "skipped"
  }

  // Identity gate — the file at the row's path must be the one the server
  // trashed. Emptying .trash/ by hand leaves the row behind, and Obsidian can
  // later trash another note under the same name; deleting that file would
  // destroy a note the server never trashed. A file that differs, or a row
  // recorded before identities were kept, keeps the file and drops the row,
  // since the recorded file can no longer be shown to be there.
  const identityCheck = await checkRecordedFileIdentity(
    { fullPath: resolvedPath, trashPath, recordedIdentity: currentEntry.fileIdentity },
    logger,
  )

  // Every result but "matches" returns here, so only the file the server
  // trashed reaches the unlink below.
  if (identityCheck === "unreadable") return "skipped"
  if (identityCheck === "missing") {
    trashEntryStore.deleteTrashEntry(trashPath)
    return "missing"
  }
  if (identityCheck === "differs") {
    trashEntryStore.deleteTrashEntry(trashPath)
    logger.warn(
      "trash entry cannot be matched to the file the server trashed — kept, row dropped",
      { trashPath },
    )
    return "unmatched"
  }

  // ENOENT here means the file vanished after the gates ran — the host
  // owns the bind mount and can empty the trash at any moment. Same
  // outcome as a missing parent: drop the row.
  try {
    await unlink(resolvedPath)
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      trashEntryStore.deleteTrashEntry(trashPath)
      return "missing"
    }
    // Any other failure keeps the row so the next run retries; one bad row
    // never aborts the sweep. That includes permissions, I/O, and ENOTDIR
    // from a parent folder replaced by a file since the identity read, which
    // the next sweep's identity read reports as missing.
    logger.warn("failed to remove expired trash entry", {
      trashPath,
      error: describeError(error),
    })
    return "skipped"
  }

  trashEntryStore.deleteTrashEntry(trashPath)

  // The trash move created the file's folder chain, so an unlink can strand
  // empty folders. pruneEmptyParents walks up from `path` and stops at
  // `vaultPath`, here .trash/ rather than the vault root, so .trash/ itself
  // is never removed. It logs a folder it cannot remove instead of throwing.
  await pruneEmptyParents({ vaultPath: trashRoot, path: relative(trashRoot, resolvedPath) }, logger)
  return "unlinked"
}

/** Removes every recorded trash entry older than `retentionDays` whose file
 *  still has its recorded identity, and drops the rows of entries whose files
 *  are gone or no longer match. Each row is processed under the shared
 *  trash-domain lock (per row, so a long sweep never starves deletes), with
 *  an in-lock re-read deciding whether the row is still expired. */
const sweepExpiredTrashEntries = async (params: SweepParams, logger: Logger): Promise<void> => {
  const cutoffEpochSeconds = DateTime.now().minus({ days: params.retentionDays }).toUnixInteger()
  const expiredEntries = params.trashEntryStore.listExpiredTrashEntries(cutoffEpochSeconds)

  const rowOutcomes: SweepRowOutcome[] = []
  for (const expiredEntry of expiredEntries) {
    // withFileLock queues behind the current holder instead of failing, so
    // each row waits for any in-flight trash move on the shared key, and a
    // move waits for the row.
    const rowOutcome = await withFileLock(trashDomainLockKey(params.vaultPath), () => {
      return sweepOneEntry(
        {
          vaultPath: params.vaultPath,
          trashPath: expiredEntry.trashPath,
          cutoffEpochSeconds,
          trashEntryStore: params.trashEntryStore,
        },
        logger,
      )
    })
    rowOutcomes.push(rowOutcome)
  }

  const countOutcome = (outcome: SweepRowOutcome): number => {
    return rowOutcomes.filter((rowOutcome) => rowOutcome === outcome).length
  }

  // Skipped rows are `expired` minus the three counts below. Every skip has
  // already logged a warning, except a row that changed after the listing.
  logger.info("trash retention sweep complete", {
    retentionDays: params.retentionDays,
    expired: expiredEntries.length,
    purged: countOutcome("unlinked"),
    droppedMissing: countOutcome("missing"),
    droppedUnmatched: countOutcome("unmatched"),
  })
}

/** Runs one sweep now and re-arms a daily timer after each run settles — a
 *  timeout chain, not setInterval, so a slow sweep can never overlap the
 *  next one. The timer is unref'd and never holds the process open; a
 *  failed run is logged and the chain continues. */
const startTrashSweepSchedule = (params: SweepParams, logger: Logger): void => {
  const runAndReschedule = async (): Promise<void> => {
    try {
      await sweepExpiredTrashEntries(params, logger)
    } catch (error) {
      logger.error("trash retention sweep failed", {
        error: describeError(error),
      })
    } finally {
      // Re-arms the chain whether the sweep resolved or failed.
      setTimeout(() => void runAndReschedule(), SWEEP_INTERVAL_MS).unref()
    }
  }
  // Not awaited, so startup never waits on a sweep.
  void runAndReschedule()
}

/** Drops trash_entries rows whose .trash/ file no longer exists — runs once
 *  at boot regardless of TRASH_RETENTION_DAYS, so rows left behind by manual
 *  .trash/ emptying or TRASH_RETENTION_DAYS=none don't accumulate. Never
 *  unlinks files. */
const purgeOrphanedTrashEntries = async (
  params: { vaultPath: string; trashEntryStore: TrashEntryStore },
  logger: Logger,
): Promise<void> => {
  const allEntries = params.trashEntryStore.listAllTrashEntries()

  if (allEntries.length === 0) return

  // Rows take the lock one at a time. Queuing them all at once (Promise.all)
  // would put every row ahead of a delete that arrives mid-purge; this loop
  // lets the delete in after the current row. The count is a let because a
  // counter across awaited iterations reads plainer than an async fold.
  let purgedCount = 0
  for (const entry of allEntries) {
    const wasPurged = await withFileLock(trashDomainLockKey(params.vaultPath), async () => {
      // Re-read under the lock, because a concurrent trash move can replace
      // the row (INSERT OR REPLACE refreshes trashedAt), meaning a new file
      // now lives at this path. Dropping that row would leave the new file
      // unrecorded, so the sweep would never delete it.
      const currentEntry = params.trashEntryStore.getTrashEntry(entry.trashPath)
      const rowChanged = !currentEntry || currentEntry.trashedAt !== entry.trashedAt

      if (rowChanged) return false

      // lstat (not stat) so a dangling symlink in .trash/ is still
      // recognized as present — stat would follow it, get ENOENT, and
      // drop the row, stranding an unlinkable symlink with no record.
      try {
        const entryStats = await lstatOrNull(resolve(params.vaultPath, entry.trashPath))

        if (entryStats) return false
      } catch (error) {
        logger.warn("failed to stat trash entry", {
          trashPath: entry.trashPath,
          error: describeError(error),
        })
        return false
      }

      params.trashEntryStore.deleteTrashEntry(entry.trashPath)
      return true
    })

    if (wasPurged) purgedCount++
  }

  if (purgedCount > 0) {
    logger.info("orphaned trash entries purged", {
      checked: allEntries.length,
      purged: purgedCount,
    })
  }
}

export const trashSweeper = {
  sweepExpiredTrashEntries,
  startTrashSweepSchedule,
  purgeOrphanedTrashEntries,
}
