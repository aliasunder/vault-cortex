import { describe, it, expect } from "vitest"
import { DateTime, Settings } from "luxon"
import { mtimeToIso } from "../../../utils/mtime-to-iso.js"
import {
  isString,
  coerceToArray,
  buildFtsMetadataText,
  rowToMetadata,
  rowToTaskEntry,
  noteRowToSearchResult,
  fileContentRowToSearchResult,
  buildSnippetFromChunkText,
  escapeLikeWildcards,
  stripTrailingSlashes,
  dayToEpochMsRange,
  foldTag,
  normalizeTagQuery,
  nestedTagLikePattern,
  IndexIntegrityError,
} from "../search-helpers.js"
import type { NoteRow, TaskRow } from "../search-index.js"

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

/** The class, message and cause class a call throws. Vitest's
 *  `toThrow(errorInstance)` compares only the message, so a plain `Error`
 *  would pass it. */
const describeThrow = (
  call: () => unknown,
): { isIndexIntegrityError: boolean; message: string; causeName: string | undefined } => {
  try {
    call()
  } catch (error) {
    if (!(error instanceof Error)) throw error

    const causeName = error.cause instanceof Error ? error.cause.name : undefined
    return {
      isIndexIntegrityError: error instanceof IndexIntegrityError,
      message: error.message,
      causeName,
    }
  }
  throw new Error("expected the call to throw")
}

// ── coerceToArray ─────────────────────────────────────────────

describe("coerceToArray", () => {
  it("preserves string array values", () => {
    expect(coerceToArray(["a", "b"])).toEqual(["a", "b"])
  })

  it("stringifies primitive non-string array elements and drops null and objects", () => {
    expect(coerceToArray(["a", 2, true, null, { nested: "value" }])).toEqual(["a", "2", "true"])
  })

  it("wraps a scalar string in an array", () => {
    expect(coerceToArray("solo")).toEqual(["solo"])
  })

  it("wraps a number in a stringified array", () => {
    expect(coerceToArray(42)).toEqual(["42"])
  })

  it("returns empty array for a mapping instead of stringifying it", () => {
    expect(coerceToArray({ project: true })).toEqual([])
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
    expect(buildFtsMetadataText({ title: "My Note", status: "draft" })).toBe("status: draft")
  })

  it("joins array elements with spaces", () => {
    expect(buildFtsMetadataText({ tags: ["a", "b", "c"] })).toBe("tags: a b c")
  })

  it("skips null and undefined values", () => {
    expect(buildFtsMetadataText({ a: null, b: undefined, c: "kept" })).toBe("c: kept")
  })

  it("skips nested object values entirely", () => {
    expect(buildFtsMetadataText({ nested: { deep: "value" } })).toBe("")
  })

  it("filters non-primitive elements from arrays", () => {
    expect(buildFtsMetadataText({ mixed: ["text", { obj: true }, 42, null] })).toBe(
      "mixed: text 42",
    )
  })

  it("skips array with only non-primitive elements", () => {
    expect(buildFtsMetadataText({ all_objects: [{ a: 1 }, { b: 2 }] })).toBe("")
  })

  it("returns empty string for empty frontmatter", () => {
    expect(buildFtsMetadataText({})).toBe("")
  })
})

// ── Row mapper factories ────────────────────────────────────────

const makeNoteRow = (overrides: Partial<NoteRow> = {}): NoteRow => ({
  path: "Projects/Alpha/note.md",
  title: "Test Note",
  tags: JSON.stringify(["project", "alpha"]),
  body_tags: "[]",
  related: JSON.stringify(["Other.md"]),
  folder: "Projects/Alpha",
  type: "note",
  created: "2024-01-01",
  mtime: 1700000000000,
  properties: JSON.stringify({ status: "active" }),
  leading_callout: JSON.stringify({
    type: "info",
    title: "Note",
    body: "Important context",
  }),
  bytes: 1024,
  ...overrides,
})

