import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createSearchIndex,
  sanitizeFtsQuery,
  extractLinks,
  resolveLink,
} from "../search-index.js"
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

// ── extractLinks ─────────────────────────────────────────────────

describe("extractLinks", () => {
  it("extracts basic wikilinks", () => {
    const links = extractLinks("See [[Note A]] and [[Note B]].")
    expect(links).toContain("Note A")
    expect(links).toContain("Note B")
  })

  it("extracts wikilinks with display text", () => {
    const links = extractLinks("See [[Note A|my note]].")
    expect(links).toEqual(["Note A"])
  })

  it("extracts wikilinks with heading anchors", () => {
    const links = extractLinks("See [[Note A#Section One]].")
    expect(links).toEqual(["Note A"])
  })

  it("extracts wikilinks with heading and display text", () => {
    const links = extractLinks("See [[Note A#Section|display]].")
    expect(links).toEqual(["Note A"])
  })

  it("extracts wikilinks with folder paths", () => {
    const links = extractLinks("See [[Projects/vault-cortex]].")
    expect(links).toEqual(["Projects/vault-cortex"])
  })

  it("extracts embeds as links", () => {
    const links = extractLinks("![[Embedded Note]]")
    expect(links).toEqual(["Embedded Note"])
  })

  it("extracts markdown internal links", () => {
    const links = extractLinks("[click here](Projects/plan.md)")
    expect(links).toContain("Projects/plan")
  })

  it("excludes external URLs", () => {
    const links = extractLinks("[Google](https://google.com) and [[Internal]]")
    expect(links).toEqual(["Internal"])
  })

  it("excludes mailto links", () => {
    const links = extractLinks("[email](mailto:test@example.com)")
    expect(links).toHaveLength(0)
  })

  it("excludes same-page anchors", () => {
    const links = extractLinks("[section](#heading)")
    expect(links).toHaveLength(0)
  })

  it("deduplicates repeated targets", () => {
    const links = extractLinks("[[Note A]] and again [[Note A]]")
    expect(links).toEqual(["Note A"])
  })

  it("skips links inside fenced code blocks", () => {
    const content = [
      "before [[Real Link]]",
      "```",
      "[[Fake Link]]",
      "```",
      "after [[Another Real Link]]",
    ].join("\n")
    const links = extractLinks(content)
    expect(links).toContain("Real Link")
    expect(links).toContain("Another Real Link")
    expect(links).not.toContain("Fake Link")
  })

  it("skips links inside tilde fenced blocks", () => {
    const content = ["~~~", "[[Fake]]", "~~~"].join("\n")
    const links = extractLinks(content)
    expect(links).not.toContain("Fake")
  })

  it("handles nested fences correctly", () => {
    const content = [
      "````",
      "```",
      "[[Inside Nested]]",
      "```",
      "````",
      "[[Outside]]",
    ].join("\n")
    const links = extractLinks(content)
    expect(links).not.toContain("Inside Nested")
    expect(links).toContain("Outside")
  })

  it("returns empty for content with no links", () => {
    expect(extractLinks("Just plain text.")).toEqual([])
  })
})

// ── resolveLink ──────────────────────────────────────────────────

describe("resolveLink", () => {
  const allPaths = [
    "Projects/vault-cortex.md",
    "About Me/Principles.md",
    "notes/random.md",
    "deep/nested/note.md",
    "note.md",
  ]

  it("resolves exact path match", () => {
    expect(resolveLink("Projects/vault-cortex", allPaths)).toBe(
      "Projects/vault-cortex.md",
    )
  })

  it("resolves exact path with .md extension", () => {
    expect(resolveLink("Projects/vault-cortex.md", allPaths)).toBe(
      "Projects/vault-cortex.md",
    )
  })

  it("resolves basename match", () => {
    expect(resolveLink("Principles", allPaths)).toBe("About Me/Principles.md")
  })

  it("resolves to shortest path when multiple basename matches exist", () => {
    expect(resolveLink("note", allPaths)).toBe("note.md")
  })

  it("returns null for unresolvable target", () => {
    expect(resolveLink("NonExistent", allPaths)).toBeNull()
  })
})

