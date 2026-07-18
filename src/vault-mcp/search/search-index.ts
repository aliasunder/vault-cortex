import Database from "better-sqlite3"
import { DateTime } from "luxon"
import * as sqliteVec from "sqlite-vec"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, basename, posix, relative, resolve } from "node:path"
import type { Logger } from "../../logger.js"
import { parseNote } from "../obsidian-markdown/frontmatter.js"
import { parseLeadingCallout } from "../obsidian-markdown/callouts.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { links } from "../obsidian-markdown/links.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { parseHeadings } from "../obsidian-markdown/headings.js"
import {
  parseMemoryEntries,
  type MemoryEntry,
} from "../obsidian-markdown/memory-entries.js"
import { tasks } from "../obsidian-markdown/tasks.js"
import type { TaskPriority, TaskStatus } from "../obsidian-markdown/tasks.js"
import { contentHash, type Embedder } from "./embedder.js"
import type { Reranker } from "./reranker.js"
import { chunkNoteContent } from "./chunker.js"
import { describeError } from "../../utils/describe-error.js"
import { filterValidSymlinks } from "../../utils/filter-valid-symlinks.js"
import { statOrNull } from "../../utils/fs.js"
import {
  isString,
  coerceToArray,
  buildFtsMetadataText,
  escapeLikeWildcards,
} from "./search-helpers.js"
import * as queries from "./search-queries.js"

// ── Types ───────────────────────────────────────────────────────

/** A note path with its best-chunk distance from a vector KNN query. */
export type VectorHit = Readonly<{
  path: string
  distance: number
  chunkText: string
}>

export type SearchResult = {
  path: string
  title: string
  snippet: string
  score: number
  tags: string[]
  folder: string
  type: string | null
  created?: string
  modified: string
  bytes: number
  leading_callout?: LeadingCallout
}

export type HybridSearchResult = {
  results: SearchResult[]
  search_mode: "hybrid" | "fts"
  reranked: boolean
}

export type NoteMetadata = {
  path: string
  title: string
  tags: string[]
  related: string[]
  folder: string
  type: string | null
  created: string | null
  modified: string
  bytes: number
  properties: Record<string, unknown>
  leading_callout: LeadingCallout | null
}

export type TagCount = {
  tag: string
  count: number
}

export type PropertyKeyInfo = {
  key: string
  count: number
  sample_values: string[]
}

export type PropertyValueCount = {
  value: string
  count: number
}

export type VaultStats = {
  totalNotes: number
  untaggedNotes: number
  noPropertiesNotes: number
}

export type SearchFilters = {
  folder?: string | undefined
  tags?: string[] | undefined
  related?: string[] | undefined
  type?: string | undefined
  properties?: Record<string, string | number | boolean> | undefined
  created?: DateFilter | undefined
  modified?: DateFilter | undefined
  limit?: number | undefined
  snippet_tokens?: number | undefined
  include_leading_callout?: boolean | undefined
}

export type NoteRow = {
  path: string
  title: string
  tags: string
  related: string
  folder: string
  type: string | null
  created: string | null
  mtime: number
  properties: string
  leading_callout: string | null
  bytes: number
}

/** One tasks-table row as stored in SQLite: depends_on and tags are
 *  JSON-encoded arrays; dates are raw YYYY-MM-DD strings. */
export type TaskRow = {
  note_path: string
  line: number
  status_char: string
  status: TaskStatus
  description: string
  created: string | null
  scheduled: string | null
  start: string | null
  due: string | null
  done: string | null
  cancelled: string | null
  priority: TaskPriority | null
  recurrence: string | null
  on_completion: string | null
  task_id: string | null
  depends_on: string
  tags: string
  block_id: string | null
  heading: string | null
  folder: string
  is_kanban_task: number
  kanban_done_lanes: string | null
}

/** One task on the wire — snake_case multi-word fields match the JSON
 *  response shape. Every entry carries its attribution (path, folder,
 *  heading, line) so a client never needs a follow-up read to locate it. */
export type TaskEntry = {
  path: string
  line: number
  status: TaskStatus
  status_char: string
  description: string
  heading: string | null
  folder: string
  created: string | null
  scheduled: string | null
  start: string | null
  due: string | null
  done: string | null
  cancelled: string | null
  priority: TaskPriority | null
  recurrence: string | null
  on_completion: string | null
  task_id: string | null
  depends_on: string[]
  tags: string[]
  block_id: string | null
  is_kanban_task: boolean
  lane: string | null
  done_lanes: string[] | null
}

/** Status filter vocabulary for listTasks. "not_done" (the default) covers
 *  todo + in_progress — the Tasks plugin's own `not done` semantics, which
 *  exclude cancelled tasks. */
export type TaskStatusFilter =
  "not_done" | "todo" | "in_progress" | "done" | "cancelled" | "all"

/** Date bounds for one date field — task dates and vault_search's
 *  created/modified filters. before/after are exclusive and on is an exact
 *  match — the Tasks plugin's query vocabulary. Bounds are YYYY-MM-DD: task
 *  dates and note created days compare lexicographically; modified bounds
 *  convert to server-local epoch-ms day boundaries. */
export type DateFilter = {
  before?: string | undefined
  on?: string | undefined
  after?: string | undefined
}

/** Priority filter value — the five explicit levels plus "none" for tasks
 *  with no priority signifier. */
export type TaskPriorityFilter = TaskPriority | "none"

/** Sort keys for listTasks. The five task dates and priority sort on the
 *  task's own metadata; note_mtime sorts on the owning note's modified time;
 *  position sorts by file path then line number (Kanban card order). */
export type TaskSortKey =
  | "due"
  | "scheduled"
  | "start"
  | "created"
  | "done"
  | "priority"
  | "note_mtime"
  | "position"

/** listTasks response: tasks is the limit-capped page, total the full match
 *  count — so callers can tell "50 of 338" from "all 50". */
export type ListTasksResult = { total: number; tasks: TaskEntry[] }

/** One recalled memory entry on the wire. file + section feed directly back
 *  into vault_get_memory / vault_delete_memory; text is the raw entry
 *  markdown (wikilinks intact, continuation lines included). */
export type MemoryRecallEntry = {
  file: string
  section: string
  date: string
  text: string
}

/** memoryRecall response: entries is the max_results-capped evidence set in
 *  ascending date order; total counts every entry that survived the
 *  relevance cut, so truncated = total > entries.length tells the client the
 *  set is incomplete (the least-relevant matches were dropped — never a date
 *  range). */
export type MemoryRecallResult = {
  entries: MemoryRecallEntry[]
  total: number
  truncated: boolean
  search_mode: "hybrid" | "fts"
  reranked: boolean
}

export type BacklinkEntry = { path: string; title: string; bytes: number }

export type OutgoingLinkEntry = {
  path: string
  title: string | null
  exists: boolean
  /** "note" for .md targets, "asset" for resolved non-markdown files
   *  (.canvas, .base, images, etc.). Defaults to "note" for broken links. */
  kind: "note" | "asset"
  bytes: number | null
  /** True when the target is under the daily notes folder and the note
   *  does not exist yet — a forward-reference ("create on click"
   *  navigation), not a genuinely broken link. */
  daily_note_forward_ref: boolean
}

// ── Link extraction ─────────────────────────────────────────────
//
// Links between notes are tracked in a `links` table (source → target)
// to power backlink queries, outgoing link lookups, and orphan detection.
// The link grammar — recognizing, parsing, and resolving links — lives in
// ../links.ts; this section only composes it for indexing.
//
// Indexing flow:
//   1. links.extractFromBody() parses wikilinks ([[target]]) and markdown
//      links ([text](target) / ![alt](target)) from the note body (skipping fenced code
//      blocks and inline code spans); links.extractFromFrontmatter() adds
//      [[wikilinks]] from frontmatter property values (e.g. related:).
//   2. links.resolve() maps each raw target to a vault-relative path by trying
//      exact match → relative-to-source match → basename/shortest-path heuristic.
//   3. upsertNote stores resolved links in the `links` table. Unresolved
//      targets are stored as-is (raw text) for broken-link detection.
//   4. When a new note is created, upsertNote re-resolves any stale
//      unresolved targets that now match the new note's path or basename
//      (handles Obsidian's "link first, create later" workflow).
//   5. rebuildFromVault uses a two-pass approach: Pass 1 indexes all
//      notes without links (skipLinks), Pass 2 extracts links with the
//      complete path list so all targets can resolve.

