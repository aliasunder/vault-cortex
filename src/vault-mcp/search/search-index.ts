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
import { tasks } from "../obsidian-markdown/tasks.js"
import type { TaskPriority, TaskStatus } from "../obsidian-markdown/tasks.js"
import { contentHash, type Embedder } from "./embedder.js"
import type { Reranker } from "./reranker.js"
import { chunkNoteContent } from "./chunker.js"
import { describeError } from "../../utils/describe-error.js"
import { filterValidSymlinks } from "../../utils/filter-valid-symlinks.js"
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
  folder?: string
  tags?: string[]
  related?: string[]
  type?: string
  properties?: Record<string, string | number | boolean>
  limit?: number
  snippet_tokens?: number
  include_leading_callout?: boolean
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
}

/** Status filter vocabulary for listTasks. "not_done" (the default) covers
 *  todo + in_progress — the Tasks plugin's own `not done` semantics, which
 *  exclude cancelled tasks. */
export type TaskStatusFilter =
  | "not_done"
  | "todo"
  | "in_progress"
  | "done"
  | "cancelled"
  | "all"

/** Date bounds for one task date field. before/after are exclusive and on is
 *  an exact match — the Tasks plugin's query vocabulary. Dates are
 *  YYYY-MM-DD, so bounds compare lexicographically. */
export type TaskDateFilter = { before?: string; on?: string; after?: string }

/** Priority filter value — the five explicit levels plus "none" for tasks
 *  with no priority signifier. */
export type TaskPriorityFilter = TaskPriority | "none"

/** Sort keys for listTasks. The five task dates and priority sort on the
 *  task's own metadata; note_mtime sorts on the owning note's modified time. */
export type TaskSortKey =
  | "due"
  | "scheduled"
  | "start"
  | "created"
  | "done"
  | "priority"
  | "note_mtime"

