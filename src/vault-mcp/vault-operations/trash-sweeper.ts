/** Trash bookkeeping — retention sweep (unlink expired files) and orphan
 *  purge (drop rows whose files are gone). Both operate on trash_entries
 *  rows, never walk the .trash/ folder, so Obsidian's own trash entries
 *  and hand-placed files are out of reach. */

import { unlink } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { DateTime } from "luxon"
import { describeError } from "../../utils/describe-error.js"
import { realpathOrNull, statOrNull } from "../../utils/fs.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { withFileLock } from "../../utils/file-write-lock.js"
import { pruneEmptyParents, trashDomainLockKey } from "./vault-filesystem.js"
import type { TrashEntryStore } from "../search/search-index.js"
import type { Logger } from "../../logger.js"

/** Sweep cadence. Bounds how stale the retention window can get between
 *  runs — the window itself is TRASH_RETENTION_DAYS. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

type SweepParams = {
  vaultPath: string
  retentionDays: number
  trashEntryStore: TrashEntryStore
}

type SweepRowOutcome = "purged" | "missing" | "skipped"

/** Processes one expired row: re-validate, contain, unlink, drop the row,
 *  prune the folders the unlink emptied. Runs under the shared trash-domain
 *  lock (the caller holds it), so no trash move can land a fresh file at
 *  this row's path mid-decision. */
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

  // Re-read the row under the lock: the expired list is a snapshot from
  // before any lock was taken, and a delete can refresh a listed row (the
  // same path re-trashed) before this row's turn — its file is then fresh,
  // and unlinking it would destroy the copy retention exists to keep.
  const currentEntry = trashEntryStore.getTrashEntry(trashPath)
  if (!currentEntry || currentEntry.trashedAt >= params.cutoffEpochSeconds) {
    return "skipped"
  }

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
  // symlink, not its target). A missing parent means the file is gone (the
  // user emptied the trash) — drop the row.
  try {
    const realTrashRootOrNull = await realpathOrNull(trashRoot)
    const realParentOrNull = await realpathOrNull(dirname(resolvedPath))
    if (realTrashRootOrNull === null || realParentOrNull === null) {
      trashEntryStore.deleteTrashEntry(trashPath)
      return "missing"
    }
    const parentInsideTrashRoot =
      realParentOrNull === realTrashRootOrNull ||
      realParentOrNull.startsWith(realTrashRootOrNull + sep)

    if (!parentInsideTrashRoot) {
      logger.warn("trash entry parent escapes .trash — skipped", {
        trashPath,
      })
      return "skipped"
    }
  } catch (error) {
    // Non-ENOENT realpath failure (EACCES, EIO) — keep the row so the
    // next sweep retries; one bad row never aborts the sweep.
    logger.warn("failed to resolve trash entry path", {
      trashPath,
      error: describeError(error),
    })
    return "skipped"
  }

  // ENOENT here means the file vanished after the guards ran — the host
  // owns the bind mount and can empty the trash at any moment. Same
  // outcome as a missing parent: drop the row.
  try {
    await unlink(resolvedPath)
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      trashEntryStore.deleteTrashEntry(trashPath)
      return "missing"
    }
    // Any other failure (permissions, I/O) keeps the row so the next run
    // retries; one bad row never aborts the sweep.
    logger.warn("failed to remove expired trash entry", {
      trashPath,
      error: describeError(error),
    })
    return "skipped"
  }

  trashEntryStore.deleteTrashEntry(trashPath)
  // The trash move mkdir'd the file's folder chain, so a purge can strand
  // empty folder skeletons; pruning them (rooted at .trash/, which is never
  // removed) keeps the folder's growth bounded along with its files.
  // pruneEmptyParents walks up from `path` and stops at `vaultPath` — here
  // the pruning root is .trash/, not the vault itself.
  await pruneEmptyParents(
    { vaultPath: trashRoot, path: relative(trashRoot, resolvedPath) },
    logger,
  )
  return "purged"
}

