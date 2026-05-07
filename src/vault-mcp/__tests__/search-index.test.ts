import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSearchIndex } from "../search-index.js"
import type { SearchIndex } from "../search-index.js"

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
    const results = index.fullTextSearch("Test")
    expect(results).toHaveLength(1)
  })
})

describe("upsertNote", () => {
  it("indexes a note with full frontmatter", () => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    const results = index.fullTextSearch("burnout")
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
    expect(results[0].title).toBe("Principles")
    expect(results[0].tags).toEqual(["principles", "self"])
  })

  it("extracts title from frontmatter", () => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    const results = index.searchByFolder("About Me")
    expect(results[0].title).toBe("Principles")
  })

  it("falls back to filename for title when no frontmatter title", () => {
    index.upsertNote("notes/random.md", NOTE_MINIMAL, 1000)
    const results = index.searchByFolder("notes")
    expect(results[0].title).toBe("random")
  })

  it("stores folder as first path segment", () => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    const results = index.searchByFolder("About Me")
    expect(results[0].folder).toBe("About Me")
  })

  it("stores empty folder for root-level notes", () => {
    index.upsertNote("root.md", NOTE_MINIMAL, 1000)
    const recent = index.recentNotes()
    expect(recent[0].folder).toBe("")
  })

  it("updates existing note on re-index", () => {
    index.upsertNote("test.md", "---\ntitle: V1\n---\nold\n", 1000)
    index.upsertNote("test.md", "---\ntitle: V2\n---\nnew content\n", 2000)
    const results = index.fullTextSearch("new content")
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe("V2")
  })

  it("handles notes with no frontmatter", () => {
    index.upsertNote("bare.md", "Just plain text\n", 1000)
    const results = index.fullTextSearch("plain text")
    expect(results).toHaveLength(1)
    expect(results[0].tags).toEqual([])
  })

  it("normalizes tags to array when given as string", () => {
    index.upsertNote("t.md", "---\ntags: single-tag\n---\nbody\n", 1000)
    const tags = index.listAllTags()
    expect(tags).toEqual([{ tag: "single-tag", count: 1 }])
  })
})

describe("removeNote", () => {
  it("removes an indexed note", () => {
    index.upsertNote("test.md", "# Removable\n", 1000)
    index.removeNote("test.md")
    const results = index.fullTextSearch("Removable")
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
    const results = index.fullTextSearch("burnout")
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
  })

  it("finds notes by title", () => {
    const results = index.fullTextSearch("Principles")
    expect(results).toHaveLength(1)
  })

  it("returns highlighted snippets", () => {
    const results = index.fullTextSearch("burnout")
    expect(results[0].snippet).toContain("<mark>")
  })

  it("respects folder filter", () => {
    const results = index.fullTextSearch("notes", { folder: "Projects" })
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("Projects/notes.md")
  })

  it("respects tags filter", () => {
    const results = index.fullTextSearch("notes", { tags: ["project"] })
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("Projects/notes.md")
  })

  it("respects type filter", () => {
    const results = index.fullTextSearch("notes", { type: "project" })
    expect(results).toHaveLength(1)
  })

  it("respects limit", () => {
    const results = index.fullTextSearch("notes", { limit: 1 })
    expect(results).toHaveLength(1)
  })

  it("returns empty for no matches", () => {
    const results = index.fullTextSearch("xyznonexistent")
    expect(results).toHaveLength(0)
  })

  it("handles porter stemming", () => {
    index.upsertNote("stem.md", "The runners were running quickly\n", 4000)
    const results = index.fullTextSearch("run")
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.path === "stem.md")).toBe(true)
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
    const results = index.searchByTag("project")
    expect(results).toHaveLength(2)
  })

  it("exact match mode", () => {
    const results = index.searchByTag("project", { exactMatch: true })
    expect(results).toHaveLength(0)
  })

  it("exact match finds specific tag", () => {
    const results = index.searchByTag("project/vault-mcp", { exactMatch: true })
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("a.md")
  })

  it("returns empty for non-existent tag", () => {
    const results = index.searchByTag("nope")
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
    const results = index.searchByFolder("About Me", { recursive: true })
    expect(results).toHaveLength(2)
  })

  it("non-recursive mode excludes nested files", () => {
    const results = index.searchByFolder("About Me", { recursive: false })
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
    const results = index.searchByType("about-me")
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
  })

  it("returns empty for unknown type", () => {
    const results = index.searchByType("nonexistent")
    expect(results).toHaveLength(0)
  })
})

describe("listAllTags", () => {
  beforeEach(() => {
    index.upsertNote("About Me/Principles.md", NOTE_WITH_FRONTMATTER, 1000)
    index.upsertNote("a.md", "---\ntags: [principles, work]\n---\nbody\n", 2000)
  })

  it("returns tags with counts ordered by count desc", () => {
    const tags = index.listAllTags()
    expect(tags[0]).toEqual({ tag: "principles", count: 2 })
    expect(tags.find((t) => t.tag === "self")).toEqual({
      tag: "self",
      count: 1,
    })
  })

  it("handles notes with no tags", () => {
    index.upsertNote("bare.md", "no tags\n", 3000)
    const tags = index.listAllTags()
    expect(tags.length).toBeGreaterThan(0)
  })
})

describe("recentNotes", () => {
  beforeEach(() => {
    index.upsertNote("old.md", "---\ncreated: 2025-01-01\n---\nold\n", 1000)
    index.upsertNote("new.md", "---\ncreated: 2026-05-01\n---\nnew\n", 5000)
    index.upsertNote("no-created.md", "no date\n", 3000)
  })

  it("sorts by mtime by default", () => {
    const results = index.recentNotes()
    expect(results[0].path).toBe("new.md")
    expect(results[1].path).toBe("no-created.md")
    expect(results[2].path).toBe("old.md")
  })

  it("sorts by created date", () => {
    const results = index.recentNotes({ sort_by: "created" })
    expect(results[0].path).toBe("new.md")
    expect(results[1].path).toBe("old.md")
  })

  it("puts nulls last for created sort", () => {
    const results = index.recentNotes({ sort_by: "created" })
    expect(results[results.length - 1].path).toBe("no-created.md")
  })

  it("respects limit", () => {
    const results = index.recentNotes({ limit: 1 })
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
    const results = index.fullTextSearch("hidden")
    expect(results).toHaveLength(0)
  })

  it("clears existing data before rebuilding", async () => {
    index.upsertNote("stale.md", "stale content\n", 1000)
    await index.rebuildFromVault(vaultDir)
    const results = index.fullTextSearch("stale")
    expect(results).toHaveLength(0)
  })

  it("makes indexed notes searchable", async () => {
    await index.rebuildFromVault(vaultDir)
    const results = index.fullTextSearch("burnout")
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("About Me/Principles.md")
  })
})
