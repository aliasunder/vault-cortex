/**
 * SQLite FTS5 search wrapper.
 *
 * All FTS5 SQL is contained here — the MCP tool layer never touches SQL.
 * The index is DERIVED from the vault and can be rebuilt from scratch.
 *
 * Uses better-sqlite3 which has FTS5 compiled in by default.
 * Schema uses content='' (external content) with triggers to keep
 * the FTS index in sync with the notes table automatically.
 */

import Database from "better-sqlite3";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import matter from "gray-matter";

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
  folder: string;
}

export class VaultSearch {
  private db: ReturnType<typeof Database>;

  constructor(dbPath: string) {
    this.db = Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // better concurrent read perf
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        path    TEXT PRIMARY KEY,
        title   TEXT,
        content TEXT,
        tags    TEXT,  -- JSON array
        folder  TEXT,
        mtime   INTEGER
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        path UNINDEXED,
        title,
        content,
        tags,
        folder UNINDEXED,
        content='notes',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Triggers keep FTS in sync with the notes table automatically.
      -- On insert/update/delete of a note, the FTS index updates too.
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, path, title, content, tags, folder)
        VALUES (new.rowid, new.path, new.title, new.content, new.tags, new.folder);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, path, title, content, tags, folder)
        VALUES ('delete', old.rowid, old.path, old.title, old.content, old.tags, old.folder);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, path, title, content, tags, folder)
        VALUES ('delete', old.rowid, old.path, old.title, old.content, old.tags, old.folder);
        INSERT INTO notes_fts(rowid, path, title, content, tags, folder)
        VALUES (new.rowid, new.path, new.title, new.content, new.tags, new.folder);
      END;
    `);
  }

  /** Index or re-index a single file. */
  upsert(filePath: string, rawContent: string): void {
    const { data: fm, content } = matter(rawContent);
    const title = (fm.title as string) ?? basename(filePath, ".md");
    const tags = JSON.stringify(Array.isArray(fm.tags) ? fm.tags : []);
    const folder = dirname(filePath);

    this.db
      .prepare(
        `INSERT INTO notes (path, title, content, tags, folder, mtime)
         VALUES (@path, @title, @content, @tags, @folder, @mtime)
         ON CONFLICT(path) DO UPDATE SET
           title=excluded.title, content=excluded.content,
           tags=excluded.tags, folder=excluded.folder, mtime=excluded.mtime`,
      )
      .run({ path: filePath, title, content, tags, folder, mtime: Date.now() });
  }

  /** Remove a file from the index. */
  remove(filePath: string): void {
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(filePath);
  }

  /** Full-text search with BM25 ranking. */
  search(query: string, limit = 20): SearchResult[] {
    const ftsQuery = query.includes(" ")
      ? `"${query}" OR ${query.split(" ").join(" OR ")}`
      : query;

    return this.db
      .prepare(
        `SELECT
           n.path, n.title,
           snippet(notes_fts, 2, '<b>', '</b>', '...', 32) AS snippet,
           notes_fts.rank AS score,
           n.tags, n.folder
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit)
      .map((row: Record<string, unknown>) => ({
        path: row.path as string,
        title: row.title as string,
        snippet: row.snippet as string,
        score: Math.abs(row.score as number),
        tags: JSON.parse((row.tags as string) ?? "[]") as string[],
        folder: row.folder as string,
      }));
  }

  /** Rebuild the entire index from vault files. */
  async reindex(vaultPath: string): Promise<void> {
    const files = await this.walk(vaultPath);
    const upsertMany = this.db.transaction(
      (entries: Array<{ path: string; content: string }>) => {
        for (const { path, content } of entries) this.upsert(path, content);
      },
    );

    const entries = await Promise.all(
      files.map(async (f) => ({
        path: f,
        content: await readFile(join(vaultPath, f), "utf8"),
      })),
    );
    upsertMany(entries);
    console.log(`Indexed ${entries.length} notes`);
  }

  private async walk(dir: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        results.push(...(await this.walk(join(dir, e.name), rel)));
      } else if (e.name.endsWith(".md")) {
        results.push(rel);
      }
    }
    return results;
  }
}
