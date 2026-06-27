/** Filters directory entries, excluding symlinks whose resolved targets are
 *  broken (dangling), escape the given root directory, or are not regular files. */

import type { Dirent } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { describeError } from "./describe-error.js"

type SymlinkLogger = {
  warn: (message: string, meta: Record<string, unknown>) => void
}

export const filterValidSymlinks = async (params: {
  entries: ReadonlyArray<Dirent>
  roots: { canonical: string; normalized: string }
  logger: SymlinkLogger
}): Promise<Dirent[]> => {
  const { entries, roots, logger } = params
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isSymbolicLink()) return entry
        const entryPath = join(entry.parentPath, entry.name)
        try {
          const targetPath = await realpath(entryPath)
          if (!targetPath.startsWith(roots.canonical + "/")) {
            logger.warn("symlink target escapes root, skipping", {
              path: relative(roots.normalized, entryPath),
            })
            return null
          }
          const targetStat = await stat(targetPath)
          if (!targetStat.isFile()) {
            logger.warn("symlink target is not a file, skipping", {
              path: relative(roots.normalized, entryPath),
            })
            return null
          }
          return entry
        } catch (error) {
          logger.warn("broken symlink, skipping", {
            path: relative(roots.normalized, entryPath),
            error: describeError(error),
          })
          return null
        }
      }),
    )
  ).filter((entry): entry is Dirent => entry !== null)
}