const makeTaskRow = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  note_path: "Projects/Alpha/tasks.md",
  line: 5,
  status_char: " ",
  status: "todo",
  description: "Fix the bug",
  created: "2024-01-01",
  scheduled: null,
  start: null,
  due: "2024-03-01",
  done: null,
  cancelled: null,
  priority: null,
  recurrence: null,
  on_completion: null,
  task_id: "abc123",
  depends_on: JSON.stringify(["def456"]),
  tags: JSON.stringify(["bug"]),
  block_id: null,
  heading: "Tasks",
  folder: "Projects/Alpha",
  depth: 0,
  parent_line: null,
  parent_block_id: null,
  subtask_done: 0,
  subtask_total: 0,
  is_kanban_task: 0,
  kanban_done_lanes: null,
  ...overrides,
})

// ── rowToMetadata ────────────────────────────────────────────────

describe("rowToMetadata", () => {
  it("maps a complete NoteRow to NoteMetadata with parsed JSON columns", () => {
    const metadata = rowToMetadata(makeNoteRow())
    expect(metadata).toEqual({
      path: "Projects/Alpha/note.md",
      title: "Test Note",
      tags: ["project", "alpha"],
      related: ["Other.md"],
      folder: "Projects/Alpha",
      type: "note",
      created: "2024-01-01",
      modified: mtimeToIso(1700000000000),
      bytes: 1024,
      properties: { status: "active" },
      leading_callout: {
        type: "info",
        title: "Note",
        body: "Important context",
      },
    })
  })

  it("sets leading_callout to null when the column is null", () => {
    const metadata = rowToMetadata(makeNoteRow({ leading_callout: null }))
    expect(metadata.leading_callout).toBeNull()
  })

  it("throws IndexIntegrityError when tags column contains a non-array value", () => {
    expect(describeThrow(() => rowToMetadata(makeNoteRow({ tags: '"not-an-array"' })))).toEqual({
      isIndexIntegrityError: true,
      message: 'expected string[] from JSON column, got: "not-an-array"',
    })
  })

  it("throws IndexIntegrityError when tags column contains an array with non-string elements", () => {
    expect(
      describeThrow(() => rowToMetadata(makeNoteRow({ tags: JSON.stringify(["ok", 123]) }))),
    ).toEqual({
      isIndexIntegrityError: true,
      message: 'expected string[] from JSON column, got: ["ok",123]',
    })
  })

  it("throws IndexIntegrityError, with the parse error as its cause, when tags column is not JSON", () => {
    // JSON.parse's message text is the engine's, so only the cause's class is pinned
    expect(describeThrow(() => rowToMetadata(makeNoteRow({ tags: "{" })))).toEqual({
      isIndexIntegrityError: true,
      message: "JSON column is not JSON: {",
      causeName: "SyntaxError",
    })
  })

  it("throws IndexIntegrityError when properties column contains a non-object value", () => {
    expect(describeThrow(() => rowToMetadata(makeNoteRow({ properties: '"string"' })))).toEqual({
      isIndexIntegrityError: true,
      message: 'expected object from JSON column, got: "string"',
    })
  })

  it("throws IndexIntegrityError when leading_callout column has missing fields", () => {
    expect(
      describeThrow(() => rowToMetadata(makeNoteRow({ leading_callout: '{"type":"info"}' }))),
    ).toEqual({
      isIndexIntegrityError: true,
      message: 'expected LeadingCallout from JSON column, got: {"type":"info"}',
    })
  })

  it("throws IndexIntegrityError when the stored mtime cannot be formatted", () => {
    expect(describeThrow(() => rowToMetadata(makeNoteRow({ mtime: NaN })))).toEqual({
      isIndexIntegrityError: true,
      message: "invalid mtime: NaN",
      causeName: "Error",
    })
  })
})

// ── rowToTaskEntry ───────────────────────────────────────────────

