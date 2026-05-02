/**
 * Vault filesystem operations.
 *
 * All file reads/writes go through this module — tool-definitions.ts
 * and other callers never touch the filesystem directly. This keeps
 * the vault-as-source-of-truth invariant in one place and makes it
 * easy to add path validation, logging, or write hooks later.
 *
 * When vault-mcp writes a file, obsidian-headless detects the change
 * and syncs it to all devices via Obsidian Sync. The file watcher
 * also picks it up and updates the search index.
 */

// TODO: implement all functions below
//
// Key imports needed:
//   readFile, writeFile, readdir, mkdir from "node:fs/promises"
//   join, dirname, relative, resolve from "node:path"

/** Read a note's raw content by relative path. Throws if not found. */
export const readNote = async (
  _vaultPath: string,
  _notePath: string,
): Promise<string> => {
  // TODO: implement
  // - Resolve full path: join(vaultPath, notePath)
  // - IMPORTANT: validate the resolved path doesn't escape vault root
  //   (e.g. "../../etc/passwd" — use resolve() + startsWith() check)
  // - Return file content as utf-8 string
  throw new Error("Not implemented");
};

/** Create or overwrite a note. Creates parent dirs if needed. */
export const writeNote = async (
  _vaultPath: string,
  _notePath: string,
  _content: string,
): Promise<void> => {
  // TODO: implement
  // - Validate path doesn't escape vault root
  // - mkdir(dirname(fullPath), { recursive: true })
  // - writeFile(fullPath, content, "utf8")
  // - obsidian-headless will detect the write and sync it
  throw new Error("Not implemented");
};

/**
 * List .md files under a folder. Returns relative paths from vault root.
 * If no folder specified, lists from vault root.
 */
export const listNotes = async (
  _vaultPath: string,
  _folder?: string,
  _glob?: string,
): Promise<string[]> => {
  // TODO: implement
  // - Validate folder doesn't escape vault root
  // - readdir with { recursive: true, withFileTypes: true }
  // - Filter to .md files
  // - Optionally apply glob pattern (consider using micromatch or picomatch)
  // - Return relative paths
  return [];
};