/** Removes every recorded trash entry older than `retentionDays` and drops
 *  rows whose files are already gone. Each row is processed under the shared
 *  trash-domain lock (per row, so a long sweep never starves deletes), with
 *  an in-lock re-read deciding whether the row is still expired. */
const sweepExpiredTrashEntries = async (
  params: SweepParams,
  logger: Logger,
): Promise<void> => {
  const cutoffEpochSeconds = DateTime.now()
    .minus({ days: params.retentionDays })
    .toUnixInteger()
  const expiredEntries =
    params.trashEntryStore.listExpiredTrashEntries(cutoffEpochSeconds)

  const rowOutcomes: SweepRowOutcome[] = []
  for (const expiredEntry of expiredEntries) {
    // withFileLock is the serializing mode — each row queues behind any
    // in-flight trash move on the shared key, and vice versa.
    const rowOutcome = await withFileLock(
      trashDomainLockKey(params.vaultPath),
      () => {
        return sweepOneEntry(
          {
            vaultPath: params.vaultPath,
            trashPath: expiredEntry.trashPath,
            cutoffEpochSeconds,
            trashEntryStore: params.trashEntryStore,
          },
          logger,
        )
      },
    )
    rowOutcomes.push(rowOutcome)
  }

  const countOutcome = (outcome: SweepRowOutcome): number => {
    return rowOutcomes.filter((rowOutcome) => rowOutcome === outcome).length
  }
  logger.info("trash retention sweep complete", {
    retentionDays: params.retentionDays,
    expired: expiredEntries.length,
    purged: countOutcome("purged"),
    droppedMissing: countOutcome("missing"),
  })
}

/** Runs one sweep now and re-arms a daily timer after each run settles — a
 *  timeout chain, not setInterval, so a slow sweep can never overlap the
 *  next one. The timer is unref'd and never holds the process open; a
 *  failed run is logged and the chain continues. */
const startTrashSweepSchedule = (params: SweepParams, logger: Logger): void => {
  const runAndReschedule = (): void => {
    // .finally() re-arms the chain whether the sweep resolved or failed,
    // without making the caller await it.
    void sweepExpiredTrashEntries(params, logger)
      .catch((error: unknown) => {
        logger.error("trash retention sweep failed", {
          error: describeError(error),
        })
      })
      .finally(() => {
        setTimeout(runAndReschedule, SWEEP_INTERVAL_MS).unref()
      })
  }
  runAndReschedule()
}

/** Drops trash_entries rows whose .trash/ file no longer exists — runs once
 *  at boot regardless of TRASH_RETENTION_DAYS, so rows left behind by manual
 *  .trash/ emptying or retention=none don't accumulate. Never unlinks files. */
const purgeOrphanedTrashEntries = async (
  params: { vaultPath: string; trashEntryStore: TrashEntryStore },
  logger: Logger,
): Promise<void> => {
  const allEntries = params.trashEntryStore.listAllTrashEntries()
  if (allEntries.length === 0) return

  // Sequential async loop — each iteration awaits the lock.
  let purgedCount = 0
  for (const entry of allEntries) {
    const wasPurged = await withFileLock(
      trashDomainLockKey(params.vaultPath),
      async () => {
        // Re-read under the lock: a concurrent trash move can replace the
        // row (INSERT OR REPLACE refreshes trashedAt), meaning a new file
        // now lives at this path — dropping the row would orphan it.
        const currentEntry = params.trashEntryStore.getTrashEntry(
          entry.trashPath,
        )
        if (!currentEntry || currentEntry.trashedAt !== entry.trashedAt) {
          return false
        }

        // Non-ENOENT stat failures (EACCES, EIO) keep the row so the next
        // boot retries — one bad row never aborts the purge.
        try {
          const fileStat = await statOrNull(
            resolve(params.vaultPath, entry.trashPath),
          )
          if (fileStat) return false
        } catch (error) {
          logger.warn("failed to stat trash entry", {
            trashPath: entry.trashPath,
            error: describeError(error),
          })
          return false
        }

        params.trashEntryStore.deleteTrashEntry(entry.trashPath)
        return true
      },
    )
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