// ── Factory ─────────────────────────────────────────────────────

export const createSearchIndex = (
  dbPath: string,
  embedder?: Embedder,
  reranker?: Reranker,
  options?: {
    /** Vault-relative memory folder ("About Me"). When set, dated entries in
     *  its direct-child .md files are additionally indexed at entry
     *  granularity for vault_memory_recall; undefined (memory disabled)
     *  skips the entry tables entirely. */
    memoryDir?: string | undefined
  },
) => {
  const memoryDir = options?.memoryDir
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  sqliteVec.load(db)

  // FTS5 doesn't support ALTER TABLE ADD COLUMN. When opening a warm database
  // that lacks the metadata column, drop the table so the CREATE below rebuilds
  // it with the new schema. rebuildFromVault repopulates on every startup.
  const ftsColumns = db
    .prepare<unknown[], { name: string }>("PRAGMA table_info(notes_fts)")
    .all()
  if (
    ftsColumns.length > 0 &&
    !ftsColumns.some((column) => column.name === "metadata")
  ) {
    db.exec("DROP TABLE notes_fts")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      path        TEXT PRIMARY KEY,
      title       TEXT,
      content     TEXT,
      tags        TEXT,
      related     TEXT,
      folder      TEXT,
      type        TEXT,
      created     TEXT,
      mtime       INTEGER,
      properties  TEXT,
      leading_callout TEXT,
      bytes       INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      path UNINDEXED, title, content, metadata, tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS links (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (source, target)
    );

    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);

    CREATE TABLE IF NOT EXISTS non_md_files (
      path      TEXT PRIMARY KEY,
      base_path TEXT NOT NULL,
      basename  TEXT NOT NULL,
      bytes     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_non_md_base_path ON non_md_files(base_path);
    CREATE INDEX IF NOT EXISTS idx_non_md_basename ON non_md_files(basename);

    CREATE TABLE IF NOT EXISTS tasks (
      note_path     TEXT NOT NULL,
      line          INTEGER NOT NULL,
      status_char   TEXT NOT NULL,
      status        TEXT NOT NULL,
      description   TEXT NOT NULL,
      created       TEXT,
      scheduled     TEXT,
      start         TEXT,
      due           TEXT,
      done          TEXT,
      cancelled     TEXT,
      priority      TEXT,
      recurrence    TEXT,
      on_completion TEXT,
      task_id       TEXT,
      depends_on    TEXT NOT NULL,
      tags          TEXT NOT NULL,
      block_id      TEXT,
      heading       TEXT,
      folder        TEXT NOT NULL,
      PRIMARY KEY (note_path, line)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
  `)
  // path UNINDEXED: stored for JOIN/DELETE but not searchable, saves index space

  // ── Vector tables (embedding pipeline) ────────────────────────
  // Created only when an embedder is provided — otherwise the search index
  // operates in FTS5-only mode with no model download or vector storage.
  if (embedder) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        note_path    TEXT NOT NULL,
        chunk_index  INTEGER NOT NULL,
        chunk_text   TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(note_path, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_note_chunks_path ON note_chunks(note_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS note_vectors USING vec0(
        chunk_id  INTEGER PRIMARY KEY,
        embedding float[384]
      );
    `)
  }

  // ── Memory-entry tables (vault_memory_recall) ──────────────────
  // Created whenever a memory dir is configured: the entry rows and their FTS
  // index power the lexical leg, which must work even with embeddings off —
  // the same split as the always-on notes_fts vs the embedder-gated
  // note_chunks. Only the vector table additionally requires the embedder.
  //
  // No UNIQUE(file, entry_index): the hash reconcile in upsertMemoryEntries
  // UPDATEs indices in place as entries shift (memory appends insert at the
  // top of a section), and SQLite checks uniqueness per-statement — not
  // deferred — so mid-reconcile index collisions would be spurious errors.
  if (memoryDir !== undefined) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        file         TEXT NOT NULL,
        section      TEXT NOT NULL,
        entry_date   TEXT NOT NULL,
        entry_text   TEXT NOT NULL,
        entry_index  INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entries_file ON memory_entries(file);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        entry_id UNINDEXED, file UNINDEXED, section, entry_text, tokenize='porter unicode61'
      );
    `)
    if (embedder) {
      // distance_metric=cosine (unlike note_vectors' L2 default): ordering is
      // identical on L2-normalized bge vectors, but memoryRecall's fallback
      // cut is a distance margin, which needs the interpretable cosine scale.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_entry_vectors USING vec0(
          entry_id  INTEGER PRIMARY KEY,
          embedding float[384] distance_metric=cosine
        );
      `)
    }
  }

  // CREATE TABLE IF NOT EXISTS is a no-op on a pre-existing DB file, so a warm
  // database from before the `leading_callout` column was added would lack it
  // (and the upsert below would throw). Add it idempotently when absent. The
  // column is not FTS-indexed — the callout text already lives in `content`, so
  // it's searchable; this column only stores the parsed block for cheap retrieval.
  const noteColumns = db
    .prepare<unknown[], { name: string }>(`PRAGMA table_info(notes)`)
    .all()
  if (!noteColumns.some((column) => column.name === "leading_callout")) {
    db.exec(`ALTER TABLE notes ADD COLUMN leading_callout TEXT`)
  }
  if (!noteColumns.some((column) => column.name === "bytes")) {
    db.exec(`ALTER TABLE notes ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`)
  }
  if (!noteColumns.some((column) => column.name === "kanban_done_lanes")) {
    db.exec(`ALTER TABLE notes ADD COLUMN kanban_done_lanes TEXT`)
  }

  // Same idempotent migration for non_md_files.bytes: a warm database from
  // before the column existed would fail the upsert. Nullable — NULL means
  // "not yet statted"; the startup rebuild backfills every row.
  const nonMdColumns = db
    .prepare<unknown[], { name: string }>(`PRAGMA table_info(non_md_files)`)
    .all()
  if (!nonMdColumns.some((column) => column.name === "bytes")) {
    db.exec(`ALTER TABLE non_md_files ADD COLUMN bytes INTEGER`)
  }

  // Daily notes folder for forward-ref exclusion — broken links under
  // this folder are treated as intentional "create on click" navigation.
  // Set via setDailyNotesFolder from server.ts config; null until then.
  let dailyNotesFolder: string | null = null

  // Prepared statements are compiled once here and reused across all calls.
  // db.prepare() caches the compiled SQL — calling it inside a function
  // would re-compile on every invocation.
  const upsertNotesStmt = db.prepare(`
    INSERT OR REPLACE INTO notes (path, title, content, tags, related, folder, type, created, mtime, properties, leading_callout, bytes, kanban_done_lanes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const deleteFtsStmt = db.prepare(`DELETE FROM notes_fts WHERE path = ?`)
  const insertFtsStmt = db.prepare(
    `INSERT INTO notes_fts (path, title, content, metadata) VALUES (?, ?, ?, ?)`,
  )
  const removeNotesStmt = db.prepare(`DELETE FROM notes WHERE path = ?`)
  const deleteTasksStmt = db.prepare(`DELETE FROM tasks WHERE note_path = ?`)
  const insertTaskStmt = db.prepare(`
    INSERT INTO tasks (note_path, line, status_char, status, description,
      created, scheduled, start, due, done, cancelled,
      priority, recurrence, on_completion, task_id, depends_on, tags,
      block_id, heading, folder)
    VALUES (@notePath, @line, @statusChar, @status, @description,
      @created, @scheduled, @start, @due, @done, @cancelled,
      @priority, @recurrence, @onCompletion, @taskId, @dependsOn, @tags,
      @blockId, @heading, @folder)
  `)
  const deleteLinksStmt = db.prepare(`DELETE FROM links WHERE source = ?`)
  const insertLinkStmt = db.prepare(
    `INSERT OR IGNORE INTO links (source, target) VALUES (?, ?)`,
  )
  // Links whose target isn't a known note or non-md file — stored as raw text
  // because they were unresolved when indexed (e.g. a forward reference).
  // Used by both note and non-md re-resolution to find candidates to upgrade.
  const selectUnresolvedLinksStmt = db.prepare<
    unknown[],
    { source: string; target: string }
  >(
    `SELECT source, target FROM links WHERE target NOT IN (SELECT path FROM notes) AND target NOT IN (SELECT path FROM non_md_files)`,
  )
  // Upgrade one raw link to its resolved path. OR REPLACE drops a pre-existing
  // (source, resolved) row so re-resolution can't hit a PK collision.
  const updateLinkTargetStmt = db.prepare(
    `UPDATE OR REPLACE links SET target = @resolved WHERE source = @source AND target = @rawTarget`,
  )

  // ── Non-markdown file awareness ────────────────────────────────
  //
  // Obsidian resolves extensionless wikilinks (e.g. [[Trip Route]]) against
  // ALL vault files, not just .md. The non_md_files table tracks non-markdown
  // file paths so unresolved link targets can be checked against it before
  // being counted as broken. Populated during rebuildFromVault, maintained
  // incrementally by the file watcher.

  const upsertNonMdFileStmt = db.prepare(
    `INSERT OR REPLACE INTO non_md_files (path, base_path, basename, bytes) VALUES (?, ?, ?, ?)`,
  )
  const deleteNonMdFileStmt = db.prepare(
    `DELETE FROM non_md_files WHERE path = ?`,
  )
  /** Direct path match for targets that already include a non-md extension
   *  (e.g. `[[photo.png]]`, `![[diagram.svg]]`). */
  const resolveNonMdByFullPathStmt = db.prepare<[string], { path: string }>(
    `SELECT path FROM non_md_files WHERE path = ? LIMIT 1`,
  )
  /** All four base_path/basename/suffix queries use ORDER BY length(path), path
   *  so resolution is deterministic when multiple non-md files share a stem —
   *  shortest path wins, matching links.resolve's note-resolution heuristic. */
  const resolveNonMdByBasePathStmt = db.prepare<[string], { path: string }>(
    `SELECT path FROM non_md_files WHERE base_path = ? ORDER BY length(path), path LIMIT 1`,
  )
  const resolveNonMdByBasenameStmt = db.prepare<[string], { path: string }>(
    `SELECT path FROM non_md_files WHERE basename = ? ORDER BY length(path), path LIMIT 1`,
  )
  /** Suffix-path match: finds non-md files whose base_path ends with the target
   *  (preserving folder segments). Mirrors links.resolve's basename tier which
   *  checks `candidatePath.endsWith('/' + target)`. ESCAPE clause prevents `_`
   *  and `%` in the target from acting as LIKE wildcards. */
  const resolveNonMdByBasePathSuffixStmt = db.prepare<
    [string],
    { path: string }
  >(
    `SELECT path FROM non_md_files WHERE base_path LIKE '%/' || ? ESCAPE '\\' ORDER BY length(path), path LIMIT 1`,
  )
  /** Suffix match on the full stored path, for targets that include their
   *  extension — [[photo.png]] or ![img](attachments/photo.png) where the file
   *  lives in a deeper folder (Obsidian's shortest-path format). The
   *  base_path/basename columns strip the extension, so with-extension targets
   *  can only ever match the path column. Same ESCAPE rationale as above. */
  const resolveNonMdByFullPathSuffixStmt = db.prepare<
    [string],
    { path: string }
  >(
    `SELECT path FROM non_md_files WHERE path LIKE '%/' || ? ESCAPE '\\' ORDER BY length(path), path LIMIT 1`,
  )
  // ── Vector prepared statements (conditional on embedder) ──────
  const upsertChunkStmt = embedder
    ? db.prepare(
        `INSERT OR REPLACE INTO note_chunks (note_path, chunk_index, chunk_text, content_hash)
         VALUES (@note_path, @chunk_index, @chunk_text, @content_hash)`,
      )
    : null
  const selectChunkHashesStmt = embedder
    ? db.prepare<unknown[], { chunk_index: number; content_hash: string }>(
        `SELECT chunk_index, content_hash FROM note_chunks WHERE note_path = ?`,
      )
    : null
  const selectChunkIdStmt = embedder
    ? db.prepare<[string, number], { id: number }>(
        `SELECT id FROM note_chunks WHERE note_path = ? AND chunk_index = ?`,
      )
    : null
  const deleteStaleChunksStmt = embedder
    ? db.prepare(
        `DELETE FROM note_chunks WHERE note_path = ? AND chunk_index >= ?`,
      )
    : null
  const insertVectorStmt = embedder
    ? db.prepare(`INSERT INTO note_vectors (chunk_id, embedding) VALUES (?, ?)`)
    : null
  const deleteVectorByChunkIdStmt = embedder
    ? db.prepare(`DELETE FROM note_vectors WHERE chunk_id = ?`)
    : null
  const deleteVectorsForNoteStmt = embedder
    ? db.prepare(
        `DELETE FROM note_vectors WHERE chunk_id IN (SELECT id FROM note_chunks WHERE note_path = ?)`,
      )
    : null
  const deleteChunksForNoteStmt = embedder
    ? db.prepare(`DELETE FROM note_chunks WHERE note_path = ?`)
    : null
  const deleteStaleVectorsStmt = embedder
    ? db.prepare(
        `DELETE FROM note_vectors WHERE chunk_id IN (SELECT id FROM note_chunks WHERE note_path = ? AND chunk_index >= ?)`,
      )
    : null

  // ── Memory-entry prepared statements (conditional on memoryDir) ──
  const insertMemoryEntryStmt = memoryDir
    ? db.prepare(
        `INSERT INTO memory_entries (file, section, entry_date, entry_text, entry_index, content_hash)
         VALUES (@file, @section, @entry_date, @entry_text, @entry_index, @content_hash)`,
      )
    : null
  const updateMemoryEntryIndexStmt = memoryDir
    ? db.prepare(`UPDATE memory_entries SET entry_index = ? WHERE id = ?`)
    : null
  const selectMemoryEntryHashesStmt = memoryDir
    ? db.prepare<[string], { id: number; content_hash: string }>(
        `SELECT id, content_hash FROM memory_entries WHERE file = ? ORDER BY entry_index`,
      )
    : null
  const selectMemoryEntriesForFileStmt = memoryDir
    ? db.prepare<[string], { id: number; section: string; entry_text: string }>(
        `SELECT id, section, entry_text FROM memory_entries WHERE file = ?`,
      )
    : null
  const deleteMemoryEntryByIdStmt = memoryDir
    ? db.prepare(`DELETE FROM memory_entries WHERE id = ?`)
    : null
  const deleteMemoryEntriesForFileStmt = memoryDir
    ? db.prepare(`DELETE FROM memory_entries WHERE file = ?`)
    : null
  const deleteMemoryFtsForFileStmt = memoryDir
    ? db.prepare(`DELETE FROM memory_entries_fts WHERE file = ?`)
    : null
  const insertMemoryFtsStmt = memoryDir
    ? db.prepare(
        `INSERT INTO memory_entries_fts (entry_id, file, section, entry_text)
         VALUES (@entry_id, @file, @section, @entry_text)`,
      )
    : null
  const selectDistinctMemoryFilesStmt = memoryDir
    ? db.prepare<[], { file: string }>(
        `SELECT DISTINCT file FROM memory_entries`,
      )
    : null
  // Vector side — additionally requires the embedder.
  const selectUnembeddedMemoryEntriesStmt =
    memoryDir && embedder
      ? db.prepare<
          [string],
          { id: number; file: string; section: string; entry_text: string }
        >(
          `SELECT id, file, section, entry_text FROM memory_entries
           WHERE file = ? AND id NOT IN (SELECT entry_id FROM memory_entry_vectors)
           ORDER BY id`,
        )
      : null
  const insertMemoryVectorStmt =
    memoryDir && embedder
      ? db.prepare(
          `INSERT INTO memory_entry_vectors (entry_id, embedding) VALUES (?, ?)`,
        )
      : null
  const deleteMemoryVectorByEntryIdStmt =
    memoryDir && embedder
      ? db.prepare(`DELETE FROM memory_entry_vectors WHERE entry_id = ?`)
      : null
  const deleteMemoryVectorsForFileStmt =
    memoryDir && embedder
      ? db.prepare(
          `DELETE FROM memory_entry_vectors WHERE entry_id IN (SELECT id FROM memory_entries WHERE file = ?)`,
        )
      : null
  // Query side — memoryRecall's two retrieval legs plus row hydration.
  const memoryFtsSearchStmt = memoryDir
    ? db.prepare<[string], { entry_id: number }>(
        `SELECT entry_id FROM memory_entries_fts WHERE memory_entries_fts MATCH ? ORDER BY rank`,
      )
    : null
  const selectMemoryEntryByIdStmt = memoryDir
    ? db.prepare<[number], queries.MemoryEntryRow>(
        `SELECT id, file, section, entry_date, entry_text, entry_index
         FROM memory_entries WHERE id = ?`,
      )
    : null
  const memoryKnnStmt =
    memoryDir && embedder
      ? db.prepare<unknown[], queries.MemoryEntryVectorHitRow>(
          `SELECT me.id, me.file, me.section, me.entry_date, me.entry_text, me.entry_index, mev.distance
           FROM memory_entry_vectors mev
           JOIN memory_entries me ON me.id = mev.entry_id
           WHERE mev.embedding MATCH ?
             AND mev.k = ?
           ORDER BY mev.distance`,
        )
      : null

  // ── Vector query statements ─────────────────────────────────────
  /** KNN search — finds the k nearest chunks to a query embedding. */
  const knnSearchStmt = embedder
    ? db.prepare<
        unknown[],
        { note_path: string; chunk_text: string; distance: number }
      >(
        `SELECT nc.note_path, nc.chunk_text, nv.distance
         FROM note_vectors nv
         JOIN note_chunks nc ON nc.id = nv.chunk_id
         WHERE nv.embedding MATCH ?
           AND nv.k = ?
         ORDER BY nv.distance`,
      )
    : null

  /** First chunk text for a note — used by the reranker to score FTS-only
   *  results that have no vector hit. Chunk 0 contains the title + intro. */
  const selectFirstChunkStmt = embedder
    ? db.prepare<[string], { chunk_text: string }>(
        `SELECT chunk_text FROM note_chunks WHERE note_path = ? AND chunk_index = 0`,
      )
    : null

  /** Metadata lookup for notes found only via vector search. */
  const selectNoteMetadataStmt = db.prepare<[string], NoteRow>(
    `SELECT path, title, tags, related, folder, type, created, mtime,
            properties, leading_callout, bytes
     FROM notes WHERE path = ?`,
  )

  /** Resolves a wikilink target to a known non-markdown file path, or null
   *  when no match is found. Handles both extensionless targets ([[Trip Route]]
   *  → Trip Route.canvas) and explicit-extension targets ([[photo.png]],
   *  ![img](attachments/photo.png)) in every form Obsidian resolves — exact
   *  path, relative to the source note, and basename/shortest path. Mirrors
   *  links.resolve's three-tier strategy but checks against non_md_files
   *  instead of the notes table.
   *
   *  The full-filename tiers (path column) all run before any stem tier
   *  (extension-stripped base_path/basename columns). The families are
   *  NOT disjoint: a multi-dot filename's stem retains its inner dots
   *  ("photo.png.canvas" → base_path "photo.png"), so a with-extension target
   *  can stem-match a different file. Family ordering makes the full-filename
   *  match win ("photo.png" prefers a/photo.png), while the stem tiers remain
   *  the fallback so [[photo.png]] with only photo.png.canvas in the vault
   *  still resolves — mirroring Obsidian's [[Trip Route]] → Trip Route.canvas
   *  stem matching. Extensionless targets fall through the full-filename
   *  family unmatched (stored paths always carry an extension) at the cost of
   *  three query misses. */
  const resolveNonMarkdownFile = (
    target: string,
    sourcePath?: string,
  ): string | null => {
    const relativeTarget =
      sourcePath === undefined
        ? null
        : posix.join(posix.dirname(sourcePath), target)

    // ── Full-filename family: exact → relative → path suffix ──

    // Exact path match for targets that already include a non-md extension
    // (e.g. [[photo.png]], ![[diagram.svg]]).
    const fullPathMatch = resolveNonMdByFullPathStmt.get(target)
    if (fullPathMatch) return fullPathMatch.path

    // Relative-to-source match ("path from current file"), e.g.
    // ![x](../assets/photo.png).
    if (relativeTarget) {
      const relativeFullPathMatch =
        resolveNonMdByFullPathStmt.get(relativeTarget)
      if (relativeFullPathMatch) return relativeFullPathMatch.path
    }

    // Path-suffix match ("photo.png", "assets/photo.png") — Obsidian's
    // shortest-path format for assets in a deeper folder.
    const fullPathSuffixMatch = resolveNonMdByFullPathSuffixStmt.get(
      escapeLikeWildcards(target),
    )
    if (fullPathSuffixMatch) return fullPathSuffixMatch.path

    // ── Stem family: exact → relative → suffix/basename ──

    // Exact base_path match ("path from vault folder")
    const basePathMatch = resolveNonMdByBasePathStmt.get(target)
    if (basePathMatch) return basePathMatch.path

    // Relative-to-source match for extensionless targets
    // (e.g. [[../boards/Trip Route]]).
    if (relativeTarget) {
      const relativeBasePathMatch =
        resolveNonMdByBasePathStmt.get(relativeTarget)
      if (relativeBasePathMatch) return relativeBasePathMatch.path
    }

    // Basename / suffix-path match (Obsidian's shortest-path resolution).
    // When the target includes folder segments (e.g. "views/Inventory"),
    // preserve them in the match — only strip to pure basename when the
    // target is already a bare name. Mirrors links.resolve's endsWith check.
    if (target.includes("/")) {
      const basePathSuffixMatch = resolveNonMdByBasePathSuffixStmt.get(
        escapeLikeWildcards(target),
      )
      return basePathSuffixMatch?.path ?? null
    }
    const basenameMatch = resolveNonMdByBasenameStmt.get(target)
    return basenameMatch?.path ?? null
  }

  /** Indexes pre-statted non-markdown files into the non_md_files table.
   *  The caller owns entry filtering and stat (fs work stays out of the
   *  write transaction); this just writes the rows. */
  const indexNonMarkdownFiles = (
    files: ReadonlyArray<{ relativePath: string; bytes: number }>,
  ): number => {
    for (const file of files) {
      const basePath = links.stripExtension(file.relativePath)
      const baseFilename = links.stripExtension(basename(file.relativePath))
      upsertNonMdFileStmt.run(
        file.relativePath,
        basePath,
        baseFilename,
        file.bytes,
      )
    }
    return files.length
  }

  /** Adds a single non-markdown file to the index and re-resolves any
   *  unresolved links that now match it. Called by the file watcher on
   *  add/change. Mirrors the note forward-reference re-resolution pattern:
   *  updates the link target from the raw text to the resolved non-md path. */
  const upsertNonMdFile = (filePath: string, bytes: number): void => {
    const basePath = links.stripExtension(filePath)
    const baseFilename = links.stripExtension(basename(filePath))
    upsertNonMdFileStmt.run(filePath, basePath, baseFilename, bytes)

    // Re-resolve unresolved links that now match this non-md file — upgrade
    // raw targets (e.g. "Trip Route") to resolved paths ("Trip Route.canvas").
    const unresolvedLinks = selectUnresolvedLinksStmt.all()
    for (const link of unresolvedLinks) {
      const resolvedPath = resolveNonMarkdownFile(link.target, link.source)
      if (resolvedPath !== null) {
        updateLinkTargetStmt.run({
          resolved: resolvedPath,
          source: link.source,
          rawTarget: link.target,
        })
      }
    }
  }

  /** Removes a non-markdown file from the index. Called by the file watcher
   *  on unlink. Links that resolved to this file become broken automatically
   *  at query time — getOutgoingLinks shows exists: false, brokenLinkCount
   *  includes them. Same behavior as removeNote for deleted .md files. */
  const removeNonMdFile = (filePath: string): void => {
    deleteNonMdFileStmt.run(filePath)
  }

  // ── Memory-entry indexing ──────────────────────────────────────

  /** Bare memory file name ("Principles") for notes that are DIRECT children
   *  of the memory dir — the memory tool family's flat namespace, so recall
   *  output feeds straight back into vault_get_memory / vault_delete_memory.
   *  Null for every other path (nested subfolders included). */
  const memoryFileNameFromPath = (filePath: string): string | null => {
    if (memoryDir === undefined) return null
    if (!filePath.endsWith(".md")) return null
    if (posix.dirname(filePath) !== memoryDir) return null
    return basename(filePath, ".md")
  }

  /** Identity hash for one entry — NUL-delimited so field boundaries can't
   *  collide. Keyed on content, NOT position: memory appends insert at the
   *  top of a section and shift every later entry's index, so index-keyed
   *  hashes (the note_chunks pattern) would re-embed a whole file per append.
   *  The date is included (a hand-edited date is a changed entry) even though
   *  the embedding input excludes it. */
  const memoryEntryHash = (entry: MemoryEntry): string =>
    contentHash([entry.section, entry.date, entry.text].join("\u0000"))

  /** Reconciles a memory file's parsed entries against its stored rows by
   *  hash identity: unchanged entries keep their row id (and therefore their
   *  vector) while their entry_index is refreshed in place; new entries are
   *  inserted awaiting embedding; leftover rows — entries edited or pruned —
   *  are deleted along with their vectors. The FTS side is rebuilt per file
   *  (delete-then-insert, the notes_fts convention). Runs in one transaction;
   *  embedding is NOT gated on these hashes but on vector absence, so a crash
   *  between this upsert and embedMemoryEntriesForFile self-heals. */
  const upsertMemoryEntries = (
    memoryFile: string,
    noteBody: string,
    logger: Logger,
  ): void => {
    if (
      !insertMemoryEntryStmt ||
      !updateMemoryEntryIndexStmt ||
      !selectMemoryEntryHashesStmt ||
      !selectMemoryEntriesForFileStmt ||
      !deleteMemoryEntryByIdStmt ||
      !deleteMemoryFtsForFileStmt ||
      !insertMemoryFtsStmt
    ) {
      return
    }

    const parsedEntries = parseMemoryEntries(splitIntoLines(noteBody))

    db.transaction(() => {
      // Queue per hash (not a plain map): hand-edited duplicates can give two
      // entries the same hash, and each must claim its own row.
      const rowIdQueuesByHash = new Map<string, number[]>()
      for (const row of selectMemoryEntryHashesStmt.all(memoryFile)) {
        const queue = rowIdQueuesByHash.get(row.content_hash) ?? []
        queue.push(row.id)
        rowIdQueuesByHash.set(row.content_hash, queue)
      }

      // Sequential reconcile — each parsed entry claims a matching stored row
      // or inserts a new one; counters feed the summary log.
      let insertedCount = 0
      for (const entry of parsedEntries) {
        const matchingRowId = rowIdQueuesByHash
          .get(memoryEntryHash(entry))
          ?.shift()
        if (matchingRowId !== undefined) {
          updateMemoryEntryIndexStmt.run(entry.entryIndex, matchingRowId)
          continue
        }
        insertMemoryEntryStmt.run({
          file: memoryFile,
          section: entry.section,
          entry_date: entry.date,
          entry_text: entry.text,
          entry_index: entry.entryIndex,
          content_hash: memoryEntryHash(entry),
        })
        insertedCount++
      }

      // Unclaimed rows are entries that no longer exist (edited text hashes
      // differently and was inserted fresh above; pruned text just vanishes).
      let deletedCount = 0
      for (const staleRowIds of rowIdQueuesByHash.values()) {
        for (const staleRowId of staleRowIds) {
          deleteMemoryVectorByEntryIdStmt?.run(BigInt(staleRowId))
          deleteMemoryEntryByIdStmt.run(staleRowId)
          deletedCount++
        }
      }

      deleteMemoryFtsForFileStmt.run(memoryFile)
      for (const row of selectMemoryEntriesForFileStmt.all(memoryFile)) {
        insertMemoryFtsStmt.run({
          entry_id: row.id,
          file: memoryFile,
          section: row.section,
          entry_text: row.entry_text,
        })
      }

      logger.debug("indexed memory entries", {
        file: memoryFile,
        total: parsedEntries.length,
        inserted: insertedCount,
        deleted: deletedCount,
      })
    })()
  }

  /** Deletes every entry row, FTS row, and vector for one memory file. */
  const removeMemoryEntriesForFile = (memoryFile: string): void => {
    if (!deleteMemoryEntriesForFileStmt || !deleteMemoryFtsForFileStmt) return
    deleteMemoryVectorsForFileStmt?.run(memoryFile)
    deleteMemoryEntriesForFileStmt.run(memoryFile)
    deleteMemoryFtsForFileStmt.run(memoryFile)
  }

  // ── Index maintenance ──────────────────────────────────────────

  // FTS rows are managed manually (delete-then-insert) because SQLite triggers
  // combined with INSERT OR REPLACE cause FTS5 corruption.

  /** Parses a note's content and frontmatter, then indexes it for search. */
  const upsertNote = (
    params: {
      filePath: string
      rawContent: string
      fileStat: { mtimeMs: number; size: number }
      skipLinks?: boolean
    },
    logger: Logger,
  ): void => {
    const { filePath, rawContent, fileStat } = params
    const skipLinks = params.skipLinks ?? false
    const parsed = parseNote(rawContent)
    const { data: frontmatter } = parsed

    const tags = coerceToArray(frontmatter.tags)
    const related = coerceToArray(frontmatter.related)
    const bodyLines = splitIntoLines(parsed.content)

    // Store the leading callout (a top-of-file `> [!type]` block — info,
    // warning, etc.) as JSON so discovery tools can return it structured;
    // null when the note has none.
    const leadingCallout = parseLeadingCallout(bodyLines)

    // Detect Kanban done lanes for boards with kanban-plugin frontmatter.
    // The Kanban plugin marks completion lanes with a **Complete** paragraph.
    const isKanbanBoard = Boolean(frontmatter["kanban-plugin"])
    let kanbanDoneLanes: string | null = null
    if (isKanbanBoard) {
      const headings = parseHeadings(bodyLines)
      const doneLanes = tasks.extractDoneLanes(bodyLines, headings)
      kanbanDoneLanes = doneLanes.length > 0 ? JSON.stringify(doneLanes) : null
    }

    const note = {
      path: filePath,
      title: isString(frontmatter.title)
        ? frontmatter.title
        : basename(filePath, ".md"),
      content: parsed.content,
      tags: JSON.stringify(tags),
      related: JSON.stringify(related),
      folder: filePath.includes("/") ? filePath.split("/")[0] : "",
      type: isString(frontmatter.type) ? frontmatter.type : null,
      created: isString(frontmatter.created)
        ? DateTime.fromISO(frontmatter.created).toISO()
        : null,
      mtime: fileStat.mtimeMs,
      properties: JSON.stringify(frontmatter),
      leading_callout: leadingCallout ? JSON.stringify(leadingCallout) : null,
      bytes: fileStat.size,
      kanban_done_lanes: kanbanDoneLanes,
    }

    deleteFtsStmt.run(note.path)
    upsertNotesStmt.run(
      note.path,
      note.title,
      note.content,
      note.tags,
      note.related,
      note.folder,
      note.type,
      note.created,
      note.mtime,
      note.properties,
      note.leading_callout,
      note.bytes,
      note.kanban_done_lanes,
    )
    const metadataText = buildFtsMetadataText(frontmatter)
    insertFtsStmt.run(note.path, note.title, note.content, metadataText)

    // Task rows carry the full immediate-parent folder (posix dirname), unlike
    // notes.folder which stores only the first path segment — task triage
    // needs project-level attribution ("Code Projects/vault-cortex", not
    // "Code Projects").
    const taskFolder = filePath.includes("/") ? posix.dirname(filePath) : ""
    deleteTasksStmt.run(note.path)
    const extractedTasks = tasks.extractTasks(rawContent)
    for (const extractedTask of extractedTasks) {
      insertTaskStmt.run({
        notePath: note.path,
        line: extractedTask.line,
        statusChar: extractedTask.statusChar,
        status: extractedTask.status,
        description: extractedTask.description,
        created: extractedTask.createdDate,
        scheduled: extractedTask.scheduledDate,
        start: extractedTask.startDate,
        due: extractedTask.dueDate,
        done: extractedTask.doneDate,
        cancelled: extractedTask.cancelledDate,
        priority: extractedTask.priority,
        recurrence: extractedTask.recurrence,
        onCompletion: extractedTask.onCompletion,
        taskId: extractedTask.taskId,
        dependsOn: JSON.stringify(extractedTask.dependsOn),
        tags: JSON.stringify(extractedTask.tags),
        blockId: extractedTask.blockId,
        heading: extractedTask.heading,
        folder: taskFolder,
      })
    }

    // Memory files additionally maintain their entry-granular index. Placed
    // before the skipLinks return so rebuild Pass 1 covers it.
    const memoryFile = memoryFileNameFromPath(filePath)
    if (memoryFile !== null) {
      upsertMemoryEntries(memoryFile, parsed.content, logger)
    }

    logger.debug("indexed note", {
      path: note.path,
      bytes: note.bytes,
      tasksIndexed: extractedTasks.length,
    })

    if (skipLinks) return

    const allPaths = db
      .prepare<unknown[], { path: string }>("SELECT path FROM notes")
      .all()
    const pathList = allPaths.map((row) => row.path)

    deleteLinksStmt.run(note.path)
    for (const rawTarget of links.extractAll(parsed.content, frontmatter)) {
      const resolved = links.resolve(rawTarget, pathList, note.path)
      if (resolved !== null) {
        insertLinkStmt.run(note.path, resolved)
      } else {
        const resolvedNonMdPath = resolveNonMarkdownFile(rawTarget, note.path)
        insertLinkStmt.run(note.path, resolvedNonMdPath ?? rawTarget)
      }
    }

    // Re-resolve links still stored as raw text now that this note exists.
    // Re-run resolveLink with each link's own source so every form upgrades
    // uniformly — basename, full path, and source-relative ("../") — covering
    // Obsidian's "link first, create the note later" workflow.
    const unresolvedLinks = selectUnresolvedLinksStmt.all()
    for (const link of unresolvedLinks) {
      const resolved = links.resolve(link.target, pathList, link.source)
      if (resolved !== null) {
        updateLinkTargetStmt.run({
          resolved,
          source: link.source,
          rawTarget: link.target,
        })
      }
    }
  }

  // ── Embedding pipeline ─────────────────────────────────────────

  /** Chunk, hash, embed, and store vectors for a single note. Content-hash
   *  gating skips chunks whose text hasn't changed since the last embedding.
   *  Returns the number of chunks that were actually embedded (0 = all cached). */
  const embedAndStoreChunks = async (
    params: { notePath: string; rawContent: string },
    logger: Logger,
  ): Promise<number> => {
    const { notePath, rawContent } = params
    if (
      !embedder ||
      !upsertChunkStmt ||
      !selectChunkHashesStmt ||
      !selectChunkIdStmt ||
      !deleteStaleChunksStmt ||
      !insertVectorStmt ||
      !deleteVectorByChunkIdStmt
    ) {
      return 0
    }

    const parsed = parseNote(rawContent)
    const noteTitle =
      (isString(parsed.data.title) ? parsed.data.title : null) ??
      basename(notePath, ".md")
    const chunks = chunkNoteContent(noteTitle, parsed.content)

    // Load existing hashes for content-hash gating
    const existingHashes = new Map(
      selectChunkHashesStmt
        .all(notePath)
        .map((row) => [row.chunk_index, row.content_hash]),
    )

    // Counter tracking how many chunks were actually (re-)embedded — returned for logging
    let embeddedCount = 0

    for (const chunk of chunks) {
      const hash = contentHash(chunk.text)

      // Skip if content hasn't changed
      if (existingHashes.get(chunk.index) === hash) continue

      const embedding = await embedder.embedText(chunk.text)

      // Wrap the DB writes in a transaction so the content hash is never
      // saved without its corresponding vector — prevents a crash between
      // chunk upsert and vector insert from permanently marking the chunk
      // as "already embedded" while its vector is missing.
      db.transaction(() => {
        const existingChunk = selectChunkIdStmt.get(notePath, chunk.index)
        if (existingChunk) {
          deleteVectorByChunkIdStmt.run(BigInt(existingChunk.id))
        }

        upsertChunkStmt.run({
          note_path: notePath,
          chunk_index: chunk.index,
          chunk_text: chunk.text,
          content_hash: hash,
        })

        const chunkRow = selectChunkIdStmt.get(notePath, chunk.index)
        if (!chunkRow) {
          throw new Error(
            `chunk row missing after upsert: ${notePath} chunk ${String(chunk.index)}`,
          )
        }
        insertVectorStmt.run(
          BigInt(chunkRow.id),
          Buffer.from(
            embedding.buffer,
            embedding.byteOffset,
            embedding.byteLength,
          ),
        )
      })()
      embeddedCount++
    }

    // Delete stale chunks and their vectors (note now has fewer chunks than before)
    if (deleteStaleVectorsStmt) {
      deleteStaleVectorsStmt.run(notePath, chunks.length)
    }
    deleteStaleChunksStmt.run(notePath, chunks.length)

    logger.debug("embedded note", {
      path: notePath,
      totalChunks: chunks.length,
      embeddedCount,
    })
    return embeddedCount
  }

  /** How many memory entries go to the embedder per embedBatch call. Entries
   *  are uniformly short (~20–80 tokens), so padding waste inside a batch is
   *  negligible while the initial whole-corpus backfill collapses from one
   *  pipeline call per entry to one per 16. */
  const MEMORY_EMBED_BATCH_SIZE = 16

  /** Embeds every not-yet-embedded entry of one memory file. Table-driven:
   *  upsertMemoryEntries is the single parse of truth, and this reads entry
   *  texts straight from memory_entries WHERE no vector exists — gating on
   *  vector ABSENCE rather than content hashes, so a crash between upsert and
   *  embed self-heals on the next call. The embedding input prefixes the
   *  file and section name ("Agents > Communication\n...") so both the
   *  embedder and cross-encoder see which file an entry belongs to — the
   *  date is excluded (semantic noise). Returns the number embedded. */
  const embedMemoryEntriesForFile = async (
    memoryFile: string,
    logger: Logger,
  ): Promise<number> => {
    if (
      !embedder ||
      !selectUnembeddedMemoryEntriesStmt ||
      !insertMemoryVectorStmt
    ) {
      return 0
    }
    const unembeddedRows = selectUnembeddedMemoryEntriesStmt.all(memoryFile)
    if (unembeddedRows.length === 0) return 0

    for (
      let batchStart = 0;
      batchStart < unembeddedRows.length;
      batchStart += MEMORY_EMBED_BATCH_SIZE
    ) {
      const batchRows = unembeddedRows.slice(
        batchStart,
        batchStart + MEMORY_EMBED_BATCH_SIZE,
      )
      const embeddings = await embedder.embedBatch(
        batchRows.map(
          (row) => `${row.file} > ${row.section}\n${row.entry_text}`,
        ),
      )
      db.transaction(() => {
        for (const [rowIndexInBatch, row] of batchRows.entries()) {
          const embedding = embeddings[rowIndexInBatch]
          if (embedding === undefined) {
            throw new Error(
              `embedBatch returned ${String(embeddings.length)} vectors for ${String(batchRows.length)} entries`,
            )
          }
          insertMemoryVectorStmt.run(
            BigInt(row.id),
            Buffer.from(
              embedding.buffer,
              embedding.byteOffset,
              embedding.byteLength,
            ),
          )
        }
      })()
    }

    logger.debug("embedded memory entries", {
      file: memoryFile,
      embeddedCount: unembeddedRows.length,
    })
    return unembeddedRows.length
  }

  /** Embed a note's content into vector storage — section-level chunks for
   *  every note, plus entry-level vectors when the note is a memory file.
   *  No-op when the embedding pipeline is disabled (no embedder provided).
   *  Safe to call unconditionally. */
  const embedNote = async (
    params: { notePath: string; rawContent: string },
    logger: Logger,
  ): Promise<void> => {
    if (!embedder) return
    await embedAndStoreChunks(params, logger)
    const memoryFile = memoryFileNameFromPath(params.notePath)
    if (memoryFile !== null) {
      await embedMemoryEntriesForFile(memoryFile, logger)
    }
  }

  /** Removes a note from the notes table, FTS index, links, tasks, vectors,
   *  and — for memory files — the entry-granular index. A watcher rename
   *  arrives as unlink+add, so a renamed memory file behaves as delete+create:
   *  its entries re-enter as new rows and re-embed once in the background. */
  const removeNote = (filePath: string): void => {
    deleteFtsStmt.run(filePath)
    removeNotesStmt.run(filePath)
    deleteLinksStmt.run(filePath)
    deleteTasksStmt.run(filePath)
    if (deleteVectorsForNoteStmt && deleteChunksForNoteStmt) {
      deleteVectorsForNoteStmt.run(filePath)
      deleteChunksForNoteStmt.run(filePath)
    }
    const memoryFile = memoryFileNameFromPath(filePath)
    if (memoryFile !== null) {
      removeMemoryEntriesForFile(memoryFile)
    }
  }

  /** Drops the entire index and re-indexes every .md file in the vault.
   *  Returns the note count and a background embedding promise. The server
   *  can start accepting requests immediately — embedding is progressive. */
  const rebuildFromVault = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<{ count: number; embedding: Promise<void> }> => {
    const { vaultPath } = params
    db.exec("DELETE FROM notes_fts")
    db.exec("DELETE FROM notes")
    db.exec("DELETE FROM links")
    db.exec("DELETE FROM non_md_files")
    db.exec("DELETE FROM tasks")
    // Vector tables are NOT wiped — embedAndStoreChunks uses content-hash
    // gating to skip unchanged chunks, so only new/modified notes re-embed.
    // Deleted notes are cleaned up in Pass 3 before embedding starts.

    const normalizedVault = resolve(vaultPath)
    const allEntries = await readdir(vaultPath, {
      recursive: true,
      withFileTypes: true,
    })

    // Symlinks may point outside the vault (e.g. ARCHITECTURE.md →
    // ~/Code/repo/ARCHITECTURE.md) — Obsidian supports this natively, so we
    // follow suit. Only broken symlinks and non-file targets are excluded.
    const entries = await filterValidSymlinks({
      entries: allEntries,
      normalizedRoot: normalizedVault,
      logger,
    })

    // Filter directory entries to visible files of one kind (.md notes or
    // non-md assets) — shared by the notes pass and the non-md stat pass.
    const visibleFilesOfKind = (
      fileKind: "note" | "asset",
    ): { relativePath: string; absolutePath: string }[] =>
      entries.reduce<{ relativePath: string; absolutePath: string }[]>(
        (filteredFiles, directoryEntry) => {
          if (!directoryEntry.isFile() && !directoryEntry.isSymbolicLink())
            return filteredFiles
          const isNoteFile = directoryEntry.name.endsWith(".md")
          const matchesKind = fileKind === "note" ? isNoteFile : !isNoteFile
          if (!matchesKind) return filteredFiles
          const absolutePath = join(
            directoryEntry.parentPath,
            directoryEntry.name,
          )
          const relativePath = relative(normalizedVault, absolutePath)
          if (
            relativePath.split("/").some((segment) => segment.startsWith("."))
          )
            return filteredFiles
          return [...filteredFiles, { relativePath, absolutePath }]
        },
        [],
      )

    const markdownFiles = visibleFilesOfKind("note")

    // Stat non-md files before the write transaction (fs stays out of it).
    // A file vanishing between listing and stat (sync race) is dropped here
    // and re-indexed by its own watcher event.
    const nonMarkdownFileSizes = (
      await Promise.all(
        visibleFilesOfKind("asset").map(async (file) => {
          const fileStat = await statOrNull(file.absolutePath)
          if (!fileStat) return null
          return { relativePath: file.relativePath, bytes: fileStat.size }
        }),
      )
    ).filter(
      (entry): entry is { relativePath: string; bytes: number } =>
        entry !== null,
    )

    const noteContents = await Promise.all(
      markdownFiles.map(async (file) => {
        const [content, fileStat] = await Promise.all([
          readFile(file.absolutePath, "utf8"),
          stat(file.absolutePath),
        ])
        return {
          relativePath: file.relativePath,
          content,
          modifiedAtMs: fileStat.mtimeMs,
          sizeBytes: fileStat.size,
        }
      }),
    )

    // better-sqlite3: .transaction() returns a function; call it immediately
    db.transaction(() => {
      // Index non-markdown files so extensionless wikilinks to .canvas, .base,
      // etc. are recognized as asset references rather than broken note links.
      const nonMdCount = indexNonMarkdownFiles(nonMarkdownFileSizes)
      logger.debug("indexed non-md files", { count: nonMdCount })

      // Pass 1: index all notes (content, frontmatter, FTS) — skip link
      // extraction here; Pass 2 handles it with the complete path list.
      for (const note of noteContents) {
        upsertNote(
          {
            filePath: note.relativePath,
            rawContent: note.content,
            fileStat: { mtimeMs: note.modifiedAtMs, size: note.sizeBytes },
            skipLinks: true,
          },
          logger,
        )
      }

      // Entry-index reconciliation for memory files deleted while the server
      // was down: memory_entries is not wiped above (like the vector tables,
      // its rows survive on content-hash identity), so files that vanished
      // from disk leave orphaned entries the per-file upsert never touches.
      if (selectDistinctMemoryFilesStmt) {
        const memoryFilesOnDisk = new Set(
          noteContents
            .map((note) => memoryFileNameFromPath(note.relativePath))
            .filter((fileName) => fileName !== null),
        )
        const deletedMemoryFiles = selectDistinctMemoryFilesStmt
          .all()
          .map((row) => row.file)
          .filter((fileName) => !memoryFilesOnDisk.has(fileName))
        for (const deletedFile of deletedMemoryFiles) {
          removeMemoryEntriesForFile(deletedFile)
        }
        if (deletedMemoryFiles.length > 0) {
          logger.info("cleaned up entries for deleted memory files", {
            count: deletedMemoryFiles.length,
          })
        }
      }

      // Pass 2: re-extract links now that all paths are in the notes table,
      // resolving targets that the per-note upsertNote pass may have missed
      // (e.g. Note A links to Note B, but Note B was indexed after Note A).
      const allPaths = db
        .prepare<[], { path: string }>("SELECT path FROM notes")
        .all()
      const pathList = allPaths.map((row) => row.path)

      db.exec("DELETE FROM links")
      for (const note of noteContents) {
        const parsed = parseNote(note.content)
        for (const rawTarget of links.extractAll(parsed.content, parsed.data)) {
          const resolved = links.resolve(rawTarget, pathList, note.relativePath)
          if (resolved !== null) {
            insertLinkStmt.run(note.relativePath, resolved)
          } else {
            const resolvedNonMdPath = resolveNonMarkdownFile(
              rawTarget,
              note.relativePath,
            )
            insertLinkStmt.run(
              note.relativePath,
              resolvedNonMdPath ?? rawTarget,
            )
          }
        }
      }
    })()

    const totalBytes = noteContents.reduce(
      (sum, note) => sum + note.sizeBytes,
      0,
    )
    logger.info("rebuilt index", { count: noteContents.length, totalBytes })

    // Extract only what Pass 3 needs so the full noteContents array (with
    // every note's body + stats) can be garbage-collected during embedding.
    const notesForEmbedding = noteContents.map((note) => ({
      relativePath: note.relativePath,
      content: note.content,
      snapshotMtimeMs: note.modifiedAtMs,
    }))

    // Pass 3 runs in the background — the server can start accepting requests
    // immediately after FTS indexing (Passes 1+2) finishes. Embedding is a
    // progressive enhancement: search works with FTS-only until vectors are ready.
    const embeddingPromise = embedder
      ? (async () => {
          // Clean up vectors for notes that no longer exist on disk
          const currentPaths = new Set(
            notesForEmbedding.map((note) => note.relativePath),
          )
          const indexedChunkPaths = db
            .prepare<unknown[], { note_path: string }>(
              "SELECT DISTINCT note_path FROM note_chunks",
            )
            .all()
            .map((row) => row.note_path)

          const deletedPaths = indexedChunkPaths.filter(
            (path) => !currentPaths.has(path),
          )
          const hasDeletedNotes =
            deletedPaths.length > 0 &&
            deleteVectorsForNoteStmt &&
            deleteChunksForNoteStmt
          if (hasDeletedNotes) {
            for (const path of deletedPaths) {
              deleteVectorsForNoteStmt.run(path)
              deleteChunksForNoteStmt.run(path)
            }
            logger.info("cleaned up vectors for deleted notes", {
              count: deletedPaths.length,
            })
          }

          // Guard against the file watcher having processed a newer version
          // of a note (or removed it entirely) while Pass 3 was running. The
          // notes table mtime is updated by upsertNote (file watcher) and
          // removeNote deletes the row — so a mismatch or absence means this
          // snapshot entry is stale and should be skipped.
          const selectNoteMtimeStmt = db.prepare<[string], { mtime: number }>(
            "SELECT mtime FROM notes WHERE path = ?",
          )

          // Running totals accumulated across the sequential embedding loop
          let chunksEmbedded = 0
          let entriesEmbedded = 0
          let embedErrors = 0
          for (const note of notesForEmbedding) {
            const currentNote = selectNoteMtimeStmt.get(note.relativePath)
            const noteIsStale =
              !currentNote || currentNote.mtime !== note.snapshotMtimeMs
            if (noteIsStale) {
              continue
            }

            try {
              chunksEmbedded += await embedAndStoreChunks(
                { notePath: note.relativePath, rawContent: note.content },
                logger,
              )
              const memoryFile = memoryFileNameFromPath(note.relativePath)
              if (memoryFile !== null) {
                entriesEmbedded += await embedMemoryEntriesForFile(
                  memoryFile,
                  logger,
                )
              }
            } catch (err) {
              embedErrors++
              logger.warn("failed to embed note", {
                path: note.relativePath,
                error: describeError(err),
              })
            }
          }
          logger.info("embedding pass complete", {
            notes: notesForEmbedding.length,
            chunksEmbedded,
            ...(entriesEmbedded > 0 ? { entriesEmbedded } : {}),
            ...(embedErrors > 0 ? { embedErrors } : {}),
          })
        })()
      : Promise.resolve()

    // Log but don't crash on unhandled embedding errors
    embeddingPromise.catch((err) => {
      logger.error("embedding pass failed", { error: describeError(err) })
    })

    return { count: noteContents.length, embedding: embeddingPromise }
  }

  // ── Query context + delegation ───────────────────────────────

  const queryContext: queries.SearchQueryContext = {
    db,
    getDailyNotesFolder: () => dailyNotesFolder,
    vector: {
      embedder,
      knnSearchStmt,
      selectNoteMetadataStmt,
    },
    reranker,
    selectFirstChunkStmt,
    // Null when no memory dir is configured — memoryRecall rejects with a
    // remediation message. knnStmt is additionally null without an embedder
    // (lexical-only recall).
    memory:
      memoryFtsSearchStmt && selectMemoryEntryByIdStmt
        ? {
            embedder,
            ftsSearchStmt: memoryFtsSearchStmt,
            knnStmt: memoryKnnStmt,
            selectEntryByIdStmt: selectMemoryEntryByIdStmt,
          }
        : null,
  }

  /** Binds the query context as the first argument of a query function,
   *  producing the two-arg (params, logger) signature the factory exposes. */
  const bindQueryContext = <P, R>(
    fn: (context: queries.SearchQueryContext, params: P, logger: Logger) => R,
  ): ((params: P, logger: Logger) => R) => {
    return (params, logger) => fn(queryContext, params, logger)
  }

  /** Sets the daily notes folder used by brokenLinkCount and
   *  getOutgoingLinks to identify forward-reference links. Called
   *  from server.ts after reading the vault's daily notes config. */
  const setDailyNotesFolder = (folder: string): void => {
    dailyNotesFolder = folder
  }

  return {
    upsertNote,
    embedNote,
    removeNote,
    rebuildFromVault,
    upsertNonMdFile,
    removeNonMdFile,
    setDailyNotesFolder,
    fullTextSearch: bindQueryContext(queries.fullTextSearch),
    hybridSearch: bindQueryContext(queries.hybridSearch),
    memoryRecall: bindQueryContext(queries.memoryRecall),
    searchByTag: bindQueryContext(queries.searchByTag),
    searchByFolder: bindQueryContext(queries.searchByFolder),
    listTasks: bindQueryContext(queries.listTasks),
    listAllTags: bindQueryContext(queries.listAllTags),
    recentNotes: bindQueryContext(queries.recentNotes),
    listPropertyKeys: bindQueryContext(queries.listPropertyKeys),
    listPropertyValues: bindQueryContext(queries.listPropertyValues),
    searchByProperty: bindQueryContext(queries.searchByProperty),
    getBacklinks: bindQueryContext(queries.getBacklinks),
    getOutgoingLinks: bindQueryContext(queries.getOutgoingLinks),
    findOrphans: bindQueryContext(queries.findOrphans),
    brokenLinkCount: bindQueryContext(queries.brokenLinkCount),
    modifiedOnDate: bindQueryContext(queries.modifiedOnDate),
    vaultStats: bindQueryContext(queries.vaultStats),
  }
}

export type SearchIndex = ReturnType<typeof createSearchIndex>
