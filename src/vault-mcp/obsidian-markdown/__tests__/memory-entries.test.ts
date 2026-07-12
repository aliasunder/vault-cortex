import { describe, it, expect } from "vitest"
import { parseMemoryEntries } from "../memory-entries.js"

describe("parseMemoryEntries", () => {
  it("parses a single dated entry with exact section, date, text, and index", () => {
    const lines = [
      "## Working style (newest first)",
      "- **2026-05-14**: Thorough planning before implementation starts.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Working style (newest first)",
        date: "2026-05-14",
        text: "- **2026-05-14**: Thorough planning before implementation starts.",
        entryIndex: 0,
      },
    ])
  })

  it("absorbs continuation lines and sub-bullets into the entry text", () => {
    const lines = [
      "## Code patterns (newest first)",
      "- **2026-06-20**: A test must clear two separate bars:",
      "  wrapped prose continues the entry.",
      "  - sub-bullet one",
      "  - sub-bullet two",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Code patterns (newest first)",
        date: "2026-06-20",
        text: [
          "- **2026-06-20**: A test must clear two separate bars:",
          "  wrapped prose continues the entry.",
          "  - sub-bullet one",
          "  - sub-bullet two",
        ].join("\n"),
        entryIndex: 0,
      },
    ])
  })

  it("ends an entry at the next dated bullet", () => {
    const lines = [
      "## Process (newest first)",
      "- **2026-07-02**: Newer entry.",
      "- **2026-06-15**: Older entry.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Process (newest first)",
        date: "2026-07-02",
        text: "- **2026-07-02**: Newer entry.",
        entryIndex: 0,
      },
      {
        section: "Process (newest first)",
        date: "2026-06-15",
        text: "- **2026-06-15**: Older entry.",
        entryIndex: 1,
      },
    ])
  })

  it("ends an entry at the next heading, trimming trailing blank lines", () => {
    const lines = [
      "## First section",
      "- **2026-01-01**: Entry in first section.",
      "",
      "",
      "## Second section",
      "- **2026-02-02**: Entry in second section.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "First section",
        date: "2026-01-01",
        text: "- **2026-01-01**: Entry in first section.",
        entryIndex: 0,
      },
      {
        section: "Second section",
        date: "2026-02-02",
        text: "- **2026-02-02**: Entry in second section.",
        entryIndex: 1,
      },
    ])
  })

  it("ends the final entry at EOF", () => {
    const lines = [
      "## Only section",
      "- **2026-03-03**: Final entry,",
      "  with a continuation line at EOF.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Only section",
        date: "2026-03-03",
        text: "- **2026-03-03**: Final entry,\n  with a continuation line at EOF.",
        entryIndex: 0,
      },
    ])
  })

  it("ignores prose and callouts before a section's first entry", () => {
    const lines = [
      "## Targets (newest first)",
      "> [!info] Scope note",
      "> This callout belongs to no entry.",
      "Intro prose also belongs to no entry.",
      "- **2026-04-04**: The actual entry.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Targets (newest first)",
        date: "2026-04-04",
        text: "- **2026-04-04**: The actual entry.",
        entryIndex: 0,
      },
    ])
  })

  it("does not start an entry from a dated bullet inside a fenced code block", () => {
    const lines = [
      "## Section",
      "- **2026-05-05**: Real entry before the fence.",
      "```markdown",
      "- **2026-01-01**: fake entry inside a fence",
      "```",
    ]
    const entries = parseMemoryEntries(lines)
    // Exactly one entry — the fake bullet started nothing — and the fenced
    // lines are absorbed into the real entry as continuation content.
    expect(entries).toEqual([
      {
        section: "Section",
        date: "2026-05-05",
        text: [
          "- **2026-05-05**: Real entry before the fence.",
          "```markdown",
          "- **2026-01-01**: fake entry inside a fence",
          "```",
        ].join("\n"),
        entryIndex: 0,
      },
    ])
  })

  it("does not start an entry from a dated bullet inside a fence that precedes any entry", () => {
    const lines = [
      "## Section",
      "```",
      "- **2026-01-01**: fake entry, no real entry is open",
      "```",
      "- **2026-06-06**: Real entry after the fence.",
    ]
    // The fenced fake bullet belongs to no entry (none open) and is dropped
    // with the rest of the pre-entry content; only the real entry survives.
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Section",
        date: "2026-06-06",
        text: "- **2026-06-06**: Real entry after the fence.",
        entryIndex: 0,
      },
    ])
  })

  it("does not start an entry from a dated bullet inside a %% comment block", () => {
    const lines = [
      "## Section",
      "%%",
      "- **2026-01-01**: fake entry inside a comment",
      "%%",
      "- **2026-07-07**: Real entry after the comment.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Section",
        date: "2026-07-07",
        text: "- **2026-07-07**: Real entry after the comment.",
        entryIndex: 0,
      },
    ])
  })

  it("keeps a calendar-invalid date verbatim", () => {
    const lines = [
      "## Section",
      "- **2026-13-45**: Impossible date, kept as-is.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Section",
        date: "2026-13-45",
        text: "- **2026-13-45**: Impossible date, kept as-is.",
        entryIndex: 0,
      },
    ])
  })

  it("attributes entries under an H3 to the enclosing H2 section", () => {
    const lines = [
      "## Outer H2",
      "- **2026-01-10**: Directly under the H2.",
      "### Inner H3",
      "- **2026-01-20**: Under the H3, still attributed to the H2.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Outer H2",
        date: "2026-01-10",
        text: "- **2026-01-10**: Directly under the H2.",
        entryIndex: 0,
      },
      {
        section: "Outer H2",
        date: "2026-01-20",
        text: "- **2026-01-20**: Under the H3, still attributed to the H2.",
        entryIndex: 1,
      },
    ])
  })

  it("numbers entryIndex in document order across sections", () => {
    const lines = [
      "# File Title",
      "## Section A",
      "- **2026-02-01**: First in A.",
      "- **2026-01-01**: Second in A.",
      "## Section B",
      "- **2026-03-01**: First in B.",
    ]
    const entryIndexByDate = parseMemoryEntries(lines).map((entry) => [
      entry.date,
      entry.entryIndex,
    ])
    expect(entryIndexByDate).toEqual([
      ["2026-02-01", 0],
      ["2026-01-01", 1],
      ["2026-03-01", 2],
    ])
  })

  it("returns no entries for a file without H2 sections", () => {
    const lines = [
      "# Only a Title",
      "- **2026-01-01**: Dated bullet outside any H2 section.",
    ]
    expect(parseMemoryEntries(lines)).toEqual([])
  })

  it("does not treat an undated or malformed bullet as an entry start", () => {
    const lines = [
      "## Section",
      "- **2026-08-08**: Real entry.",
      "- plain bullet without a date",
      "- **2026-9-9**: unpadded date is not the grammar",
    ]
    // Both malformed bullets are continuations of the open entry, not entries.
    expect(parseMemoryEntries(lines)).toEqual([
      {
        section: "Section",
        date: "2026-08-08",
        text: [
          "- **2026-08-08**: Real entry.",
          "- plain bullet without a date",
          "- **2026-9-9**: unpadded date is not the grammar",
        ].join("\n"),
        entryIndex: 0,
      },
    ])
  })
})
