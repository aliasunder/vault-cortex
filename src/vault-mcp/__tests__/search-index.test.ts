import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSearchIndex, sanitizeFtsQuery } from "../search-index.js"
import type { SearchIndex } from "../search-index.js"
import { logger } from "../../logger.js"

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

describe("schema creation", () => {
  it("creates without throwing", () => {
    expect(() => createSearchIndex(":memory:")).not.toThrow()
  })

  it("creates notes and notes_fts tables", () => {
    index.upsertNote("test.md", "# Test\n", Date.now())
    const results = index.fullTextSearch({ query: "Test" }, logger)
    expect(results).toHaveLength(1)
  })
})

describe("upsertNote", () => {
  it("indexes a note with full frontmatter", () => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
    expect(results[0].title).toBe("Principles")
    expect(results[0].tags).toEqual(["principles", "self"])
  })

  it("extracts title from frontmatter", () => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0].title).toBe("Principles")
  })

  it("falls back to filename for title when no frontmatter title", () => {
    index.upsertNote("notes/random.md", NOTE_MINIMAL, 1000)
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0].title).toBe("random")
  })

  it("stores folder as first path segment", () => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0].folder).toBe("About Me")
  })

  it("stores empty folder for root-level notes", () => {
    index.upsertNote("root.md", NOTE_MINIMAL, 1000)
    const recent = index.recentNotes({}, logger)
    expect(recent[0].folder).toBe("")
  })

  it("updates existing note on re-index", () => {
    index.upsertNote("test.md", "---\ntitle: V1\n---\nold\n", 1000)
    index.upsertNote("test.md", "---\ntitle: V2\n---\nnew content\n", 2000)
    const results = index.fullTextSearch({ query: "new content" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe("V2")
  })

  it("handles notes with no frontmatter", () => {
    index.upsertNote("bare.md", "Just plain text\n", 1000)
    const results = index.fullTextSearch({ query: "plain text" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].tags).toEqual([])
  })

  it("normalizes tags to array when given as string", () => {
    index.upsertNote("t.md", "---\ntags: single-tag\n---\nbody\n", 1000)
    const tags = index.listAllTags(logger)
    expect(tags).toEqual([{ tag: "single-tag", count: 1 }])
  })
})

describe("removeNote", () => {
  it("removes an indexed note", () => {
    index.upsertNote("test.md", "# Removable\n", 1000)
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
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    index.upsertNote(
      "Projects/notes.md",
      "---\ntitle: Project Notes\ntype: project\ntags: [project]\n---\n\nMeeting notes about the vault project\n",
      2000,
    )
    index.upsertNote("notes/random.md", NOTE_MINIMAL, 3000)
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
    index.upsertNote("stem.md", "The runners were running quickly\n", 4000)
    const results = index.fullTextSearch({ query: "run" }, logger)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.path === "stem.md")).toBe(true)
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
      "spread.md",
      "The word alpha appears here. Much later, beta shows up.\n",
      5000,
    )
    const results = index.fullTextSearch({ query: "alpha beta" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("spread.md")
  })

  it("exact phrase match with quotes", () => {
    index.upsertNote("phrase.md", "Learn machine learning today\n", 5000)
    index.upsertNote(
      "separate.md",
      "The machine was broken. Learning was slow.\n",
      5001,
    )
    const phraseResults = index.fullTextSearch(
      { query: '"machine learning"' },
      logger,
    )
    expect(phraseResults.some((r) => r.path === "phrase.md")).toBe(true)
    expect(phraseResults.some((r) => r.path === "separate.md")).toBe(false)
  })

  it("query with FTS5 operators does not throw", () => {
    expect(() =>
      index.fullTextSearch(
        { query: 'test "quoted" AND (grouped) OR NOT *wild*' },
        logger,
      ),
    ).not.toThrow()
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
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    const result = sanitizeFtsQuery(input)
    expect(result).toBe(expected)
  })
})

