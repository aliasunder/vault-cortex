/**
 * SQLite FTS5 search index for the vault.
 *
 * Factory pattern — `createSearchIndex(dbPath)` returns an object with
 * query methods. The db connection lives in the closure, no class needed.
 *
 * The index is DERIVED from the vault and can be rebuilt from scratch
 * at any time. The vault .md files are always the source of truth.
 *
 * Uses better-sqlite3 which ships with FTS5 compiled in.
 *
 * Schema overview:
 *   - `notes` table: path (PK), title, content, tags (JSON), folder, type, mtime
 *   - `notes_fts` virtual table: FTS5 over notes with porter stemming
 *   - Triggers keep FTS in sync with notes table on insert/update/delete
 *
 * Usage:
 *   const index = createSearchIndex("/data/index.db");
 *   await index.rebuildFromVault("/vault");
 *   const results = index.fullTextSearch("meeting notes", { limit: 10 });
 *   const tagged = index.searchByTag("project/vault-mcp");
 */

import type Database from "better-sqlite3";

// ── Types ───────────────────────────────────────────────────────

export type SearchResult = {
  path: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
  folder: string;
};

export type NoteMetadata = {
  path: string;
  title: string;
  tags: string[];
  folder: string;
  type: string | null;
  mtime: number;
};

export type TagCount = {
  tag: string;
  count: number;
};

export type SearchFilters = {
  folder?: string;     // restrict to notes under this folder
  tags?: string[];     // require ALL of these tags
  type?: string;       // match frontmatter `type` field
  limit?: number;      // max results (default 20)
};

// ── Factory ─────────────────────────────────────────────────────

export const createSearchIndex = (dbPath: string) => {
  // TODO: implement
  //
  // 1. Open database with better-sqlite3
  // 2. Set WAL mode for concurrent reads
  // 3. Create `notes` table + `notes_fts` FTS5 virtual table
  // 4. Create triggers to keep FTS in sync with notes table
  // 5. Prepare reusable statements for each query method
  // 6. Return the methods object below

  // ── Index maintenance ──────────────────────────────────────────

  /** Parse frontmatter + content, upsert into notes table. */
  const upsertNote = (filePath: string, rawContent: string): void => {
    // TODO: implement
    // - Use gray-matter to parse frontmatter (title, tags, type)
    // - Fall back to filename for title if frontmatter missing
    // - INSERT ... ON CONFLICT(path) DO UPDATE
    // - FTS triggers handle the rest automatically
  };

  /** Remove a deleted note from the index. */
  const removeNote = (filePath: string): void => {
    // TODO: implement
  };

  /** Drop all rows and reindex every .md file in the vault. */
  const rebuildFromVault = async (vaultPath: string): Promise<number> => {
    // TODO: implement
    // - Walk the vault directory recursively
    // - Skip hidden dirs (.obsidian, .git, etc)
    // - Read each .md file
    // - Wrap all upserts in a transaction for speed
    // - Return count of indexed notes
    return 0;
  };

  // ── Query methods ──────────────────────────────────────────────
  // These are the queries an Obsidian user actually needs.

  /** Full-text search with BM25 ranking. Supports optional filters. */
  const fullTextSearch = (
    query: string,
    filters?: SearchFilters,
  ): SearchResult[] => {
    // TODO: implement
    // - FTS5 MATCH with porter stemming
    // - Multi-word: try phrase match OR individual terms
    // - Apply folder filter: WHERE path LIKE 'folder/%'
    // - Apply tag filter: check JSON tags array
    // - Apply type filter: WHERE type = ?
    // - ORDER BY rank (BM25), LIMIT
    return [];
  };

  /** Find notes with a specific tag. Obsidian tags are hierarchical
   *  (e.g. "project/vault-mcp"), so this should match both exact
   *  and prefix ("project" matches "project/vault-mcp"). */
  const searchByTag = (
    tag: string,
    options?: { exactMatch?: boolean; limit?: number },
  ): NoteMetadata[] => {
    // TODO: implement
    // - Query the tags JSON array in the notes table
    // - Support both exact match and prefix/hierarchical match
    // - json_each(tags) WHERE value = ? (exact)
    // - json_each(tags) WHERE value LIKE ?||'%' (prefix)
    return [];
  };

  /** List notes in a folder (and optionally subfolders). */
  const searchByFolder = (
    folder: string,
    options?: { recursive?: boolean; limit?: number },
  ): NoteMetadata[] => {
    // TODO: implement
    // - Recursive: WHERE path LIKE 'folder/%'
    // - Non-recursive: WHERE folder = 'folder'
    return [];
  };

  /** Find notes by frontmatter `type` field (e.g. "task-note", "reference"). */
  const searchByType = (
    type: string,
    limit?: number,
  ): NoteMetadata[] => {
    // TODO: implement
    return [];
  };

  /** List all tags in the vault with note counts. Useful for discovery. */
  const listAllTags = (): TagCount[] => {
    // TODO: implement
    // - json_each(tags) across all notes
    // - GROUP BY value, COUNT(*), ORDER BY count DESC
    return [];
  };

  /** Recently modified notes. Useful for "what was I working on?". */
  const recentNotes = (limit?: number): NoteMetadata[] => {
    // TODO: implement
    // - ORDER BY mtime DESC, LIMIT
    return [];
  };

  return {
    // Index maintenance
    upsertNote,
    removeNote,
    rebuildFromVault,

    // Queries
    fullTextSearch,
    searchByTag,
    searchByFolder,
    searchByType,
    listAllTags,
    recentNotes,
  };
};

/** Type of the search index returned by createSearchIndex. */
export type SearchIndex = ReturnType<typeof createSearchIndex>;
