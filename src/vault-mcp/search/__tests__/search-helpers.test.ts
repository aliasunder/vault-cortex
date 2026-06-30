import { describe, it, expect } from "vitest"
import {
  isString,
  coerceToArray,
  buildFtsMetadataText,
  mtimeToIso,
  noteMatchesSearchFilters,
  buildSnippetFromChunkText,
  escapeLikeWildcards,
  stripTrailingSlashes,
} from "../search-helpers.js"
import type { NoteRow } from "../search-index.js"

// ── isString ──────────────────────────────────────────────────

describe("isString", () => {
  it("returns true for strings", () => {
    expect(isString("hello")).toBe(true)
    expect(isString("")).toBe(true)
  })

  it("returns false for non-strings", () => {
    expect(isString(42)).toBe(false)
    expect(isString(null)).toBe(false)
    expect(isString(undefined)).toBe(false)
    expect(isString(["a"])).toBe(false)
  })
})

// ── coerceToArray ─────────────────────────────────────────────

describe("coerceToArray", () => {
  it("passes through an existing array", () => {
    expect(coerceToArray(["a", "b"])).toEqual(["a", "b"])
  })

  it("wraps a scalar string in an array", () => {
    expect(coerceToArray("solo")).toEqual(["solo"])
  })

  it("wraps a number in a stringified array", () => {
    expect(coerceToArray(42)).toEqual(["42"])
  })

  it("returns empty array for null", () => {
    expect(coerceToArray(null)).toEqual([])
  })

  it("returns empty array for undefined", () => {
    expect(coerceToArray(undefined)).toEqual([])
  })

  it("returns empty array for empty string", () => {
    expect(coerceToArray("")).toEqual([])
  })
})

// ── buildFtsMetadataText ──────────────────────────────────────

describe("buildFtsMetadataText", () => {
  it("flattens scalar properties with key prefix", () => {
    expect(buildFtsMetadataText({ status: "active", priority: 1 })).toBe(
      "status: active\npriority: 1",
    )
  })

  it("excludes title from output", () => {
    expect(buildFtsMetadataText({ title: "My Note", status: "draft" })).toBe(
      "status: draft",
    )
  })

  it("joins array elements with spaces", () => {
    expect(buildFtsMetadataText({ tags: ["a", "b", "c"] })).toBe("tags: a b c")
  })

  it("skips null and undefined values", () => {
    expect(buildFtsMetadataText({ a: null, b: undefined, c: "kept" })).toBe(
      "c: kept",
    )
  })

  it("skips nested object values entirely", () => {
    expect(buildFtsMetadataText({ nested: { deep: "value" } })).toBe("")
  })

  it("filters non-primitive elements from arrays", () => {
    expect(
      buildFtsMetadataText({ mixed: ["text", { obj: true }, 42, null] }),
    ).toBe("mixed: text 42")
  })

  it("skips array with only non-primitive elements", () => {
    expect(buildFtsMetadataText({ all_objects: [{ a: 1 }, { b: 2 }] })).toBe("")
  })

  it("returns empty string for empty frontmatter", () => {
    expect(buildFtsMetadataText({})).toBe("")
  })
})

// ── mtimeToIso ────────────────────────────────────────────────

