import { describe, it, expect } from "vitest"
import {
  splitIntoLines,
  trimBlankEdgeLines,
  collapseEmptyLineRunsAtEdits,
  advanceFence,
  advanceComment,
  classifyLines,
  pageTextByLines,
  type OpenFence,
} from "../lines.js"

// ── trimBlankEdgeLines ───────────────────────────────────────────

describe("trimBlankEdgeLines", () => {
  it("drops blank lines from both ends", () => {
    expect(trimBlankEdgeLines(["", "  ", "a", "b", "", "\t"])).toEqual(["a", "b"])
  })

  it("keeps interior blank lines", () => {
    expect(trimBlankEdgeLines(["a", "", "b"])).toEqual(["a", "", "b"])
  })

  it("returns an empty array when every line is blank", () => {
    expect(trimBlankEdgeLines(["", "   ", "\t"])).toEqual([])
  })

  it("returns an empty array for no lines", () => {
    expect(trimBlankEdgeLines([])).toEqual([])
  })

  it("leaves an already-trimmed array unchanged", () => {
    expect(trimBlankEdgeLines(["a", "b"])).toEqual(["a", "b"])
  })
})

// ── collapseEmptyLineRunsAtEdits ─────────────────────────────────

describe("collapseEmptyLineRunsAtEdits", () => {
  it("keeps one empty line where two one-line gaps meet", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "B"],
      edits: [{ boundary: 2, gapAbove: 1, gapBelow: 1 }],
    })

    expect(collapsed).toEqual(["A", "", "B"])
  })

  it("keeps the wider gap when it sat above the edit", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "", "B"],
      edits: [{ boundary: 3, gapAbove: 2, gapBelow: 1 }],
    })

    expect(collapsed).toEqual(["A", "", "", "B"])
  })

  it("keeps the wider gap when it sat below the edit", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "", "B"],
      edits: [{ boundary: 2, gapAbove: 1, gapBelow: 2 }],
    })

    expect(collapsed).toEqual(["A", "", "", "B"])
  })

  it("leaves a run the edit touched from one side only", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "B"],
      edits: [{ boundary: 1, gapAbove: 0, gapBelow: 2 }],
    })

    expect(collapsed).toEqual(["A", "", "", "B"])
  })

  it("leaves a single empty line even when its gaps were smaller", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "B"],
      edits: [{ boundary: 1, gapAbove: 0, gapBelow: 0 }],
    })

    expect(collapsed).toEqual(["A", "", "B"])
  })

  it("keeps one empty line of a longer run whose gaps were both zero", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "B"],
      edits: [
        { boundary: 1, gapAbove: 0, gapBelow: 0 },
        { boundary: 2, gapAbove: 0, gapBelow: 0 },
      ],
    })

    expect(collapsed).toEqual(["A", "", "B"])
  })

  it("leaves runs that no edit touches", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["top", "", "", "middle", "", "", "end"],
      edits: [{ boundary: 5, gapAbove: 1, gapBelow: 1 }],
    })

    expect(collapsed).toEqual(["top", "", "", "middle", "", "end"])
  })

  it("treats a line of spaces as text, not as part of a run", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", " ", "", "B"],
      edits: [{ boundary: 2, gapAbove: 1, gapBelow: 1 }],
    })

    expect(collapsed).toEqual(["A", "", " ", "", "B"])
  })

  it("pools the gaps of two edits in one run when the first edit holds the widest", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "", "", "B"],
      edits: [
        { boundary: 2, gapAbove: 3, gapBelow: 0 },
        { boundary: 4, gapAbove: 0, gapBelow: 1 },
      ],
    })

    expect(collapsed).toEqual(["A", "", "", "", "B"])
  })

  it("pools the gaps of two edits in one run when the second edit holds the widest", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "", "", "B"],
      edits: [
        { boundary: 2, gapAbove: 1, gapBelow: 0 },
        { boundary: 4, gapAbove: 0, gapBelow: 3 },
      ],
    })

    expect(collapsed).toEqual(["A", "", "", "", "B"])
  })

  it("collapses a run at the start of the lines", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["", "", "", "B"],
      edits: [{ boundary: 0, gapAbove: 0, gapBelow: 2 }],
    })

    expect(collapsed).toEqual(["", "", "B"])
  })

  it("collapses a run that ends the lines, for an edit placed after the last line", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", ""],
      edits: [{ boundary: 4, gapAbove: 2, gapBelow: 0 }],
    })

    expect(collapsed).toEqual(["A", "", ""])
  })

  it("measures every run before dropping lines, so an earlier collapse does not shift a later edit", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "", "B", "", "", "", "C"],
      edits: [
        { boundary: 2, gapAbove: 1, gapBelow: 1 },
        { boundary: 6, gapAbove: 2, gapBelow: 0 },
      ],
    })

    expect(collapsed).toEqual(["A", "", "B", "", "", "C"])
  })

  it("returns the lines unchanged when there are no edits", () => {
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "", "", "B"],
      edits: [],
    })

    expect(collapsed).toEqual(["A", "", "", "B"])
  })

  it("never adds empty lines to a run shorter than its widest gap", () => {
    // The first edit sits between two lines of text (a run of no lines); the
    // second's gap counts more lines than its one-line run holds.
    const collapsed = collapseEmptyLineRunsAtEdits({
      lines: ["A", "B", "", "C"],
      edits: [
        { boundary: 1, gapAbove: 0, gapBelow: 0 },
        { boundary: 2, gapAbove: 3, gapBelow: 0 },
      ],
    })

    expect(collapsed).toEqual(["A", "B", "", "C"])
  })
})

