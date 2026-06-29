import Database from "better-sqlite3"
import { DateTime } from "luxon"
import * as sqliteVec from "sqlite-vec"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, basename, posix, relative, resolve } from "node:path"
import { logger, type Logger } from "../../logger.js"
import { parseNote } from "../obsidian-markdown/frontmatter.js"
import { parseLeadingCallout } from "../obsidian-markdown/callouts.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { links } from "../obsidian-markdown/links.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { contentHash, type Embedder } from "./embedder.js"
import { chunkNoteContent } from "./chunker.js"
import { describeError } from "../../utils/describe-error.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { filterValidSymlinks } from "../../utils/filter-valid-symlinks.js"
// ── Type guards ─────────────────────────────────────────────────

const isString = (value: unknown): value is string => typeof value === "string"

/** Coerces a YAML frontmatter field to a string array.
 *  gray-matter may parse multi-value YAML fields as a single string
 *  or an array depending on syntax (flow vs block). */
const coerceToArray = (value: unknown): string[] =>
  Array.isArray(value) ? value : value ? [String(value)] : []

// ── FTS5 query sanitization ─────────────────────────────────────

const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"])

/** One FTS5 bareword character: anything except whitespace and ASCII
 *  punctuation. Covers letters, digits, underscore, and all non-ASCII
 *  characters (FTS5 treats code points ≥ 0x80 as bareword characters). */
const BAREWORD_CHARACTER = "[^\\s!-/:-@[-^`{-~]"

/** One compound-joiner character: ASCII punctuation that glues segments of a
 *  single term together (the dot in mcpservers.org, the hyphen in
 *  vault-cortex, the slash in deploy/local). Excludes the FTS5 metacharacters
 *  " * ^ ( ) : (stripped outright, never joiners) and underscore (a bareword
 *  character). */
const COMPOUND_JOINER_CHARACTER = "[!#-'+-/;-@[-\\]`{-~]"

/** Matches compound terms — two or more bareword segments joined by
 *  punctuation — which FTS5 would otherwise reject as a syntax error
 *  (e.g. "fts5: syntax error near '.'" for mcpservers.org). */
const COMPOUND_TERM_REGEX = new RegExp(
  `${BAREWORD_CHARACTER}+(?:${COMPOUND_JOINER_CHARACTER}+${BAREWORD_CHARACTER}+)+`,
  "g",
)

/** Matches a run of joiner punctuation inside a compound term, for
 *  replacement with a single space when the compound becomes a phrase. */
const COMPOUND_JOINER_RUN_REGEX = new RegExp(
  `${COMPOUND_JOINER_CHARACTER}+`,
  "g",
)

/** Matches every ASCII punctuation character except underscore. Used as the
 *  final sweep that turns stray punctuation (word-edge dots, unbalanced
 *  quotes, lone operators) into token separators so it never reaches FTS5. */
