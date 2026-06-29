/** Per-file async write serializer. Chains operations behind the same file
 *  path so concurrent read-modify-write cycles run one-at-a-time per file.
 *  Writes to different files never block each other. The lock map is a
 *  module-level singleton — all importers in the same process share it,
 *  so a vault_update_memory and a vault_replace_in_note targeting the same
 *  file also serialize correctly. */

// One promise per file path — that file's most recent write. Entries are
// removed once a file's writes settle and no later write is queued (see
// forgetIfStillTail), so the map only holds files with a write in flight.
const fileWriteLocks = new Map<string, Promise<unknown>>()

/** Runs `operation` only after the previous write to the same `filePath`
 *  has settled, keeping writes to one file strictly one-at-a-time. Passing
 *  `operation` as both `.then` handlers runs it whether the previous write
 *  resolved or threw, so one failed write can't make later ones skip their
 *  turn. The operation's own result and errors propagate to its caller.
 *
 *  Uses `.then()` rather than `async/await` because the function must queue
 *  the operation behind the previous promise without itself awaiting the
 *  chain — awaiting would make the caller wait for the entire chain, not
 *  just its own operation. */
export const withFileLock = <T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previousWrite = fileWriteLocks.get(filePath) ?? Promise.resolve()
  const thisWrite = previousWrite.then(operation, operation)
  fileWriteLocks.set(filePath, thisWrite)

  // Once this write settles, forget it — but only if no later write has
  // queued behind it (i.e. we're still the tail of the chain).
  const forgetIfStillTail = (): void => {
    if (fileWriteLocks.get(filePath) === thisWrite) {
      fileWriteLocks.delete(filePath)
    }
  }
  void thisWrite.then(forgetIfStillTail, forgetIfStillTail)

  return thisWrite
}
