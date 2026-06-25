import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  onTestFinished,
} from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { createSearchIndex, sanitizeFtsQuery } from "../search-index.js"
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
  it("creates without throwing", () => {
    expect(() => createSearchIndex(":memory:")).not.toThrow()
  })

  it("creates notes and notes_fts tables", () => {
    index.upsertNote(
      { filePath: "test.md", rawContent: "# Test\n", fileStat: testStat(1000) },
      logger,
    )
    const results = index.fullTextSearch({ query: "Test" }, logger)
    expect(results).toHaveLength(1)
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
    expect(results[0].leading_callout).toEqual({
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
    expect(results[0].leading_callout).toBeNull()
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
    expect(withoutFlag[0].leading_callout).toBeUndefined()

    const withFlag = index.fullTextSearch(
      { query: "burnout", filters: { include_leading_callout: true } },
      logger,
    )
    expect(withFlag[0].leading_callout?.title).toBe("Scope of this file")
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
    expect(results[0].leading_callout?.title).toBe("Scope of this file")
    expect(results[0].bytes).toBe(100)
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
    expect(results[0].bytes).toBe(42)
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
    expect(results[0].bytes).toBe(256)
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
    expect(results[0].bytes).toBe(128)
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
    expect(results[0].bytes).toBe(0)
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
    expect(results[0].path).toBe("About Me/Principles.md")
    expect(results[0].title).toBe("Principles")
    expect(results[0].tags).toEqual(["principles", "self"])
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
    expect(results[0].title).toBe("Principles")
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
    expect(results[0].title).toBe("random")
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
    expect(results[0].folder).toBe("About Me")
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
    expect(recent[0].folder).toBe("")
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
    expect(results[0].title).toBe("V2")
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
    expect(results[0].tags).toEqual([])
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
    expect(results[0].path).toBe("About Me/Principles.md")
  })

  it("finds notes by title", () => {
    const results = index.fullTextSearch({ query: "Principles" }, logger)
    expect(results).toHaveLength(1)
  })

  it("returns snippets without HTML markup", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0].snippet).not.toContain("<mark>")
    expect(results[0].snippet).toContain("burnout")
  })

  it("includes type in search results", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0].type).toBe("about-me")
  })

  it("rounds score to at most 4 significant figures", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    const score = results[0].score
    expect(score).toBe(Number(score.toPrecision(4)))
  })

  it("omits created when null", () => {
    const results = index.fullTextSearch({ query: "content without" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]).not.toHaveProperty("created")
  })

  it("includes created when present", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]).toHaveProperty("created")
    expect(results[0].created).toContain("2025")
  })

  it("returns modified as ISO 8601 string", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(typeof results[0].modified).toBe("string")
    expect(results[0].modified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
    expect(long[0].snippet.length).toBeGreaterThan(short[0].snippet.length)
  })

  it("respects folder filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "Projects" } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("Projects/notes.md")
  })

  it("respects tags filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { tags: ["project"] } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("Projects/notes.md")
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
    expect(results[0].path).toBe("About Me/Principles.md")
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
    expect(results[0].path).toBe("spread.md")
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
    expect(results[0].path).toBe("project.md")
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
    expect(results[0].path).toBe("directories.md")
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
    expect(results[0].path).toBe("garden/layout.md")
  })

  it("finds a note by a status value that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "overdue" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("garden/fence.md")
  })

  it("finds a note by a tag that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "xeriscaping" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("garden/layout.md")
  })

  it("finds a note by a frontmatter key name", () => {
    const results = index.fullTextSearch({ query: "lifecycle" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("garden/layout.md")
  })

  it("cross-field query matches a frontmatter term + body term together", () => {
    const results = index.fullTextSearch({ query: "compost gypsum" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("garden/notes.md")
  })

  it("snippet contains body text, not metadata, for a frontmatter-only match", () => {
    const results = index.fullTextSearch({ query: "overdue" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].snippet).not.toContain("status")
    expect(results[0].snippet).not.toContain("overdue")
    expect(results[0].snippet).toContain("rotted posts")
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
    expect(results[0].path).toBe("garden/layout.md")
  })
})

describe("sanitizeFtsQuery", () => {
  const scenarios = [
    {
      name: "multi-word: unquoted terms joined with spaces",
      input: "burnout boundaries",
      expected: "burnout boundaries",
    },
    {
      name: "single word: passthrough unquoted for stemming",
      input: "single",
      expected: "single",
    },
    {
      name: "quoted phrase: preserved",
      input: '"machine learning"',
      expected: '"machine learning"',
    },
    {
      name: "phrase + unquoted term",
      input: '"machine learning" kubernetes',
      expected: '"machine learning" kubernetes',
    },
    {
      name: "FTS5 specials stripped, reserved words dropped",
      input: 'test "quoted" AND (grouped)',
      expected: '"quoted" test grouped',
    },
    {
      name: "wildcard stripped",
      input: "burn*",
      expected: "burn",
    },
    {
      name: "all reserved words: empty result",
      input: "AND OR NOT",
      expected: '""',
    },
    {
      name: "empty string: empty result",
      input: "",
      expected: '""',
    },
    {
      name: "caret and colon stripped",
      input: "field:value ^boost",
      expected: "field value boost",
    },
    {
      name: "hyphenated compound → quoted phrase",
      input: "vault-cortex",
      expected: '"vault cortex"',
    },
    {
      name: "multi-hyphen compound → quoted phrase",
      input: "self-hosted-app",
      expected: '"self hosted app"',
    },
    {
      name: "hyphenated + bare terms",
      input: "vault-cortex search",
      expected: '"vault cortex" search',
    },
    {
      name: "multiple hyphenated terms",
      input: "vault-cortex self-hosted",
      expected: '"vault cortex" "self hosted"',
    },
    {
      name: "leading hyphen stripped",
      input: "-excluded term",
      expected: "excluded term",
    },
    {
      name: "hyphen inside quoted phrase preserved",
      input: '"vault-cortex"',
      expected: '"vault-cortex"',
    },
    {
      name: "mixed: quoted phrase + hyphenated + bare",
      input: 'search "exact-match" vault-cortex',
      expected: '"exact-match" "vault cortex" search',
    },
    {
      name: "dotted domain → quoted phrase",
      input: "mcpservers.org",
      expected: '"mcpservers org"',
    },
    {
      name: "dotted domain + bare terms (live failure 2026-06-09)",
      input: "mcpservers.org submission email",
      expected: '"mcpservers org" submission email',
    },
    {
      name: "dotted filename → quoted phrase",
      input: "server.json",
      expected: '"server json"',
    },
    {
      name: "slash path → quoted phrase",
      input: "deploy/local",
      expected: '"deploy local"',
    },
    {
      name: "email address → quoted phrase",
      input: "user@example.com",
      expected: '"user example com"',
    },
    {
      name: "comma-joined terms → quoted phrase",
      input: "foo,bar",
      expected: '"foo bar"',
    },
    {
      name: "apostrophe contraction → quoted phrase",
      input: "don't",
      expected: '"don t"',
    },
    {
      name: "mixed dot + hyphen compound → quoted phrase",
      input: "vault-cortex.test",
      expected: '"vault cortex test"',
    },
    {
      name: "word-edge punctuation stripped, term left bare",
      input: "email. really?!",
      expected: "email really",
    },
    {
      name: "punctuation-only input: empty result",
      input: "?!.,",
      expected: '""',
    },
    {
      name: "metachar adjoining compound: not a joiner",
      input: "vault-cortex: search",
      expected: '"vault cortex" search',
    },
    {
      name: "underscore is a bareword character, term left bare",
      input: "snake_case_name",
      expected: "snake_case_name",
    },
    {
      name: "non-ASCII term left bare",
      input: "café",
      expected: "café",
    },
    {
      name: "dot inside quoted phrase preserved",
      input: '"mcpservers.org"',
      expected: '"mcpservers.org"',
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    const result = sanitizeFtsQuery(input)
    expect(result).toBe(expected)
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
    expect(results[0].path).toBe("a.md")
  })

  it("returns empty for non-existent tag", () => {
    const results = index.searchByTag({ tag: "nope" }, logger)
    expect(results).toHaveLength(0)
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
    expect(results[0].path).toBe("About Me/Principles.md")
  })

  it("sorts results by most recently modified", () => {
    const results = index.searchByFolder({ folder: "About Me" }, logger)
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
    expect(results[0].path).toBe("bare.md")
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
    expect(results[0].path).toBe("new.md")
    expect(results[1].path).toBe("no-created.md")
    expect(results[2].path).toBe("old.md")
  })

  it("sorts by created date", () => {
    const results = index.recentNotes({ sort_by: "created" }, logger)
    expect(results[0].path).toBe("new.md")
    expect(results[1].path).toBe("old.md")
  })

  it("puts nulls last for created sort", () => {
    const results = index.recentNotes({ sort_by: "created" }, logger)
    expect(results[results.length - 1].path).toBe("no-created.md")
  })

  it("respects limit", () => {
    const results = index.recentNotes({ limit: 1 }, logger)
    expect(results).toHaveLength(1)
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
      expect(keys[i - 1].count).toBeGreaterThanOrEqual(keys[i].count)
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
      expect(values[i - 1].count).toBeGreaterThanOrEqual(values[i].count)
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
    expect(results[0].path).toBe("Projects/active.md")
  })

  it("finds notes by array property value", () => {
    const results = index.searchByProperty(
      { key: "tags", value: "active" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("Projects/active.md")
  })

  it("returns NoteMetadata with all fields", () => {
    const results = index.searchByProperty(
      { key: "status", value: "done" },
      logger,
    )
    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result.path).toBe("Projects/done.md")
    expect(result.title).toBe("Done Project")
    expect(result.tags).toEqual(["project", "done"])
    expect(result.folder).toBe("Projects")
    expect(result.type).toBe("project")
    expect(result.bytes).toBe(100)
    expect(result.properties).toEqual(
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
    expect(results[0].path).toBe("Projects/active.md")
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
    expect(results[0].path).toBe("dated.md")
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
    const count = await index.rebuildFromVault(vaultDir)
    expect(count).toBe(2)
  })

  it("skips hidden directories", async () => {
    const indexedCount = await index.rebuildFromVault(vaultDir)
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
    await index.rebuildFromVault(vaultDir)
    const results = index.fullTextSearch({ query: "stale" }, logger)
    expect(results).toHaveLength(0)
  })

  it("makes indexed notes searchable", async () => {
    await index.rebuildFromVault(vaultDir)
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
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
    await index.rebuildFromVault(vaultDir)
    const backlinks = index.getBacklinks({ path: "z-target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0].path).toBe("a-source.md")
  })

  it("does not count extensionless wikilinks to non-md files as broken", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Trip Route]] and [[missing-note]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "Trip Route.canvas"), "{}", "utf8")
    await index.rebuildFromVault(vaultDir)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Trip Route.canvas")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("asset")
    const broken = outgoing.find((link) => link.path === "missing-note")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
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
    await index.rebuildFromVault(vaultDir)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find(
      (link) => link.path === "canvases/Dashboard.canvas",
    )
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("asset")
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
    await index.rebuildFromVault(vaultDir)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "views/Inventory.base")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("asset")
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
    await index.rebuildFromVault(vaultDir)

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
    await index.rebuildFromVault(vaultDir)

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
    await index.rebuildFromVault(vaultDir)

    const outgoing = index.getOutgoingLinks({ path: "sub/source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Route.canvas")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("asset")
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
    await index.rebuildFromVault(vaultDir)

    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves explicit-extension wikilinks against the non-md file index", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\n![[photo.png]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "photo.png"), "binary", "utf8")
    await index.rebuildFromVault(vaultDir)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "photo.png")
    expect(asset!.exists).toBe(true)
    expect(asset!.kind).toBe("asset")
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
    await index.rebuildFromVault(vaultDir)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.path).toBe("Report.md")
    expect(outgoing[0]!.kind).toBe("note")
    expect(outgoing[0]!.exists).toBe(true)
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
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
    expect(backlinks[0].path).toBe("hub.md")
  })

  it("finds backlinks from notes that link to the target", () => {
    const backlinks = index.getBacklinks({ path: "hub.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0].path).toBe("spoke-a.md")
  })

  it("returns empty for notes with no backlinks", () => {
    const backlinks = index.getBacklinks({ path: "island.md" }, logger)
    expect(backlinks).toHaveLength(0)
  })

  it("includes title in results", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks[0].title).toBe("hub")
  })

  it("includes bytes in results", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks[0].bytes).toBe(100)
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
    expect(backlinks[0].path).toBe("source.md")
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
    expect(backlinks[0].path).toBe("source.md")
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
    expect(links[0].path).toBe("task-board.md")
    expect(links[0].exists).toBe(true)
    expect(links[0].kind).toBe("note")
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
    expect(backlinks[0].path).toBe("session.md")
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
    expect(backlinks[0].path).toBe("double.md")
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

  it("does not count wikilinks to non-note assets as broken when files are registered", () => {
    index.upsertNonMdFile("photo.png")
    index.upsertNonMdFile("report.pdf")
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
    expect(photo!.kind).toBe("asset")
    const pdf = outgoing.find((link) => link.path === "report.pdf")
    expect(pdf!.exists).toBe(true)
    expect(pdf!.kind).toBe("asset")
    const broken = outgoing.find((link) => link.path === "real-note")
    expect(broken!.exists).toBe(false)
    expect(broken!.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("excludes extensionless targets after upsertNonMdFile registers the file", () => {
    index.upsertNonMdFile("Trip Route.canvas")
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
    expect(asset!.kind).toBe("asset")
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

    index.upsertNonMdFile("Route.canvas")
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.path).toBe("Route.canvas")
    expect(outgoing[0]!.exists).toBe(true)
    expect(outgoing[0]!.kind).toBe("asset")
  })

  it("removeNonMdFile makes previously resolved asset links broken again", () => {
    index.upsertNonMdFile("Route.canvas")
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
