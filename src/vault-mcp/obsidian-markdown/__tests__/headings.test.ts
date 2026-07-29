import { describe, it, expect } from "vitest"
import {
  parseHeadings,
  findHeading,
  linesBeforeFirstHeading,
} from "../headings.js"

describe("parseHeadings", () => {
  it("parses H1–H6 with each section spanning to the next same-or-higher heading", () => {
    const lines = [
      "# Top", // 0
      "intro", // 1
      "## Sub A", // 2
      "a body", // 3
      "## Sub B", // 4
      "b body", // 5
    ]
    const headings = parseHeadings(lines)
    // "Top" (H1) has no later H1-or-higher heading, so its span runs to EOF
    // and includes both H2 children. Each H2 stops at the next H2.
    expect(headings).toEqual([
      { text: "Top", level: 1, startLine: 0, bodyStartLine: 1, bodyEndLine: 6 },
      {
        text: "Sub A",
        level: 2,
        startLine: 2,
        bodyStartLine: 3,
        bodyEndLine: 4,
      },
      {
        text: "Sub B",
        level: 2,
        startLine: 4,
        bodyStartLine: 5,
        bodyEndLine: 6,
      },
    ])
  })

  it("includes child headings in a parent section's span", () => {
    const lines = ["## Parent", "x", "### Child", "y", "## Sibling", "z"]
    const parent = parseHeadings(lines).find(
      (heading) => heading.text === "Parent",
    )
    // bodyEndLine stops at "## Sibling" (line 4), so "### Child" is included.
    expect(parent).toEqual({
      text: "Parent",
      level: 2,
      startLine: 0,
      bodyStartLine: 1,
      bodyEndLine: 4,
    })
  })

  it("ignores ATX headings inside fenced code blocks", () => {
    const lines = ["# Real", "```", "# Not a heading", "```", "## Also real"]
    const headingTexts = parseHeadings(lines).map((heading) => heading.text)
    expect(headingTexts).toEqual(["Real", "Also real"])
  })

  it("ignores ATX headings inside a blockquoted fenced code block", () => {
    const lines = [
      "# Real",
      "> ```",
      "> ## Not a heading",
      "> ```",
      "## Also real",
    ]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
      "Also real",
    ])
  })

  it("recognizes a heading after a blockquoted fence implicitly closes", () => {
    const lines = [
      "> ```",
      "> ## Hidden inside fence",
      "## Visible after implicit close",
    ]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Visible after implicit close",
    ])
  })

  it("ignores ATX headings inside an indented fenced code block (CommonMark §4.5)", () => {
    // The fence is indented 3 spaces — recognized via the shared lines.ts fence
    // grammar. The previous heading-local matcher required column 0, so it would
    // have mis-parsed "# Not a heading" here as a real heading.
    const lines = [
      "# Real",
      "   ```",
      "# Not a heading",
      "   ```",
      "## Also real",
    ]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
      "Also real",
    ])
  })

  // ── CommonMark §4.2 parity ────────────────────────────────────

  it("parses a heading with a tab separator", () => {
    const headings = parseHeadings(["##\tTitle"])
    expect(headings).toEqual([
      {
        text: "Title",
        level: 2,
        startLine: 0,
        bodyStartLine: 1,
        bodyEndLine: 1,
      },
    ])
  })

  it("parses headings with 1-3 leading spaces", () => {
    const headings = parseHeadings([
      " # One", // 0
      "  ## Two", // 1
      "   ### Three", // 2
    ])
    expect(headings).toEqual([
      { text: "One", level: 1, startLine: 0, bodyStartLine: 1, bodyEndLine: 3 },
      { text: "Two", level: 2, startLine: 1, bodyStartLine: 2, bodyEndLine: 3 },
      {
        text: "Three",
        level: 3,
        startLine: 2,
        bodyStartLine: 3,
        bodyEndLine: 3,
      },
    ])
  })

  it("parses a heading with leading spaces and tab separator", () => {
    const headings = parseHeadings(["  ##\tTitle"])
    expect(headings).toEqual([
      {
        text: "Title",
        level: 2,
        startLine: 0,
        bodyStartLine: 1,
        bodyEndLine: 1,
      },
    ])
  })

  it("does not parse a heading with 4+ leading spaces (indented code block)", () => {
    expect(parseHeadings(["    ## Title"])).toEqual([])
  })

  it("parses an empty heading (hashes only, no separator or text)", () => {
    const headings = parseHeadings(["##"])
    expect(headings).toEqual([
      {
        text: "",
        level: 2,
        startLine: 0,
        bodyStartLine: 1,
        bodyEndLine: 1,
      },
    ])
  })

  it("parses an empty heading with trailing space (separator but no text)", () => {
    const headings = parseHeadings(["## "])
    expect(headings).toEqual([
      {
        text: "",
        level: 2,
        startLine: 0,
        bodyStartLine: 1,
        bodyEndLine: 1,
      },
    ])
  })

  it("does not parse hashes followed by text without a separator", () => {
    expect(parseHeadings(["##NoSpace"])).toEqual([])
  })

  it("strips trailing closing hashes from heading text", () => {
    const headings = parseHeadings(["## Title ##"])
    const headingTexts = headings.map((heading) => heading.text)
    expect(headingTexts).toEqual(["Title"])
  })

  it("stops the final section before a trailing Kanban %% settings block", () => {
    const lines = [
      "## Active", // 0
      "- card", // 1
      "", // 2
      "%% kanban:settings", // 3
      "{}", // 4
      "%%", // 5
    ]
    // bodyEndLine absorbs the blank line before %% → ends at line 2.
    const headings = parseHeadings(lines)
    expect(headings[0]?.bodyEndLine).toBe(2)
  })

  it("returns an empty array when there are no headings", () => {
    expect(parseHeadings(["just", "prose"])).toEqual([])
  })

  // ── comment-block awareness ───────────────────────────────────

  it("ignores headings inside a %% %% comment block", () => {
    const lines = ["# Real", "%%", "## Hidden", "%%", "## Also real"]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
      "Also real",
    ])
  })

  it("recognizes a heading after a comment block closes", () => {
    const lines = ["%%", "## Hidden", "%%", "## Visible"]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Visible",
    ])
  })

  it("does not open a fence inside a comment block", () => {
    const lines = [
      "%%",
      "```",
      "## Hidden inside comment",
      "```",
      "%%",
      "## Visible",
    ]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Visible",
    ])
  })

  it("ignores a heading inside a single-line inline comment", () => {
    const lines = ["# Real", "%% ## Hidden %%", "## Also real"]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
      "Also real",
    ])
  })

  it("ignores headings inside an unclosed comment running to EOF", () => {
    const lines = [
      "# Real",
      "%%",
      "## Hidden by unclosed comment",
      "## Also hidden",
    ]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
    ])
  })

  it("does not toggle comment state inside a fenced code block", () => {
    const lines = [
      "```",
      "%%",
      "## Hidden inside fence",
      "%%",
      "```",
      "## Real",
    ]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
    ])
  })

  // ── setext heading support (CommonMark §4.3) ─────────────────

  it("parses a setext H1 heading (=== underline)", () => {
    const headings = parseHeadings(["Title", "==="])
    expect(headings).toEqual([
      {
        text: "Title",
        level: 1,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 2,
      },
    ])
  })

  it("parses a setext H2 heading (--- underline)", () => {
    const headings = parseHeadings(["Title", "---"])
    expect(headings).toEqual([
      {
        text: "Title",
        level: 2,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 2,
      },
    ])
  })

  it("parses setext underlines with 0-3 leading spaces", () => {
    const headings = parseHeadings(["H1", " ===", "H2", "  ---"])
    expect(
      headings.map((heading) => ({ text: heading.text, level: heading.level })),
    ).toEqual([
      { text: "H1", level: 1 },
      { text: "H2", level: 2 },
    ])
  })

  it("parses setext underlines with trailing whitespace", () => {
    const headings = parseHeadings(["Title", "=== \t "])
    expect(headings).toEqual([
      {
        text: "Title",
        level: 1,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 2,
      },
    ])
  })

  it("parses a single-character = underline as H1", () => {
    expect(parseHeadings(["Title", "="])).toEqual([
      {
        text: "Title",
        level: 1,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 2,
      },
    ])
  })

  it("parses a single-character - underline as H2", () => {
    expect(parseHeadings(["Title", "-"])).toEqual([
      {
        text: "Title",
        level: 2,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 2,
      },
    ])
  })

  it("does not parse --- after a blank line as setext (thematic break)", () => {
    expect(parseHeadings(["Text", "", "---"])).toEqual([])
  })

  it("does not parse --- as the first line as setext", () => {
    expect(parseHeadings(["---", "body"])).toEqual([])
  })

  it("does not parse a setext underline with 4+ leading spaces", () => {
    expect(parseHeadings(["Title", "    ==="])).toEqual([])
  })

  it("ignores setext underlines inside a fenced code block", () => {
    const lines = ["```", "Title", "===", "```", "## Real"]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
    ])
  })

  it("ignores setext underlines inside a comment block", () => {
    const lines = ["%%", "Title", "===", "%%", "## Real"]
    expect(parseHeadings(lines).map((heading) => heading.text)).toEqual([
      "Real",
    ])
  })

  it("parses adjacent setext headings", () => {
    // H2 is a child of H1, so H1's body spans to EOF (includes the H2).
    const headings = parseHeadings(["H1 Title", "===", "H2 Title", "---"])
    expect(headings).toEqual([
      {
        text: "H1 Title",
        level: 1,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 4,
      },
      {
        text: "H2 Title",
        level: 2,
        startLine: 2,
        bodyStartLine: 4,
        bodyEndLine: 4,
      },
    ])
  })

  it("parses mixed ATX and setext headings with correct spans", () => {
    const lines = [
      "# ATX H1", // 0
      "body", // 1
      "Setext H2", // 2
      "---", // 3
      "more body", // 4
    ]
    const headings = parseHeadings(lines)
    expect(headings).toEqual([
      {
        text: "ATX H1",
        level: 1,
        startLine: 0,
        bodyStartLine: 1,
        bodyEndLine: 5,
      },
      {
        text: "Setext H2",
        level: 2,
        startLine: 2,
        bodyStartLine: 4,
        bodyEndLine: 5,
      },
    ])
  })

  it("does not parse ATX heading followed by === as setext", () => {
    const headings = parseHeadings(["## ATX Title", "==="])
    expect(headings).toEqual([
      {
        text: "ATX Title",
        level: 2,
        startLine: 0,
        bodyStartLine: 1,
        bodyEndLine: 2,
      },
    ])
  })

  it("trims whitespace from setext heading text", () => {
    expect(parseHeadings(["  Padded Title  ", "==="])).toEqual([
      {
        text: "Padded Title",
        level: 1,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 2,
      },
    ])
  })

  it("spans a setext heading body to the next same-or-higher heading", () => {
    const lines = [
      "Section A", // 0
      "===", // 1
      "body a", // 2
      "Section B", // 3
      "---", // 4
      "body b", // 5
    ]
    expect(parseHeadings(lines)).toEqual([
      {
        text: "Section A",
        level: 1,
        startLine: 0,
        bodyStartLine: 2,
        bodyEndLine: 6,
      },
      {
        text: "Section B",
        level: 2,
        startLine: 3,
        bodyStartLine: 5,
        bodyEndLine: 6,
      },
    ])
  })
})

