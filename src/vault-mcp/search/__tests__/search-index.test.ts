import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  onTestFinished,
} from "vitest"
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import * as sqliteVec from "sqlite-vec"
vi.mock("sqlite-vec", { spy: true })
import { createSearchIndex } from "../search-index.js"
import type { SearchIndex } from "../search-index.js"
import { logger } from "../../../logger.js"

let index: SearchIndex

beforeEach(() => {
  index = createSearchIndex(":memory:")
})

const NOTE_WITH_FRONTMATTER = `---
title: Principles
type: about-me
tags: [principles, self]
related: [Routines, Career]
created: 2025-08-12T09:00:00-07:00
---

# Principles

## Decision heuristics

- Prefer reversible decisions when context is thin
- Avoid burnout by setting boundaries early
`

const NOTE_MINIMAL = `# Just a note

Some content without frontmatter.
`

const NOTE_WITH_CALLOUT = `---
title: Me
---

# Me

> [!info] Scope of this file
> **Contains:** identity facts.
> **Convention:** append newest first.

## Identity

- a fact about burnout boundaries
`

/** Builds a fileStat object for upsertNote. Defaults to size 100. */
const testStat = (
  mtimeMs: number,
  size = 100,
): { mtimeMs: number; size: number } => ({
  mtimeMs,
  size,
})

describe("schema creation", () => {
  it("creates a searchable index with notes and FTS tables", () => {
    const isolatedIndex = createSearchIndex(":memory:")
    isolatedIndex.upsertNote(
      { filePath: "test.md", rawContent: "# Test\n", fileStat: testStat(1000) },
      logger,
    )
    const results = isolatedIndex.fullTextSearch({ query: "Test" }, logger)
    expect(results).toHaveLength(1)
  })

  it("loads the sqlite-vec extension during construction", () => {
    createSearchIndex(":memory:")
    expect(sqliteVec.load).toHaveBeenCalled()
  })

  it("sqlite-vec native binary loads on this platform", () => {
    const db = new Database(":memory:")
    sqliteVec.load(db)
    const row = db.prepare("SELECT vec_version() AS version").get()
    expect(row).toHaveProperty("version")
  })
})

describe("leading callout", () => {
  it("surfaces a note's leading callout in discovery results", () => {
    index.upsertNote(
      {
        filePath: "About Me/Me.md",
        rawContent: NOTE_WITH_CALLOUT,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.leading_callout).toEqual({
      type: "info",
      title: "Scope of this file",
      body: "**Contains:** identity facts.\n**Convention:** append newest first.",
    })
  })

  it("returns callout null for a note without a leading callout", () => {
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.leading_callout).toBeNull()
  })

  it("omits the callout from fullTextSearch by default, includes it on request", () => {
    index.upsertNote(
      {
        filePath: "About Me/Me.md",
        rawContent: NOTE_WITH_CALLOUT,
        fileStat: testStat(1000),
      },
      logger,
    )

    const withoutFlag = index.fullTextSearch({ query: "burnout" }, logger)
    expect(withoutFlag).toHaveLength(1)
    expect(withoutFlag[0]?.leading_callout).toBeUndefined()

    const withFlag = index.fullTextSearch(
      { query: "burnout", filters: { include_leading_callout: true } },
      logger,
    )
    expect(withFlag[0]?.leading_callout?.title).toBe("Scope of this file")
  })

  it("adds the leading_callout column to a pre-existing notes table (warm-DB migration)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-db-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    // Simulate a database file created before the leading_callout column existed.
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE notes (
        path TEXT PRIMARY KEY, title TEXT, content TEXT, tags TEXT, related TEXT,
        folder TEXT, type TEXT, created TEXT, mtime INTEGER, properties TEXT
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        path UNINDEXED, title, content, tokenize='porter unicode61'
      );
      CREATE TABLE links (
        source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (source, target)
      );
    `)
    legacyDb.close()

    // Opening through the factory must add the missing column, not throw on upsert.
    const warmIndex = createSearchIndex(dbPath)
    expect(() =>
      warmIndex.upsertNote(
        {
          filePath: "About Me/Me.md",
          rawContent: NOTE_WITH_CALLOUT,
          fileStat: testStat(1000),
        },
        logger,
      ),
    ).not.toThrow()
    const results = warmIndex.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.leading_callout?.title).toBe("Scope of this file")
    expect(results[0]?.bytes).toBe(100)
  })

  it("adds the bytes column to a pre-existing non_md_files table (warm-DB migration)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-db-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    // Simulate a database file created before the non_md_files bytes column.
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE non_md_files (
        path TEXT PRIMARY KEY, base_path TEXT NOT NULL, basename TEXT NOT NULL
      );
    `)
    legacyDb.close()

    // Opening through the factory must add the missing column — the 4-column
    // upsert would throw against the legacy 3-column table otherwise.
    const warmIndex = createSearchIndex(dbPath)
    expect(() => warmIndex.upsertNonMdFile("photo.png", 77)).not.toThrow()
    warmIndex.upsertNote(
      {
        filePath: "source.md",
        rawContent: "![[photo.png]]",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(warmIndex.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 77,
        daily_note_forward_ref: false,
      },
    ])
  })
})

