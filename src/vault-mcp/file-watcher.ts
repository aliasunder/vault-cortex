/**
 * File watcher — keeps the SQLite FTS5 index current.
 *
 * Watches the vault directory for .md file changes using chokidar.
 * When a file is added or modified, it re-indexes that single file.
 * When a file is deleted, it removes it from the index.
 *
 * Uses awaitWriteFinish to handle atomic writes from obsidian-headless,
 * which may write to a temp file then rename (common on Linux).
 *
 * In Phase 2, this gains a second callback for LightRAG ingestion —
 * same watcher, additional hook. That's the R8 extensibility.
 */

import type { SearchIndex } from "./search-index.js"

export const startFileWatcher = (
  _vaultPath: string,
  _search: SearchIndex,
): void => {
  // TODO: implement
  //
  // Key imports needed:
  //   chokidar from "chokidar"
  //   readFile from "node:fs/promises"
  //
  // Setup:
  //   chokidar.watch(vaultPath, {
  //     ignored: (path) => {
  //       // Skip hidden dirs: .obsidian, .git, .neural_memory
  //       // Only watch .md files
  //     },
  //     persistent: true,
  //     ignoreInitial: true,  // already indexed on startup via rebuildFromVault()
  //     awaitWriteFinish: {
  //       stabilityThreshold: 2000,  // wait 2s after last write before firing
  //       pollInterval: 100,
  //     },
  //   })
  //
  // Events:
  //   .on("add", handleChange)    — new file appeared
  //   .on("change", handleChange) — existing file modified
  //   .on("unlink", handleDelete) — file removed
  //
  // handleChange: read file content, call search.upsertNote(relativePath, content)
  // handleDelete: call search.removeNote(relativePath)
}