describe("linesBeforeFirstHeading", () => {
  const regionOf = (lines: readonly string[]): readonly string[] =>
    linesBeforeFirstHeading(lines, parseHeadings(lines))

  it("returns the lines above the first heading", () => {
    expect(regionOf(["Intro.", "", "## Section", "body"])).toEqual([
      "Intro.",
      "",
    ])
  })

  it("returns nothing when the first line is a heading", () => {
    expect(regionOf(["# Title", "", "body"])).toEqual([])
  })

  it("returns the whole body when the note has no headings", () => {
    expect(regionOf(["Just prose.", "", "more"])).toEqual([
      "Just prose.",
      "",
      "more",
    ])
  })

  it("stops at the first heading whatever its level", () => {
    // A deeper heading first, then a shallower one — so "first of any level"
    // is really under test, not "first H1" or "first H2".
    expect(regionOf(["intro", "###### Deep", "# Later"])).toEqual(["intro"])
  })

  it("keeps a heading inside a fenced code block in the region", () => {
    const lines = ["```md", "## Example", "```", "", "Prose", "", "## Real"]
    expect(regionOf(lines)).toEqual([
      "```md",
      "## Example",
      "```",
      "",
      "Prose",
      "",
    ])
  })

  it("keeps a heading inside a comment block in the region", () => {
    const lines = ["%%", "# Draft", "%%", "", "Prose", "## Real"]
    expect(regionOf(lines)).toEqual(["%%", "# Draft", "%%", "", "Prose"])
  })

  it("stops before a trailing comment block when the note has no headings", () => {
    // An empty Kanban board: no lanes yet, just its settings block. Running to
    // EOF here would report the settings JSON as body content.
    const lines = ["", "%% kanban:settings", "```json", "{}", "```", "%%", ""]
    expect(regionOf(lines)).toEqual([])
  })

  it("keeps a non-trailing comment block in the region", () => {
    const lines = ["%% note %%", "", "Prose", "", "## S"]
    expect(regionOf(lines)).toEqual(["%% note %%", "", "Prose", ""])
  })

  it("returns nothing for an empty line array", () => {
    expect(regionOf([])).toEqual([])
  })

  it("does not trim a blank-only region", () => {
    // Blank-suppression is the consumer's call, not this parser's.
    expect(regionOf(["", "   ", "\t"])).toEqual(["", "   ", "\t"])
  })

  it("stops at a heading with leading spaces", () => {
    expect(regionOf(["intro", "  ## Section"])).toEqual(["intro"])
  })

  it("stops at a heading with a tab separator", () => {
    expect(regionOf(["intro", "##\tSection"])).toEqual(["intro"])
  })

  it("stops at an empty heading (no separator or text)", () => {
    expect(regionOf(["intro", "##"])).toEqual(["intro"])
  })

  it("stops at a setext heading", () => {
    expect(regionOf(["intro", "Section", "===", "body"])).toEqual(["intro"])
  })

  it("returns nothing when the first line is a setext heading's text line", () => {
    expect(regionOf(["Title", "===", "body"])).toEqual([])
  })

  it("finds no heading boundary in raw CRLF lines", () => {
    // Documents the contract: callers normalize with splitIntoLines first.
    // HEADING_REGEX uses `(.*)` where `.` excludes CR, so "## S\r" is not a
    // heading and the whole body reads as leading content.
    const lines = "intro\r\n## S\r\n".split("\n")
    expect(regionOf(lines)).toEqual(["intro\r", "## S\r", ""])
  })
})

