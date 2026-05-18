import Database from "better-sqlite3"
import matter from "gray-matter"
import { DateTime } from "luxon"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, basename, relative, resolve } from "node:path"
import { logger, type Logger } from "../../logger.js"

// ── Type guards ─────────────────────────────────────────────────

const isString = (value: unknown): value is string => typeof value === "string"

const isDate = (value: unknown): value is Date => value instanceof Date

/** Converts Date instances in frontmatter to ISO date strings (YYYY-MM-DD)
 *  before JSON.stringify, preventing gray-matter's YAML 1.1 Date parsing
 *  from producing full ISO timestamps in the properties column. */
const convertFrontmatterDatesToIsoStrings = (
  data: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      isDate(value)
        ? DateTime.fromJSDate(value, { zone: "utc" }).toFormat("yyyy-MM-dd")
        : value,
    ]),
  )

// ── FTS5 query sanitization ─────────────────────────────────────

const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"])

/** Matches hyphenated compound terms (e.g. vault-cortex, self-hosted-app)
 *  where at least two word segments are joined by hyphens. */
const HYPHENATED_COMPOUND_REGEX = /\b(\w+(?:-\w+)+)\b/g

/** Sanitizes user input for safe FTS5 querying. Quoted phrases are preserved
 *  for exact-phrase matching. Hyphenated compound terms (e.g. vault-cortex)
 *  are converted to quoted phrases for adjacent-token matching. Remaining
 *  unquoted terms are left bare to preserve porter stemming. FTS5
 *  metacharacters and reserved words are stripped. */
