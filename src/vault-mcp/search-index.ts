import Database from "better-sqlite3"
import matter from "gray-matter"
import { DateTime } from "luxon"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, basename, relative, resolve } from "node:path"
import { logger, type Logger } from "../logger.js"

// ── Type guards ─────────────────────────────────────────────────

const isString = (value: unknown): value is string => typeof value === "string"

const isDate = (value: unknown): value is Date => value instanceof Date

// ── FTS5 query sanitization ─────────────────────────────────────

const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"])

/** Sanitizes user input for safe FTS5 querying. Quoted phrases are preserved
 *  for exact-phrase matching; unquoted terms are left bare to preserve porter
 *  stemming. FTS5 metacharacters and reserved words are stripped. */
export const sanitizeFtsQuery = (raw: string): string => {
  const phrases: string[] = []
  const remaining = raw.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const cleaned = phrase.replace(/[*^():]/g, "").trim()
    if (cleaned.length > 0) phrases.push(`"${cleaned}"`)
    return " "
  })
  const tokens = remaining
    .replace(/["*^():]/g, " ")
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
  mtime: number
}

type NoteMetadata = {
  path: string
  title: string
  tags: string[]
  related: string[]
  folder: string
  type: string | null
  created: string | null
  mtime: number
  properties: Record<string, unknown>
}

type TagCount = {
  tag: string
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
  `)
  // path UNINDEXED: stored for JOIN/DELETE but not searchable, saves index space

  const upsertNotesStmt = db.prepare(`
    INSERT OR REPLACE INTO notes (path, title, content, tags, related, folder, type, created, mtime, properties)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const deleteFtsStmt = db.prepare(`DELETE FROM notes_fts WHERE path = ?`)
  const insertFtsStmt = db.prepare(
    `INSERT INTO notes_fts (path, title, content) VALUES (?, ?, ?)`,
  )
  const removeNotesStmt = db.prepare(`DELETE FROM notes WHERE path = ?`)

  // ── Index maintenance ──────────────────────────────────────────

  // FTS rows are managed manually (delete-then-insert) because SQLite triggers
  // combined with INSERT OR REPLACE cause FTS5 corruption.

  /** Parses a note's content and frontmatter, then indexes it for search. */
  const upsertNote = (
    filePath: string,
    rawContent: string,
    lastModifiedMs: number,
  ): void => {
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
      properties: JSON.stringify(data),
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
  }

  /** Removes a note from both the notes table and FTS index. */
  const removeNote = (filePath: string): void => {
    deleteFtsStmt.run(filePath)
    removeNotesStmt.run(filePath)
  }

  /** Drops the entire index and re-indexes every .md file in the vault. */
  const rebuildFromVault = async (vaultPath: string): Promise<number> => {
    db.exec("DELETE FROM notes_fts")
    db.exec("DELETE FROM notes")

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
      for (const item of items) {
        upsertNote(item.rel, item.content, item.mtime)
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
        mtime: Math.round(row.mtime),
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

  /** Finds notes by their frontmatter `type` field. */
  const searchByType = (
    params: { type: string; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties
      FROM notes
      WHERE type = ?
      LIMIT ?
    `

    const rows = db
      .prepare(sql)
      .all(params.type, params.limit ?? 20) as NoteRow[]
    const results = rows.map(rowToMetadata)
    logger.info("search by type", {
      type: params.type,
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
    params: { sort_by?: "created" | "mtime"; limit?: number },
    logger: Logger,
  ): NoteMetadata[] => {
    const sortBy = params.sort_by ?? "mtime"
    const limit = params.limit ?? 20

    // "created IS NULL" sorts NULLs last in a DESC ordering (SQLite evaluates 0/1)
    const orderClause =
      sortBy === "created"
        ? "ORDER BY created IS NULL, created DESC"
        : "ORDER BY mtime DESC"

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

  /** Returns aggregate vault statistics for quick orientation. */
  const getStats = (logger: Logger) => {
    const { noteCount } = db
      .prepare("SELECT COUNT(*) as noteCount FROM notes")
      .get() as { noteCount: number }
    const { tagCount } = db
      .prepare(
        "SELECT COUNT(DISTINCT value) as tagCount FROM notes, json_each(notes.tags)",
      )
      .get() as { tagCount: number }
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const { recentlyModified } = db
      .prepare("SELECT COUNT(*) as recentlyModified FROM notes WHERE mtime > ?")
      .get(sevenDaysAgo) as { recentlyModified: number }
    const topTags = db
      .prepare(
        "SELECT value as tag, COUNT(*) as count FROM notes, json_each(notes.tags) GROUP BY value ORDER BY count DESC LIMIT 10",
      )
      .all() as Array<{ tag: string; count: number }>

    logger.info("vault stats", { noteCount, tagCount })
    return { noteCount, tagCount, recentlyModified, topTags }
  }

  return {
    upsertNote,
    removeNote,
    rebuildFromVault,
    fullTextSearch,
    searchByTag,
    searchByFolder,
    searchByType,
    listAllTags,
    recentNotes,
    getStats,
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
  mtime: row.mtime,
  properties: JSON.parse(row.properties) as Record<string, unknown>,
})

export type SearchIndex = ReturnType<typeof createSearchIndex>
