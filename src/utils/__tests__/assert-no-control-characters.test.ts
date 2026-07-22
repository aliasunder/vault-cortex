import { describe, it, expect } from "vitest"
import { assertNoControlCharacters } from "../assert-no-control-characters.js"

/** Captures the thrown error so both message and absence checks are possible. */
const getError = (fn: () => void): Error => {
  try {
    fn()
    throw new Error("expected function to throw")
  } catch (thrown) {
    if (
      thrown instanceof Error &&
      thrown.message !== "expected function to throw"
    )
      return thrown
    throw thrown
  }
}

describe("assertNoControlCharacters", () => {
  it("rejects NUL (U+0000)", () => {
    expect(() => assertNoControlCharacters("hello\x00world", "body")).toThrow(
      "body contains a control character (U+0000 at position 5) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects BEL (U+0007)", () => {
    expect(() => assertNoControlCharacters("\x07beep", "body")).toThrow(
      "body contains a control character (U+0007 at position 0) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects VT (U+000B)", () => {
    expect(() => assertNoControlCharacters("line\x0Bbreak", "body")).toThrow(
      "body contains a control character (U+000B at position 4) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects FF (U+000C)", () => {
    expect(() => assertNoControlCharacters("page\x0Cfeed", "body")).toThrow(
      "body contains a control character (U+000C at position 4) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects DEL (U+007F)", () => {
    expect(() => assertNoControlCharacters("del\x7F", "body")).toThrow(
      "body contains a control character (U+007F at position 3) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects C1 NEL (U+0085)", () => {
    expect(() => assertNoControlCharacters("next\x85line", "body")).toThrow(
      "body contains a control character (U+0085 at position 4) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects C1 upper bound (U+009F)", () => {
    expect(() => assertNoControlCharacters("end\x9F", "body")).toThrow(
      "body contains a control character (U+009F at position 3) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("allows tab (U+0009)", () => {
    expect(() => assertNoControlCharacters("col1\tcol2", "body")).not.toThrow()
  })

  it("allows LF (U+000A)", () => {
    expect(() =>
      assertNoControlCharacters("line1\nline2", "body"),
    ).not.toThrow()
  })

  it("allows CRLF", () => {
    expect(() =>
      assertNoControlCharacters("line1\r\nline2", "body"),
    ).not.toThrow()
  })

  it("allows empty string", () => {
    expect(() => assertNoControlCharacters("", "body")).not.toThrow()
  })

  it("allows normal markdown content", () => {
    expect(() =>
      assertNoControlCharacters(
        "## Heading\n\nBody with [[links]] and #tags",
        "body",
      ),
    ).not.toThrow()
  })

  it("allows bare CR (U+000D)", () => {
    expect(() =>
      assertNoControlCharacters("line1\rline2", "body"),
    ).not.toThrow()
  })

  it("includes the param name in the error message", () => {
    expect(() => assertNoControlCharacters("bad\x00", "entry")).toThrow(
      "entry contains a control character (U+0000 at position 3) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("reports first occurrence only", () => {
    const error = getError(() => assertNoControlCharacters("\x01\x02", "body"))
    expect(error.message).toBe(
      "body contains a control character (U+0001 at position 0) — control characters other than tab, LF, and CR are not allowed",
    )
    expect(error.message).not.toContain("U+0002")
  })
})