describe("rowToTaskEntry", () => {
  it("maps a TaskRow to TaskEntry, parsing JSON columns and dropping NULL metadata", () => {
    const entry = rowToTaskEntry(makeTaskRow())
    expect(entry).toEqual({
      path: "Projects/Alpha/tasks.md",
      line: 5,
      status: "todo",
      status_char: " ",
      description: "Fix the bug",
      heading: "Tasks",
      folder: "Projects/Alpha",
      created: "2024-01-01",
      due: "2024-03-01",
      task_id: "abc123",
      depends_on: ["def456"],
      tags: ["bug"],
      depth: 0,
      is_kanban_task: false,
    })
  })

  it("maps subtask counts to subtask_progress when the task has children", () => {
    const entry = rowToTaskEntry(makeTaskRow({ subtask_done: 2, subtask_total: 4 }))
    expect(entry.subtask_progress).toEqual({ done: 2, total: 4 })
  })

  it("maps done_lanes for Kanban tasks", () => {
    const entry = rowToTaskEntry(
      makeTaskRow({
        is_kanban_task: 1,
        heading: "Active",
        kanban_done_lanes: JSON.stringify(["Done"]),
      }),
    )
    expect(entry).toEqual({
      path: "Projects/Alpha/tasks.md",
      line: 5,
      status: "todo",
      status_char: " ",
      description: "Fix the bug",
      heading: "Active",
      folder: "Projects/Alpha",
      created: "2024-01-01",
      due: "2024-03-01",
      task_id: "abc123",
      depends_on: ["def456"],
      tags: ["bug"],
      depth: 0,
      is_kanban_task: true,
      done_lanes: ["Done"],
    })
  })

  it("omits done_lanes for non-Kanban tasks", () => {
    const entry = rowToTaskEntry(makeTaskRow({ is_kanban_task: 0 }))
    expect(entry.done_lanes).toBeUndefined()
  })

  it("renames note_path to path", () => {
    const entry = rowToTaskEntry(makeTaskRow({ note_path: "Journal/2024-01-01.md" }))
    expect(entry).toEqual({
      path: "Journal/2024-01-01.md",
      line: 5,
      status: "todo",
      status_char: " ",
      description: "Fix the bug",
      heading: "Tasks",
      folder: "Projects/Alpha",
      created: "2024-01-01",
      due: "2024-03-01",
      task_id: "abc123",
      depends_on: ["def456"],
      tags: ["bug"],
      depth: 0,
      is_kanban_task: false,
    })
  })

  it("throws IndexIntegrityError when depends_on column contains a non-array value", () => {
    expect(
      describeThrow(() => rowToTaskEntry(makeTaskRow({ depends_on: '"not-an-array"' }))),
    ).toEqual({
      isIndexIntegrityError: true,
      message: 'expected string[] from JSON column, got: "not-an-array"',
    })
  })

  it("throws IndexIntegrityError when tags column contains a non-array value", () => {
    expect(describeThrow(() => rowToTaskEntry(makeTaskRow({ tags: '"not-an-array"' })))).toEqual({
      isIndexIntegrityError: true,
      message: 'expected string[] from JSON column, got: "not-an-array"',
    })
  })
})

// ── noteRowToSearchResult ────────────────────────────────────────

