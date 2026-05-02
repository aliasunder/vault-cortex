/**
 * Vault filesystem operations.
 *
 * All reads/writes go through this module — tools.ts never touches
 * the filesystem directly. Keeps the vault-as-source-of-truth
 * invariant in one place.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";

/** Read a note by relative path. Throws if not found. */
export const readNote = async (
  vaultPath: string,
  notePath: string,
): Promise<string> => {
  const fullPath = join(vaultPath, notePath);
  // TODO: Validate path doesn't escape vault root (path traversal)
  return readFile(fullPath, "utf8");
};

/** Create or overwrite a note. Creates parent dirs if needed. */
export const writeNote = async (
  vaultPath: string,
  notePath: string,
  content: string,
): Promise<void> => {
  const fullPath = join(vaultPath, notePath);
  // TODO: Validate path doesn't escape vault root
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

/** List .md files in a folder. Returns relative paths from vault root. */
export const listNotes = async (
  vaultPath: string,
  folder?: string,
  _glob?: string,
): Promise<string[]> => {
  const targetDir = folder ? join(vaultPath, folder) : vaultPath;
  // TODO: Implement glob filter
  // TODO: Validate folder doesn't escape vault root
  const entries = await readdir(targetDir, {
    withFileTypes: true,
    recursive: true,
  });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => relative(vaultPath, join(e.parentPath ?? targetDir, e.name)));
};