describe("searchByTag", () => {
  beforeEach(() => {
    index.upsertNote(
      "a.md",
      "---\ntags: [project/vault-mcp, self]\n---\nbody\n",
      1000,
    )
    index.upsertNote("b.md", "---\ntags: [project/other]\n---\nbody\n", 2000)
    index.upsertNote("c.md", "---\ntags: [unrelated]\n---\nbody\n", 3000)
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
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    index.upsertNote(
      "About Me/sub/deep.md",
      "---\ntitle: Deep\n---\nbody\n",
      2000,
    )
    index.upsertNote("Projects/notes.md", "---\ntitle: P\n---\nbody\n", 3000)
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
})

describe("searchByType", () => {
  beforeEach(() => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    index.upsertNote("other.md", "---\ntitle: Other\n---\nbody\n", 2000)
  })

  it("finds notes by type", () => {
    const results = index.searchByType({ type: "about-me" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
  })

  it("returns empty for unknown type", () => {
    const results = index.searchByType({ type: "nonexistent" }, logger)
    expect(results).toHaveLength(0)
  })
})

describe("listAllTags", () => {
  beforeEach(() => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    index.upsertNote("a.md", "---\ntags: [principles, work]\n---\nbody\n", 2000)
  })

  it("returns tags with counts ordered by count desc", () => {
    const tags = index.listAllTags(logger)
    expect(tags[0]).toEqual({ tag: "principles", count: 2 })
    expect(tags.find((t) => t.tag === "self")).toEqual({
      tag: "self",
      count: 1,
    })
  })

  it("handles notes with no tags", () => {
    index.upsertNote("bare.md", "no tags\n", 3000)
    const tags = index.listAllTags(logger)
    expect(tags.length).toBeGreaterThan(0)
  })
})

describe("recentNotes", () => {
  beforeEach(() => {
    index.upsertNote("old.md", "---\ncreated: 2025-01-01\n---\nold\n", 1000)
    index.upsertNote("new.md", "---\ncreated: 2026-05-01\n---\nnew\n", 5000)
    index.upsertNote("no-created.md", "no date\n", 3000)
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
    index.upsertNote("Projects/active.md", NOTE_WITH_STATUS, 1000)
    index.upsertNote("Projects/done.md", NOTE_WITH_DIFFERENT_STATUS, 2000)
    index.upsertNote("notes/plain.md", NOTE_WITH_NO_CUSTOM_PROPS, 3000)
  })

  it("returns all property keys with counts", () => {
    const keys = index.listPropertyKeys({}, logger)
    expect(keys.length).toBeGreaterThan(0)
    const titleKey = keys.find((k) => k.key === "title")
    expect(titleKey).toBeDefined()
    expect(titleKey!.count).toBe(3)
  })

  it("includes sample_values for each key", () => {
    const keys = index.listPropertyKeys({}, logger)
    const statusKey = keys.find((k) => k.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey!.sample_values).toContain("in-progress")
    expect(statusKey!.sample_values).toContain("done")
  })

  it("returns at most 3 sample values", () => {
    for (let i = 0; i < 5; i++) {
      index.upsertNote(
        `extra/n${i}.md`,
        `---\nvariety: value-${i}\n---\nbody\n`,
        4000 + i,
      )
    }
    const keys = index.listPropertyKeys({}, logger)
    const varietyKey = keys.find((k) => k.key === "variety")
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
    const statusKey = keys.find((k) => k.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey!.count).toBe(2)
  })

  it("folder filter excludes notes outside the folder", () => {
    const keys = index.listPropertyKeys({ folder: "notes" }, logger)
    const statusKey = keys.find((k) => k.key === "status")
    expect(statusKey).toBeUndefined()
  })
})

describe("listPropertyValues", () => {
  beforeEach(() => {
    index.upsertNote("Projects/active.md", NOTE_WITH_STATUS, 1000)
    index.upsertNote("Projects/done.md", NOTE_WITH_DIFFERENT_STATUS, 2000)
    index.upsertNote("notes/plain.md", NOTE_WITH_NO_CUSTOM_PROPS, 3000)
  })

  it("returns distinct values with counts for a scalar property", () => {
    const values = index.listPropertyValues({ key: "status" }, logger)
    expect(values).toHaveLength(2)
    expect(values.find((v) => v.value === "in-progress")).toEqual({
      value: "in-progress",
      count: 1,
    })
    expect(values.find((v) => v.value === "done")).toEqual({
      value: "done",
      count: 1,
    })
  })

  it("enumerates individual array elements for array properties", () => {
    const values = index.listPropertyValues({ key: "tags" }, logger)
    expect(values.find((v) => v.value === "project")).toBeDefined()
    expect(values.find((v) => v.value === "active")).toBeDefined()
    expect(values.find((v) => v.value === "note")).toBeDefined()
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
    const values = index.listPropertyValues(
      { key: "status", folder: "Projects" },
      logger,
    )
    expect(values).toHaveLength(2)
  })

  it("returns empty for non-existent key", () => {
    const values = index.listPropertyValues({ key: "nonexistent" }, logger)
    expect(values).toHaveLength(0)
  })
})

describe("searchByProperty", () => {
  beforeEach(() => {
    index.upsertNote("Projects/active.md", NOTE_WITH_STATUS, 1000)
    index.upsertNote("Projects/done.md", NOTE_WITH_DIFFERENT_STATUS, 2000)
    index.upsertNote("notes/plain.md", NOTE_WITH_NO_CUSTOM_PROPS, 3000)
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
    expect(results[0]).toHaveProperty("path")
    expect(results[0]).toHaveProperty("title")
    expect(results[0]).toHaveProperty("tags")
    expect(results[0]).toHaveProperty("related")
    expect(results[0]).toHaveProperty("folder")
    expect(results[0]).toHaveProperty("type")
    expect(results[0]).toHaveProperty("modified")
    expect(results[0]).toHaveProperty("properties")
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
      "Other/also-active.md",
      "---\nstatus: in-progress\n---\nbody\n",
      4000,
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
      "Projects/another.md",
      "---\nstatus: in-progress\n---\nbody\n",
      4000,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", limit: 1 },
      logger,
    )
    expect(results).toHaveLength(1)
  })

  it("finds notes by YAML date property (normalized from Date object)", () => {
    index.upsertNote("dated.md", "---\ndue: 2026-05-13\n---\nbody\n", 5000)
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
    await index.rebuildFromVault(vaultDir)
    const results = index.fullTextSearch({ query: "hidden" }, logger)
    expect(results).toHaveLength(0)
  })

  it("clears existing data before rebuilding", async () => {
    index.upsertNote("stale.md", "stale content\n", 1000)
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
})
