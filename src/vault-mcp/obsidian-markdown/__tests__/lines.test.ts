import { describe, it, expect } from "vitest"
import {
  splitIntoLines,
  advanceFence,
  advanceComment,
  classifyLines,
  type OpenFence,
} from "../lines.js"

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
    expect([...classifyLines("hello world")]).toEqual([
      { text: "hello world", inCode: false },
    ])
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
    const content = [
      "before",
      "> ```",
      "> inside fence",
      "> ```",
      "after",
    ].join("\n")
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
