/**
 * File watcher — keeps the SQLite FTS5 index current.
 *
 * Uses chokidar with awaitWriteFinish to handle atomic writes from
 * obsidian-headless (which may write + rename). Debounce is handled
 * by awaitWriteFinish's stabilityThreshold.
 *
 * In Phase 2, this gains a second hook for LightRAG ingestion —
 * same watcher, additional callback. The R8 extensibility requirement.
 */

import chokidar from "chokidar";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultSearch } from "./search.js";

export function startWatcher(
  vaultPath: string,
  search: VaultSearch,
): void {
  const watcher = chokidar.watch(vaultPath, {
    ignored: (path) => {
      // Ignore non-markdown, hidden dirs (.obsidian, .git, etc)
      if (path === vaultPath) return false;
      if (path.includes("/.")) return true;
      if (!path.endsWith(".md") && !path.includes("/")) return false; // dirs
      return !path.endsWith(".md");
    },
    persistent: true,
    ignoreInitial: true, // we already indexed on startup
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
}