export type ListTasksResult = { total: number; tasks: TaskEntry[] }

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
//      links ([text](path.md)) from the note body (skipping fenced code
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
) => {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  sqliteVec.load(db)

  // FTS5 doesn't support ALTER TABLE ADD COLUMN. When opening a warm database
  // that lacks the metadata column, drop the table so the CREATE below rebuilds
  // it with the new schema. rebuildFromVault repopulates on every startup.
  const ftsColumns = db.prepare("PRAGMA table_info(notes_fts)").all() as Array<{
    name: string
  }>
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
      basename  TEXT NOT NULL
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

  // CREATE TABLE IF NOT EXISTS is a no-op on a pre-existing DB file, so a warm
  // database from before the `leading_callout` column was added would lack it
  // (and the upsert below would throw). Add it idempotently when absent. The
  // column is not FTS-indexed — the callout text already lives in `content`, so
  // it's searchable; this column only stores the parsed block for cheap retrieval.
  const noteColumns = db.prepare(`PRAGMA table_info(notes)`).all() as Array<{
    name: string
  }>
  if (!noteColumns.some((column) => column.name === "leading_callout")) {
    db.exec(`ALTER TABLE notes ADD COLUMN leading_callout TEXT`)
  }
  if (!noteColumns.some((column) => column.name === "bytes")) {
    db.exec(`ALTER TABLE notes ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`)
  }

  // Daily notes folder for forward-ref exclusion — broken links under
  // this folder are treated as intentional "create on click" navigation.
  // Set via setDailyNotesFolder from server.ts config; null until then.
  let dailyNotesFolder: string | null = null

  // Prepared statements are compiled once here and reused across all calls.
  // db.prepare() caches the compiled SQL — calling it inside a function
  // would re-compile on every invocation.
  const upsertNotesStmt = db.prepare(`
    INSERT OR REPLACE INTO notes (path, title, content, tags, related, folder, type, created, mtime, properties, leading_callout, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const selectUnresolvedLinksStmt = db.prepare(
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
    `INSERT OR REPLACE INTO non_md_files (path, base_path, basename) VALUES (?, ?, ?)`,
  )
  const deleteNonMdFileStmt = db.prepare(
    `DELETE FROM non_md_files WHERE path = ?`,
  )
  /** Direct path match for targets that already include a non-md extension
   *  (e.g. `[[photo.png]]`, `![[diagram.svg]]`). */
  const resolveNonMdByFullPathStmt = db.prepare(
    `SELECT path FROM non_md_files WHERE path = ? LIMIT 1`,
  )
  /** All three base_path/basename/suffix queries use ORDER BY length(path), path
   *  so resolution is deterministic when multiple non-md files share a stem —
   *  shortest path wins, matching links.resolve's note-resolution heuristic. */
  const resolveNonMdByBasePathStmt = db.prepare(
    `SELECT path FROM non_md_files WHERE base_path = ? ORDER BY length(path), path LIMIT 1`,
  )
  const resolveNonMdByBasenameStmt = db.prepare(
    `SELECT path FROM non_md_files WHERE basename = ? ORDER BY length(path), path LIMIT 1`,
  )
  /** Suffix-path match: finds non-md files whose base_path ends with the target
   *  (preserving folder segments). Mirrors links.resolve's basename tier which
   *  checks `candidatePath.endsWith('/' + target)`. ESCAPE clause prevents `_`
   *  and `%` in the target from acting as LIKE wildcards. */
  const resolveNonMdBySuffixPathStmt = db.prepare(
    `SELECT path FROM non_md_files WHERE base_path LIKE '%/' || ? ESCAPE '\\' ORDER BY length(path), path LIMIT 1`,
  )
  // ── Vector prepared statements (conditional on embedder) ──────
  const upsertChunkStmt = embedder
    ? db.prepare(
        `INSERT OR REPLACE INTO note_chunks (note_path, chunk_index, chunk_text, content_hash)
         VALUES (@note_path, @chunk_index, @chunk_text, @content_hash)`,
      )
    : null
  const selectChunkHashesStmt = embedder
    ? db.prepare(
        `SELECT chunk_index, content_hash FROM note_chunks WHERE note_path = ?`,
      )
    : null
  const selectChunkIdStmt = embedder
    ? db.prepare(
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

  // ── Vector query statements ─────────────────────────────────────
  /** KNN search — finds the k nearest chunks to a query embedding. */
  const knnSearchStmt = embedder
    ? db.prepare(
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

  /** Strips the file extension from a path, or returns the path unchanged if
   *  it has no extension. Uses the last dot in the filename (not the path). */
  const stripExtension = (filePath: string): string => {
    const fileName = basename(filePath)
    const dotIndex = fileName.lastIndexOf(".")
    if (dotIndex <= 0) return filePath
    return filePath.slice(0, filePath.length - (fileName.length - dotIndex))
  }

  /** Resolves a wikilink target to a known non-markdown file path, or null
   *  when no match is found. Handles both extensionless targets ([[Trip Route]]
   *  → Trip Route.canvas) and explicit-extension targets ([[photo.png]] →
   *  photo.png). Mirrors links.resolve's three-tier strategy but checks against
   *  non_md_files instead of the notes table. */
  const resolveNonMarkdownFile = (
    target: string,
    sourcePath?: string,
  ): string | null => {
    // Full-path match for targets that already include a non-md extension
    // (e.g. [[photo.png]], ![[diagram.svg]]). Checked first because the
    // base_path column strips the extension, so "photo.png" wouldn't match
    // base_path "photo".
    const fullPathMatch = resolveNonMdByFullPathStmt.get(target) as
      | { path: string }
      | undefined
    if (fullPathMatch) return fullPathMatch.path

    // Exact base_path match ("path from vault folder")
    const exactMatch = resolveNonMdByBasePathStmt.get(target) as
      | { path: string }
      | undefined
    if (exactMatch) return exactMatch.path

    // Relative-to-source match ("path from current file")
    if (sourcePath) {
      const relativeTarget = posix.join(posix.dirname(sourcePath), target)
      const relativeMatch = resolveNonMdByBasePathStmt.get(relativeTarget) as
        | { path: string }
        | undefined
      if (relativeMatch) return relativeMatch.path
    }

    // Basename / suffix-path match (Obsidian's shortest-path resolution).
    // When the target includes folder segments (e.g. "views/Inventory"),
    // preserve them in the match — only strip to pure basename when the
    // target is already a bare name. Mirrors links.resolve's endsWith check.
    if (target.includes("/")) {
      const suffixMatch = resolveNonMdBySuffixPathStmt.get(
        escapeLikeWildcards(target),
      ) as { path: string } | undefined
      return suffixMatch?.path ?? null
    }
    const basenameMatch = resolveNonMdByBasenameStmt.get(target) as
      | { path: string }
      | undefined
    return basenameMatch?.path ?? null
  }

  /** Indexes non-markdown files from a directory listing into the
   *  non_md_files table. Skips hidden directories (same filter as notes). */
  const indexNonMarkdownFiles = (
    entries: ReadonlyArray<{
      isFile: () => boolean
      isSymbolicLink: () => boolean
      name: string
      parentPath: string
    }>,
    normalizedVault: string,
  ): number => {
    // Counter incremented per non-md file upserted — returned to caller for logging
    let filesIndexed = 0
    for (const directoryEntry of entries) {
      if (
        (!directoryEntry.isFile() && !directoryEntry.isSymbolicLink()) ||
        directoryEntry.name.endsWith(".md")
      )
        continue
      const absolutePath = join(directoryEntry.parentPath, directoryEntry.name)
      const relativePath = relative(normalizedVault, absolutePath)
      if (relativePath.split("/").some((segment) => segment.startsWith(".")))
        continue
      const basePath = stripExtension(relativePath)
      const baseFilename = stripExtension(directoryEntry.name)
      upsertNonMdFileStmt.run(relativePath, basePath, baseFilename)
      filesIndexed += 1
    }
    return filesIndexed
  }

  /** Adds a single non-markdown file to the index and re-resolves any
   *  unresolved links that now match it. Called by the file watcher on
   *  add/change. Mirrors the note forward-reference re-resolution pattern:
   *  updates the link target from the raw text to the resolved non-md path. */
  const upsertNonMdFile = (filePath: string): void => {
    const basePath = stripExtension(filePath)
    const baseFilename = stripExtension(basename(filePath))
    upsertNonMdFileStmt.run(filePath, basePath, baseFilename)

    // Re-resolve unresolved links that now match this non-md file — upgrade
    // raw targets (e.g. "Trip Route") to resolved paths ("Trip Route.canvas").
    const unresolvedLinks = selectUnresolvedLinksStmt.all() as Array<{
      source: string
      target: string
    }>
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
    // Store the leading callout (a top-of-file `> [!type]` block — info,
    // warning, etc.) as JSON so discovery tools can return it structured;
    // null when the note has none.
    const leadingCallout = parseLeadingCallout(splitIntoLines(parsed.content))

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

    logger.debug("indexed note", {
      path: note.path,
      bytes: note.bytes,
      tasksIndexed: extractedTasks.length,
    })

    if (skipLinks) return

    const allPaths = db.prepare("SELECT path FROM notes").all() as Array<{
      path: string
    }>
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
    const unresolvedLinks = selectUnresolvedLinksStmt.all() as Array<{
      source: string
      target: string
    }>
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
      (
        selectChunkHashesStmt.all(notePath) as Array<{
          chunk_index: number
          content_hash: string
        }>
      ).map((row) => [row.chunk_index, row.content_hash]),
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
        const existingChunk = selectChunkIdStmt.get(notePath, chunk.index) as
          | { id: number }
          | undefined
        if (existingChunk) {
          deleteVectorByChunkIdStmt.run(BigInt(existingChunk.id))
        }

        upsertChunkStmt.run({
          note_path: notePath,
          chunk_index: chunk.index,
          chunk_text: chunk.text,
          content_hash: hash,
        })

        const chunkRow = selectChunkIdStmt.get(notePath, chunk.index) as {
          id: number
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

  /** Embed a note's content into vector storage. No-op when the embedding
   *  pipeline is disabled (no embedder provided). Safe to call unconditionally. */
  const embedNote = async (
    params: { notePath: string; rawContent: string },
    logger: Logger,
  ): Promise<void> => {
    if (!embedder) return
    await embedAndStoreChunks(params, logger)
  }

  /** Removes a note from the notes table, FTS index, links, tasks, and
   *  vectors. */
  const removeNote = (filePath: string): void => {
    deleteFtsStmt.run(filePath)
    removeNotesStmt.run(filePath)
    deleteLinksStmt.run(filePath)
    deleteTasksStmt.run(filePath)
    if (deleteVectorsForNoteStmt && deleteChunksForNoteStmt) {
      deleteVectorsForNoteStmt.run(filePath)
      deleteChunksForNoteStmt.run(filePath)
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

    // Filter directory entries to visible .md files, then load their content
    const markdownFiles = entries.reduce<
      { relativePath: string; absolutePath: string }[]
    >((filteredFiles, directoryEntry) => {
      if (
        (!directoryEntry.isFile() && !directoryEntry.isSymbolicLink()) ||
        !directoryEntry.name.endsWith(".md")
      )
        return filteredFiles
      const absolutePath = join(directoryEntry.parentPath, directoryEntry.name)
      const relativePath = relative(normalizedVault, absolutePath)
      if (relativePath.split("/").some((segment) => segment.startsWith(".")))
        return filteredFiles
      return [...filteredFiles, { relativePath, absolutePath }]
    }, [])

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
      const nonMdCount = indexNonMarkdownFiles(entries, normalizedVault)
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

      // Pass 2: re-extract links now that all paths are in the notes table,
      // resolving targets that the per-note upsertNote pass may have missed
      // (e.g. Note A links to Note B, but Note B was indexed after Note A).
      const allPaths = db.prepare("SELECT path FROM notes").all() as Array<{
        path: string
      }>
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
          const indexedChunkPaths = (
            db
              .prepare("SELECT DISTINCT note_path FROM note_chunks")
              .all() as Array<{ note_path: string }>
          ).map((row) => row.note_path)

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
          const selectNoteMtimeStmt = db.prepare(
            "SELECT mtime FROM notes WHERE path = ?",
          )

          // Running totals accumulated across the sequential embedding loop
          let chunksEmbedded = 0
          let embedErrors = 0
          for (const note of notesForEmbedding) {
            const currentNote = selectNoteMtimeStmt.get(note.relativePath) as
              | { mtime: number }
              | undefined
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
