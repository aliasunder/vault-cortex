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
 * ── Schema ─────────────────────────────────────────────────────────
 *
 * The whole frontmatter is ingested at index time. Well-known keys
 * get first-class columns (filterable + sortable directly); everything
 * else is stashed in a JSON `properties` column for ad-hoc queries
 * via `json_extract(properties, '$.<key>')`.
 *
 * ```sql
 * CREATE TABLE notes (
 *   path        TEXT PRIMARY KEY,   -- relative path from vault root
 *   title       TEXT,               -- frontmatter.title ?? filename
 *   content     TEXT,               -- body, frontmatter stripped
 *   tags        TEXT,               -- JSON array, e.g. ["principles","self"]
 *   related     TEXT,               -- JSON array of wikilink targets
 *   folder      TEXT,               -- top-level folder, e.g. "About Me"
 *   type        TEXT,               -- frontmatter.type, e.g. "about-me"
 *   created     TEXT,               -- frontmatter.created, ISO 8601 with TZ
 *                                   -- ("2026-05-03T14:30:00-07:00")
 *                                   -- Stored as TEXT — human-readable AND
 *                                   -- lexicographically sortable in ISO form.
 *   mtime       INTEGER,            -- filesystem mtime, epoch ms
 *   properties  TEXT                -- JSON object: full frontmatter
 * );
 *
 * CREATE VIRTUAL TABLE notes_fts USING fts5(
 *   title, content, tokenize='porter unicode61'
 * );
 * -- Triggers keep notes_fts in sync with notes on insert/update/delete.
 * ```
 *
 * `created` ≠ `mtime`:
 *   - `created` is what the user typed in frontmatter (semantic time).
 *   - `mtime` is the filesystem mtime (last edit, even a typo fix).
 *   - `recentNotes()` accepts `sort_by` to choose between them.
 *
 * Usage:
 *   const index = createSearchIndex("/data/index.db");
 *   await index.rebuildFromVault("/vault");
 *   const results = index.fullTextSearch("meeting notes", { limit: 10 });
 *   const tagged = index.searchByTag("project/vault-mcp");
 */

import type _Database from "better-sqlite3"

// ── Types ───────────────────────────────────────────────────────

export type SearchResult = {
  path: string
  title: string
  snippet: string // FTS5 snippet() with <mark>…</mark> highlights
  score: number // BM25 rank (higher = better, after negation)
  tags: string[]
  folder: string
  created: string | null // ISO 8601 with TZ, or null if absent
  mtime: number // epoch ms
}

export type NoteMetadata = {
  path: string
  title: string
  tags: string[]
  related: string[]
  folder: string
  type: string | null
  created: string | null
  mtime: number
  properties: Record<string, unknown> // full frontmatter as parsed
}

export type TagCount = {
  tag: string
  count: number
}

export type SearchFilters = {
  folder?: string // restrict to notes under this folder
  tags?: string[] // require ALL of these tags
  related?: string[] // require ALL of these wikilink targets
  type?: string // match frontmatter `type` field
  /**
   * Match arbitrary frontmatter keys — translated into
   * `json_extract(properties, '$.<key>') = ?` clauses (AND-joined).
   * Example: `{ status: "open", area: "work" }`.
   */
  properties?: Record<string, string | number | boolean>
  limit?: number // max results (default 20)
}

// ── Factory ─────────────────────────────────────────────────────