describe("noteRowToSearchResult", () => {
  it("builds a SearchResult with parsed tags and computed modified timestamp", () => {
    const result = noteRowToSearchResult({
      row: makeNoteRow(),
      snippet: "matched text",
      score: 0.95,
      includeLeadingCallout: false,
    })
    expect(result).toEqual({
      path: "Projects/Alpha/note.md",
      title: "Test Note",
      snippet: "matched text",
      score: 0.95,
      tags: ["project", "alpha"],
      folder: "Projects/Alpha",
      type: "note",
      kind: "note",
      created: "2024-01-01",
      modified: mtimeToIso(1700000000000),
      bytes: 1024,
    })
  })

  it("includes leading_callout when includeLeadingCallout is true and column is present", () => {
    const result = noteRowToSearchResult({
      row: makeNoteRow(),
      snippet: "text",
      score: 0.5,
      includeLeadingCallout: true,
    })
    expect(result.leading_callout).toEqual({
      type: "info",
      title: "Note",
      body: "Important context",
    })
  })

  it("omits leading_callout when includeLeadingCallout is false", () => {
    const result = noteRowToSearchResult({
      row: makeNoteRow(),
      snippet: "text",
      score: 0.5,
      includeLeadingCallout: false,
    })
    expect(result.leading_callout).toBeUndefined()
  })

  it("omits created when the column is null", () => {
    const result = noteRowToSearchResult({
      row: makeNoteRow({ created: null }),
      snippet: "text",
      score: 0.5,
      includeLeadingCallout: false,
    })
    expect("created" in result).toBe(false)
  })

  it("throws IndexIntegrityError when tags column contains invalid data", () => {
    expect(
      describeThrow(() =>
        noteRowToSearchResult({
          row: makeNoteRow({ tags: "42" }),
          snippet: "text",
          score: 0.5,
          includeLeadingCallout: false,
        }),
      ),
    ).toEqual({
      isIndexIntegrityError: true,
      message: "expected string[] from JSON column, got: 42",
    })
  })

  it("throws IndexIntegrityError when leading_callout column contains invalid data", () => {
    expect(
      describeThrow(() =>
        noteRowToSearchResult({
          row: makeNoteRow({
            leading_callout: JSON.stringify({
              type: "note",
              title: "Invalid",
              body: 42,
            }),
          }),
          snippet: "text",
          score: 0.5,
          includeLeadingCallout: true,
        }),
      ),
    ).toEqual({
      isIndexIntegrityError: true,
      message:
        'expected LeadingCallout from JSON column, got: {"type":"note","title":"Invalid","body":42}',
    })
  })

  it("throws IndexIntegrityError when the stored mtime cannot be formatted", () => {
    expect(
      describeThrow(() =>
        noteRowToSearchResult({
          row: makeNoteRow({ mtime: NaN }),
          snippet: "text",
          score: 0.5,
          includeLeadingCallout: false,
        }),
      ),
    ).toEqual({ isIndexIntegrityError: true, message: "invalid mtime: NaN", causeName: "Error" })
  })
})

// ── fileContentRowToSearchResult ──────────────────────────────────────

describe("fileContentRowToSearchResult", () => {
  it("builds a SearchResult with kind file and extracted extension", () => {
    const result = fileContentRowToSearchResult(
      {
        path: "Diagrams/architecture.canvas",
        title: "architecture",
        folder: "Diagrams",
        mtime: 1700000000000,
        bytes: 2048,
        snippet: "Architecture overview with deployment details",
      },
      0.85,
    )
    expect(result).toEqual({
      path: "Diagrams/architecture.canvas",
      title: "architecture",
      snippet: "Architecture overview with deployment details",
      score: 0.85,
      tags: [],
      folder: "Diagrams",
      type: null,
      kind: "file",
      extension: ".canvas",
      modified: mtimeToIso(1700000000000),
      bytes: 2048,
    })
  })

  it("sets extension to undefined for a path with no extension", () => {
    const result = fileContentRowToSearchResult(
      {
        path: "assets/Makefile",
        title: "Makefile",
        folder: "assets",
        mtime: 1700000000000,
        bytes: 512,
        snippet: "build target",
      },
      0.5,
    )
    expect(result).toEqual({
      path: "assets/Makefile",
      title: "Makefile",
      snippet: "build target",
      score: 0.5,
      tags: [],
      folder: "assets",
      type: null,
      kind: "file",
      extension: undefined,
      modified: mtimeToIso(1700000000000),
      bytes: 512,
    })
  })

  it("throws IndexIntegrityError when the stored mtime cannot be formatted", () => {
    expect(
      describeThrow(() =>
        fileContentRowToSearchResult(
          {
            path: "Diagrams/architecture.canvas",
            title: "architecture",
            folder: "Diagrams",
            mtime: NaN,
            bytes: 2048,
            snippet: "Architecture overview",
          },
          0.85,
        ),
      ),
    ).toEqual({ isIndexIntegrityError: true, message: "invalid mtime: NaN", causeName: "Error" })
  })
})

// ── Tag comparison ───────────────────────────────────────────────────