// ── splitIntoLines ───────────────────────────────────────────────

describe("splitIntoLines", () => {
  it("splits LF content into lines", () => {
    expect(splitIntoLines("a\nb\nc")).toEqual(["a", "b", "c"])
  })

  it("strips a trailing CR so CRLF content yields LF-only lines", () => {
    expect(splitIntoLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"])
  })

  it("strips CR only at line end, leaving a mid-line CR intact", () => {
    expect(splitIntoLines("a\rb\r\nc")).toEqual(["a\rb", "c"])
  })

  it("returns a single empty line for empty content", () => {
    expect(splitIntoLines("")).toEqual([""])
  })
})

// ── advanceComment ──────────────────────────────────────────────

describe("advanceComment", () => {
  it("reports a plain line outside a comment as not comment", () => {
    expect(advanceComment("some text", false)).toEqual({
      commentOpen: false,
      lineIsComment: false,
    })
  })

  it("reports a plain line inside an open comment as comment", () => {
    expect(advanceComment("some text", true)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })

  it("opens a comment on a standalone %% delimiter", () => {
    expect(advanceComment("%%", false)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })

  it("closes a comment on a standalone %% delimiter", () => {
    expect(advanceComment("%%", true)).toEqual({
      commentOpen: false,
      lineIsComment: true,
    })
  })

  it("opens a comment when line starts with %%", () => {
    expect(advanceComment("%% hidden text", false)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })

  it("closes a comment when line ends with %%", () => {
    expect(advanceComment("end of comment %%", true)).toEqual({
      commentOpen: false,
      lineIsComment: true,
    })
  })

  it("handles inline comment (2 toggles) from closed state — net unchanged", () => {
    expect(advanceComment("%% inline comment %%", false)).toEqual({
      commentOpen: false,
      lineIsComment: true,
    })
  })

  it("handles inline comment (2 toggles) from open state — net unchanged", () => {
    expect(advanceComment("%% inline comment %%", true)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })

  it("does not toggle on mid-line %% surrounded by other text", () => {
    expect(advanceComment("Card with 100%% off", false)).toEqual({
      commentOpen: false,
      lineIsComment: false,
    })
  })

  it("does not toggle on mid-line %% inside an open comment", () => {
    expect(advanceComment("100%% done items", true)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })

  it("treats a whitespace-padded %% as a delimiter", () => {
    expect(advanceComment("  %%  ", false)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })

  it("counts only the boundary %% when a non-boundary %% sits mid-line", () => {
    expect(advanceComment("%% note %% more text", false)).toEqual({
      commentOpen: true,
      lineIsComment: true,
    })
  })
})

// ── advanceFence ─────────────────────────────────────────────────

/** Shorthand for an open fence at a given depth (default 0). */
const fence = (delimiter: string, quoteDepth = 0): OpenFence => ({
  delimiter,
  quoteDepth,
})

describe("advanceFence", () => {
  // ── depth-0 (backward-compatible) ────────────────────────────

  it("opens a fence on a delimiter line outside a fence", () => {
    expect(advanceFence("```", null)).toEqual({
      openFence: fence("```"),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("reports a non-fence line outside a fence as neither delimiter nor open", () => {
    expect(advanceFence("plain", null)).toEqual({
      openFence: null,
      isFenceDelimiter: false,
      lineIsCode: false,
    })
  })

  it("keeps the fence open for an interior non-fence line", () => {
    expect(advanceFence("code", fence("```"))).toEqual({
      openFence: fence("```"),
      isFenceDelimiter: false,
      lineIsCode: true,
    })
  })

  it("closes the fence on a matching closer", () => {
    expect(advanceFence("```", fence("```"))).toEqual({
      openFence: null,
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("does not close a backtick fence on a tilde delimiter", () => {
    expect(advanceFence("~~~", fence("```"))).toEqual({
      openFence: fence("```"),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("does not close on a delimiter shorter than the opener", () => {
    expect(advanceFence("```", fence("````"))).toEqual({
      openFence: fence("````"),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("closes on a delimiter longer than the opener", () => {
    expect(advanceFence("`````", fence("```"))).toEqual({
      openFence: null,
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("does not close on a delimiter carrying a trailing info string", () => {
    expect(advanceFence("``` js", fence("```"))).toEqual({
      openFence: fence("```"),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("opens a fence indented up to three spaces (CommonMark §4.5)", () => {
    expect(advanceFence("   ```", null)).toEqual({
      openFence: fence("```"),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("does not treat four-space-indented backticks as a fence opener", () => {
    expect(advanceFence("    ```", null)).toEqual({
      openFence: null,
      isFenceDelimiter: false,
      lineIsCode: false,
    })
  })

  // ── blockquote depth awareness ───────────────────────────────

  it("opens a fence inside a blockquote at depth 1", () => {
    expect(advanceFence("> ```", null)).toEqual({
      openFence: fence("```", 1),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("recognizes content inside a blockquoted fence as code", () => {
    expect(advanceFence("> code", fence("```", 1))).toEqual({
      openFence: fence("```", 1),
      isFenceDelimiter: false,
      lineIsCode: true,
    })
  })

  it("closes a blockquoted fence at matching depth", () => {
    expect(advanceFence("> ```", fence("```", 1))).toEqual({
      openFence: null,
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("implicitly closes fence when blockquote depth drops", () => {
    expect(advanceFence("plain text", fence("```", 1))).toEqual({
      openFence: null,
      isFenceDelimiter: false,
      lineIsCode: false,
    })
  })

  it("implicitly closes fence and opens a new one at lower depth", () => {
    expect(advanceFence("```", fence("```", 1))).toEqual({
      openFence: fence("```", 0),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("treats deeper-depth lines as content inside the fence", () => {
    expect(advanceFence("> > text", fence("```", 1))).toEqual({
      openFence: fence("```", 1),
      isFenceDelimiter: false,
      lineIsCode: true,
    })
  })

  it("treats blockquoted lines inside a depth-0 fence as content", () => {
    expect(advanceFence("> text", fence("```", 0))).toEqual({
      openFence: fence("```", 0),
      isFenceDelimiter: false,
      lineIsCode: true,
    })
  })

  it("opens a fence at depth 2 with nested blockquote markers", () => {
    expect(advanceFence("> > ```", null)).toEqual({
      openFence: fence("```", 2),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("opens a fence with an info string inside a blockquote", () => {
    expect(advanceFence("> ```js", null)).toEqual({
      openFence: fence("```", 1),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("opens a tilde fence inside a blockquote", () => {
    expect(advanceFence("> ~~~", null)).toEqual({
      openFence: fence("~~~", 1),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })

  it("opens a fence when a tab follows the blockquote marker", () => {
    expect(advanceFence(">\t```", null)).toEqual({
      openFence: fence("```", 1),
      isFenceDelimiter: true,
      lineIsCode: true,
    })
  })
})

// ── classifyLines ────────────────────────────────────────────────

describe("classifyLines", () => {
  it("tags a plain line as not code", () => {
    expect([...classifyLines("hello world")]).toEqual([{ text: "hello world", inCode: false }])
  })

  it("tags fence delimiters and interior lines as code, then resumes after the close", () => {
    const content = ["before", "```", "inside", "```", "after"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "before", inCode: false },
      { text: "```", inCode: true },
      { text: "inside", inCode: true },
      { text: "```", inCode: true },
      { text: "after", inCode: false },
    ])
  })

  it("does not let a tilde fence close a backtick fence", () => {
    const content = ["```", "~~~", "still inside", "```", "out"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "```", inCode: true },
      { text: "~~~", inCode: true },
      { text: "still inside", inCode: true },
      { text: "```", inCode: true },
      { text: "out", inCode: false },
    ])
  })

  it("closes on a fence at least as long as the opener", () => {
    const content = ["```", "``", "````", "after"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "```", inCode: true },
      { text: "``", inCode: true },
      { text: "````", inCode: true },
      { text: "after", inCode: false },
    ])
  })

  it("does not close on a fence shorter than the opener", () => {
    const content = ["````", "```", "````", "out"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "````", inCode: true },
      { text: "```", inCode: true },
      { text: "````", inCode: true },
      { text: "out", inCode: false },
    ])
  })

  it("does not close on a fence line carrying a trailing info string", () => {
    const content = ["```", "``` extra", "```", "out"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "```", inCode: true },
      { text: "``` extra", inCode: true },
      { text: "```", inCode: true },
      { text: "out", inCode: false },
    ])
  })

  it("marks all trailing lines as code for an unterminated fence", () => {
    const content = ["text", "```", "code one", "code two"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "text", inCode: false },
      { text: "```", inCode: true },
      { text: "code one", inCode: true },
      { text: "code two", inCode: true },
    ])
  })

  it("treats a fence indented up to three spaces as code (CommonMark §4.5)", () => {
    const content = ["before", "  ```", "inside", "  ```", "after"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "before", inCode: false },
      { text: "  ```", inCode: true },
      { text: "inside", inCode: true },
      { text: "  ```", inCode: true },
      { text: "after", inCode: false },
    ])
  })

  // ── blockquote-aware classification ──────────────────────────

  it("classifies lines inside a blockquoted fence as code", () => {
    const content = ["before", "> ```", "> inside fence", "> ```", "after"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "before", inCode: false },
      { text: "> ```", inCode: true },
      { text: "> inside fence", inCode: true },
      { text: "> ```", inCode: true },
      { text: "after", inCode: false },
    ])
  })

  it("implicitly closes the fence when the blockquote ends", () => {
    const content = ["> ```", "> code", "not code anymore"].join("\n")
    expect([...classifyLines(content)]).toEqual([
      { text: "> ```", inCode: true },
      { text: "> code", inCode: true },
      { text: "not code anymore", inCode: false },
    ])
  })
})

// ── pageTextByLines ─────────────────────────────────────────────

describe("pageTextByLines", () => {
  it("pages text to the requested 1-based window", () => {
    const text = "alpha\nbeta\ngamma\ndelta\nepsilon"
    const result = pageTextByLines({
      text,
      path: "note.md",
      startLine: 2,
      limit: 2,
    })
    expect(result.text).toBe("beta\ngamma")
    expect(result.lineWindow).toEqual({
      startLine: 2,
      endLine: 3,
      totalLines: 5,
    })
  })

  it("returns remaining lines when limit is omitted", () => {
    const text = "a\nb\nc\nd\ne"
    const result = pageTextByLines({ text, path: "note.md", startLine: 4 })
    expect(result.text).toBe("d\ne")
    expect(result.lineWindow).toEqual({
      startLine: 4,
      endLine: 5,
      totalLines: 5,
    })
  })

  it("returns first lines when startLine is omitted", () => {
    const text = "a\nb\nc\nd\ne"
    const result = pageTextByLines({ text, path: "note.md", limit: 2 })
    expect(result.text).toBe("a\nb")
    expect(result.lineWindow).toEqual({
      startLine: 1,
      endLine: 2,
      totalLines: 5,
    })
  })

  it("normalizes CRLF to LF", () => {
    const text = "alpha\r\nbeta\r\ngamma\r\n"
    const result = pageTextByLines({
      text,
      path: "note.md",
      startLine: 1,
      limit: 3,
    })
    expect(result.text).toBe("alpha\nbeta\ngamma")
    expect(result.lineWindow).toEqual({
      startLine: 1,
      endLine: 3,
      totalLines: 3,
    })
  })

  it("does not count a trailing newline as a line", () => {
    const text = "alpha\nbeta\n"
    const result = pageTextByLines({ text, path: "note.md", startLine: 1 })
    expect(result.text).toBe("alpha\nbeta")
    expect(result.lineWindow).toEqual({
      startLine: 1,
      endLine: 2,
      totalLines: 2,
    })
  })

  it("counts lines correctly without a trailing newline", () => {
    const text = "line1\nline2\nline3"
    const result = pageTextByLines({ text, path: "note.md", startLine: 1 })
    expect(result.text).toBe("line1\nline2\nline3")
    expect(result.lineWindow).toEqual({
      startLine: 1,
      endLine: 3,
      totalLines: 3,
    })
  })

  it("returns a zero-line window for empty text", () => {
    const result = pageTextByLines({ text: "", path: "note.md", startLine: 1 })
    expect(result.text).toBe("")
    expect(result.lineWindow).toEqual({
      startLine: 1,
      endLine: 0,
      totalLines: 0,
    })
  })

  it("returns the empty window for a startLine past empty text", () => {
    const result = pageTextByLines({ text: "", path: "note.md", startLine: 50 })
    expect(result.text).toBe("")
    expect(result.lineWindow).toEqual({
      startLine: 50,
      endLine: 49,
      totalLines: 0,
    })
  })

  it("clamps naturally when limit exceeds remaining lines", () => {
    const text = "a\nb\nc\nd\ne"
    const result = pageTextByLines({
      text,
      path: "note.md",
      startLine: 4,
      limit: 100,
    })
    expect(result.text).toBe("d\ne")
    expect(result.lineWindow).toEqual({
      startLine: 4,
      endLine: 5,
      totalLines: 5,
    })
  })

  it("rejects a startLine below 1", () => {
    expect(() => pageTextByLines({ text: "a\nb", path: "note.md", startLine: 0 })).toThrow(
      'invalid line range: "note.md" needs a start line and limit of at least 1',
    )
  })

  it("rejects a limit below 1", () => {
    expect(() => pageTextByLines({ text: "a\nb", path: "note.md", limit: 0 })).toThrow(
      'invalid line range: "note.md" needs a start line and limit of at least 1',
    )
  })

  it("rejects a startLine past the end", () => {
    expect(() => pageTextByLines({ text: "a\nb\nc", path: "note.md", startLine: 6 })).toThrow(
      'start line past the end: "note.md" renders to 3 lines',
    )
  })
})