describe("bytes", () => {
  it("surfaces file size in bytes in discovery results", () => {
    index.upsertNote(
      {
        filePath: "notes/sized.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000, 42),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.bytes).toBe(42)
  })

  it("includes bytes in full text search results", () => {
    index.upsertNote(
      {
        filePath: "sized.md",
        rawContent: "searchable content\n",
        fileStat: testStat(1000, 256),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "searchable" }, logger)
    expect(results[0]?.bytes).toBe(256)
  })

  it("includes bytes in recent notes results", () => {
    index.upsertNote(
      {
        filePath: "recent.md",
        rawContent: "---\ntitle: R\n---\nbody\n",
        fileStat: testStat(5000, 128),
      },
      logger,
    )
    const results = index.recentNotes({}, logger)
    expect(results[0]?.bytes).toBe(128)
  })

  it("stores and retrieves a bytes value of 0", () => {
    index.upsertNote(
      {
        filePath: "notes/zero.md",
        rawContent: "body\n",
        fileStat: testStat(1000, 0),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.bytes).toBe(0)
  })
})

describe("upsertNote", () => {
  it("indexes a note with full frontmatter", () => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
    expect(results[0]?.title).toBe("Principles")
    expect(results[0]?.tags).toEqual(["principles", "self"])
  })

  it("extracts title from frontmatter", () => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.title).toBe("Principles")
  })

  it("falls back to filename for title when no frontmatter title", () => {
    index.upsertNote(
      {
        filePath: "notes/random.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.title).toBe("random")
  })

  it("stores folder as first path segment", () => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.folder).toBe("About Me")
  })

  it("stores empty folder for root-level notes", () => {
    index.upsertNote(
      {
        filePath: "root.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000),
      },
      logger,
    )
    const recent = index.recentNotes({}, logger)
    expect(recent[0]?.folder).toBe("")
  })

  it("updates existing note on re-index", () => {
    index.upsertNote(
      {
        filePath: "test.md",
        rawContent: "---\ntitle: V1\n---\nold\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "test.md",
        rawContent: "---\ntitle: V2\n---\nnew content\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "new content" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe("V2")
  })

  it("handles notes with no frontmatter", () => {
    index.upsertNote(
      {
        filePath: "bare.md",
        rawContent: "Just plain text\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "plain text" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.tags).toEqual([])
  })

  it("normalizes tags to array when given as string", () => {
    index.upsertNote(
      {
        filePath: "t.md",
        rawContent: "---\ntags: single-tag\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const tags = index.listAllTags({}, logger)
    expect(tags).toEqual([{ tag: "single-tag", count: 1 }])
  })
})

describe("removeNote", () => {
  it("removes an indexed note", () => {
    index.upsertNote(
      {
        filePath: "test.md",
        rawContent: "# Removable\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.removeNote("test.md")
    const results = index.fullTextSearch({ query: "Removable" }, logger)
    expect(results).toHaveLength(0)
  })

  it("does not throw for non-existent path", () => {
    expect(() => index.removeNote("ghost.md")).not.toThrow()
  })
})

describe("fullTextSearch", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/notes.md",
        rawContent:
          "---\ntitle: Project Notes\ntype: project\ntags: [project]\n---\n\nMeeting notes about the vault project\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/random.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("finds notes by content keyword", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("finds notes by title", () => {
    const results = index.fullTextSearch({ query: "Principles" }, logger)
    expect(results).toHaveLength(1)
  })

  it("returns snippets without HTML markup", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]?.snippet).not.toContain("<mark>")
    expect(results[0]?.snippet).toContain("burnout")
  })

  it("includes type in search results", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]?.type).toBe("about-me")
  })

  it("rounds score to at most 4 significant figures", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    const score = results[0]?.score
    expect(score).toBeDefined()
    expect(score).toBe(Number(score?.toPrecision(4)))
  })

  it("omits created when null", () => {
    const results = index.fullTextSearch({ query: "content without" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]).not.toHaveProperty("created")
  })

  it("includes created when present", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]).toHaveProperty("created")
    expect(results[0]?.created).toContain("2025")
  })

  it("returns modified as ISO 8601 string", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(typeof results[0]?.modified).toBe("string")
    expect(results[0]?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("respects custom snippet_tokens", () => {
    const short = index.fullTextSearch(
      { query: "burnout", filters: { snippet_tokens: 5 } },
      logger,
    )
    const long = index.fullTextSearch(
      { query: "burnout", filters: { snippet_tokens: 60 } },
      logger,
    )
    expect(long[0]?.snippet?.length).toBeGreaterThan(
      short[0]?.snippet?.length ?? 0,
    )
  })

  it("respects folder filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "Projects" } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/notes.md")
  })

  it("strips trailing slashes from folder filter before matching", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "Projects/" } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/notes.md")
  })

  it("respects tags filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { tags: ["project"] } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/notes.md")
  })

  it("respects type filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { type: "project" } },
      logger,
    )
    expect(results).toHaveLength(1)
  })

  it("respects limit", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { limit: 1 } },
      logger,
    )
    expect(results).toHaveLength(1)
  })

  it("returns empty for no matches", () => {
    const results = index.fullTextSearch({ query: "xyznonexistent" }, logger)
    expect(results).toHaveLength(0)
  })

  it("handles porter stemming", () => {
    index.upsertNote(
      {
        filePath: "stem.md",
        rawContent: "The runners were running quickly\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "run" }, logger)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((result) => result.path === "stem.md")).toBe(true)
  })

  it("multi-word query matches notes containing both terms (implicit AND)", () => {
    const results = index.fullTextSearch(
      { query: "burnout boundaries" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("multi-word query does not require exact phrase adjacency", () => {
    index.upsertNote(
      {
        filePath: "spread.md",
        rawContent: "The word alpha appears here. Much later, beta shows up.\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "alpha beta" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("spread.md")
  })

  it("exact phrase match with quotes", () => {
    index.upsertNote(
      {
        filePath: "phrase.md",
        rawContent: "Learn machine learning today\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "separate.md",
        rawContent: "The machine was broken. Learning was slow.\n",
        fileStat: testStat(5001),
      },
      logger,
    )
    const phraseResults = index.fullTextSearch(
      { query: '"machine learning"' },
      logger,
    )
    expect(phraseResults.some((result) => result.path === "phrase.md")).toBe(
      true,
    )
    expect(phraseResults.some((result) => result.path === "separate.md")).toBe(
      false,
    )
  })

  it("query with FTS5 operators does not throw", () => {
    expect(() =>
      index.fullTextSearch(
        { query: 'test "quoted" AND (grouped) OR NOT *wild*' },
        logger,
      ),
    ).not.toThrow()
  })

  it("hyphenated query matches content containing the hyphenated term", () => {
    index.upsertNote(
      {
        filePath: "project.md",
        rawContent: "The flux-capacitor enables time travel\n",
        fileStat: testStat(6000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "flux-capacitor" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("project.md")
  })

  it("dotted query matches content containing the dotted term", () => {
    index.upsertNote(
      {
        filePath: "directories.md",
        rawContent: "Submitted the listing to mcpservers.org yesterday\n",
        fileStat: testStat(6001),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "unrelated.md",
        rawContent: "The mcpservers registry has no org field\n",
        fileStat: testStat(6002),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "mcpservers.org" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("directories.md")
  })

  it("query with stray punctuation does not throw", () => {
    expect(() =>
      index.fullTextSearch(
        { query: "what's new in deploy/local, server.json & .env?" },
        logger,
      ),
    ).not.toThrow()
  })
})

// ── Metadata search (frontmatter in FTS5) ──────────────────────
//
// Test notes use terms that appear ONLY in frontmatter — never in
// the title or body — so the tests genuinely prove FTS metadata
// indexing (and fail if the metadata column is empty).

const NOTE_WITH_TAXONOMY = `---
title: Garden Layout
type: blueprint
tags: [perennial, xeriscaping]
status: dormant
lifecycle: evergreen
---

# Garden Layout

Raised beds along the south fence with drip irrigation.
`

const NOTE_WITH_PRIORITY = `---
title: Fence Repair
type: maintenance
tags: [structural]
status: overdue
priority: critical
---

# Fence Repair

Replace the rotted posts on the north side.
`

describe("metadata search", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "garden/layout.md",
        rawContent: NOTE_WITH_TAXONOMY,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "garden/fence.md",
        rawContent: NOTE_WITH_PRIORITY,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "garden/notes.md",
        rawContent:
          "---\ntitle: Soil Notes\ntype: reference\ntags: [compost]\n---\n\nAmend with gypsum before planting season.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("finds a note by a type value that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "blueprint" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })

  it("finds a note by a status value that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "overdue" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/fence.md")
  })

  it("finds a note by a tag that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "xeriscaping" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })

  it("finds a note by a frontmatter key name", () => {
    const results = index.fullTextSearch({ query: "lifecycle" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })

  it("cross-field query matches a frontmatter term + body term together", () => {
    const results = index.fullTextSearch({ query: "compost gypsum" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/notes.md")
  })

  it("snippet contains body text, not metadata, for a frontmatter-only match", () => {
    const results = index.fullTextSearch({ query: "overdue" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.snippet).not.toContain("status")
    expect(results[0]?.snippet).not.toContain("overdue")
    expect(results[0]?.snippet).toContain("rotted posts")
  })

  it("does not match notes that lack the queried frontmatter term", () => {
    const results = index.fullTextSearch({ query: "dormant" }, logger)
    const paths = results.map((result) => result.path)
    expect(paths).toEqual(["garden/layout.md"])
  })

  it("warm-DB migration: FTS metadata column is added to a pre-existing database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-fts-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE notes (
        path TEXT PRIMARY KEY, title TEXT, content TEXT, tags TEXT, related TEXT,
        folder TEXT, type TEXT, created TEXT, mtime INTEGER, properties TEXT,
        leading_callout TEXT, bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        path UNINDEXED, title, content, tokenize='porter unicode61'
      );
      CREATE TABLE links (
        source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (source, target)
      );
    `)
    legacyDb.close()

    const warmIndex = createSearchIndex(dbPath)
    warmIndex.upsertNote(
      {
        filePath: "garden/layout.md",
        rawContent: NOTE_WITH_TAXONOMY,
        fileStat: testStat(1000),
      },
      logger,
    )

    const results = warmIndex.fullTextSearch({ query: "xeriscaping" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })
})

describe("searchByTag", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\ntags: [project/vault-mcp, self]\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\ntags: [project/other]\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "c.md",
        rawContent: "---\ntags: [unrelated]\n---\nbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("prefix match: parent tag matches children", () => {
    const results = index.searchByTag({ tag: "project" }, logger)
    expect(results).toHaveLength(2)
  })

  it("exact match mode", () => {
    const results = index.searchByTag(
      { tag: "project", exactMatch: true },
      logger,
    )
    expect(results).toHaveLength(0)
  })

  it("exact match finds specific tag", () => {
    const results = index.searchByTag(
      { tag: "project/vault-mcp", exactMatch: true },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("a.md")
  })

  it("returns empty for non-existent tag", () => {
    const results = index.searchByTag({ tag: "nope" }, logger)
    expect(results).toHaveLength(0)
  })

  it("prefix match treats LIKE wildcards in the tag as literal characters", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [a_b/child]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    // Without escaping, LIKE 'a_b/%' would also match this tag — the "_"
    // wildcard matches the "x" in "axb".
    index.upsertNote(
      {
        filePath: "e.md",
        rawContent: "---\ntags: [axb/child]\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )

    const results = index.searchByTag({ tag: "a_b" }, logger)
    expect(results.map((result) => result.path)).toEqual(["d.md"])
  })
})

describe("searchByFolder", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "About Me/sub/deep.md",
        rawContent: "---\ntitle: Deep\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/notes.md",
        rawContent: "---\ntitle: P\n---\nbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("recursive mode includes nested files", () => {
    const results = index.searchByFolder(
      { folder: "About Me", recursive: true },
      logger,
    )
    expect(results).toHaveLength(2)
  })

  it("non-recursive mode excludes nested files", () => {
    const results = index.searchByFolder(
      { folder: "About Me", recursive: false },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("sorts results by most recently modified", () => {
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results.map((note) => note.path)).toEqual([
      "About Me/sub/deep.md",
      "About Me/Principles.md",
    ])
  })

  it("strips trailing slashes from folder before matching", () => {
    const results = index.searchByFolder({ folder: "About Me/" }, logger)
    expect(results.map((note) => note.path)).toEqual([
      "About Me/sub/deep.md",
      "About Me/Principles.md",
    ])
  })
})

describe("listAllTags", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\ntags: [principles, work]\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
  })

  it("returns tags with counts ordered by count desc", () => {
    const tags = index.listAllTags({}, logger)
    expect(tags[0]).toEqual({ tag: "principles", count: 2 })
    expect(tags.find((tagEntry) => tagEntry.tag === "self")).toEqual({
      tag: "self",
      count: 1,
    })
  })

  it("handles notes with no tags", () => {
    index.upsertNote(
      {
        filePath: "bare.md",
        rawContent: "no tags\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    const tags = index.listAllTags({}, logger)
    expect(tags).toHaveLength(3)
    const results = index.fullTextSearch({ query: "no tags" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("bare.md")
  })
})

describe("recentNotes", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "old.md",
        rawContent: "---\ncreated: 2025-01-01\n---\nold\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "new.md",
        rawContent: "---\ncreated: 2026-05-01\n---\nnew\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "no-created.md",
        rawContent: "no date\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("sorts by modified by default", () => {
    const results = index.recentNotes({}, logger)
    expect(results[0]?.path).toBe("new.md")
    expect(results[1]?.path).toBe("no-created.md")
    expect(results[2]?.path).toBe("old.md")
  })

  it("sorts by created date", () => {
    const results = index.recentNotes({ sort_by: "created" }, logger)
    expect(results[0]?.path).toBe("new.md")
    expect(results[1]?.path).toBe("old.md")
  })

  it("puts nulls last for created sort", () => {
    const results = index.recentNotes({ sort_by: "created" }, logger)
    expect(results[results.length - 1]?.path).toBe("no-created.md")
  })

  it("respects limit", () => {
    const results = index.recentNotes({ limit: 1 }, logger)
    expect(results).toHaveLength(1)
  })

  it("floors a fractional limit instead of failing with SQLite's datatype mismatch", () => {
    const results = index.recentNotes({ limit: 1.9 }, logger)
    expect(results.map((note) => note.path)).toEqual(["new.md"])
  })
})

// ── Property query fixtures ──────────────────────────────────────

const NOTE_WITH_STATUS = `---
title: Active Project
type: project
tags: [project, active]
status: in-progress
priority: high
---

# Active Project

Work in progress.
`

const NOTE_WITH_DIFFERENT_STATUS = `---
title: Done Project
type: project
tags: [project, done]
status: done
priority: low
---

# Done Project

Completed work.
`

const NOTE_WITH_NO_CUSTOM_PROPS = `---
title: Plain Note
tags: [note]
---

# Plain Note

No custom properties.
`

describe("listPropertyKeys", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/active.md",
        rawContent: NOTE_WITH_STATUS,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/done.md",
        rawContent: NOTE_WITH_DIFFERENT_STATUS,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_WITH_NO_CUSTOM_PROPS,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("returns all property keys with counts", () => {
    const keys = index.listPropertyKeys({}, logger)
    expect(keys.length).toBeGreaterThan(0)
    const titleKey = keys.find((entry) => entry.key === "title")
    expect(titleKey).toBeDefined()
    expect(titleKey!.count).toBe(3)
  })

  it("includes sample_values for each key", () => {
    const keys = index.listPropertyKeys({}, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey!.sample_values).toContain("in-progress")
    expect(statusKey!.sample_values).toContain("done")
  })

  it("returns at most 3 sample values", () => {
    for (let i = 0; i < 5; i++) {
      index.upsertNote(
        {
          filePath: `extra/n${i}.md`,
          rawContent: `---\nvariety: value-${i}\n---\nbody\n`,
          fileStat: testStat(4000 + i),
        },
        logger,
      )
    }
    const keys = index.listPropertyKeys({}, logger)
    const varietyKey = keys.find((entry) => entry.key === "variety")
    expect(varietyKey!.sample_values.length).toBeLessThanOrEqual(3)
  })

  it("sorts by count descending", () => {
    const keys = index.listPropertyKeys({}, logger)
    for (let i = 1; i < keys.length; i++) {
      const prev = keys[i - 1]
      const curr = keys[i]
      if (prev === undefined || curr === undefined) continue
      expect(prev.count).toBeGreaterThanOrEqual(curr.count)
    }
  })

  it("respects folder filter", () => {
    const keys = index.listPropertyKeys({ folder: "Projects" }, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey!.count).toBe(2)
  })

  it("folder filter excludes notes outside the folder", () => {
    const keys = index.listPropertyKeys({ folder: "notes" }, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeUndefined()
  })

  it("sample_values are scoped to the folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/other.md",
        rawContent: "---\nstatus: blocked\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const keys = index.listPropertyKeys({ folder: "Projects" }, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey!.sample_values).not.toContain("blocked")
  })
})

describe("listPropertyValues", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/active.md",
        rawContent: NOTE_WITH_STATUS,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/done.md",
        rawContent: NOTE_WITH_DIFFERENT_STATUS,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_WITH_NO_CUSTOM_PROPS,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("returns distinct values with counts for a scalar property", () => {
    const values = index.listPropertyValues({ key: "status" }, logger)
    expect(values).toHaveLength(2)
    expect(values.find((entry) => entry.value === "in-progress")).toEqual({
      value: "in-progress",
      count: 1,
    })
    expect(values.find((entry) => entry.value === "done")).toEqual({
      value: "done",
      count: 1,
    })
  })

  it("enumerates individual array elements for array properties", () => {
    const values = index.listPropertyValues({ key: "tags" }, logger)
    expect(values.find((entry) => entry.value === "project")).toBeDefined()
    expect(values.find((entry) => entry.value === "active")).toBeDefined()
    expect(values.find((entry) => entry.value === "note")).toBeDefined()
  })

  it("sorts by count descending", () => {
    const values = index.listPropertyValues({ key: "tags" }, logger)
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]
      const curr = values[i]
      if (prev === undefined || curr === undefined) continue
      expect(prev.count).toBeGreaterThanOrEqual(curr.count)
    }
  })

  it("respects limit", () => {
    const values = index.listPropertyValues({ key: "tags", limit: 2 }, logger)
    expect(values).toHaveLength(2)
  })

  it("respects folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/excluded.md",
        rawContent: "---\nstatus: blocked\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const values = index.listPropertyValues(
      { key: "status", folder: "Projects" },
      logger,
    )
    expect(values).toHaveLength(2)
    const blockedValue = values.find((entry) => entry.value === "blocked")
    expect(blockedValue).toBeUndefined()
  })

  it("returns empty for non-existent key", () => {
    const values = index.listPropertyValues({ key: "nonexistent" }, logger)
    expect(values).toHaveLength(0)
  })
})

describe("searchByProperty", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/active.md",
        rawContent: NOTE_WITH_STATUS,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/done.md",
        rawContent: NOTE_WITH_DIFFERENT_STATUS,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_WITH_NO_CUSTOM_PROPS,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("finds notes by scalar property value", () => {
    const results = index.searchByProperty(
      { key: "status", value: "in-progress" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/active.md")
  })

  it("finds notes by array property value", () => {
    const results = index.searchByProperty(
      { key: "tags", value: "active" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/active.md")
  })

  it("returns NoteMetadata with all fields", () => {
    const results = index.searchByProperty(
      { key: "status", value: "done" },
      logger,
    )
    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result).toBeDefined()
    expect(result?.path).toBe("Projects/done.md")
    expect(result?.title).toBe("Done Project")
    expect(result?.tags).toEqual(["project", "done"])
    expect(result?.folder).toBe("Projects")
    expect(result?.type).toBe("project")
    expect(result?.bytes).toBe(100)
    expect(result?.properties).toEqual(
      expect.objectContaining({ status: "done", priority: "low" }),
    )
  })

  it("returns empty for non-matching value", () => {
    const results = index.searchByProperty(
      { key: "status", value: "archived" },
      logger,
    )
    expect(results).toHaveLength(0)
  })

  it("returns empty for non-existent key", () => {
    const results = index.searchByProperty(
      { key: "nonexistent", value: "any" },
      logger,
    )
    expect(results).toHaveLength(0)
  })

  it("respects folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/also-active.md",
        rawContent: "---\nstatus: in-progress\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", folder: "Projects" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/active.md")
  })

  it("respects limit", () => {
    index.upsertNote(
      {
        filePath: "Projects/another.md",
        rawContent: "---\nstatus: in-progress\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", limit: 1 },
      logger,
    )
    expect(results).toHaveLength(1)
  })

  it("finds notes by YAML date property (normalized from Date object)", () => {
    index.upsertNote(
      {
        filePath: "dated.md",
        rawContent: "---\ndue: 2026-05-13\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "due", value: "2026-05-13" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("dated.md")
  })
})

describe("markdown path requirement", () => {
  it("getBacklinks rejects a path without the .md extension", () => {
    expect(() => index.getBacklinks({ path: "Projects/Plan" }, logger)).toThrow(
      'path must end in ".md" (received "Projects/Plan")',
    )
  })

  it("getOutgoingLinks rejects a path without the .md extension", () => {
    expect(() =>
      index.getOutgoingLinks({ path: "Projects/Plan" }, logger),
    ).toThrow('path must end in ".md" (received "Projects/Plan")')
  })
})

describe("rebuildFromVault", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "vault-idx-test-"))
    await mkdir(join(vaultDir, "About Me"), { recursive: true })
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
    await writeFile(
      join(vaultDir, "About Me/Principles.md"),
      NOTE_WITH_FRONTMATTER,
      "utf8",
    )
    await writeFile(join(vaultDir, "root.md"), NOTE_MINIMAL, "utf8")
    await writeFile(join(vaultDir, ".obsidian/config.md"), "hidden\n", "utf8")
  })

  afterEach(async () => {
    await rm(vaultDir, { recursive: true })
  })

  it("indexes all visible .md files", async () => {
    const { count } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    expect(count).toBe(2)
  })

  it("skips hidden directories", async () => {
    const { count: indexedCount } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    expect(indexedCount).toBe(2)
    const hidden = index.fullTextSearch({ query: "hidden" }, logger)
    expect(hidden).toHaveLength(0)
  })

  it("clears existing data before rebuilding", async () => {
    index.upsertNote(
      {
        filePath: "stale.md",
        rawContent: "stale content\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    const results = index.fullTextSearch({ query: "stale" }, logger)
    expect(results).toHaveLength(0)
  })

  it("makes indexed notes searchable", async () => {
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("resolves a frontmatter wikilink whose target is indexed later (forward reference)", async () => {
    // related: points to a note that sorts after the source, so the source is
    // indexed first; the two-pass rebuild must still resolve it. The body has
    // no link to z-target, so only frontmatter extraction can produce the edge.
    await writeFile(
      join(vaultDir, "a-source.md"),
      '---\ntitle: Source\nrelated: ["[[z-target]]"]\n---\n\n# Source\n\nProse only.\n',
      "utf8",
    )
    await writeFile(
      join(vaultDir, "z-target.md"),
      "# Z Target\n\nBody.\n",
      "utf8",
    )
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    const backlinks = index.getBacklinks({ path: "z-target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("a-source.md")
  })

  it("does not count extensionless wikilinks to non-md files as broken", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Trip Route]] and [[missing-note]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "Trip Route.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Trip Route.canvas")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "missing-note")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves markdown-style file embeds through the two-pass rebuild", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\n![p](photo.png) and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "photo.png"), "png-bytes", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    // Results order by target, so "genuinely-missing" sorts first.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "genuinely-missing",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
      {
        path: "photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 9,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves extensionless wikilinks to non-md files by basename", async () => {
    await mkdir(join(vaultDir, "canvases"), { recursive: true })
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Dashboard]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "canvases/Dashboard.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find(
      (link) => link.path === "canvases/Dashboard.canvas",
    )
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves extensionless wikilinks to non-md files by exact path", async () => {
    await mkdir(join(vaultDir, "views"), { recursive: true })
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[views/Inventory]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(
      join(vaultDir, "views/Inventory.base"),
      "filters: []\n",
      "utf8",
    )
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "views/Inventory.base")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not match a folder-qualified target against a same-named file in a different folder", async () => {
    await mkdir(join(vaultDir, "other"), { recursive: true })
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[views/Inventory]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "other/Inventory.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.path).toBe("views/Inventory")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not let LIKE wildcards in the target match unrelated files", async () => {
    await mkdir(join(vaultDir, "foo/aXb"), { recursive: true })
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[a_b/c]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "foo/aXb/c.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves extensionless wikilinks to non-md files by relative path", async () => {
    await mkdir(join(vaultDir, "sub"), { recursive: true })
    await writeFile(
      join(vaultDir, "sub/source.md"),
      "# Source\n\nSee [[../Route]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "Route.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "sub/source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Route.canvas")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("skips non-md files in hidden directories", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[config]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, ".obsidian/config.json"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves explicit-extension wikilinks against the non-md file index", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\n![[photo.png]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "photo.png"), "binary", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "photo.png")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken!.exists).toBe(false)
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves an extensionless target to a note when both note and non-md file share the same base name", async () => {
    await writeFile(
      join(vaultDir, "Report.md"),
      "# Report\n\nNote content.\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "Report.pdf"), "binary", "utf8")
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Report]].\n",
      "utf8",
    )
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.path).toBe("Report.md")
    expect(outgoing[0]!.kind).toBe("note")
    expect(outgoing[0]!.exists).toBe(true)
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("indexes a symlinked .md file", async () => {
    await mkdir(join(vaultDir, "real"), { recursive: true })
    await writeFile(
      join(vaultDir, "real/original.md"),
      "# Original\n\nSymlink target content.\n",
      "utf8",
    )
    await symlink("real/original.md", join(vaultDir, "linked.md"))

    const { count } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    expect(count).toBe(4)

    const results = index.fullTextSearch(
      { query: "symlink target content" },
      logger,
    )
    expect(results).toHaveLength(2)
    const paths = results.map((result) => result.path).sort()
    expect(paths).toEqual(["linked.md", "real/original.md"])
  })

  it("indexes a symlinked non-.md file for link resolution", async () => {
    await mkdir(join(vaultDir, "boards"), { recursive: true })
    await writeFile(join(vaultDir, "boards/real-board.canvas"), "{}", "utf8")
    await symlink("boards/real-board.canvas", join(vaultDir, "Board.canvas"))
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Board]].\n",
      "utf8",
    )

    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toEqual([
      expect.objectContaining({
        path: "Board.canvas",
        exists: true,
        kind: "file",
      }),
    ])
  })

  it("indexes a symlink whose target is outside the vault root", async () => {
    // Obsidian supports symlinks to files outside the vault (e.g. repo files
    // symlinked into the vault for browsing), so vault-cortex follows suit
    const outsideDir = await mkdtemp(join(tmpdir(), "vault-outside-"))
    onTestFinished(async () => rm(outsideDir, { recursive: true }))
    await writeFile(
      join(outsideDir, "external.md"),
      "# External\n\nExternal content.\n",
      "utf8",
    )
    await symlink(
      join(outsideDir, "external.md"),
      join(vaultDir, "linked-external.md"),
    )

    const { count } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    expect(count).toBe(3)

    const results = index.fullTextSearch({ query: "external content" }, logger)
    expect(results.map((result) => result.path)).toEqual(["linked-external.md"])
  })

  it("skips a broken symlink without crashing the rebuild", async () => {
    // A valid internal symlink proves the system indexes symlinks —
    // without it, the test passes trivially even if all symlinks are ignored
    await symlink("root.md", join(vaultDir, "valid-link.md"))
    await symlink("nonexistent/target.md", join(vaultDir, "broken.md"))

    const { count } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    expect(count).toBe(3) // 2 baseline + valid-link.md (broken.md filtered)

    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
  })

  it("skips a symlink whose target is a directory, not a file", async () => {
    // A valid internal symlink proves the system indexes symlinks —
    // without it, the test passes trivially even if all symlinks are ignored
    await symlink("root.md", join(vaultDir, "valid-link.md"))
    await mkdir(join(vaultDir, "realdir"), { recursive: true })
    await writeFile(join(vaultDir, "realdir/inner.md"), "inner\n", "utf8")
    await symlink(join(vaultDir, "realdir"), join(vaultDir, "dirlink.md"))

    const { count } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    expect(count).toBe(4) // 2 baseline + valid-link.md + inner.md (dirlink.md filtered)

    const results = index.fullTextSearch({ query: "inner" }, logger)
    expect(results.map((result) => result.path)).toEqual(["realdir/inner.md"])
  })
})

// ── Link query methods ───────────────────────────────────────────

describe("getBacklinks", () => {
  beforeEach(() => {
    // hub links to spoke-a and spoke-b; spoke-a links back to hub.
    // upsertNote re-resolves stale targets, so ordering doesn't matter.
    index.upsertNote(
      {
        filePath: "hub.md",
        rawContent: "# Hub\n\nLinks to [[spoke-a]] and [[spoke-b]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "spoke-a.md",
        rawContent: "# Spoke A\n\nLinks back to [[hub]].\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "spoke-b.md",
        rawContent: "# Spoke B\n\nNo backlink.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "island.md",
        rawContent: "# Island\n\nNo links at all.\n",
        fileStat: testStat(4000),
      },
      logger,
    )
  })

  it("finds notes linking to the target", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("hub.md")
  })

  it("finds backlinks from notes that link to the target", () => {
    const backlinks = index.getBacklinks({ path: "hub.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("spoke-a.md")
  })

  it("returns empty for notes with no backlinks", () => {
    const backlinks = index.getBacklinks({ path: "island.md" }, logger)
    expect(backlinks).toHaveLength(0)
  })

  it("includes title in results", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks[0]?.title).toBe("hub")
  })

  it("includes bytes in results", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks[0]?.bytes).toBe(100)
  })
})

describe("getOutgoingLinks", () => {
  beforeEach(() => {
    // source links to target-exists (will be resolved) and NonExistent (unresolved)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[target-exists]] and [[NonExistent]].\n",
        fileStat: testStat(1000, 11),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "target-exists.md",
        rawContent: "---\ntitle: Target\n---\n\n# Target\n\nBody.\n",
        fileStat: testStat(2000, 222),
      },
      logger,
    )
  })

  it("returns outgoing links with exists flag and kind", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(links).toHaveLength(2)

    const existing = links.find((link) => link.path === "target-exists.md")
    expect(existing).toBeDefined()
    expect(existing!.exists).toBe(true)
    expect(existing!.kind).toBe("note")
    expect(existing!.title).toBe("Target")
  })

  it("marks unresolved links as exists: false with kind note", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    const missing = links.find((link) => link.path === "NonExistent")
    expect(missing).toBeDefined()
    expect(missing!.exists).toBe(false)
    expect(missing!.kind).toBe("note")
    expect(missing!.title).toBeNull()
    expect(missing!.bytes).toBeNull()
  })

  it("includes bytes for existing targets, null for broken links", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    const existing = links.find((link) => link.path === "target-exists.md")
    expect(existing!.bytes).toBe(222)
    const broken = links.find((link) => link.path === "NonExistent")
    expect(broken!.bytes).toBeNull()
  })

  it("flags daily note forward-refs when exclusion is set", () => {
    index.setDailyNotesFolder("Daily Notes")
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-06-24.md",
        rawContent:
          "# 2026-06-24\n\n[[Daily Notes/2026-06-25|Tomorrow >>]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )

    const links = index.getOutgoingLinks(
      { path: "Daily Notes/2026-06-24.md" },
      logger,
    )
    const forwardRef = links.find(
      (link) => link.path === "Daily Notes/2026-06-25",
    )
    expect(forwardRef!.exists).toBe(false)
    expect(forwardRef!.daily_note_forward_ref).toBe(true)

    const genuinelyBroken = links.find((link) => link.path === "missing")
    expect(genuinelyBroken!.exists).toBe(false)
    expect(genuinelyBroken!.daily_note_forward_ref).toBe(false)
  })

  it("returns empty for notes with no outgoing links", () => {
    index.upsertNote(
      {
        filePath: "lonely.md",
        rawContent: "# Lonely\n\nNo links.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    const links = index.getOutgoingLinks({ path: "lonely.md" }, logger)
    expect(links).toHaveLength(0)
  })
})

describe("findOrphans", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "hub.md",
        rawContent: "# Hub\n\n[[connected]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "connected.md",
        rawContent: "# Connected\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/orphan.md",
        rawContent:
          "---\ntitle: Orphan\ntype: project\ntags: [project]\n---\n\n# Orphan\n\nNobody links here.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-05-13.md",
        rawContent: "---\ntitle: 2026-05-13\n---\n\n# Daily\n",
        fileStat: testStat(4000),
      },
      logger,
    )
  })

  it("finds notes with no incoming links", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).toContain("Projects/orphan.md")
  })

  it("excludes connected notes", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).not.toContain("connected.md")
  })

  it("includes all folders when no exclusions provided", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).toContain("Daily Notes/2026-05-13.md")
  })

  it("excludes Daily Notes when passed in excludeFolders", () => {
    const orphans = index.findOrphans(
      { excludeFolders: ["Daily Notes"] },
      logger,
    )
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).not.toContain("Daily Notes/2026-05-13.md")
  })

  it("strips trailing slashes from excludeFolders before matching", () => {
    const orphans = index.findOrphans(
      { excludeFolders: ["Daily Notes/"] },
      logger,
    )
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).not.toContain("Daily Notes/2026-05-13.md")
    expect(orphanPaths).toContain("Projects/orphan.md")
  })

  it("respects limit", () => {
    const orphans = index.findOrphans({ limit: 1 }, logger)
    expect(orphans).toHaveLength(1)
  })

  it("returns NoteMetadata with all fields", () => {
    const orphans = index.findOrphans({}, logger)
    const projectOrphan = orphans.find(
      (orphan) => orphan.path === "Projects/orphan.md",
    )
    expect(projectOrphan).toBeDefined()
    expect(projectOrphan!.title).toBe("Orphan")
    expect(projectOrphan!.tags).toEqual(["project"])
    expect(projectOrphan!.folder).toBe("Projects")
    expect(projectOrphan!.bytes).toBe(100)
    expect(typeof projectOrphan!.modified).toBe("string")
  })

  it("treats self-linking notes as orphans", () => {
    index.upsertNote(
      {
        filePath: "self-ref.md",
        rawContent: "# Self\n\nLinks to [[self-ref]].\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).toContain("self-ref.md")
  })
})

describe("forward reference resolution", () => {
  it("resolves backlinks when target is indexed after source", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\nLinks to [[target]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )

    const backlinks = index.getBacklinks({ path: "target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("source.md")
  })

  it("re-resolves a full-path forward reference when the target is created later", () => {
    // A full-path link is stored without .md ("folder/target") while the target
    // doesn't exist yet. Frontmatter related: links are usually full-path, so
    // this is the common incremental case. Body has no link → only the
    // frontmatter edge is under test.
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          '---\ntitle: Source\nrelated: ["[[folder/target]]"]\n---\n\n# Source\n\nProse only.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    // Target absent → link stored unresolved → no backlink yet.
    expect(
      index.getBacklinks({ path: "folder/target.md" }, logger),
    ).toHaveLength(0)

    index.upsertNote(
      {
        filePath: "folder/target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "folder/target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("source.md")
  })

  it("re-resolves a relative ../ forward reference when the target is created later", () => {
    // A source-relative link is stored raw ("../Health/later") while the target
    // doesn't exist yet. Re-resolution must re-run with the link's own source so
    // the relative form upgrades, not just basename/full-path forms.
    index.upsertNote(
      {
        filePath: "Areas/Work/early.md",
        rawContent: "# Early\n\nLinks to [[../Health/later]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(
      index.getBacklinks({ path: "Areas/Health/later.md" }, logger),
    ).toHaveLength(0)

    index.upsertNote(
      {
        filePath: "Areas/Health/later.md",
        rawContent: "# Later\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks(
      { path: "Areas/Health/later.md" },
      logger,
    )
    expect(backlinks).toEqual([
      { path: "Areas/Work/early.md", title: "early", bytes: 100 },
    ])
  })
})

describe("frontmatter links in the graph", () => {
  // Every fixture below gives the source a body with NO link to the target, so
  // the asserted edge can only come from the frontmatter wikilink — never from a
  // body link that happened to cover it.

  it("surfaces a frontmatter-only target in getOutgoingLinks", () => {
    index.upsertNote(
      {
        filePath: "session.md",
        rawContent:
          '---\ntitle: Session\nrelated: ["[[task-board]]"]\n---\n\n# Session\n\nProse with no links.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "task-board.md",
        rawContent: "# Task Board\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const links = index.getOutgoingLinks({ path: "session.md" }, logger)
    expect(links).toHaveLength(1)
    expect(links[0]?.path).toBe("task-board.md")
    expect(links[0]?.exists).toBe(true)
    expect(links[0]?.kind).toBe("note")
  })

  it("surfaces a frontmatter-only source in getBacklinks", () => {
    index.upsertNote(
      {
        filePath: "session.md",
        rawContent:
          '---\ntitle: Session\nrelated: ["[[task-board]]"]\n---\n\n# Session\n\nProse with no links.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "task-board.md",
        rawContent: "# Task Board\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "task-board.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("session.md")
  })

  it("does not flag a frontmatter-referenced note as an orphan, but still flags a truly unreferenced one", () => {
    index.upsertNote(
      {
        filePath: "referencer.md",
        rawContent:
          '---\ntitle: Referencer\nrelated: ["[[referenced]]"]\n---\n\n# Referencer\n\nNo body links.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "referenced.md",
        rawContent: "# Referenced\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "true-orphan.md",
        rawContent: "# True Orphan\n\nNobody links here.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    const orphanPaths = index
      .findOrphans({}, logger)
      .map((orphan) => orphan.path)
    // referenced only via frontmatter → connected, not an orphan
    expect(orphanPaths).not.toContain("referenced.md")
    // genuinely unreferenced → still an orphan (proves exclusion is selective)
    expect(orphanPaths).toContain("true-orphan.md")
  })

  it("counts a target linked from both body and frontmatter as a single edge", () => {
    index.upsertNote(
      {
        filePath: "double.md",
        rawContent:
          '---\ntitle: Double\nrelated: ["[[shared]]"]\n---\n\n# Double\n\nAlso links [[shared]] in the body.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "shared.md",
        rawContent: "# Shared\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "shared.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("double.md")
  })
})

describe("relative links (path from current file)", () => {
  // Obsidian's "Path from current file" format writes links relative to the
  // linking note. note.md links up and across to a sibling folder via
  // "../Health/target"; the target is indexed first so it exists at link time.
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Areas/Health/target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Areas/Work/note.md",
        rawContent: "# Note\n\nLinks to [[../Health/target]].\n",
        fileStat: testStat(2000),
      },
      logger,
    )
  })

  it("resolves the ../ link so the target lists the source as a backlink", () => {
    const backlinks = index.getBacklinks(
      { path: "Areas/Health/target.md" },
      logger,
    )
    expect(backlinks).toEqual([
      { path: "Areas/Work/note.md", title: "note", bytes: 100 },
    ])
  })

  it("resolves the ../ link so the source lists the target as an outgoing link", () => {
    const outgoing = index.getOutgoingLinks(
      { path: "Areas/Work/note.md" },
      logger,
    )
    expect(outgoing).toEqual([
      {
        path: "Areas/Health/target.md",
        title: "target",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })
})

// ── brokenLinkCount ─────────────────────────────────────────────

describe("brokenLinkCount", () => {
  it("returns 0 when all link targets exist", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[target]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("counts links to non-existent notes", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[missing-a]] and [[missing-b]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(2)
  })

  it("counts only broken links, not resolved ones", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[exists]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "exists.md",
        rawContent: "# Exists\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not count escaped-pipe wikilinks as broken when the target note exists", () => {
    index.upsertNote(
      {
        filePath: "dashboard.md",
        rawContent: "| Link |\n| --- |\n| [[sessions/log-a\\|log-a]] |\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "sessions/log-a.md",
        rawContent: "# Log A\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const outgoing = index.getOutgoingLinks({ path: "dashboard.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.path).toBe("sessions/log-a.md")
    expect(outgoing[0]!.exists).toBe(true)
    expect(outgoing[0]!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("does not count wikilinks to non-note files as broken when files are registered", () => {
    index.upsertNonMdFile("photo.png", 100)
    index.upsertNonMdFile("report.pdf", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          "# Source\n\n![[photo.png]] and [[report.pdf]] and [[real-note]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(3)
    const photo = outgoing.find((link) => link.path === "photo.png")
    expect(photo!.exists).toBe(true)
    expect(photo!.kind).toBe("file")
    const pdf = outgoing.find((link) => link.path === "report.pdf")
    expect(pdf!.exists).toBe(true)
    expect(pdf!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "real-note")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("excludes extensionless targets after upsertNonMdFile registers the file", () => {
    index.upsertNonMdFile("Trip Route.canvas", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Trip Route]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Trip Route.canvas")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "missing")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("upsertNonMdFile re-resolves previously unresolved links to non-md paths", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Route]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)

    index.upsertNonMdFile("Route.canvas", 100)
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.path).toBe("Route.canvas")
    expect(outgoing[0]!.exists).toBe(true)
    expect(outgoing[0]!.kind).toBe("file")
  })

  it("removeNonMdFile makes previously resolved file links broken again", () => {
    index.upsertNonMdFile("Route.canvas", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Route]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(0)

    index.removeNonMdFile("Route.canvas")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.exists).toBe(false)
    expect(outgoing[0]!.kind).toBe("note")
  })

  it("excludes forward-reference links that are valid dates under the daily note folder", () => {
    index.setDailyNotesFolder("Daily Notes")
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-06-24.md",
        rawContent:
          "# 2026-06-24\n\n[[Daily Notes/2026-06-25|Tomorrow >>]] and [[missing-note]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("excludes .md-suffixed forward-reference targets", () => {
    index.setDailyNotesFolder("Daily Notes")
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-06-24.md",
        rawContent:
          "# 2026-06-24\n\n[[Daily Notes/2026-06-25.md|Tomorrow >>]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("still counts broken links outside the daily note folder", () => {
    index.setDailyNotesFolder("Daily Notes")
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[missing-a]] and [[missing-b]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(2)
  })

  it("excludes all broken links under the daily notes folder, not just dates", () => {
    index.setDailyNotesFolder("Daily Notes")
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          "# Source\n\n[[Daily Notes/random-text]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.brokenLinkCount({}, logger)
    expect(result.count).toBe(1)
    expect(result.excludedCount).toBe(1)
  })

  it("counts all broken links when no daily note exclusion is set", () => {
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-06-24.md",
        rawContent:
          "# 2026-06-24\n\n[[Daily Notes/2026-06-25|Tomorrow >>]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(2)
  })
})

// ── modifiedOnDate ──────────────────────────────────────────────

describe("markdown-style links to non-md targets", () => {
  it("resolves a markdown image embed as a file", () => {
    index.upsertNonMdFile("pics/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          "# Source\n\n![photo](pics/photo.png) and [[genuinely-missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    // The broken control link proves link indexing ran — without it, a broken
    // count of 0 could come from extraction silently producing nothing.
    // Results order by target, so "genuinely-missing" sorts first.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "genuinely-missing",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
      {
        path: "pics/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves a markdown link to a PDF as a file", () => {
    index.upsertNonMdFile("papers/report.pdf", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\nSee [the paper](papers/report.pdf).\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "papers/report.pdf",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("percent-decodes a markdown file path with folders and spaces", () => {
    index.upsertNonMdFile("Trip Photos/pic 1.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![shot](Trip%20Photos/pic%201.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Trip Photos/pic 1.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("percent-decodes a markdown link to a note with spaces end-to-end", () => {
    index.upsertNote(
      {
        filePath: "My Note.md",
        rawContent: "# My Note\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[link](My%20Note.md)\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "My Note.md",
        title: "My Note",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("keeps markdown links to .md notes resolving with the target stored as written", () => {
    index.upsertNote(
      {
        filePath: "Projects/target.md",
        rawContent: "# Target\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[t](Projects/target.md)\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Projects/target.md",
        title: "target",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("resolves an extensionless markdown link like a wikilink", () => {
    index.upsertNote(
      {
        filePath: "Some Note.md",
        rawContent: "# Some Note\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[team notes](Some%20Note)\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Some Note.md",
        title: "Some Note",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("counts a markdown link to a missing file as broken with the target as written", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![x](missing.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "missing.png",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not index scheme-prefixed markdown targets as links", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          "# Source\n\n[o](obsidian://open?vault=v) [z](zotero://select/items/123) [f](ftp://host/file.pdf) [u](HTTPS://x.com/a.png) [[Control]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    // The Control wikilink proves link indexing ran — without it, both
    // assertions could pass from extraction silently producing nothing.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Control",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })
})

describe("file targets written with extensions", () => {
  it("resolves a wikilink embed by basename when the file lives in a subfolder", () => {
    index.upsertNonMdFile("attachments/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "attachments/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a markdown embed by basename when the file lives in a subfolder", () => {
    index.upsertNonMdFile("attachments/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![diagram](photo.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "attachments/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a relative file link against the source note's folder", () => {
    index.upsertNonMdFile("assets/photo.png", 100)
    index.upsertNote(
      {
        filePath: "A/note.md",
        rawContent: "# Note\n\n![x](../assets/photo.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "A/note.md" }, logger)).toEqual([
      {
        path: "assets/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a folder-qualified target with extension by path suffix", () => {
    index.upsertNonMdFile("deep/sub/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[sub/photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "deep/sub/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a shared basename deterministically to the shortest path", () => {
    index.upsertNonMdFile("bb/photo.png", 100)
    index.upsertNonMdFile("a/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "a/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("prefers a full-filename match over a multi-dot stem match", () => {
    // "photo.png.canvas" strips to base_path "photo.png" — the same text as
    // the target — so the stem tiers would hit it. The full-filename family
    // must win: the target names an actual .png that exists elsewhere.
    index.upsertNonMdFile("photo.png.canvas", 100)
    index.upsertNonMdFile("a/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "a/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("falls back to a multi-dot stem match when no full-filename match exists", () => {
    // With only photo.png.canvas in the vault, [[photo.png]] still resolves
    // via its stem — the same matching that gives [[Trip Route]] →
    // Trip Route.canvas. The stem tiers are a fallback, not dead code.
    index.upsertNonMdFile("photo.png.canvas", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo.png.canvas",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("does not resolve a basename whose extension differs from the file's", () => {
    index.upsertNonMdFile("attachments/photo.jpg", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    // The suffix match is on the full filename, not the extension-stripped
    // stem — photo.jpg must not satisfy a photo.png link.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo.png",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("upsertNonMdFile re-resolves a previously unresolved with-extension target", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)

    index.upsertNonMdFile("attachments/photo.png", 100)
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "attachments/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("does not let LIKE wildcards in the target match unrelated files via full-path suffix", () => {
    // Only photo1final.png exists — if the _ in the target were treated as a
    // LIKE wildcard it would match (1 satisfies _), giving a false resolution.
    index.upsertNonMdFile("img/photo1final.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo_final.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo_final.png",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })
})

describe("modifiedOnDate", () => {
  const midday = DateTime.fromISO("2026-06-15T12:00:00").toMillis()
  const lateEvening = DateTime.fromISO("2026-06-15T23:00:00").toMillis()
  const nextDayMorning = DateTime.fromISO("2026-06-16T08:00:00").toMillis()

  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "today-note.md",
        rawContent: "---\ntitle: Today\n---\n# Today\n",
        fileStat: testStat(midday),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "today-late.md",
        rawContent: "---\ntitle: Today Late\n---\n# Late\n",
        fileStat: testStat(lateEvening),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "tomorrow-note.md",
        rawContent: "---\ntitle: Tomorrow\n---\n# Tomorrow\n",
        fileStat: testStat(nextDayMorning),
      },
      logger,
    )
  })

  it("returns notes modified on the given date, ordered by mtime descending", () => {
    const results = index.modifiedOnDate({ date: "2026-06-15" }, logger)
    const paths = results.map((note) => note.path)
    expect(paths).toEqual(["today-late.md", "today-note.md"])
  })

  it("excludes notes modified on other dates", () => {
    const results = index.modifiedOnDate({ date: "2026-06-15" }, logger)
    const paths = results.map((note) => note.path)
    expect(paths).not.toContain("tomorrow-note.md")
  })

  it("respects the limit parameter", () => {
    const results = index.modifiedOnDate(
      { date: "2026-06-15", limit: 1 },
      logger,
    )
    const paths = results.map((note) => note.path)
    expect(paths).toEqual(["today-late.md"])
  })

  it("returns empty array for a date with no modifications", () => {
    const results = index.modifiedOnDate({ date: "2020-01-01" }, logger)
    expect(results).toEqual([])
  })
})

// ── vaultStats ──────────────────────────────────────────────────

describe("vaultStats", () => {
  it("returns correct total note count", () => {
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\ntags: [one]\nstatus: active\n---\n# A\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\ntags: [two]\n---\n# B\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const stats = index.vaultStats({}, logger)
    expect(stats.totalNotes).toBe(2)
  })

  it("counts untagged notes", () => {
    index.upsertNote(
      {
        filePath: "tagged.md",
        rawContent: "---\ntags: [one]\n---\n# Tagged\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "untagged.md",
        rawContent: "# Untagged\n\nNo frontmatter.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const stats = index.vaultStats({}, logger)
    expect(stats.untaggedNotes).toBe(1)
  })

  it("counts notes without frontmatter properties", () => {
    index.upsertNote(
      {
        filePath: "with-props.md",
        rawContent: "---\nstatus: active\n---\n# Props\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "no-props.md",
        rawContent: "# Bare\n\nNo frontmatter at all.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const stats = index.vaultStats({}, logger)
    expect(stats.noPropertiesNotes).toBe(1)
  })

  it("returns all zeros on an empty index", () => {
    const stats = index.vaultStats({}, logger)
    expect(stats).toEqual({
      totalNotes: 0,
      untaggedNotes: 0,
      noPropertiesNotes: 0,
    })
  })
})

// ── Embedding pipeline ───────────────────────────────────────────

describe("embedding pipeline", () => {
  const DIMENSIONS = 384

  /** Creates a mock embedder that returns deterministic embeddings. */
  const createMockEmbedder = () => ({
    embedText: vi
      .fn()
      .mockResolvedValue(new Float32Array(DIMENSIONS).fill(0.1)),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map(() => new Float32Array(DIMENSIONS).fill(0.1)),
        ),
      ),
  })

  const NOTE_FOR_EMBEDDING = `---
title: Test Note
tags: [test]
---

This is a test note with enough content to be indexed.
It has multiple sentences to verify chunking works correctly.
`

  describe("with embedder", () => {
    it("embedNote calls the embedder when provided", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )

      expect(mockEmbedder.embedText).toHaveBeenCalled()
    })

    it("content-hash gating skips unchanged chunks on re-embed", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      // First embed
      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )
      const firstCallCount = mockEmbedder.embedText.mock.calls.length

      // Second embed with same content — should skip (hash match)
      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )
      const secondCallCount = mockEmbedder.embedText.mock.calls.length

      expect(secondCallCount).toBe(firstCallCount)
    })

    it("re-embeds when content changes", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )
      const firstCallCount = mockEmbedder.embedText.mock.calls.length

      const updatedNote = NOTE_FOR_EMBEDDING.replace(
        "multiple sentences",
        "different content entirely",
      )
      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: updatedNote },
        logger,
      )
      const secondCallCount = mockEmbedder.embedText.mock.calls.length

      expect(secondCallCount).toBeGreaterThan(firstCallCount)
    })

    it("removeNote deletes associated chunks and vectors", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      embeddingIndex.upsertNote(
        {
          filePath: "test.md",
          rawContent: NOTE_FOR_EMBEDDING,
          fileStat: testStat(1000),
        },
        logger,
      )
      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )

      // Remove should not throw — cleanup should succeed
      embeddingIndex.removeNote("test.md")

      // Re-embedding after removal should embed again (not skip via hash)
      mockEmbedder.embedText.mockClear()
      embeddingIndex.upsertNote(
        {
          filePath: "test.md",
          rawContent: NOTE_FOR_EMBEDDING,
          fileStat: testStat(2000),
        },
        logger,
      )
      await embeddingIndex.embedNote(
        { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalled()
    })

    it("embedNote produces a chunk even for empty content", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      await embeddingIndex.embedNote(
        { notePath: "empty.md", rawContent: "" },
        logger,
      )

      // chunker returns at least one chunk (the title-only fallback), so
      // embedText is called even for empty content
      expect(mockEmbedder.embedText).toHaveBeenCalled()
    })

    it("embedNote propagates embedder errors to the caller", async () => {
      const mockEmbedder = createMockEmbedder()
      mockEmbedder.embedText.mockRejectedValueOnce(
        new Error("embedding failed"),
      )
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      await expect(
        embeddingIndex.embedNote(
          { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
          logger,
        ),
      ).rejects.toThrow("embedding failed")
    })
  })

  describe("without embedder", () => {
    it("embedNote is a no-op when no embedder is provided", async () => {
      const noEmbedIndex = createSearchIndex(":memory:")

      await expect(
        noEmbedIndex.embedNote(
          { notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
          logger,
        ),
      ).resolves.toBeUndefined()
    })

    it("removeNote works without vector tables", () => {
      const noEmbedIndex = createSearchIndex(":memory:")

      noEmbedIndex.upsertNote(
        {
          filePath: "test.md",
          rawContent: NOTE_FOR_EMBEDDING,
          fileStat: testStat(1000),
        },
        logger,
      )

      noEmbedIndex.removeNote("test.md")

      // Verify the note was actually removed from the FTS index
      const results = noEmbedIndex.fullTextSearch(
        { query: "test note" },
        logger,
      )
      expect(results).toHaveLength(0)
    })
  })

  describe("rebuildFromVault with embedding", () => {
    it("embeds notes during rebuild Pass 3", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const vaultDir = await mkdtemp(join(tmpdir(), "embed-test-"))
      onTestFinished(async () => {
        await rm(vaultDir, { recursive: true })
      })

      await writeFile(
        join(vaultDir, "note1.md"),
        "---\ntitle: Note 1\n---\nFirst note content here.",
      )
      await writeFile(
        join(vaultDir, "note2.md"),
        "---\ntitle: Note 2\n---\nSecond note content here.",
      )

      const { count, embedding } = await embeddingIndex.rebuildFromVault(
        { vaultPath: vaultDir },
        logger,
      )
      await embedding

      expect(count).toBe(2)
      // Both notes are short → 1 chunk each → exactly 2 embedText calls
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(2)
    })

    it("continues embedding remaining notes when one fails during rebuild", async () => {
      const mockEmbedder = createMockEmbedder()
      // First embedText call rejects, subsequent calls use the default (resolve)
      mockEmbedder.embedText.mockRejectedValueOnce(
        new Error("embedding failed"),
      )
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const vaultDir = await mkdtemp(join(tmpdir(), "embed-err-"))
      onTestFinished(async () => {
        await rm(vaultDir, { recursive: true })
      })

      await writeFile(
        join(vaultDir, "note1.md"),
        "---\ntitle: Note 1\n---\nFirst note content.",
      )
      await writeFile(
        join(vaultDir, "note2.md"),
        "---\ntitle: Note 2\n---\nSecond note content.",
      )

      const warnSpy = vi.spyOn(logger, "warn")
      const { count, embedding } = await embeddingIndex.rebuildFromVault(
        { vaultPath: vaultDir },
        logger,
      )
      await embedding

      expect(count).toBe(2)
      // One note failed, warn logged with the specific error
      expect(warnSpy).toHaveBeenCalledWith(
        "failed to embed note",
        expect.objectContaining({ error: "[Error]: embedding failed" }),
      )
      // Both notes attempted embedding (first failed, second succeeded)
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(2)
      warnSpy.mockRestore()
    })
  })
})

describe("fullTextSearch created filter", () => {
  const noteCreatedOn = (createdDate: string): string => `---
title: Dated note
created: ${createdDate}
---
Shared datefilter content for boundary tests.
`

  const NOTE_WITHOUT_CREATED = `# Undated note

Shared datefilter content for boundary tests.
`

  /** Seeds three dated notes (2026-03-09 / -10 / -11) plus one without a
   *  created property, all matching the "datefilter" query term. */
  const indexWithCreatedDates = (): SearchIndex => {
    const dateIndex = createSearchIndex(":memory:")
    dateIndex.upsertNote(
      {
        filePath: "early.md",
        rawContent: noteCreatedOn("2026-03-09"),
        fileStat: testStat(1000),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "middle.md",
        rawContent: noteCreatedOn("2026-03-10"),
        fileStat: testStat(1000),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "late.md",
        rawContent: noteCreatedOn("2026-03-11"),
        fileStat: testStat(1000),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "undated.md",
        rawContent: NOTE_WITHOUT_CREATED,
        fileStat: testStat(1000),
      },
      logger,
    )
    return dateIndex
  }

  it("created.on matches only notes created on that calendar day", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { on: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["middle.md"])
  })

  it("created.before is exclusive of the boundary day", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { before: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["early.md"])
  })

  it("created.after is exclusive of the boundary day", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { after: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["late.md"])
  })

  it("created before and after combine into a range", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { created: { after: "2026-03-09", before: "2026-03-11" } },
      },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["middle.md"])
  })

  it("a created filter never matches notes without a created property", () => {
    const dateIndex = indexWithCreatedDates()
    // Bound satisfied by every dated note — only the undated note can be
    // excluded, proving NULL exclusion rather than an over-tight bound
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { before: "2099-01-01" } } },
      logger,
    )
    const resultPaths = results.map((result) => result.path)
    expect(resultPaths.toSorted()).toEqual(["early.md", "late.md", "middle.md"])
  })

  it("created.on matches on the calendar day of a created value with a time component", () => {
    const dateIndex = createSearchIndex(":memory:")
    dateIndex.upsertNote(
      {
        filePath: "timed.md",
        rawContent: noteCreatedOn("2026-03-10T23:45:00"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // A neighbor on the adjacent day proves the filter actually ran —
    // without it, an ignored filter would return the same single result
    dateIndex.upsertNote(
      {
        filePath: "next-day.md",
        rawContent: noteCreatedOn("2026-03-11T00:15:00"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { on: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["timed.md"])
  })

  it("rejects a malformed created date with remediation text", () => {
    const dateIndex = indexWithCreatedDates()
    expect(() =>
      dateIndex.fullTextSearch(
        { query: "datefilter", filters: { created: { on: "March 10" } } },
        logger,
      ),
    ).toThrow(
      'invalid created.on date: "March 10". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })

  it("rejects a calendar-invalid created date", () => {
    const dateIndex = indexWithCreatedDates()
    expect(() =>
      dateIndex.fullTextSearch(
        {
          query: "datefilter",
          filters: { created: { before: "2026-02-31" } },
        },
        logger,
      ),
    ).toThrow(
      'invalid created.before date: "2026-02-31". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })
})

describe("fullTextSearch modified filter", () => {
  const noteModifiedAt = (title: string): string => `---
title: ${title}
tags: [datefilter-test]
---
Shared datefilter content for mtime boundary tests.
`

  /** Seeds three notes stat-stamped minutes around the 2026-06-15 day
   *  boundaries: 23:59 the day before, midday, and 00:30 the day after —
   *  so an off-by-one on either boundary flips a test. */
  const indexWithModifiedTimes = (): SearchIndex => {
    const dateIndex = createSearchIndex(":memory:")
    dateIndex.upsertNote(
      {
        filePath: "day-before.md",
        rawContent: noteModifiedAt("Day before"),
        fileStat: testStat(DateTime.fromISO("2026-06-14T23:59:00").toMillis()),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "during.md",
        rawContent: noteModifiedAt("During"),
        fileStat: testStat(DateTime.fromISO("2026-06-15T12:00:00").toMillis()),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "day-after.md",
        rawContent: noteModifiedAt("Day after"),
        fileStat: testStat(DateTime.fromISO("2026-06-16T00:30:00").toMillis()),
      },
      logger,
    )
    return dateIndex
  }

  it("modified.on matches notes touched within that server-local day", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { modified: { on: "2026-06-15" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["during.md"])
  })

  it("modified.before matches strictly earlier days", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { modified: { before: "2026-06-15" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["day-before.md"])
  })

  it("modified.after matches strictly later days", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { modified: { after: "2026-06-15" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["day-after.md"])
  })

  it("modified after and before combine into a range", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { modified: { after: "2026-06-14", before: "2026-06-16" } },
      },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["during.md"])
  })

  it("rejects a malformed modified date with remediation text", () => {
    const dateIndex = indexWithModifiedTimes()
    expect(() =>
      dateIndex.fullTextSearch(
        { query: "datefilter", filters: { modified: { after: "yesterday" } } },
        logger,
      ),
    ).toThrow(
      'invalid modified.after date: "yesterday". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })

  it("rejects a calendar-invalid modified date", () => {
    const dateIndex = indexWithModifiedTimes()
    expect(() =>
      dateIndex.fullTextSearch(
        {
          query: "datefilter",
          filters: { modified: { before: "2026-02-31" } },
        },
        logger,
      ),
    ).toThrow(
      'invalid modified.before date: "2026-02-31". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })

  it("date filters AND-combine with other filters and the text query", () => {
    const dateIndex = indexWithModifiedTimes()
    // All three notes carry the datefilter-test tag — with the tag filter
    // satisfied, only the date bound can narrow the results to during.md
    const tagMatchedResults = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { modified: { on: "2026-06-15" }, tags: ["datefilter-test"] },
      },
      logger,
    )
    expect(tagMatchedResults.map((result) => result.path)).toEqual([
      "during.md",
    ])
    // And the reverse: during.md matches the modified bound but lacks the
    // required tag — the tag filter must exclude it despite the date match
    const tagExcludedResults = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { modified: { on: "2026-06-15" }, tags: ["nonexistent-tag"] },
      },
      logger,
    )
    expect(tagExcludedResults).toHaveLength(0)
  })
})

describe("hybridSearch", () => {
  const EMBEDDING_DIMENSIONS = 384

  /** Creates a mock embedder where all texts get the same embedding (distance 0
   *  between any two notes). For tests that need differentiated distances, override
   *  embedText after creation. */
  const createHybridMockEmbedder = () => ({
    embedText: vi
      .fn()
      .mockResolvedValue(new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
        ),
      ),
  })

  /** Generates a unique embedding by setting one dimension to 1.0 based on seed. */
  const seededEmbedding = (seed: number): Float32Array => {
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS).fill(0)
    embedding[seed % EMBEDDING_DIMENSIONS] = 1.0
    return embedding
  }

  const NOTE_A = `---
title: Career Goals
tags: [personal, career]
type: reflection
---

I aspire to build meaningful products and grow as a technical leader.
My targets include shipping a major open source project.
`

  const NOTE_B = `---
title: Project Ideas
tags: [ideas]
type: brainstorm
---

Some project ideas for the next quarter. Build a CLI tool for vault management.
`

  const NOTE_C = `---
title: Meeting Notes
tags: [work, meetings]
type: meeting
related: ["[[Projects/alpha.md]]"]
---

Discussed the deployment timeline and infrastructure costs. Need to follow up on
the Lightsail budget estimates for next quarter.
`

  describe("fallback to FTS-only", () => {
    it("returns FTS results when no embedder is provided", async () => {
      const ftsIndex = createSearchIndex(":memory:")
      ftsIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )

      const { results, search_mode } = await ftsIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["a.md"])
      expect(search_mode).toBe("fts")
    })

    it("returns FTS results when embedder exists but no vectors indexed", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)
      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      // upsertNote doesn't embed — vectors are empty

      const { results, search_mode } = await hybridIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["a.md"])
      expect(search_mode).toBe("fts")
      expect(mockEmbedder.embedText).toHaveBeenCalled()
    })

    it("returns FTS results when embedder fails", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      mockEmbedder.embedText.mockRejectedValue(new Error("model unavailable"))
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)
      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const { results, search_mode } = await hybridIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["a.md"])
      expect(search_mode).toBe("fts")
      expect(warnSpy).toHaveBeenCalledWith(
        "vector search failed, falling back to FTS-only",
        expect.objectContaining({ error: "[Error]: model unavailable" }),
      )
    })
  })

  describe("hybrid ranking", () => {
    it("boosts results that appear in both FTS and vector search", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(1000) },
        logger,
      )

      // Embed both notes (same embedding = both match any query equally)
      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      // Query that matches NOTE_A via FTS ("career goals") and both via vector
      const { results, search_mode } = await hybridIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(search_mode).toBe("hybrid")
      expect(results).toHaveLength(2)
      // a.md appears in both FTS and vector → higher RRF score → ranked first
      expect(results[0]?.path).toBe("a.md")
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)
    })

    it("includes vector-only results with full metadata", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      // Query that matches b.md via FTS ("project ideas CLI") and both via vector
      const { results } = await hybridIndex.hybridSearch(
        { query: "project ideas CLI" },
        logger,
      )

      expect(results).toHaveLength(2)
      // b.md matches both FTS + vector → ranked first; a.md is vector-only
      expect(results.map((result) => result.path)).toEqual(["b.md", "a.md"])

      // Vector-only result (a.md — no FTS match for "project ideas CLI")
      // should carry full metadata from the notes table
      const vectorOnlyResult = results.find((result) => result.path === "a.md")
      if (!vectorOnlyResult) throw new Error("expected a.md in results")
      expect(vectorOnlyResult).toEqual(
        expect.objectContaining({
          path: "a.md",
          title: "Career Goals",
          tags: ["personal", "career"],
          folder: "",
          type: "reflection",
          bytes: 100,
          modified: DateTime.fromMillis(1000).toISO(),
        }),
      )
      expect(vectorOnlyResult.score).toBeGreaterThan(0)
    })

    it("generates snippets from chunk text for vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      // Embed call 1 (a.md chunk): seed 0
      // Embed call 2 (c.md chunk): seed 1
      // Embed call 3+ (query): seed 0 — matches a.md exactly (distance 0)
      let embedCallIndex = 0
      mockEmbedder.embedText.mockImplementation(() => {
        const seed = embedCallIndex === 1 ? 1 : 0
        embedCallIndex++
        return Promise.resolve(seededEmbedding(seed))
      })

      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      // Query that doesn't match any note via FTS — results are vector-only
      const { results } = await hybridIndex.hybridSearch(
        { query: "zzz_no_fts_match" },
        logger,
      )

      // a.md should appear (closest vector match) with a snippet from its chunk
      const noteA = results.find((result) => result.path === "a.md")
      if (!noteA) throw new Error("expected a.md in results")
      // Default snippet_tokens is 30 — chunk text is title-prefixed body,
      // well under 30 words, so no truncation
      expect(noteA.snippet).toBe(
        "Career Goals I aspire to build meaningful products and grow as a technical leader. My targets include shipping a major open source project.",
      )
    })
  })

  describe("filters", () => {
    it("applies folder filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteInFolder = `---
title: Inside Folder
tags: [test]
---
Content about deployment costs and infrastructure.
`
      const noteOutsideFolder = `---
title: Outside Folder
tags: [test]
---
Content about deployment costs and infrastructure.
`

      hybridIndex.upsertNote(
        {
          filePath: "Work/inside.md",
          rawContent: noteInFolder,
          fileStat: testStat(1000),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "Personal/outside.md",
          rawContent: noteOutsideFolder,
          fileStat: testStat(1000),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "Work/inside.md", rawContent: noteInFolder },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "Personal/outside.md", rawContent: noteOutsideFolder },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment costs", filters: { folder: "Work" } },
        logger,
      )

      // Only the note inside Work/ should appear
      const paths = results.map((result) => result.path)
      expect(paths).toContain("Work/inside.md")
      expect(paths).not.toContain("Personal/outside.md")
    })

    it("applies tag filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment infrastructure", filters: { tags: ["work"] } },
        logger,
      )

      // Only c.md has the "work" tag — a.md (tags: personal, career) excluded
      const paths = results.map((result) => result.path)
      expect(paths).toContain("c.md")
      expect(paths).not.toContain("a.md")
    })

    it("applies type filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment timeline", filters: { type: "meeting" } },
        logger,
      )

      // Only c.md is type "meeting" — a.md (type: reflection) excluded
      const paths = results.map((result) => result.path)
      expect(paths).toContain("c.md")
      expect(paths).not.toContain("a.md")
    })

    it("applies created filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteCreatedOn = (createdDate: string): string => `---
title: Dated
created: ${createdDate}
---
Content about quarterly planning and roadmaps.
`

      hybridIndex.upsertNote(
        {
          filePath: "on-day.md",
          rawContent: noteCreatedOn("2026-03-10"),
          fileStat: testStat(1000),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "other-day.md",
          rawContent: noteCreatedOn("2026-03-11"),
          fileStat: testStat(1000),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "on-day.md", rawContent: noteCreatedOn("2026-03-10") },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "other-day.md", rawContent: noteCreatedOn("2026-03-11") },
        logger,
      )

      // Query with no FTS match — results arrive exclusively via the vector
      // leg, so the TypeScript filter mirror is the only gate
      const { results } = await hybridIndex.hybridSearch(
        {
          query: "zzz_no_fts_match",
          filters: { created: { on: "2026-03-10" } },
        },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["on-day.md"])
    })

    it("applies modified filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteBody = `---
title: Timestamped
---
Content about quarterly planning and roadmaps.
`

      hybridIndex.upsertNote(
        {
          filePath: "during.md",
          rawContent: noteBody,
          fileStat: testStat(
            DateTime.fromISO("2026-06-15T12:00:00").toMillis(),
          ),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "day-after.md",
          rawContent: noteBody,
          fileStat: testStat(
            DateTime.fromISO("2026-06-16T00:30:00").toMillis(),
          ),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "during.md", rawContent: noteBody },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "day-after.md", rawContent: noteBody },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "zzz_no_fts_match",
          filters: { modified: { on: "2026-06-15" } },
        },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["during.md"])
    })

    it("rejects a malformed date filter through hybridSearch", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      // The validation throw must escape hybridSearch — not be swallowed by
      // fullTextSearch's DB-error fallback or the FTS-only fallback path
      await expect(
        hybridIndex.hybridSearch(
          { query: "anything", filters: { modified: { on: "bad" } } },
          logger,
        ),
      ).rejects.toThrow(
        'invalid modified.on date: "bad". Use YYYY-MM-DD (e.g. 2026-07-03).',
      )
    })
  })

  describe("limit and deduplication", () => {
    it("respects the user limit after fusion", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "project", filters: { limit: 1 } },
        logger,
      )

      expect(results).toHaveLength(1)
    })

    it("deduplicates to one result per note", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      // A long note produces multiple chunks — each could match in KNN
      const longNote = `---
title: Long Document
tags: [test]
---

## Section One

This section discusses project management and team coordination.
We need to ensure all stakeholders are aligned on the timeline.

## Section Two

This section covers deployment strategies and infrastructure.
The deployment pipeline should be automated for efficiency.

## Section Three

This section is about monitoring and observability patterns.
We should track latency and error rates across all services.
`

      hybridIndex.upsertNote(
        { filePath: "long.md", rawContent: longNote, fileStat: testStat(1000) },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "long.md", rawContent: longNote },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment" },
        logger,
      )

      // Even with multiple chunks, the note appears only once
      const longNoteResults = results.filter(
        (result) => result.path === "long.md",
      )
      expect(longNoteResults).toHaveLength(1)
    })
  })

  describe("include_leading_callout", () => {
    it("includes leading callout for vector-only results when requested", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteWithCallout = `---
title: Reference Doc
tags: [reference]
---

> [!info] Quick reference
> This is a reference document about API design patterns.

The main content discusses RESTful API design and GraphQL alternatives.
`
      hybridIndex.upsertNote(
        {
          filePath: "ref.md",
          rawContent: noteWithCallout,
          fileStat: testStat(1000),
        },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "ref.md", rawContent: noteWithCallout },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "API design patterns",
          filters: { include_leading_callout: true },
        },
        logger,
      )

      const refResult = results.find((result) => result.path === "ref.md")
      if (!refResult) throw new Error("expected ref.md in results")
      expect(refResult.leading_callout).toEqual({
        type: "info",
        title: "Quick reference",
        body: "This is a reference document about API design patterns.",
      })
    })
  })

  describe("filters — related and properties", () => {
    it("applies related filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "deployment infrastructure",
          filters: { related: ["[[Projects/alpha.md]]"] },
        },
        logger,
      )

      // Only c.md has the related link — a.md has no related field
      const paths = results.map((result) => result.path)
      expect(paths).toContain("c.md")
      expect(paths).not.toContain("a.md")
    })

    it("applies properties filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteWithProperty = `---
title: Active Project
tags: [project]
status: active
---

This project is currently in development with active deployment work.
`
      const noteWithoutProperty = `---
title: Archived Project
tags: [project]
status: archived
---

This project is no longer maintained but had deployment infrastructure.
`

      hybridIndex.upsertNote(
        {
          filePath: "active.md",
          rawContent: noteWithProperty,
          fileStat: testStat(1000),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "archived.md",
          rawContent: noteWithoutProperty,
          fileStat: testStat(1000),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "active.md", rawContent: noteWithProperty },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "archived.md", rawContent: noteWithoutProperty },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "deployment",
          filters: { properties: { status: "active" } },
        },
        logger,
      )

      // Only active.md has status: active
      const paths = results.map((result) => result.path)
      expect(paths).toContain("active.md")
      expect(paths).not.toContain("archived.md")
    })
  })

  describe("snippet_tokens", () => {
    it("truncates vector-only snippets to the specified token count", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const verboseNote = `---
title: Verbose Note
tags: [test]
---

This is a note with many words that should be truncated when using a small snippet token limit for vector-only results.
`

      hybridIndex.upsertNote(
        {
          filePath: "verbose.md",
          rawContent: verboseNote,
          fileStat: testStat(1000),
        },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "verbose.md", rawContent: verboseNote },
        logger,
      )

      // Query that won't match via FTS — forces vector-only result path
      const { results } = await hybridIndex.hybridSearch(
        { query: "zzz_no_fts_match", filters: { snippet_tokens: 5 } },
        logger,
      )

      const verboseResult = results.find(
        (result) => result.path === "verbose.md",
      )
      if (!verboseResult) throw new Error("expected verbose.md in results")
      // buildSnippetFromChunkText takes first 5 words of the chunk text
      // (title-prefixed body) and appends "..."
      expect(verboseResult.snippet).toBe("Verbose Note This is a...")
    })
  })

  describe("reranking", () => {
    const createMockReranker = (scores: number[]) => ({
      rerankPairs: vi.fn().mockResolvedValue(scores),
    })

    it("sets reranked to true when reranker is present and vectors exist", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const mockReranker = createMockReranker([0.9, 0.1])
      const rerankedIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )
      rerankedIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rerankedIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rerankedIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rerankedIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      const { reranked } = await rerankedIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )
      expect(reranked).toBe(true)
    })

    it("sets reranked to false on FTS-only fallback", async () => {
      const noEmbedIndex = createSearchIndex(":memory:")
      noEmbedIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )

      const { reranked, search_mode } = await noEmbedIndex.hybridSearch(
        { query: "career" },
        logger,
      )
      expect(search_mode).toBe("fts")
      expect(reranked).toBe(false)
    })

    it("sets reranked to false when embedder exists but no reranker", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const noRerankerIndex = createSearchIndex(":memory:", mockEmbedder)
      noRerankerIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      await noRerankerIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )

      const { reranked } = await noRerankerIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )
      expect(reranked).toBe(false)
    })

    it("falls back gracefully when reranker throws", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const failingReranker = {
        rerankPairs: vi
          .fn()
          .mockRejectedValue(new Error("model failed to load")),
      }
      const failIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        failingReranker,
      )
      failIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      failIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await failIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await failIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      const warnSpy = vi.spyOn(logger, "warn")
      const { results, reranked } = await failIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(reranked).toBe(false)
      expect(results).toHaveLength(2)
      expect(warnSpy).toHaveBeenCalledWith(
        "reranker failed, using RRF-only ordering",
        expect.objectContaining({ error: "[Error]: model failed to load" }),
      )
      warnSpy.mockRestore()
    })

    it("calls rerankPairs with query and document texts", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const mockReranker = createMockReranker([0.9, 0.1])
      const rerankIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )
      rerankIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rerankIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      await rerankIndex.hybridSearch({ query: "career goals" }, logger)

      expect(mockReranker.rerankPairs).toHaveBeenCalledOnce()
      const callArgs = mockReranker.rerankPairs.mock.calls[0]
      expect(callArgs).toBeDefined()
      const [query, documents] = callArgs ?? []
      expect(query).toBe("career goals")
      expect(documents).toHaveLength(2)
      // Each document text should be non-empty (chunk text from vector hits)
      expect(documents.every((document: string) => document.length > 0)).toBe(
        true,
      )
    })

    it("modifies result scores compared to RRF-only ordering", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      // Reranker strongly favors b.md (index 1) over a.md (index 0)
      const mockReranker = createMockReranker([0.1, 0.9])
      const rerankIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )
      rerankIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rerankIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      // Get RRF-only scores (no reranker)
      const rrfOnlyIndex = createSearchIndex(":memory:", mockEmbedder)
      rrfOnlyIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rrfOnlyIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rrfOnlyIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rrfOnlyIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      const { results: rrfResults } = await rrfOnlyIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )
      const { results: rerankedResults, reranked } =
        await rerankIndex.hybridSearch({ query: "career goals" }, logger)

      expect(reranked).toBe(true)

      // Reranking must produce different scores from RRF-only — proves
      // tryRerank actually modified the results, not just set the flag
      const rrfScoreForA = rrfResults.find(
        (result) => result.path === "a.md",
      )?.score
      const rerankedScoreForA = rerankedResults.find(
        (result) => result.path === "a.md",
      )?.score
      expect(rerankedScoreForA).not.toBe(rrfScoreForA)
    })

    it("skips reranking when only one result in merged set", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const mockReranker = createMockReranker([0.9])
      const singleResultIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )

      // Only index one note so only one result can appear
      singleResultIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      await singleResultIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )

      const { reranked, results } = await singleResultIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results).toHaveLength(1)
      expect(reranked).toBe(false)
      // The reranker should not have been called — mergedResults.length <= 1
      expect(mockReranker.rerankPairs).not.toHaveBeenCalled()
    })
  })
})