describe("foldTag", () => {
  it("lowercases ASCII and accented letters", () => {
    expect(foldTag("Project")).toBe("project")
    expect(foldTag("Ärger")).toBe("ärger")
  })

  it("folds a capital sharp s to the small one, so the pair compares equal", () => {
    expect(foldTag("ẞ")).toBe("ß")
    expect(foldTag("ß")).toBe("ß")
  })

  it("keeps sharp s apart from double s, which Obsidian lists apart", () => {
    expect(foldTag("Straße")).toBe("straße")
    expect(foldTag("STRASSE")).toBe("strasse")
  })
})

describe("normalizeTagQuery", () => {
  it("removes one leading # and folds", () => {
    expect(normalizeTagQuery("#Project")).toBe("project")
    expect(normalizeTagQuery("##x")).toBe("#x")
  })

  it("keeps a trailing slash, which only a stored tag ending in a slash equals", () => {
    expect(normalizeTagQuery("foo/")).toBe("foo/")
  })

  it("throws when nothing is left after the leading #", () => {
    expect(() => normalizeTagQuery("#")).toThrow(
      new Error('tag must not be empty after its leading "#"'),
    )
  })
})

describe("nestedTagLikePattern", () => {
  it("folds, removes the leading #, escapes LIKE wildcards, and appends /%", () => {
    expect(nestedTagLikePattern("#A_b%")).toBe("a\\_b\\%/%")
  })

  it("throws for an input that is only a #", () => {
    expect(() => nestedTagLikePattern("#")).toThrow(
      new Error('tag must not be empty after its leading "#"'),
    )
  })
})

// ── dayToEpochMsRange ──────────────────────────────────────

describe("dayToEpochMsRange", () => {
  it("brackets exactly one server-local day, half-open", () => {
    const bounds = dayToEpochMsRange("2026-06-15")
    expect(bounds).toEqual({
      startMs: DateTime.fromISO("2026-06-15").toMillis(),
      endMs: DateTime.fromISO("2026-06-16").toMillis(),
    })
  })

  it("brackets a 23-hour spring-forward day and a 25-hour fall-back day in a DST zone", () => {
    // Pin a DST-observing zone — the suite's TZ-portability runs (UTC,
    // Pacific/Kiritimati) never cross a DST transition, so the helper's
    // calendar-aware plus({ days: 1 }) claim is only exercised here
    const previousZone = Settings.defaultZone
    Settings.defaultZone = "America/New_York"
    try {
      const HOUR_MS = 3_600_000
      // 2026-03-08: clocks spring forward 02:00 → 03:00, a 23-hour day
      const springForwardBounds = dayToEpochMsRange("2026-03-08")
      expect(springForwardBounds.endMs - springForwardBounds.startMs).toBe(23 * HOUR_MS)
      // 2026-11-01: clocks fall back 02:00 → 01:00, a 25-hour day
      const fallBackBounds = dayToEpochMsRange("2026-11-01")
      expect(fallBackBounds.endMs - fallBackBounds.startMs).toBe(25 * HOUR_MS)
    } finally {
      Settings.defaultZone = previousZone
    }
  })

  it("throws on a malformed date instead of returning NaN bounds", () => {
    expect(() => dayToEpochMsRange("bad")).toThrow(
      new Error('invalid date: "bad". Use YYYY-MM-DD (e.g. 2026-07-03).'),
    )
  })

  it("throws on a calendar-invalid date", () => {
    expect(() => dayToEpochMsRange("2026-02-31")).toThrow(
      new Error('invalid date: "2026-02-31". Use YYYY-MM-DD (e.g. 2026-07-03).'),
    )
  })

  it("throws on a valid ISO timestamp that is not a bare day", () => {
    // fromISO would accept this and silently compute a 10:30-to-10:30 window;
    // the strict yyyy-MM-dd parse rejects it instead
    expect(() => dayToEpochMsRange("2026-07-03T10:30:00")).toThrow(
      new Error('invalid date: "2026-07-03T10:30:00". Use YYYY-MM-DD (e.g. 2026-07-03).'),
    )
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

// ── Folder paths ──────────────────────────────────────────────

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
    expect(stripTrailingSlashes("Projects/Alpha/Beta/")).toBe("Projects/Alpha/Beta")
  })

  it("handles a bare folder name", () => {
    expect(stripTrailingSlashes("Projects")).toBe("Projects")
  })
})