const ASCII_PUNCTUATION_REGEX = /[!-/:-@[-^`{-~]/g

/** Sanitizes user input for safe FTS5 querying. Quoted phrases are preserved
 *  for exact-phrase matching. Punctuated compound terms (vault-cortex,
 *  mcpservers.org, deploy/local) are converted to quoted phrases for
 *  adjacent-token matching — the unicode61 tokenizer splits the indexed text
 *  at the same punctuation, so the phrase matches the original term exactly.
 *  Remaining unquoted terms are left bare to preserve porter stemming. FTS5
 *  metacharacters, stray punctuation, and reserved words are stripped, so
 *  literal text can never produce an FTS5 syntax error. */
export const sanitizeFtsQuery = (raw: string): string => {
  const phrases: string[] = []

  // Extract "quoted phrases", strip FTS5 metacharacters inside them,
  // and collect into phrases[]. Other punctuation inside quotes is left
  // alone — the unicode61 tokenizer splits it correctly in phrase queries.
  const remaining = raw.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const cleaned = phrase.replace(/[*^():]/g, "").trim()
    if (cleaned.length > 0) phrases.push(`"${cleaned}"`)
    return " "
  })

  // Convert bare punctuated compounds (vault-cortex → "vault cortex",
  // mcpservers.org → "mcpservers org") so FTS5 doesn't interpret the
  // punctuation as an operator or reject it as a syntax error.
  const afterCompounds = remaining.replace(COMPOUND_TERM_REGEX, (match) => {
    phrases.push(`"${match.replace(COMPOUND_JOINER_RUN_REGEX, " ")}"`)
    return " "
  })

  // Strip all remaining ASCII punctuation (metacharacters, word-edge dots,
  // stray/leading hyphens), split into tokens, and drop reserved words
  // (AND, OR, NOT, NEAR).
  const tokens = afterCompounds
    .replace(ASCII_PUNCTUATION_REGEX, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FTS5_RESERVED.has(t.toUpperCase()))

  const parts = [...phrases, ...tokens]
  return parts.length === 0 ? '""' : parts.join(" ")
}

// ── Types ───────────────────────────────────────────────────────

type SearchResult = {
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

type NoteMetadata = {
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

type TagCount = {
  tag: string
  count: number
}

type PropertyKeyInfo = {
  key: string
  count: number
  sample_values: string[]
}

type PropertyValueCount = {
  value: string
  count: number
}

type VaultStats = {
  totalNotes: number
  untaggedNotes: number
  noPropertiesNotes: number
}

type SearchFilters = {
  folder?: string
  tags?: string[]
  related?: string[]
  type?: string
  properties?: Record<string, string | number | boolean>
  limit?: number
  snippet_tokens?: number
  include_leading_callout?: boolean
}

type NoteRow = {
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

type BacklinkEntry = { path: string; title: string; bytes: number }

type OutgoingLinkEntry = {
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

/** A note's complete link set — body links unioned with frontmatter wikilinks,
 *  deduplicated. Single source of truth for "what does this note link to",
 *  shared by incremental upsert and full rebuild so the two can't diverge. */
const extractAllLinks = (
  content: string,
  data: Record<string, unknown>,
): string[] => [
  ...new Set([
    ...links.extractFromBody(content),
    ...links.extractFromFrontmatter(data),
  ]),
]

// ── Factory ─────────────────────────────────────────────────────

export const createSearchIndex = (dbPath: string, embedder?: Embedder) => {
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
  /** Escapes LIKE-wildcard characters (`\`, `%`, `_`) in a value so it is
   *  matched literally in a `LIKE ... ESCAPE '\'` clause. */
  const escapeLikeWildcards = (value: string): string =>
    value.replace(/[\\%_]/g, (character) => `\\${character}`)

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

  /** Flattens frontmatter into a searchable text block for the FTS metadata column.
   *  Keys are included (so "lifecycle" is findable), title is excluded (separate FTS column). */
  const buildFtsMetadataText = (
    frontmatter: Record<string, unknown>,
  ): string => {
    const lines: string[] = []
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === "title") continue
      if (value == null) continue
      if (Array.isArray(value)) {
        const primitiveElements = value
          .filter((element) => element != null && typeof element !== "object")
          .map(String)
        if (primitiveElements.length > 0) {
          lines.push(`${key}: ${primitiveElements.join(" ")}`)
        }
      } else if (typeof value !== "object") {
        lines.push(`${key}: ${String(value)}`)
      }
    }
    return lines.join("\n")
  }

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
    logger.debug("indexed note", { path: note.path, bytes: note.bytes })

    if (skipLinks) return

    const allPaths = db.prepare("SELECT path FROM notes").all() as Array<{
      path: string
    }>
    const pathList = allPaths.map((row) => row.path)

    deleteLinksStmt.run(note.path)
    for (const rawTarget of extractAllLinks(parsed.content, frontmatter)) {
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
    embedLogger: Logger,
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
        insertVectorStmt.run(BigInt(chunkRow.id), Buffer.from(embedding.buffer))
      })()
      embeddedCount++
    }

    // Delete stale chunks and their vectors (note now has fewer chunks than before)
    if (deleteStaleVectorsStmt) {
      deleteStaleVectorsStmt.run(notePath, chunks.length)
    }
    deleteStaleChunksStmt.run(notePath, chunks.length)

    embedLogger.debug("embedded note", {
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
    embedLogger: Logger,
  ): Promise<void> => {
    if (!embedder) return
    await embedAndStoreChunks(params, embedLogger)
  }

  /** Removes a note from the notes table, FTS index, links, and vectors. */
  const removeNote = (filePath: string): void => {
    deleteFtsStmt.run(filePath)
    removeNotesStmt.run(filePath)
    deleteLinksStmt.run(filePath)
    if (deleteVectorsForNoteStmt && deleteChunksForNoteStmt) {
      deleteVectorsForNoteStmt.run(filePath)
      deleteChunksForNoteStmt.run(filePath)
    }
  }

  /** Drops the entire index and re-indexes every .md file in the vault. */
  const rebuildFromVault = async (vaultPath: string): Promise<number> => {
    db.exec("DELETE FROM notes_fts")
    db.exec("DELETE FROM notes")
    db.exec("DELETE FROM links")
    db.exec("DELETE FROM non_md_files")
    if (embedder) {
      db.exec("DELETE FROM note_vectors")
      db.exec("DELETE FROM note_chunks")
    }

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
        for (const rawTarget of extractAllLinks(parsed.content, parsed.data)) {
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

    // Pass 3: embed all notes (outside the transaction — embedding is async
    // and doesn't need transactional consistency with FTS). Errors are caught
    // per-note so one bad note doesn't crash the server — FTS search still works.
    if (embedder) {
      let chunksEmbedded = 0
      let embedErrors = 0
      for (const note of noteContents) {
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
        notes: noteContents.length,
        chunksEmbedded,
        ...(embedErrors > 0 ? { embedErrors } : {}),
      })
    }

    const totalBytes = noteContents.reduce(
      (sum, note) => sum + note.sizeBytes,
      0,
    )
    logger.info("rebuilt index", { count: noteContents.length, totalBytes })
    return noteContents.length
  }

  // ── Query methods ──────────────────────────────────────────────

  /** Full-text search with BM25 ranking. Supports folder, tag, type, and property filters. */
  const fullTextSearch = (
    params: { query: string; filters?: SearchFilters },
    logger: Logger,
  ): SearchResult[] => {
    // Build WHERE clause dynamically: each filter appends a condition + its bind params
    const conditions: string[] = []
    const queryParams: unknown[] = []

    conditions.push("notes_fts MATCH ?")
    queryParams.push(sanitizeFtsQuery(params.query))

    if (params.filters?.folder) {
      conditions.push("n.path LIKE ?")
      queryParams.push(`${params.filters.folder}/%`)
    }

    if (params.filters?.tags) {
      for (const tag of params.filters.tags) {
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)",
        )
        queryParams.push(tag)
      }
    }

    if (params.filters?.related) {
      for (const relatedNote of params.filters.related) {
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(n.related) WHERE value = ?)",
        )
        queryParams.push(relatedNote)
      }
    }

    if (params.filters?.type) {
      conditions.push("n.type = ?")
      queryParams.push(params.filters.type)
    }

    if (params.filters?.properties) {
      for (const [key, value] of Object.entries(params.filters.properties)) {
        conditions.push(`json_extract(n.properties, '$.' || ?) = ?`)
        queryParams.push(key, value)
      }
    }

    const limit = params.filters?.limit ?? 20
    const snippetTokens = params.filters?.snippet_tokens ?? 30
    // Opt-in: the leading callout is omitted by default to keep this hot-path
    // result lean; callers triaging which note to open can request it.
    const includeLeadingCallout =
      params.filters?.include_leading_callout ?? false
    queryParams.push(limit)

    const sql = `
      SELECT n.path, n.title,
             snippet(notes_fts, 2, '', '', '...', ${Number(snippetTokens)}) as snippet,
             rank * -1 as score, n.tags, n.folder, n.type, n.created, n.mtime,
             n.bytes${includeLeadingCallout ? ", n.leading_callout" : ""}
      FROM notes_fts
      JOIN notes n ON n.path = notes_fts.path
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `
    // rank * -1: FTS5 rank is negative (lower = better), negated for human-friendly scoring

    try {
      const rows = db.prepare(sql).all(...queryParams) as Array<
        Pick<
          NoteRow,
          | "path"
          | "title"
          | "tags"
          | "folder"
          | "type"
          | "created"
          | "mtime"
          | "bytes"
        > & {
          snippet: string
          score: number
          leading_callout?: string | null
        }
      >

      const results: SearchResult[] = rows.map((row) => ({
        path: row.path,
        title: row.title,
        snippet: row.snippet,
        score: Number(row.score.toPrecision(4)),
        tags: JSON.parse(row.tags) as string[],
        folder: row.folder,
        type: row.type,
        ...(row.created !== null ? { created: row.created } : {}),
        modified: DateTime.fromMillis(Math.round(row.mtime)).toISO()!,
        bytes: row.bytes ?? 0,
        ...(includeLeadingCallout && row.leading_callout
          ? {
              leading_callout: JSON.parse(
                row.leading_callout,
              ) as LeadingCallout,
            }
          : {}),
      }))
      logger.info("full text search", {
        query: params.query,
        resultCount: results.length,
      })
      return results
    } catch (error) {
      logger.warn("full text search failed", {
        query: params.query,
        error: describeError(error),
      })
      return []
    }
  }

  /** Finds notes with a specific tag. Supports hierarchical prefix matching. */
  const searchByTag = (
    params: { tag: string; exactMatch?: boolean; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const limit = params.limit ?? 20

    const condition = params.exactMatch
      ? "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)"
      : "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ? OR value LIKE ? || '/%')"

    const queryParams: unknown[] = params.exactMatch
      ? [params.tag, limit]
      : [params.tag, params.tag, limit]

    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
      FROM notes n
      WHERE ${condition}
      ORDER BY mtime DESC
      LIMIT ?
    `

    const rows = db.prepare(sql).all(...queryParams) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("search by tag", {
      tag: params.tag,
      resultCount: results.length,
    })
    return results
  }

  /** Lists notes in a folder, optionally including subfolders. */
  const searchByFolder = (
    params: { folder: string; recursive?: boolean; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const recursive = params.recursive ?? true
    const limit = params.limit ?? 20

    const condition = recursive
      ? "path LIKE ? || '/%'"
      : "path LIKE ? || '/%' AND path NOT LIKE ? || '/%/%'"

    const queryParams: unknown[] = recursive
      ? [params.folder, limit]
      : [params.folder, params.folder, limit]

    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
      FROM notes
      WHERE ${condition}
      ORDER BY mtime DESC
      LIMIT ?
    `

    const rows = db.prepare(sql).all(...queryParams) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("search by folder", {
      folder: params.folder,
      resultCount: results.length,
    })
    return results
  }

  /** Returns all tags in the vault with their note counts. */
  const listAllTags = (
    _params: Record<string, never>,
    logger: Logger,
  ): TagCount[] => {
    const sql = `
      SELECT value as tag, COUNT(DISTINCT notes.path) as count
      FROM notes, json_each(notes.tags)
      GROUP BY value
      ORDER BY count DESC
    `
    const results = db.prepare(sql).all() as TagCount[]
    logger.info("listed all tags", { count: results.length })
    return results
  }

  /** Returns recently modified or created notes, sorted by chosen timestamp. */
  const recentNotes = (
    params: { sort_by?: "created" | "modified"; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const sortBy = params.sort_by ?? "modified"
    const limit = params.limit ?? 20

    // "created IS NULL" sorts NULLs last in a DESC ordering (SQLite evaluates 0/1)
    const orderClause =
      sortBy === "created"
        ? "ORDER BY created IS NULL, created DESC"
        : "ORDER BY mtime DESC" // SQL column is still `mtime`

    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
      FROM notes
      ${orderClause}
      LIMIT ?
    `

    const rows = db.prepare(sql).all(limit) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("recent notes", { sortBy, resultCount: results.length })
    return results
  }

  /** Returns all frontmatter property keys with note counts and top 3 sample values. */
  const listPropertyKeys = (
    params: { folder?: string },
    logger: Logger,
  ): PropertyKeyInfo[] => {
    const folderCondition = params.folder
      ? "WHERE n.path LIKE @folder || '/%'"
      : ""

    const keySql = `
      SELECT property.key, COUNT(DISTINCT n.path) as count
      FROM notes n, json_each(n.properties) property
      ${folderCondition}
      GROUP BY property.key
      ORDER BY count DESC
    `
    const keySqlParams: Record<string, string> = {}
    if (params.folder) keySqlParams.folder = params.folder
    const keyRows = db.prepare(keySql).all(keySqlParams) as Array<{
      key: string
      count: number
    }>

    const sampleFolderCondition = params.folder
      ? "AND path LIKE @folder || '/%'"
      : ""

    // For each key, fetch the 3 most common values as samples.
    // json_array() wraps scalars so json_each works uniformly for
    // both scalar ("active") and array (["a","b"]) property values.
    const sampleSql = `
      SELECT element.value, COUNT(*) as count
      FROM (
        SELECT properties FROM notes
        WHERE json_type(properties, '$.' || @key) IS NOT NULL
        ${sampleFolderCondition}
      ) filtered, json_each(
        CASE json_type(filtered.properties, '$.' || @key)
          WHEN 'array' THEN json_extract(filtered.properties, '$.' || @key)
          ELSE json_array(json_extract(filtered.properties, '$.' || @key))
        END
      ) element
      WHERE typeof(element.value) IN ('text', 'integer', 'real')
      GROUP BY element.value
      ORDER BY count DESC
      LIMIT 3
    `
    const sampleStmt = db.prepare(sampleSql)

    const results: PropertyKeyInfo[] = keyRows.map((keyRow) => {
      const sqlParams: Record<string, string> = { key: keyRow.key }
      if (params.folder) sqlParams.folder = params.folder
      const sampleRows = sampleStmt.all(sqlParams) as Array<{
        value: string
      }>
      return {
        key: keyRow.key,
        count: keyRow.count,
        sample_values: sampleRows.map((sampleRow) => String(sampleRow.value)),
      }
    })

    logger.info("listed property keys", { count: results.length })
    return results
  }

  /** Returns distinct values for a given property key with note counts. */
  const listPropertyValues = (
    params: { key: string; folder?: string; limit?: number },
    logger: Logger,
  ): PropertyValueCount[] => {
    const limit = params.limit ?? 50
    const folderCondition = params.folder ? "AND path LIKE @folder || '/%'" : ""

    // json_array() wraps scalars so json_each works uniformly for
    // both scalar ("active") and array (["a","b"]) property values.
    const sql = `
      SELECT element.value, COUNT(*) as count
      FROM (
        SELECT properties FROM notes
        WHERE json_type(properties, '$.' || @key) IS NOT NULL
        ${folderCondition}
      ) filtered, json_each(
        CASE json_type(filtered.properties, '$.' || @key)
          WHEN 'array' THEN json_extract(filtered.properties, '$.' || @key)
          ELSE json_array(json_extract(filtered.properties, '$.' || @key))
        END
      ) element
      WHERE typeof(element.value) IN ('text', 'integer', 'real')
      GROUP BY element.value
      ORDER BY count DESC
      LIMIT @limit
    `

    const sqlParams: Record<string, unknown> = { key: params.key, limit }
    if (params.folder) sqlParams.folder = params.folder

    const rows = db.prepare(sql).all(sqlParams) as Array<{
      value: string | number
      count: number
    }>
    const results = rows.map((row) => ({
      value: String(row.value),
      count: row.count,
    }))
    logger.info("listed property values", {
      key: params.key,
      count: results.length,
    })
    return results
  }

  /** Finds notes where a frontmatter property matches a value (exact match). */
  const searchByProperty = (
    params: { key: string; value: string; folder?: string; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const limit = params.limit ?? 20
    const folderCondition = params.folder
      ? "AND n.path LIKE @folder || '/%'"
      : ""

    // Two branches handle different property shapes:
    // - Array properties (tags: ["a","b"]): check if @value is IN the array
    // - Scalar properties (status: "active"): check direct equality
    // Both branches CAST to TEXT for type-safe comparison (integer 4 = text "4")
    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
      FROM notes n
      WHERE (
        (json_type(n.properties, '$.' || @key) = 'array'
         AND EXISTS (
           SELECT 1 FROM json_each(json_extract(n.properties, '$.' || @key))
           WHERE CAST(value AS TEXT) = @value
         ))
        OR
        (json_type(n.properties, '$.' || @key) IS NOT NULL
         AND json_type(n.properties, '$.' || @key) != 'array'
         AND CAST(json_extract(n.properties, '$.' || @key) AS TEXT) = @value)
      )
      ${folderCondition}
      ORDER BY mtime DESC
      LIMIT @limit
    `

    const sqlParams: Record<string, unknown> = {
      key: params.key,
      value: params.value,
      limit,
    }
    if (params.folder) sqlParams.folder = params.folder

    const rows = db.prepare(sql).all(sqlParams) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("search by property", {
      key: params.key,
      value: params.value,
      resultCount: results.length,
    })
    return results
  }

  // ── Link queries ────────────────────────────────────────────────

  /** Returns notes that link TO the given path (incoming links / backlinks). */
  const getBacklinks = (
    params: { path: string },
    logger: Logger,
  ): BacklinkEntry[] => {
    assertPathHasExtension(params.path, ".md")
    const sql = `
      SELECT n.path, n.title, n.bytes
      FROM links l
      JOIN notes n ON n.path = l.source
      WHERE l.target = ?
      ORDER BY n.title
    `
    const rows = db.prepare(sql).all(params.path) as Array<{
      path: string
      title: string
      bytes: number
    }>
    const results: BacklinkEntry[] = rows.map((row) => ({
      path: row.path,
      title: row.title,
      bytes: row.bytes ?? 0,
    }))
    logger.info("get backlinks", {
      path: params.path,
      count: results.length,
    })
    return results
  }

  /** Returns notes and assets that the given path links TO (outgoing links).
   *  Each entry carries a `kind` discriminator: "note" for .md targets,
   *  "asset" for resolved non-markdown files (.canvas, .base, images, etc.),
   *  defaulting to "note" for unresolved (broken) links. */
  const getOutgoingLinks = (
    params: { path: string },
    logger: Logger,
  ): OutgoingLinkEntry[] => {
    assertPathHasExtension(params.path, ".md")
    const sql = `
      SELECT l.target as path,
             n.title,
             CASE WHEN n.path IS NOT NULL THEN 1
                  WHEN f.path IS NOT NULL THEN 1
                  ELSE 0 END as exists_flag,
             CASE WHEN n.path IS NOT NULL THEN 'note'
                  WHEN f.path IS NOT NULL THEN 'asset'
                  ELSE 'note' END as kind,
             n.bytes
      FROM links l
      LEFT JOIN notes n ON n.path = l.target
      LEFT JOIN non_md_files f ON f.path = l.target
      WHERE l.source = ?
      ORDER BY l.target
    `
    const rows = db.prepare(sql).all(params.path) as Array<{
      path: string
      title: string | null
      exists_flag: number
      kind: "note" | "asset"
      bytes: number | null
    }>
    // Snapshot the closure `let` so TypeScript can narrow it in the callback
    const folder = dailyNotesFolder
    const folderPrefix = folder !== null ? `${folder}/` : null
    const results: OutgoingLinkEntry[] = rows.map((row) => ({
      path: row.path,
      title: row.title,
      exists: row.exists_flag === 1,
      kind: row.kind,
      bytes: row.bytes ?? null,
      daily_note_forward_ref:
        row.exists_flag === 0 &&
        folderPrefix !== null &&
        row.path.startsWith(folderPrefix),
    }))
    logger.info("get outgoing links", {
      path: params.path,
      count: results.length,
    })
    return results
  }

  /** Finds notes with no incoming links (orphans). */
  const findOrphans = (
    params: { excludeFolders?: string[]; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const excludeFolders = params.excludeFolders ?? []
    const limit = params.limit ?? 50

    // One exclusion clause per folder, each bound to a positional parameter
    const folderExclusions = Array(excludeFolders.length)
      .fill("path NOT LIKE ? || '/%'")
      .join(" AND ")
    const whereClause =
      excludeFolders.length > 0 ? `AND ${folderExclusions}` : ""

    // Self-links (source = target) are excluded from the backlink subquery
    // so a note that only links to itself is still considered an orphan.
    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
      FROM notes
      WHERE path NOT IN (SELECT DISTINCT target FROM links WHERE source != target)
        ${whereClause}
      ORDER BY mtime DESC
      LIMIT ?
    `

    const rows = db.prepare(sql).all(...excludeFolders, limit) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("find orphans", { count: results.length })
    return results
  }

  // ── Aggregate queries ──────────────────────────────────────────

  type BrokenLinkResult = {
    count: number
    excludedFolder: string | null
    excludedCount: number
  }

  /** Counts unique broken link targets — links whose targets exist in
   *  neither the notes table nor the non_md_files table. When a daily
   *  notes folder is configured, broken links under that folder are
   *  excluded — they are forward-references (intentional "create on
   *  click" navigation), not genuinely broken. Returns the count plus
   *  exclusion metadata so callers can communicate what was filtered. */
  const brokenLinkCount = (
    _params: Record<string, never>,
    logger: Logger,
  ): BrokenLinkResult => {
    // Snapshot the closure `let` so TypeScript can narrow it after the null check
    const folder = dailyNotesFolder

    if (folder === null) {
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT target) as count
           FROM links
           WHERE target NOT IN (SELECT path FROM notes)
             AND target NOT IN (SELECT path FROM non_md_files)`,
        )
        .get() as { count: number }
      logger.info("broken link count", { count: row.count })
      return { count: row.count, excludedFolder: null, excludedCount: 0 }
    }

    const folderPrefix = `${folder}/`
    const brokenTargets = db
      .prepare(
        `SELECT DISTINCT target
         FROM links
         WHERE target NOT IN (SELECT path FROM notes)
           AND target NOT IN (SELECT path FROM non_md_files)`,
      )
      .all() as Array<{ target: string }>

    const count = brokenTargets.filter(
      (row) => !row.target.startsWith(folderPrefix),
    ).length
    const excludedCount = brokenTargets.length - count

    logger.info("broken link count", {
      count,
      dailyNotesFolder: folder,
      excludedForwardRefs: excludedCount,
    })
    return { count, excludedFolder: folder, excludedCount }
  }

  /** Returns notes whose filesystem mtime falls within a calendar date
   *  (server-local day boundaries, governed by the TZ env var). */
  const modifiedOnDate = (
    params: { date: string; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const limit = params.limit ?? 50
    const dayStart = DateTime.fromISO(params.date)
    const dayEnd = dayStart.plus({ days: 1 })

    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
      FROM notes
      WHERE mtime >= ? AND mtime < ?
      ORDER BY mtime DESC
      LIMIT ?
    `
    const rows = db
      .prepare(sql)
      .all(dayStart.toMillis(), dayEnd.toMillis(), limit) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("modified on date", {
      date: params.date,
      resultCount: results.length,
    })
    return results
  }

  /** Lightweight aggregate counts — total notes, untagged notes, notes without
   *  frontmatter properties. Single SQL to avoid multiple round-trips. */
  const vaultStats = (
    _params: Record<string, never>,
    logger: Logger,
  ): VaultStats => {
    // Conditional aggregation: count all rows, then conditionally count rows
    // whose tags/properties are the empty-JSON sentinel set by upsertNote.
    const sql = `
      SELECT
        COUNT(*) as totalNotes,
        COALESCE(SUM(CASE WHEN tags = '[]' THEN 1 ELSE 0 END), 0) as untaggedNotes,
        COALESCE(SUM(CASE WHEN properties = '{}' THEN 1 ELSE 0 END), 0) as noPropertiesNotes
      FROM notes
    `
    const row = db.prepare(sql).get() as VaultStats
    logger.info("vault stats", row)
    return row
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
    fullTextSearch,
    searchByTag,
    searchByFolder,
    listAllTags,
    recentNotes,
    listPropertyKeys,
    listPropertyValues,
    searchByProperty,
    getBacklinks,
    getOutgoingLinks,
    findOrphans,
    brokenLinkCount,
    modifiedOnDate,
    vaultStats,
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/** Transforms a raw SQLite row (JSON strings) into a typed NoteMetadata object. */
const rowToMetadata = (row: NoteRow): NoteMetadata => ({
  path: row.path,
  title: row.title,
  tags: JSON.parse(row.tags) as string[],
  related: JSON.parse(row.related) as string[],
  folder: row.folder,
  type: row.type,
  created: row.created,
  modified: DateTime.fromMillis(Math.round(row.mtime)).toISO()!,
  bytes: row.bytes ?? 0,
  properties: JSON.parse(row.properties) as Record<string, unknown>,
  leading_callout: row.leading_callout
    ? (JSON.parse(row.leading_callout) as LeadingCallout)
    : null,
})

export type SearchIndex = ReturnType<typeof createSearchIndex>
