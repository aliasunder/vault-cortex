import { describe, it, expect } from "vitest"
import { truncateToCodePointLimit } from "../truncate-to-code-point-limit.js"

const COMBINING_ACUTE = String.fromCodePoint(0x301)

describe("truncateToCodePointLimit", () => {
  it("returns text within the limit unchanged", () => {
    expect(truncateToCodePointLimit("short", 10)).toBe("short")
  })

  it("returns text that is long in UTF-16 units but within the limit in code points unchanged", () => {
    // Four code points, eight UTF-16 units.
    expect(truncateToCodePointLimit("🎉🎉🎉🎉", 4)).toBe("🎉🎉🎉🎉")
  })

  it("cuts plain text at the limit", () => {
    expect(truncateToCodePointLimit("abcdefgh", 5)).toBe("abcde")
  })

  it("keeps an emoji whose surrogate pair straddles the limit in UTF-16 units", () => {
    // a, b and the emoji are three code points, and the emoji spans UTF-16 units 2 and 3.
    expect(truncateToCodePointLimit("ab🎉cd", 3)).toBe("ab🎉")
  })

  it("backs up before a flag the limit would split", () => {
    // The flag is two code points; a limit of three keeps only its first.
    expect(truncateToCodePointLimit("ab🇨🇦c", 3)).toBe("ab")
  })

  it("keeps a flag that fits the limit", () => {
    expect(truncateToCodePointLimit("ab🇨🇦c", 4)).toBe("ab🇨🇦")
  })

  it("backs up before a joined family emoji the limit would split", () => {
    // The family is five code points: three people joined by two zero-width joiners.
    expect(truncateToCodePointLimit("a👨‍👩‍👧b", 4)).toBe("a")
  })

  it("keeps a letter with its combining accent together", () => {
    const accentedText = `cafe${COMBINING_ACUTE}!`
    expect(truncateToCodePointLimit(accentedText, 4)).toBe("caf")
  })

  it("returns an empty prefix when the first grapheme is longer than the limit", () => {
    expect(truncateToCodePointLimit("🇨🇦x", 1)).toBe("")
  })
})
