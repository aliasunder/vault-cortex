/** File watcher — keeps the SQLite FTS5 index current via chokidar. */

import { watch } from "chokidar"
import { readFile, stat } from "node:fs/promises"
import { relative } from "node:path"
import type { SearchIndex } from "./search-index.js"
import { logger } from "../../logger.js"

export type FileWatcherOptions = Readonly<{
  /** ms a file's size must stay unchanged before we index it (default 2000).
   *  Prevents reading partial writes from Obsidian Sync. */
  stabilityThreshold?: number
  /** ms between file-size checks during the stability window (default 100). */
  pollInterval?: number
}>

export const startFileWatcher = (
  vaultPath: string,
  search: SearchIndex,
  options?: FileWatcherOptions,
): Promise<void> => {
  const handleChange = async (filePath: string): Promise<void> => {
    if (!filePath.endsWith(".md")) return
    const relPath = relative(vaultPath, filePath)
    try {
      const [content, fileStat] = await Promise.all([
        readFile(filePath, "utf8"),
        stat(filePath),
      ])
      search.upsertNote(relPath, content, fileStat.mtimeMs)
      logger.debug("indexed", { path: relPath })
    } catch (err) {
      logger.error("failed to index file", {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleDelete = (filePath: string): void => {
    if (!filePath.endsWith(".md")) return
    const relPath = relative(vaultPath, filePath)
    search.removeNote(relPath)
    logger.debug("removed from index", { path: relPath })
  }

  const watcher = watch(vaultPath, {
    // Skip dotfiles/directories (.obsidian/, .trash/) but allow the vault root itself
    ignored: (path: string) => {
      const rel = relative(vaultPath, path)
      if (!rel) return false
      return rel.split("/").some((seg) => seg.startsWith("."))
    },
    persistent: true,
    ignoreInitial: true,
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
