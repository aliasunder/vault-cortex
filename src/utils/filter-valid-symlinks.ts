import type { Dirent } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { Logger } from "../logger.js"
import { describeError } from "./describe-error.js"
import { mapWithConcurrency } from "./map-with-concurrency.js"

const SYMLINK_VALIDATION_CONCURRENCY = 16

/** Filters directory entries, excluding symlinks whose resolved targets are
 *  broken (dangling) or are not regular files. */
export const filterValidSymlinks = async (params: {
  entries: ReadonlyArray<Dirent>
  normalizedRoot: string
  logger: Logger
}): Promise<Dirent[]> => {
  const { entries, normalizedRoot, logger } = params
  return (
    await mapWithConcurrency({
      items: [...entries],
      concurrency: SYMLINK_VALIDATION_CONCURRENCY,
      mapper: async (entry) => {
        if (!entry.isSymbolicLink()) return entry
        const entryPath = join(entry.parentPath, entry.name)
        try {
          const targetPath = await realpath(entryPath)
          const targetStat = await stat(targetPath)
          if (!targetStat.isFile()) {
            logger.warn("symlink target is not a file, skipping", {
              path: relative(normalizedRoot, entryPath),
            })
            return null
          }
          return entry
        } catch (error) {
          logger.warn("broken symlink, skipping", {
            path: relative(normalizedRoot, entryPath),
            error: describeError(error),
          })
          return null
        }
      },
    })
  ).filter((entry): entry is Dirent => entry !== null)
}