export const createSearchIndex = (_dbPath: string) => {
  // TODO: implement
  //
  // 1. Open database with better-sqlite3
  // 2. Set WAL mode for concurrent reads
  // 3. Create `notes` table + `notes_fts` FTS5 virtual table per the
  //    schema in the file header
  // 4. Create triggers to keep FTS in sync with notes table
  // 5. Prepare reusable statements for each query method
  // 6. Return the methods object below

  // ── Index maintenance ──────────────────────────────────────────

  /**
   * Parse frontmatter + content, upsert into notes table.
   *
   * Implementation notes:
   *   - Use gray-matter to parse the file
   *   - title:       frontmatter.title ?? basename(path, ".md")
   *   - tags:        JSON.stringify(frontmatter.tags ?? [])
   *   - related:     JSON.stringify(frontmatter.related ?? [])
   *   - type:        frontmatter.type ?? null
   *   - created:     frontmatter.created ?? null  (string, ISO 8601)
   *   - properties:  JSON.stringify(frontmatter)  (the whole bag)
   *   - mtime:       fs.stat(path).mtimeMs
   *   - INSERT ... ON CONFLICT(path) DO UPDATE
   *   - FTS triggers handle the rest automatically
   */
  const upsertNote = (_filePath: string, _rawContent: string): void => {
    // TODO: implement
  }

  /** Remove a deleted note from the index. */
  const removeNote = (_filePath: string): void => {
    // TODO: implement
  }

  /** Drop all rows and reindex every .md file in the vault. */
  const rebuildFromVault = async (_vaultPath: string): Promise<number> => {
    // TODO: implement
    // - Walk the vault directory recursively
    // - Skip hidden dirs (.obsidian, .git, etc)
    // - Read each .md file
    // - Wrap all upserts in a transaction for speed
    // - Return count of indexed notes
    return 0
  }

  // ── Query methods ──────────────────────────────────────────────
  // These are the queries an Obsidian user actually needs.

  /**
   * Full-text search with BM25 ranking. Supports all filters in
   * `SearchFilters` (folder, tags, related, type, properties).
   *
   * Example call:
   *   fullTextSearch("burnout", { tags: ["principles"], limit: 5 })
   *
   * Example response:
   *   [
   *     {
   *       path: "About Me/Principles.md",
   *       title: "Principles",
   *       snippet: "...avoid <mark>burnout</mark> by...",
   *       score: 0.87,
   *       tags: ["principles", "self"],
   *       folder: "About Me",
   *       created: "2025-08-12T09:00:00-07:00",
   *       mtime: 1746300000000
   *     }
   *   ]
   *
   * Example call (property filter):
   *   fullTextSearch("Q3 plan", { properties: { status: "open" } })
   */
  const fullTextSearch = (
    _query: string,
    _filters?: SearchFilters,
  ): SearchResult[] => {
    // TODO: implement
    // - FTS5 MATCH with porter stemming
    // - Multi-word: try phrase match OR individual terms
    // - folder filter:    WHERE path LIKE 'folder/%'
    // - tags filter:      EXISTS (json_each(tags) WHERE value = ?) AND ...
    // - related filter:   same shape as tags
    // - type filter:      WHERE type = ?
    // - properties:       WHERE json_extract(properties,'$.<key>') = ? AND ...
    // - ORDER BY rank (BM25), LIMIT
    return []
  }

  /**
   * Find notes with a specific tag. Obsidian tags are hierarchical
   * (e.g. "project/vault-mcp"), so this matches both exact and
   * prefix ("project" matches "project/vault-mcp") by default.
   *
   * Example call:
   *   searchByTag("project/vault-mcp", { limit: 3 })
   *
   * Example response:
   *   [
   *     {
   *       path: "Projects/vault-cortex/notes.md",
   *       title: "vault-cortex notes",
   *       tags: ["project/vault-mcp"],
   *       related: ["Principles"],
   *       folder: "Projects",
   *       type: "project-note",
   *       created: "2025-12-01T10:00:00-08:00",
   *       mtime: 1746290000000,
   *       properties: { status: "active", priority: "high" }
   *     }
   *   ]
   */
  const searchByTag = (
    _tag: string,
    _options?: { exactMatch?: boolean; limit?: number },
  ): NoteMetadata[] => {
    // TODO: implement
    // - exact:  json_each(tags) WHERE value = ?
    // - prefix: json_each(tags) WHERE value = ? OR value LIKE ?||'/%'
    return []
  }

  /**
   * List notes in a folder (and optionally subfolders).
   *
   * Example call:
   *   searchByFolder("About Me", { recursive: false })
   *
   * Example response: `NoteMetadata[]` for every .md directly under
   * `About Me/` (Principles.md, Career.md, Routines.md, ...).
   */
  const searchByFolder = (
    _folder: string,
    _options?: { recursive?: boolean; limit?: number },
  ): NoteMetadata[] => {
    // TODO: implement
    // - Recursive: WHERE path LIKE 'folder/%'
    // - Non-recursive: WHERE folder = 'folder'
    return []
  }

  /**
   * Find notes by frontmatter `type` field (e.g. "task-note", "reference").
   *
   * Example call:
   *   searchByType("about-me")
   *
   * Example response: every NoteMetadata under About Me/ where
   * frontmatter.type === "about-me".
   */
  const searchByType = (_type: string, _limit?: number): NoteMetadata[] => {
    // TODO: implement
    return []
  }

  /**
   * List all tags in the vault with note counts. Useful for discovery.
   *
   * Example call:
   *   listAllTags()
   *
   * Example response:
   *   [
   *     { tag: "principles", count: 12 },
   *     { tag: "project/vault-mcp", count: 8 },
   *     { tag: "self", count: 5 }
   *   ]
   */
  const listAllTags = (): TagCount[] => {
    // TODO: implement
    // - json_each(tags) across all notes
    // - GROUP BY value, COUNT(*), ORDER BY count DESC
    return []
  }

  /**
   * Recently-touched notes. `sort_by` chooses semantic vs filesystem time.
   *
   * Example call:
   *   recentNotes({ sort_by: "created", limit: 10 })
   *
   * Example response: `NoteMetadata[]` ordered by frontmatter.created
   * descending, NULLs last.
   *
   * Example call:
   *   recentNotes({ sort_by: "mtime", limit: 5 })
   *
   * Example response: 5 most recently filesystem-touched notes
   * (e.g. notes you opened to fix a typo this morning).
   */
  const recentNotes = (_options?: {
    sort_by?: "created" | "mtime"
    limit?: number
  }): NoteMetadata[] => {
    // TODO: implement
    // - Default sort_by = "mtime"
    // - "created":  ORDER BY created DESC NULLS LAST
    // - "mtime":    ORDER BY mtime DESC
    // - LIMIT (default 20)
    return []
  }

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
  }
}

/** Type of the search index returned by createSearchIndex. */
export type SearchIndex = ReturnType<typeof createSearchIndex>
