/**
 * File watcher — keeps the SQLite FTS5 index current.
 *
 * Uses chokidar with awaitWriteFinish to handle atomic writes from
 * obsidian-headless (which may write + rename). Debounce is handled
 * by awaitWriteFinish's stabilityThreshold.
 *
 * In Phase 2, this gains a second hook for LightRAG ingestion —
 * same watcher, additional callback. That's the R8 extensibility.
 */

import chokidar from "chokidar";
import { readFile } from "node:fs/promises";
import type { SearchIndex } from "./search.js";

export const startWatcher = (
  vaultPath: string,
  search: SearchIndex,
): void => {
  const watcher = chokidar.watch(vaultPath, {
    ignored: (path) => {
      // Ignore hidden dirs (.obsidian, .git, .neural_memory, etc)
      if (path === vaultPath) return false;
      if (path.includes("/.")) return true;
      // Only watch .md files (let directories through for recursion)
      if (!path.endsWith(".md") && !path.includes("/")) return false;
      return !path.endsWith(".md");
    },
    persistent: true,
    ignoreInitial: true, // already indexed on startup via reindex()
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  const handleChange = async (filePath: string): Promise<void> => {
    const relativePath = filePath.replace(`${vaultPath}/`, "");
    try {
      const content = await readFile(filePath, "utf8");
      search.upsert(relativePath, content);
      console.log(`[watcher] indexed: ${relativePath}`);
    } catch (err) {
      console.error(`[watcher] failed to index: ${relativePath}`, err);
    }
  };

  watcher
    .on("add", handleChange)
    .on("change", handleChange)
    .on("unlink", (filePath) => {
      const relativePath = filePath.replace(`${vaultPath}/`, "");
      search.remove(relativePath);
      console.log(`[watcher] removed: ${relativePath}`);
    });

  console.log(`[watcher] watching ${vaultPath}`);
};
