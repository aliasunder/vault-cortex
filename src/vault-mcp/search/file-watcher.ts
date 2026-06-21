/** File watcher — keeps the SQLite FTS5 index current via chokidar. */

import { watch } from "chokidar"
import { readFile, stat } from "node:fs/promises"
import { relative } from "node:path"
import type { SearchIndex } from "./search-index.js"
import { logger } from "../../logger.js"

/** ms between filesystem polls when usePolling is on. chokidar's raw default is
 *  100ms, which stat()s the whole tree 10×/sec; 300ms meaningfully cuts CPU, and
 *  re-index latency is already governed by the 2000ms awaitWriteFinish window, so
 *  the perceived cost is negligible. */
const POLLING_INTERVAL_MS = 300

export type FileWatcherOptions = Readonly<{
  /** ms a file's size must stay unchanged before we index it (default 2000).
   *  Prevents reading partial writes from Obsidian Sync. */
  stabilityThreshold?: number
  /** ms between file-size checks during the stability window (default 100). */
  pollInterval?: number
  /** Poll the filesystem instead of using native fs events (inotify). Needed
   *  when the vault is bind-mounted across the Docker Desktop ↔ WSL2 bridge,
   *  where inotify events don't propagate. CPU-heavier; default off. */
  usePolling?: boolean
}>

export const startFileWatcher = (
  vaultPath: string,
  search: SearchIndex,
  options?: FileWatcherOptions,
): Promise<void> => {
  const handleChange = async (filePath: string): Promise<void> => {
    if (!filePath.endsWith(".md")) return
    const relativePath = relative(vaultPath, filePath)
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
    } catch (err) {
      logger.error("failed to index file", {
        path: relativePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleDelete = (filePath: string): void => {
    if (!filePath.endsWith(".md")) return
    const relativePath = relative(vaultPath, filePath)
    search.removeNote(relativePath)
    logger.debug("removed from index", { path: relativePath })
  }

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
    // interval is consulted by chokidar only when polling, so it's harmless off.
    usePolling: options?.usePolling ?? false,
    interval: POLLING_INTERVAL_MS,
    // Obsidian Sync writes files in chunks — wait for write stability before
    // indexing to avoid reading partial content
    awaitWriteFinish: {
      stabilityThreshold: options?.stabilityThreshold ?? 2000,
      pollInterval: options?.pollInterval ?? 100,
    },
  })

  watcher
    .on("add", handleChange)
    .on("change", handleChange)
    .on("unlink", handleDelete)
    .on("error", (err) => {
      logger.error("watcher error", {
        error: err instanceof Error ? err.message : String(err),
      })
    })

  return new Promise((resolve) => {
    watcher.on("ready", () => {
      logger.info("file watcher started", { vaultPath })
      resolve()
    })
  })
}
