import { describe, it, expect } from "vitest"
import { splitIntoLines, advanceFence, classifyLines } from "../lines.js"

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

// ── advanceFence ─────────────────────────────────────────────────

describe("advanceFence", () => {
  it("opens a fence on a delimiter line outside a fence", () => {
    expect(advanceFence("```", null)).toEqual({
      openFence: "```",
      isFenceDelimiter: true,
    })
  })

  it("reports a non-fence line outside a fence as neither delimiter nor open", () => {
    expect(advanceFence("plain", null)).toEqual({
      openFence: null,
      isFenceDelimiter: false,
    })
  })

  it("keeps the fence open for an interior non-fence line", () => {
    expect(advanceFence("code", "```")).toEqual({
      openFence: "```",
      isFenceDelimiter: false,
    })
  })

  it("closes the fence on a matching closer", () => {
    expect(advanceFence("```", "```")).toEqual({
      openFence: null,
      isFenceDelimiter: true,
    })
  })

  it("does not close a backtick fence on a tilde delimiter", () => {
    expect(advanceFence("~~~", "```")).toEqual({
      openFence: "```",
      isFenceDelimiter: true,
    })
  })

  it("does not close on a delimiter shorter than the opener", () => {
    expect(advanceFence("```", "````")).toEqual({
      openFence: "````",
      isFenceDelimiter: true,
    })
  })

  it("closes on a delimiter longer than the opener", () => {
    expect(advanceFence("`````", "```")).toEqual({
      openFence: null,
      isFenceDelimiter: true,
    })
  })

  it("does not close on a delimiter carrying a trailing info string", () => {
    expect(advanceFence("``` js", "```")).toEqual({
      openFence: "```",
      isFenceDelimiter: true,
    })
  })

  it("opens a fence indented up to three spaces (CommonMark §4.5)", () => {
    expect(advanceFence("   ```", null)).toEqual({
      openFence: "```",
      isFenceDelimiter: true,
    })
  })

  it("does not treat four-space-indented backticks as a fence opener", () => {
    expect(advanceFence("    ```", null)).toEqual({
      openFence: null,
      isFenceDelimiter: false,
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
})