describe("findHeading", () => {
  const headings = parseHeadings([
    "# Board",
    "## Active",
    "## Done",
    "### Active",
  ])

  it("returns the single matching heading", () => {
    expect(findHeading(headings, "Board").level).toBe(1)
  })

  it("disambiguates duplicate text by level", () => {
    expect(findHeading(headings, "Active", 3).level).toBe(3)
  })

  it("throws and lists available headings when none match", () => {
    expect(() => findHeading(headings, "Missing")).toThrow(
      'heading not found: "Missing". Available headings: # Board, ## Active, ## Done, ### Active',
    )
  })

  it("throws ambiguous when more than one heading matches", () => {
    expect(() => findHeading(headings, "Active")).toThrow(
      'ambiguous heading: "Active"',
    )
  })

  it("throws when the heading text is empty or whitespace", () => {
    expect(() => findHeading(headings, "   ")).toThrow(
      "heading cannot be empty",
    )
  })

  it("resolves a setext heading by text and level", () => {
    const mixedHeadings = parseHeadings(["# ATX", "Setext Title", "---"])
    expect(findHeading(mixedHeadings, "Setext Title")).toEqual({
      text: "Setext Title",
      level: 2,
      startLine: 1,
      bodyStartLine: 3,
      bodyEndLine: 3,
    })
  })
})
