import Database from "better-sqlite3"
import matter from "gray-matter"
import { DateTime } from "luxon"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, basename, relative, resolve } from "node:path"
import { logger as rootLogger } from "../logger.js"

const logger = rootLogger.child({ module: "search-index" })

// ── Type guards ─────────────────────────────────────────────────

const isString = (value: unknown): value is string => typeof value === "string"

const isDate = (value: unknown): value is Date => value instanceof Date

// ── Types ───────────────────────────────────────────────────────

export type SearchResult = {
  path: string
  title: string
  snippet: string
  score: number
  tags: string[]
  folder: string
  created: string | null
  mtime: number
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
  properties: Record<string, unknown>
}

export type TagCount = {
  tag: string
  count: number
}

export type SearchFilters = {
  folder?: string
  tags?: string[]
  related?: string[]
  type?: string
  properties?: Record<string, string | number | boolean>
  limit?: number
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
      folder: filePath.includes("/") ? filePath.split("/")[0] : "", // top-level vault folder
      type: isString(data.type) ? data.type : null,
      created: isDate(data.created)
        ? DateTime.fromJSDate(data.created).toISO()
        : isString(data.created)
          ? DateTime.fromISO(data.created).toISO()
          : null,
      mtime: lastModifiedMs,
      properties: JSON.stringify(data), // full frontmatter bag for ad-hoc json_extract queries
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
    query: string,
    filters?: SearchFilters,
  ): SearchResult[] => {
    const conditions: string[] = []
    const params: unknown[] = []

    // Wrap in double quotes to treat as literal phrase, not FTS5 operators (AND, OR, NOT, *)
    conditions.push("notes_fts MATCH ?")
    params.push(`"${query.replace(/"/g, '""')}"`) // escape internal quotes by doubling them

    if (filters?.folder) {
      conditions.push("n.path LIKE ?")
      params.push(`${filters.folder}/%`)
    }

    if (filters?.tags) {
      for (const tag of filters.tags) {
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)",
        )
        params.push(tag)
      }
    }

    if (filters?.related) {
      for (const rel of filters.related) {
        conditions.push(
          "EXISTS (SELECT 1 FROM json_each(n.related) WHERE value = ?)",
        )
        params.push(rel)
      }
    }

    if (filters?.type) {
      conditions.push("n.type = ?")
      params.push(filters.type)
    }

    if (filters?.properties) {
      for (const [key, value] of Object.entries(filters.properties)) {
        conditions.push(`json_extract(n.properties, '$.' || ?) = ?`)
        params.push(key, value)
      }
    }

    const limit = filters?.limit ?? 20
    params.push(limit)

    const sql = `
      SELECT n.path, n.title,
             snippet(notes_fts, 2, '<mark>', '</mark>', '...', 30) as snippet,
             rank * -1 as score, n.tags, n.folder, n.created, n.mtime
      FROM notes_fts
      JOIN notes n ON n.path = notes_fts.path
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `
    // rank * -1: FTS5 rank is negative (lower = better), negated for human-friendly scoring

    try {
      const rows = db.prepare(sql).all(...params) as Array<
        Pick<
          NoteRow,
          "path" | "title" | "tags" | "folder" | "created" | "mtime"
        > & {
          snippet: string
          score: number
        }
      >

      return rows.map((row) => ({
        ...row,
        tags: JSON.parse(row.tags) as string[],
      }))
    } catch {
      return []
    }
  }

  /** Finds notes with a specific tag. Supports hierarchical prefix matching. */
  const searchByTag = (
    tag: string,
    options?: { exactMatch?: boolean; limit?: number },
  ): NoteMetadata[] => {
    const limit = options?.limit ?? 20

    const condition = options?.exactMatch
      ? "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)"
      : "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ? OR value LIKE ? || '/%')"

    const params: unknown[] = options?.exactMatch
      ? [tag, limit]
      : [tag, tag, limit]

    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties
      FROM notes n
      WHERE ${condition}
      LIMIT ?
    `

    const rows = db.prepare(sql).all(...params) as NoteRow[]
    return rows.map(rowToMetadata)
  }

  /** Lists notes in a folder, optionally including subfolders. */
  const searchByFolder = (
    folder: string,
    options?: { recursive?: boolean; limit?: number },
  ): NoteMetadata[] => {
    const recursive = options?.recursive ?? true
    const limit = options?.limit ?? 20

    const condition = recursive
      ? "path LIKE ? || '/%'"
      : "path LIKE ? || '/%' AND path NOT LIKE ? || '/%/%'"

    const params: unknown[] = recursive
      ? [folder, limit]
      : [folder, folder, limit]

    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties
      FROM notes
      WHERE ${condition}
      LIMIT ?
    `

    const rows = db.prepare(sql).all(...params) as NoteRow[]
    return rows.map(rowToMetadata)
  }

  /** Finds notes by their frontmatter `type` field. */
  const searchByType = (type: string, limit?: number): NoteMetadata[] => {
    const sql = `
      SELECT path, title, tags, related, folder, type, created, mtime, properties
      FROM notes
      WHERE type = ?
      LIMIT ?
    `

    const rows = db.prepare(sql).all(type, limit ?? 20) as NoteRow[]
    return rows.map(rowToMetadata)
  }

  /** Returns all tags in the vault with their note counts. */
  const listAllTags = (): TagCount[] => {
    const sql = `
      SELECT value as tag, COUNT(*) as count
      FROM notes, json_each(notes.tags)
      GROUP BY value
      ORDER BY count DESC
    `
    return db.prepare(sql).all() as TagCount[]
  }

  /** Returns recently modified or created notes, sorted by chosen timestamp. */
  const recentNotes = (options?: {
    sort_by?: "created" | "mtime"
    limit?: number
  }): NoteMetadata[] => {
    const sortBy = options?.sort_by ?? "mtime"
    const limit = options?.limit ?? 20

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
    return rows.map(rowToMetadata)
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
