/** File watcher — keeps the SQLite FTS5 index and vector embeddings current via chokidar. */

import { watch } from "chokidar"
import { DateTime } from "luxon"
import { readFile, stat } from "node:fs/promises"
import { join, relative, resolve as resolvePath } from "node:path"
import type { SearchIndex } from "./search-index.js"
import { logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { readdirOrNull } from "../../utils/fs.js"

/** ms between filesystem polls when usePolling is on. chokidar's raw default is
 *  100ms, which stat()s the whole tree 10×/sec; 300ms meaningfully cuts CPU, and
 *  re-index latency is already governed by the 2000ms awaitWriteFinish window, so
 *  the perceived cost is negligible. */
const POLLING_INTERVAL_MS = 300

/** Default for FileWatcherOptions.stabilityThreshold (see its doc). */
const DEFAULT_STABILITY_THRESHOLD_MS = 2000

type FileWatcherOptions = Readonly<{
  /** ms a file's size must stay unchanged before we index it (default 2000).
   *  Prevents reading partial writes from Obsidian Sync. */
  stabilityThreshold?: number
  /** ms between file-size checks during the stability window (default 100). */
  pollInterval?: number
  /** Poll the filesystem instead of using native fs events (inotify). Needed
   *  when the vault is bind-mounted across the Docker Desktop ↔ WSL2 bridge,
   *  where inotify events don't propagate. CPU-heavier; default off. */
  usePolling?: boolean
  /** ms to wait after a new directory appears before reconciling its contents
   *  against chokidar's tracking (default 2 × stabilityThreshold). The margin
   *  past the awaitWriteFinish window lets in-flight writes settle before the
   *  rescan reads them. */
  newDirectoryRescanDelay?: number
}>

export const startFileWatcher = (
  vaultPath: string,
  search: SearchIndex,
  options?: FileWatcherOptions,
): Promise<void> => {
  // Serializes embedding per note path so overlapping chokidar events for the
  // same file can't interleave and overwrite vectors with stale content.
  const pendingEmbeds = new Map<string, Promise<void>>()

  const handleChange = async (filePath: string): Promise<void> => {
    const relativePath = relative(vaultPath, filePath)

    if (!filePath.endsWith(".md")) {
      search.upsertNonMdFile(relativePath)
      logger.debug("indexed non-md file", { path: relativePath })
      return
    }

    try {
      const [content, fileStat] = await Promise.all([
        readFile(filePath, "utf8"),
        stat(filePath),
      ])
      search.upsertNote(
        {
          filePath: relativePath,
          rawContent: content,
          fileStat: { mtimeMs: fileStat.mtimeMs, size: fileStat.size },
        },
        logger,
      )
      // Promise chain serializes embedding per path — if two events arrive for
      // the same note, the second waits for the first to finish. .catch()
      // swallows the previous rejection so a transient failure can't cascade
      // and block subsequent embeds for this path. .finally() clears the map
      // entry on success OR failure so a rejected promise can't permanently
      // block that note from re-embedding.
      const previousEmbed = pendingEmbeds.get(relativePath) ?? Promise.resolve()
      const currentEmbed = previousEmbed
        .catch((previousError) => {
          logger.debug("previous embed failed, proceeding with current", {
            path: relativePath,
            error: describeError(previousError),
          })
        })
        .then(() =>
          search.embedNote(
            { notePath: relativePath, rawContent: content },
            logger,
          ),
        )
      pendingEmbeds.set(relativePath, currentEmbed)
      currentEmbed.finally(() => {
        if (pendingEmbeds.get(relativePath) === currentEmbed) {
          pendingEmbeds.delete(relativePath)
        }
      })
      await currentEmbed
    } catch (err) {
      logger.error("failed to process file change", {
        path: relativePath,
        error: describeError(err),
      })
    }
  }

  const handleDelete = (filePath: string): void => {
    const relativePath = relative(vaultPath, filePath)

    if (!filePath.endsWith(".md")) {
      search.removeNonMdFile(relativePath)
      logger.debug("removed non-md file from index", { path: relativePath })
      return
    }

    search.removeNote(relativePath)
    logger.debug("removed from index", { path: relativePath })
  }

  const stabilityThreshold =
    options?.stabilityThreshold ?? DEFAULT_STABILITY_THRESHOLD_MS
  const newDirectoryRescanDelay =
    options?.newDirectoryRescanDelay ?? 2 * stabilityThreshold

  const watcher = watch(vaultPath, {
    // Skip dotfiles/directories (.obsidian/, .trash/) but allow the vault root itself
    ignored: (path: string) => {
      const relativePath = relative(vaultPath, path)
      if (!relativePath) return false
      return relativePath.split("/").some((segment) => segment.startsWith("."))
    },
    persistent: true,
    ignoreInitial: true,
    // Poll across the Docker Desktop ↔ WSL2 bridge, where inotify is dropped.
    usePolling: options?.usePolling ?? false,
    // interval only drives chokidar's polling backend. Pass it only when
    // polling, so we never depend on how chokidar treats an interval set
    // without usePolling (today it's ignored — a future release needn't be).
    ...(options?.usePolling ? { interval: POLLING_INTERVAL_MS } : {}),
    // Obsidian Sync writes files in chunks — wait for write stability before
    // indexing to avoid reading partial content
    awaitWriteFinish: {
      stabilityThreshold,
      pollInterval: options?.pollInterval ?? 100,
    },
  })

  // chokidar processes a newly-appeared directory by scanning it FIRST and
  // registering its fs.watch only after the scan completes (_handleDir in
  // chokidar's handler). A file that lands between the scan read and the watch
  // registration is silently lost: the scan didn't see it and no watcher
  // existed to observe the event. Our atomic writes (temp file + rename into a
  // freshly created folder) hit that window under load, leaving the note
  // invisible to search until an unrelated later event touches it. This rescan
  // is the safety net: once the dust settles, reconcile the directory's actual
  // contents against what chokidar tracks and index anything it missed.
  const rescanNewDirectory = async (dirPath: string): Promise<void> => {
    const entries = await readdirOrNull(dirPath)
    if (entries === null) {
      logger.debug("rescan skipped, directory vanished", { path: dirPath })
      return
    }

    // Map of watched directory (absolute) → tracked child basenames. Anything
    // on disk but absent here is an entry chokidar's new-directory scan missed.
    const watchedChildren = watcher.getWatched()

    for (const entry of entries) {
      const fullPath = join(entry.parentPath, entry.name)
      const relativePath = relative(vaultPath, fullPath)
      const isHidden = relativePath
        .split("/")
        .some((segment) => segment.startsWith("."))
      if (isHidden) continue

      // getWatched() keys are resolved paths (chokidar resolves internally).
      const trackedSiblings = watchedChildren[resolvePath(entry.parentPath)]
      if (trackedSiblings?.includes(entry.name)) continue

      if (entry.isDirectory()) {
        // A subdirectory chokidar never saw would stay unwatched forever —
        // watcher.add() registers its watches. Its contents are already covered
        // by this recursive listing, so the add's suppressed events don't matter.
        watcher.add(fullPath)
        logger.debug("rescan registered missed directory", {
          path: relativePath,
        })
        continue
      }

      try {
        // stat follows symlinks, so a symlinked note is indexed like the add
        // path would; a broken symlink or vanished file throws and is skipped.
        const fileStat = await stat(fullPath)
        if (fileStat.isDirectory()) {
          // Symlink to a directory — register it like a missed directory.
          watcher.add(fullPath)
          continue
        }
        // A freshly-modified file is plausibly still being written. Skip it:
        // the directory's watch is registered by now, so its next write event
        // flows through the normal awaitWriteFinish path.
        const isStillBeingWritten =
          DateTime.now().toMillis() - fileStat.mtimeMs < stabilityThreshold
        if (isStillBeingWritten) continue

        logger.debug("rescan indexing missed file", { path: relativePath })
        await handleChange(fullPath)
      } catch (err) {
        logger.debug("rescan skipped unreadable entry", {
          path: relativePath,
          error: describeError(err),
        })
      }
    }
  }

  const scheduleNewDirectoryRescan = (dirPath: string): void => {
    const rescanTimer = setTimeout(() => {
      rescanNewDirectory(dirPath).catch((err) => {
        logger.error("failed to rescan new directory", {
          path: relative(vaultPath, dirPath),
          error: describeError(err),
        })
      })
    }, newDirectoryRescanDelay)
    // Never hold the process open for a pending rescan.
    rescanTimer.unref()
  }

  watcher
    .on("add", handleChange)
    .on("change", handleChange)
    .on("unlink", handleDelete)
    .on("addDir", scheduleNewDirectoryRescan)
    .on("error", (err) => {
      logger.error("watcher error", {
        error: describeError(err),
      })
    })

  return new Promise((resolve) => {
    watcher.on("ready", () => {
      logger.info("file watcher started", { vaultPath })
      resolve()
    })
  })
}
