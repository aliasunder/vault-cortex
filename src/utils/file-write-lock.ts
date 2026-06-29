/** Per-file write locks — two modes sharing one lock map so all vault write
 *  paths are aware of each other regardless of which mode they use.
 *
 *  - `withFileLock` — **serializing.** Queues behind the previous write so
 *    each operation runs against the latest state. Used by memory-store,
 *    whose append/delete operations read inside the lock.
 *  - `withExclusiveFileLock` — **fail-fast.** Rejects immediately when a
 *    write is already in progress, so the caller knows to re-read and retry
 *    rather than executing a write planned against stale state. Used by
 *    vault-patcher and vault-filesystem, where the caller's intent (e.g.
 *    old_text for replace) was formed from an earlier read.
 *
 *  The lock map is a module-level singleton — all importers in the same
 *  process share it, so a vault_update_memory and a vault_replace_in_note
 *  targeting the same file correctly block/reject each other. */

import { resolve } from "node:path"

// One promise per file path — that file's most recent write. Entries are
// removed once a file's writes settle and no later write is queued (see
// forgetIfStillTail), so the map only holds files with a write in flight.
const fileWriteLocks = new Map<string, Promise<unknown>>()

/** Cleanup helper — removes the map entry once the write settles, but only
 *  if no later write has queued behind it (i.e. we're still the tail). */
const cleanupAfterWrite = (key: string, thisWrite: Promise<unknown>): void => {
  const forgetIfStillTail = (): void => {
    if (fileWriteLocks.get(key) === thisWrite) {
      fileWriteLocks.delete(key)
    }
  }
  void thisWrite.then(forgetIfStillTail, forgetIfStillTail)
}

/** Serializing lock — queues `operation` behind the previous write to the
 *  same file so concurrent operations run one-at-a-time. Passing `operation`
 *  as both `.then` handlers runs it whether the previous write resolved or
 *  threw, so one failed write can't make later ones skip their turn.
 *
 *  Uses `.then()` rather than `async/await` because the function must queue
 *  the operation behind the previous promise without itself awaiting the
 *  chain — awaiting would make the caller wait for the entire chain, not
 *  just its own operation. */
export const withFileLock = <T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const key = resolve(filePath)
  const previousWrite = fileWriteLocks.get(key) ?? Promise.resolve()
  const thisWrite = previousWrite.then(operation, operation)
  fileWriteLocks.set(key, thisWrite)
  cleanupAfterWrite(key, thisWrite)
  return thisWrite
}

/** Fail-fast lock — rejects immediately when a write is already in progress
 *  on the same file rather than queuing behind it. This prevents a write
 *  planned against stale state from silently executing after the in-flight
 *  write changes the file. The caller should re-read the note and retry. */
export const withExclusiveFileLock = <T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const key = resolve(filePath)
  if (fileWriteLocks.has(key)) {
    throw new Error(
      `concurrent write in progress for "${filePath}" — re-read the note and retry`,
    )
  }
  const thisWrite = operation()
  fileWriteLocks.set(key, thisWrite)
  cleanupAfterWrite(key, thisWrite)
  return thisWrite
}