export const sanitizeFtsQuery = (raw: string): string => {
  const phrases: string[] = []

  // Extract "quoted phrases", strip FTS5 metacharacters inside them,
  // and collect into phrases[]. Hyphens inside quotes are left alone —
  // the unicode61 tokenizer splits them correctly in phrase queries.
  const remaining = raw.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const cleaned = phrase.replace(/[*^():]/g, "").trim()
    if (cleaned.length > 0) phrases.push(`"${cleaned}"`)
    return " "
  })

  // Convert bare hyphenated compounds (vault-cortex → "vault cortex")
  // so FTS5 doesn't interpret the hyphen as the NOT operator.
  const afterHyphens = remaining.replace(HYPHENATED_COMPOUND_REGEX, (match) => {
    phrases.push(`"${match.replace(/-/g, " ")}"`)
    return " "
  })

  // Strip remaining FTS5 metacharacters (including stray/leading hyphens),
  // split into tokens, and drop reserved words (AND, OR, NOT, NEAR).
  const tokens = afterHyphens
    .replace(/["*^():-]/g, " ")
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
  properties: Record<string, unknown>
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

type SearchFilters = {
  folder?: string
  tags?: string[]
  related?: string[]
  type?: string
  properties?: Record<string, string | number | boolean>
  limit?: number
  snippet_tokens?: number
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
}

type BacklinkEntry = { path: string; title: string }

type OutgoingLinkEntry = {
  path: string
  title: string | null
  exists: boolean
}

// ── Link extraction ─────────────────────────────────────────────
//
// Links between notes are tracked in a `links` table (source → target)
// to power backlink queries, outgoing link lookups, and orphan detection.
//
// Indexing flow:
//   1. extractLinks() parses wikilinks ([[target]]) and markdown links
//      ([text](path.md)) from note body, skipping fenced code blocks
//      and inline code spans.
//   2. resolveLink() maps each raw target to a vault-relative path by
//      trying exact match → basename match → shortest-path heuristic.
//   3. upsertNote stores resolved links in the `links` table. Unresolved
//      targets are stored as-is (raw text) for broken-link detection.
//   4. When a new note is created, upsertNote re-resolves any stale
//      unresolved targets that now match the new note's path or basename
//      (handles Obsidian's "link first, create later" workflow).
//   5. rebuildFromVault uses a two-pass approach: Pass 1 indexes all
//      notes without links (skipLinks), Pass 2 extracts links with the
//      complete path list so all targets can resolve.

/** Matches fenced code block openers: 0-3 spaces indent + 3+ backticks or tildes (CommonMark §4.5). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/** Matches wikilinks: [[target]], [[target|text]], [[target#heading]],
 *  [[target#heading|text]], and embeds ![[target]]. Captures the
 *  target path/name (group 1) before any # or |. */
const WIKILINK_RE = /!?\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g

/** Matches markdown internal links to .md files: [text](path.md) or
 *  [text](path.md#heading). Excludes external URLs and non-.md assets
 *  (images, PDFs). Captures the path without extension (group 1). */
const MD_LINK_RE =
  /\[[^\]]*\]\((?!https?:\/\/|mailto:|#)([^)#\s]+?)\.md(?:#[^)\s]*)?\)/g

/** Safely decodes a URI component, falling back to the raw string
 *  if the percent-encoding is malformed (e.g. "100%complete"). */
const safeDecodeURIComponent = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Strips inline code spans from a line so links inside backticks
 *  (e.g. `[[Note]]`) are not extracted as real links. */
const INLINE_CODE_RE = /`+[^`\n]*`+/g

/** Extracts link targets from markdown content, skipping fenced code
 *  blocks and inline code spans. Returns deduplicated raw targets
 *  (pre-resolution). */
export const extractLinks = (content: string): string[] => {
  const lines = content.split("\n")
  const targets = new Set<string>()

  // Mutable state: tracks whether we're inside a fenced code block.
  // A state machine needs mutable state — no immutable alternative
  // without restructuring into a reduce over line-state pairs.
  let currentFenceOpener: string | null = null

  for (const line of lines) {
    const fenceMatch = FENCE_OPEN.exec(line)
    if (fenceMatch) {
      const fenceChars = fenceMatch[1]!
      if (currentFenceOpener === null) {
        currentFenceOpener = fenceChars[0]!.repeat(fenceChars.length)
      } else if (
        // Closer must use the same character as the opener (backtick vs tilde),
        // be at least as long, and contain only fence characters (no trailing content)
        fenceChars[0] === currentFenceOpener[0] &&
        fenceChars.length >= currentFenceOpener.length &&
        line.trim() === fenceChars[0]!.repeat(line.trim().length)
      ) {
        currentFenceOpener = null
      }
      continue
    }
    if (currentFenceOpener !== null) continue

    // Replace inline code spans with spaces so links inside backticks are ignored
    const withoutInlineCode = line.replace(INLINE_CODE_RE, (match) =>
      " ".repeat(match.length),
    )

    for (const match of withoutInlineCode.matchAll(WIKILINK_RE)) {
      const target = match[1]!.trim()
      if (target.length > 0) targets.add(target)
    }
    for (const match of withoutInlineCode.matchAll(MD_LINK_RE)) {
      const target = safeDecodeURIComponent(match[1]!.trim())
      if (target.length > 0) targets.add(target)
    }
  }
  return [...targets]
}

/** Resolves a wikilink target to a vault-relative path using all known paths.
 *  Returns null if unresolvable. */
export const resolveLink = (
  target: string,
  allPaths: string[],
): string | null => {
  const targetWithExtension = target.endsWith(".md") ? target : `${target}.md`

  // Exact path match: "folder/Note.md" or "Note.md"
  if (allPaths.includes(targetWithExtension)) return targetWithExtension

  // Basename match: find all paths that end with the target filename
  const basenameMatches = allPaths.filter(
    (candidatePath) =>
      candidatePath === targetWithExtension ||
      candidatePath.endsWith(`/${targetWithExtension}`),
  )
  if (basenameMatches.length === 1) return basenameMatches[0]!
  // Multiple matches: prefer the shortest path (Obsidian's resolution heuristic)
  if (basenameMatches.length > 1) {
    return basenameMatches.reduce((shortest, candidatePath) =>
      candidatePath.length < shortest.length ? candidatePath : shortest,
    )
  }

  return null
}

// ── Factory ─────────────────────────────────────────────────────

export const createSearchIndex = (dbPath: string) => {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")

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
      properties  TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      path UNINDEXED, title, content, tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS links (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (source, target)
    );

    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
  `)
  // path UNINDEXED: stored for JOIN/DELETE but not searchable, saves index space

  // Prepared statements are compiled once here and reused across all calls.
  // db.prepare() caches the compiled SQL — calling it inside a function
  // would re-compile on every invocation.
  const upsertNotesStmt = db.prepare(`
    INSERT OR REPLACE INTO notes (path, title, content, tags, related, folder, type, created, mtime, properties)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const deleteFtsStmt = db.prepare(`DELETE FROM notes_fts WHERE path = ?`)
  const insertFtsStmt = db.prepare(
    `INSERT INTO notes_fts (path, title, content) VALUES (?, ?, ?)`,
  )
  const removeNotesStmt = db.prepare(`DELETE FROM notes WHERE path = ?`)
  const deleteLinksStmt = db.prepare(`DELETE FROM links WHERE source = ?`)
  const insertLinkStmt = db.prepare(
    `INSERT OR IGNORE INTO links (source, target) VALUES (?, ?)`,
  )
  const reResolveStmt = db.prepare(
    `UPDATE links SET target = @resolved WHERE target = @raw`,
  )

  // ── Index maintenance ──────────────────────────────────────────

  // FTS rows are managed manually (delete-then-insert) because SQLite triggers
  // combined with INSERT OR REPLACE cause FTS5 corruption.

  /** Parses a note's content and frontmatter, then indexes it for search. */
  const upsertNote = (
    filePath: string,
    rawContent: string,
    lastModifiedMs: number,
    options?: { skipLinks?: boolean },
  ): void => {
    const skipLinks = options?.skipLinks ?? false
    const parsed = matter(rawContent)
    const { data } = parsed

    // gray-matter may parse tags/related as a single string or array depending on YAML syntax
    const tags = Array.isArray(data.tags)
      ? data.tags
      : data.tags
        ? [data.tags]
        : []
    const related = Array.isArray(data.related)
      ? data.related
      : data.related
        ? [data.related]
        : []

    const note = {
      path: filePath,
      title: isString(data.title) ? data.title : basename(filePath, ".md"),
      content: parsed.content,
      tags: JSON.stringify(tags),
      related: JSON.stringify(related),
      folder: filePath.includes("/") ? filePath.split("/")[0] : "",
      type: isString(data.type) ? data.type : null,
      created: isDate(data.created)
        ? DateTime.fromJSDate(data.created).toISO()
        : isString(data.created)
          ? DateTime.fromISO(data.created).toISO()
          : null,
      mtime: lastModifiedMs,
      properties: JSON.stringify(convertFrontmatterDatesToIsoStrings(data)),
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
    )
    insertFtsStmt.run(note.path, note.title, note.content)

    if (skipLinks) return

    const allPaths = db.prepare("SELECT path FROM notes").all() as Array<{
      path: string
    }>
    const pathList = allPaths.map((row) => row.path)

    deleteLinksStmt.run(note.path)
    for (const rawTarget of extractLinks(parsed.content)) {
      const resolved = resolveLink(rawTarget, pathList)
      insertLinkStmt.run(note.path, resolved ?? rawTarget)
    }

    // Re-resolve stale unresolved targets that match the newly added note.
    // Two forms: wikilinks store just the basename ("Note"), markdown links
    // may store the full path ("folder/Note.md").
    const fileBasename = basename(note.path, ".md")
    reResolveStmt.run({ resolved: note.path, raw: fileBasename })
    reResolveStmt.run({ resolved: note.path, raw: note.path })
  }

  /** Removes a note from the notes table, FTS index, and links. */
  const removeNote = (filePath: string): void => {
    deleteFtsStmt.run(filePath)
    removeNotesStmt.run(filePath)
    deleteLinksStmt.run(filePath)
  }

  /** Drops the entire index and re-indexes every .md file in the vault. */
  const rebuildFromVault = async (vaultPath: string): Promise<number> => {
    db.exec("DELETE FROM notes_fts")
    db.exec("DELETE FROM notes")
    db.exec("DELETE FROM links")

    const normalizedVault = resolve(vaultPath)
    const entries = await readdir(vaultPath, {
      recursive: true,
      withFileTypes: true,
    })

    const files = entries.reduce<{ rel: string; full: string }[]>(
      (acc, entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".md")) return acc
        const full = join(entry.parentPath, entry.name)
        const rel = relative(normalizedVault, full)
        if (rel.split("/").some((seg) => seg.startsWith("."))) return acc
        acc.push({ rel, full })
        return acc
      },
      [],
    )

    const items = await Promise.all(
      files.map(async (file) => {
        const [content, fileStat] = await Promise.all([
          readFile(file.full, "utf8"),
          stat(file.full),
        ])
        return { rel: file.rel, content, mtime: fileStat.mtimeMs }
      }),
    )

    db.transaction(() => {
      // Pass 1: index all notes (content, frontmatter, FTS) — skip link
      // extraction here; Pass 2 handles it with the complete path list.
      for (const item of items) {
        // Skip link extraction here — Pass 2 handles it with the complete
        // path list so all forward references can resolve correctly.
        upsertNote(item.rel, item.content, item.mtime, { skipLinks: true })
      }

      // Pass 2: re-extract links now that all paths are in the notes table,
      // resolving targets that the per-note upsertNote pass may have missed
      // (e.g. Note A links to Note B, but Note B was indexed after Note A).
      const allPaths = db.prepare("SELECT path FROM notes").all() as Array<{
        path: string
      }>
      const pathList = allPaths.map((row) => row.path)

      db.exec("DELETE FROM links")
      for (const item of items) {
        const parsed = matter(item.content)
        for (const rawTarget of extractLinks(parsed.content)) {
          const resolved = resolveLink(rawTarget, pathList)
          insertLinkStmt.run(item.rel, resolved ?? rawTarget)
        }
      }
    })()

    logger.info("rebuilt index", { count: items.length })
    return items.length
  }

  // ── Query methods ──────────────────────────────────────────────

  /** Full-text search with BM25 ranking. Supports folder, tag, type, and property filters. */
  const fullTextSearch = (
    params: { query: string; filters?: SearchFilters },
    logger: Logger,
  ): SearchResult[] => {
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
      for (const rel of params.filters.related) {
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(n.related) WHERE value = ?)",
        )
        queryParams.push(rel)
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
    queryParams.push(limit)

    const sql = `
      SELECT n.path, n.title,
             snippet(notes_fts, 2, '', '', '...', ${Number(snippetTokens)}) as snippet,
             rank * -1 as score, n.tags, n.folder, n.type, n.created, n.mtime
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
          "path" | "title" | "tags" | "folder" | "type" | "created" | "mtime"
        > & {
          snippet: string
          score: number
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
      }))
      logger.info("full text search", {
        query: params.query,
        resultCount: results.length,
      })
      return results
    } catch {
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
      SELECT path, title, tags, related, folder, type, created, mtime, properties
      FROM notes n
      WHERE ${condition}
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
      SELECT path, title, tags, related, folder, type, created, mtime, properties
      FROM notes
      WHERE ${condition}
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
  const listAllTags = (logger: Logger): TagCount[] => {
    const sql = `
      SELECT value as tag, COUNT(*) as count
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
      SELECT path, title, tags, related, folder, type, created, mtime, properties
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
      SELECT je.key, COUNT(DISTINCT n.path) as count
      FROM notes n, json_each(n.properties) je
      ${folderCondition}
      GROUP BY je.key
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
      SELECT path, title, tags, related, folder, type, created, mtime, properties
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
    const sql = `
      SELECT n.path, n.title
      FROM links l
      JOIN notes n ON n.path = l.source
      WHERE l.target = ?
      ORDER BY n.title
    `
    const rows = db.prepare(sql).all(params.path) as Array<{
      path: string
      title: string
    }>
    logger.info("get backlinks", {
      path: params.path,
      count: rows.length,
    })
    return rows
  }

  /** Returns notes that the given path links TO (outgoing links). */
  const getOutgoingLinks = (
    params: { path: string },
    logger: Logger,
  ): OutgoingLinkEntry[] => {
    const sql = `
      SELECT l.target as path,
             n.title,
             CASE WHEN n.path IS NOT NULL THEN 1 ELSE 0 END as exists_flag
      FROM links l
      LEFT JOIN notes n ON n.path = l.target
      WHERE l.source = ?
      ORDER BY l.target
    `
    const rows = db.prepare(sql).all(params.path) as Array<{
      path: string
      title: string | null
      exists_flag: number
    }>
    const results = rows.map((row) => ({
      path: row.path,
      title: row.title,
      exists: row.exists_flag === 1,
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

    const folderExclusions = excludeFolders
      .map(() => "path NOT LIKE ? || '/%'")
      .join(" AND ")
    const whereClause =
      excludeFolders.length > 0 ? `AND ${folderExclusions}` : ""

    // Self-links (source = target) are excluded from the backlink subquery
    // so a note that only links to itself is still considered an orphan.
    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties
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

  return {
    upsertNote,
    removeNote,
    rebuildFromVault,
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
  properties: JSON.parse(row.properties) as Record<string, unknown>,
})

export type SearchIndex = ReturnType<typeof createSearchIndex>