// ── Link query methods ───────────────────────────────────────────

describe("getBacklinks", () => {
  beforeEach(() => {
    // Index targets before sources so link resolution finds them
    index.upsertNote("spoke-a.md", "# Spoke A\n\nBody.\n", 1000)
    index.upsertNote("spoke-b.md", "# Spoke B\n\nNo backlink.\n", 2000)
    index.upsertNote("island.md", "# Island\n\nNo links at all.\n", 3000)
    index.upsertNote(
      "hub.md",
      "# Hub\n\nLinks to [[spoke-a]] and [[spoke-b]].\n",
      4000,
    )
    // Re-index spoke-a now that hub exists, so its [[hub]] link resolves
    index.upsertNote(
      "spoke-a.md",
      "# Spoke A\n\nLinks back to [[hub]].\n",
      5000,
    )
  })

  it("finds notes linking to the target", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0].path).toBe("hub.md")
  })

  it("returns multiple backlinks", () => {
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
})

describe("getOutgoingLinks", () => {
  beforeEach(() => {
    index.upsertNote(
      "target-exists.md",
      "---\ntitle: Target\n---\n\n# Target\n\nBody.\n",
      1000,
    )
    index.upsertNote(
      "source.md",
      "# Source\n\n[[target-exists]] and [[NonExistent]].\n",
      2000,
    )
  })

  it("returns outgoing links with exists flag", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(links.length).toBeGreaterThanOrEqual(1)

    const existing = links.find((l) => l.path === "target-exists.md")
    expect(existing).toBeDefined()
    expect(existing!.exists).toBe(true)
    expect(existing!.title).toBe("Target")
  })

  it("marks unresolved links as exists: false", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    const missing = links.find((l) => l.path === "NonExistent")
    expect(missing).toBeDefined()
    expect(missing!.exists).toBe(false)
    expect(missing!.title).toBeNull()
  })

  it("returns empty for notes with no outgoing links", () => {
    index.upsertNote("lonely.md", "# Lonely\n\nNo links.\n", 3000)
    const links = index.getOutgoingLinks({ path: "lonely.md" }, logger)
    expect(links).toHaveLength(0)
  })
})

describe("findOrphans", () => {
  beforeEach(() => {
    index.upsertNote("connected.md", "# Connected\n\nBody.\n", 1000)
    index.upsertNote("hub.md", "# Hub\n\n[[connected]].\n", 2000)
    index.upsertNote(
      "Projects/orphan.md",
      "---\ntitle: Orphan\ntype: project\ntags: [project]\n---\n\n# Orphan\n\nNobody links here.\n",
      3000,
    )
    index.upsertNote(
      "Daily Notes/2026-05-13.md",
      "---\ntitle: 2026-05-13\n---\n\n# Daily\n",
      4000,
    )
  })

  it("finds notes with no incoming links", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((o) => o.path)
    expect(orphanPaths).toContain("Projects/orphan.md")
  })

  it("excludes connected notes", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((o) => o.path)
    expect(orphanPaths).not.toContain("connected.md")
  })

  it("excludes Daily Notes by default", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((o) => o.path)
    expect(orphanPaths).not.toContain("Daily Notes/2026-05-13.md")
  })

  it("includes Daily Notes when excluded folders are overridden", () => {
    const orphans = index.findOrphans({ excludeFolders: [] }, logger)
    const orphanPaths = orphans.map((o) => o.path)
    expect(orphanPaths).toContain("Daily Notes/2026-05-13.md")
  })

  it("respects limit", () => {
    const orphans = index.findOrphans({ limit: 1 }, logger)
    expect(orphans).toHaveLength(1)
  })

  it("returns NoteMetadata with all fields", () => {
    const orphans = index.findOrphans({}, logger)
    const orphan = orphans.find((o) => o.path === "Projects/orphan.md")
    expect(orphan).toBeDefined()
    expect(orphan).toHaveProperty("title")
    expect(orphan).toHaveProperty("tags")
    expect(orphan).toHaveProperty("folder")
    expect(orphan).toHaveProperty("modified")
  })
})