describe("mtimeToIso", () => {
  it("converts a valid epoch ms to an ISO string", () => {
    const iso = mtimeToIso(1700000000000)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("rounds fractional milliseconds", () => {
    const iso = mtimeToIso(1700000000000.7)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("throws on invalid mtime", () => {
    expect(() => mtimeToIso(NaN)).toThrow("invalid mtime: NaN")
  })
})

// ── noteMatchesSearchFilters ─────────────────────────────────────────

describe("noteMatchesSearchFilters", () => {
  const baseRow: NoteRow = {
    path: "Projects/Alpha/note.md",
    title: "Test",
    tags: JSON.stringify(["project", "project/alpha"]),
    related: JSON.stringify(["Other.md"]),
    folder: "Projects/Alpha",
    type: "note",
    created: "2024-01-01",
    mtime: 1700000000000,
    properties: JSON.stringify({ status: "active" }),
    leading_callout: null,
    bytes: 100,
  }

  it("passes when no filters are set", () => {
    expect(noteMatchesSearchFilters(baseRow, {})).toBe(true)
  })

  it("filters by folder prefix", () => {
    expect(
      noteMatchesSearchFilters(baseRow, { folder: "Projects/Alpha" }),
    ).toBe(true)
    expect(noteMatchesSearchFilters(baseRow, { folder: "Projects/Beta" })).toBe(
      false,
    )
    expect(noteMatchesSearchFilters(baseRow, { folder: "Projects" })).toBe(true)
  })

  it("requires all tags to match", () => {
    expect(noteMatchesSearchFilters(baseRow, { tags: ["project"] })).toBe(true)
    expect(
      noteMatchesSearchFilters(baseRow, { tags: ["project", "project/alpha"] }),
    ).toBe(true)
    expect(noteMatchesSearchFilters(baseRow, { tags: ["missing"] })).toBe(false)
  })

  it("filters by type", () => {
    expect(noteMatchesSearchFilters(baseRow, { type: "note" })).toBe(true)
    expect(noteMatchesSearchFilters(baseRow, { type: "daily" })).toBe(false)
  })

  it("requires all related links to match", () => {
    expect(noteMatchesSearchFilters(baseRow, { related: ["Other.md"] })).toBe(
      true,
    )
    expect(noteMatchesSearchFilters(baseRow, { related: ["Missing.md"] })).toBe(
      false,
    )
  })

  it("filters by property key/value", () => {
    expect(
      noteMatchesSearchFilters(baseRow, { properties: { status: "active" } }),
    ).toBe(true)
    expect(
      noteMatchesSearchFilters(baseRow, { properties: { status: "archived" } }),
    ).toBe(false)
  })

  it("combines multiple filters with AND semantics", () => {
    expect(
      noteMatchesSearchFilters(baseRow, {
        folder: "Projects/Alpha",
        tags: ["project"],
        type: "note",
      }),
    ).toBe(true)
    expect(
      noteMatchesSearchFilters(baseRow, {
        folder: "Projects/Alpha",
        tags: ["missing"],
        type: "note",
      }),
    ).toBe(false)
  })

  it("strips trailing slashes from folder filter before matching", () => {
    expect(
      noteMatchesSearchFilters(baseRow, { folder: "Projects/Alpha/" }),
    ).toBe(true)
    expect(noteMatchesSearchFilters(baseRow, { folder: "Projects/" })).toBe(
      true,
    )
    expect(
      noteMatchesSearchFilters(baseRow, { folder: "Projects/Beta/" }),
    ).toBe(false)
  })
})

// ── buildSnippetFromChunkText ─────────────────────────────────

describe("buildSnippetFromChunkText", () => {
  it("returns full text when within token limit", () => {
    expect(buildSnippetFromChunkText("hello world", 10)).toBe("hello world")
  })

  it("truncates and appends ellipsis when over limit", () => {
    expect(buildSnippetFromChunkText("a b c d e f", 3)).toBe("a b c...")
  })

  it("handles empty string", () => {
    expect(buildSnippetFromChunkText("", 5)).toBe("")
  })

  it("handles whitespace-only string", () => {
    expect(buildSnippetFromChunkText("   ", 5)).toBe("")
  })
})

// ── escapeLikeWildcards ───────────────────────────────────────

describe("escapeLikeWildcards", () => {
  it("escapes percent sign", () => {
    expect(escapeLikeWildcards("100%")).toBe("100\\%")
  })

  it("escapes underscore", () => {
    expect(escapeLikeWildcards("my_folder")).toBe("my\\_folder")
  })

  it("escapes backslash", () => {
    expect(escapeLikeWildcards("path\\to")).toBe("path\\\\to")
  })

  it("escapes multiple wildcards", () => {
    expect(escapeLikeWildcards("a%b_c\\d")).toBe("a\\%b\\_c\\\\d")
  })

  it("leaves normal text unchanged", () => {
    expect(escapeLikeWildcards("Projects/Alpha")).toBe("Projects/Alpha")
  })
})

// ── stripTrailingSlashes ──────────────────────────────────────

describe("stripTrailingSlashes", () => {
  it("strips a single trailing slash", () => {
    expect(stripTrailingSlashes("Projects/")).toBe("Projects")
  })

  it("strips multiple trailing slashes", () => {
    expect(stripTrailingSlashes("Projects///")).toBe("Projects")
  })

  it("leaves paths without trailing slashes unchanged", () => {
    expect(stripTrailingSlashes("Projects/Alpha")).toBe("Projects/Alpha")
  })

  it("preserves internal slashes", () => {
    expect(stripTrailingSlashes("Projects/Alpha/Beta/")).toBe(
      "Projects/Alpha/Beta",
    )
  })

  it("handles a bare folder name", () => {
    expect(stripTrailingSlashes("Projects")).toBe("Projects")
  })
})
