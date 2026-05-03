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
//   readFile, writeFile, readdir, mkdir, unlink from "node:fs/promises"
//   join, dirname, relative, resolve from "node:path"
//   matter from "gray-matter"

/**
 * Top-level folders whose files cannot be deleted via MCP. Enforced
 * server-side as a hard guardrail — `destructiveHint: true` alone
 * isn't sufficient protection for journal-style files where bulk
 * loss would be catastrophic.
 *
 * To delete a file under one of these, use the Obsidian app directly.
 * To remove individual memory entries, use `vault_delete_memory`.
 */
const PROTECTED_PATHS = ["About Me/", "Daily Notes/"] as const;

/**
 * Read a note's raw content by relative path. Throws if not found.
 *
 * Example call:
 *   readNote("/vault", "About Me/Principles.md")
 *
 * Example response (string):
 *   "---\ntitle: Principles\ntype: about-me\ntags: [principles, self]\n
 *    created: 2025-08-12T09:00:00-07:00\nrelated: [Routines, Career]\n---\n
 *    \n# Principles\n\n## Decision heuristics\n
 *    - **2026-05-03**: prefer reversible decisions when context is thin\n..."
 */
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

/**
 * Create or overwrite a note. Creates parent dirs if needed.
 *
 * IMPORTANT: `body` is the markdown body only — NEVER raw markdown
 * including frontmatter. Frontmatter must round-trip losslessly:
 * accepting a raw string from the agent risks YAML quoting drift,
 * key-order changes, or comment loss that would corrupt the file.
 *
 * Implementation:
 *   - For new files: write `matter.stringify(body, frontmatter ?? {})`
 *   - For existing files: read, parse with gray-matter, replace
 *     `.content` with the new body, keep `.data` (frontmatter)
 *     verbatim, then `matter.stringify(...)` and write.
 *   - If the agent passes `frontmatter`, MERGE it onto the existing
 *     frontmatter (don't replace) — preserves keys the agent didn't
 *     touch (created, related, etc).
 *
 * Example call (update body, leave frontmatter alone):
 *   writeNote("/vault", "About Me/Principles.md",
 *             "# Principles\n\n## Decision heuristics\n- ...\n")
 *
 * Example call (update one frontmatter key + body):
 *   writeNote("/vault", "Projects/vault-cortex/notes.md",
 *             "# vault-cortex notes\n...",
 *             { status: "active" })
 *
 * Example response: void (throws on validation or I/O failure).
 */
export const writeNote = async (
  _vaultPath: string,
  _notePath: string,
  _body: string,
  _frontmatter?: Record<string, unknown>,
): Promise<void> => {
  // TODO: implement
  // - Validate path doesn't escape vault root
  // - mkdir(dirname(fullPath), { recursive: true })
  // - If file exists: parse with gray-matter, merge frontmatter,
  //   replace body, matter.stringify(...)
  // - If new: matter.stringify(body, frontmatter ?? {})
  // - writeFile(fullPath, serialized, "utf8")
  // - obsidian-headless will detect the write and sync it
  throw new Error("Not implemented");
};

/**
 * Delete a note. Throws if the path is protected, escapes the vault
 * root, or doesn't exist.
 *
 * The file watcher's unlink handler picks up the deletion and calls
 * `searchIndex.removeNote()` to keep the index in sync. Obsidian Sync
 * propagates the deletion to all connected devices.
 *
 * Refuses to delete any path starting with a `PROTECTED_PATHS` prefix
 * (currently `About Me/` and `Daily Notes/`). To remove memories, use
 * `vault_delete_memory` at the entry level.
 *
 * Example call:
 *   deleteNote("/vault", "Projects/scratch/typo.md")
 *
 * Example response: void (throws on protected path, missing file,
 * or path-traversal attempt).
 *
 * Example error:
 *   deleteNote("/vault", "About Me/Principles.md")
 *   // → Error: cannot delete protected path "About Me/Principles.md"
 *   //   (use vault_delete_memory for individual entries)
 */
export const deleteNote = async (
  _vaultPath: string,
  _notePath: string,
): Promise<void> => {
  // TODO: implement
  // - Validate path doesn't escape vault root (resolve + startsWith)
  // - Reject if notePath starts with any PROTECTED_PATHS prefix
  // - unlink(fullPath) — fs.promises throws ENOENT cleanly if missing
  // - File watcher unlink handler calls searchIndex.removeNote()
  throw new Error("Not implemented");
};

/**
 * List .md files under a folder. Returns relative paths from vault root.
 * If no folder specified, lists from vault root.
 *
 * Example call:
 *   listNotes("/vault", "About Me")
 *
 * Example response:
 *   ["About Me/Principles.md", "About Me/Career.md",
 *    "About Me/Routines.md", "About Me/Preferences.md"]
 *
 * Example call (with glob):
 *   listNotes("/vault", "Projects", "vault-*\/**\/*.md")
 *
 * Example response:
 *   ["Projects/vault-cortex/notes.md",
 *    "Projects/vault-cortex/architecture.md"]
 */
export const listNotes = async (
  _vaultPath: string,
  _folder?: string,
  _glob?: string,
): Promise<string[]> => {
  // TODO: implement
  // - Validate folder doesn't escape vault root
  // - readdir with { recursive: true, withFileTypes: true }
  // - Filter to .md files; skip hidden dirs (.obsidian, .git)
  // - Optionally apply glob pattern (consider using micromatch or picomatch)
  // - Return relative paths from vault root
  return [];
};
