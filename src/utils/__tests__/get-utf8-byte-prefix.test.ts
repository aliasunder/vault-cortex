import { describe, expect, it } from "vitest"
import { getUtf8BytePrefix } from "../get-utf8-byte-prefix.js"

describe("getUtf8BytePrefix", () => {
  it.each([
    { label: "empty text", text: "", maxBytes: 5, expected: "" },
    { label: "a zero budget", text: "abc", maxBytes: 0, expected: "" },
    { label: "text below the budget", text: "café🎉", maxBytes: 10, expected: "café🎉" },
    { label: "text exactly at the budget", text: "café🎉", maxBytes: 9, expected: "café🎉" },
    { label: "ASCII above the budget", text: "abcdef", maxBytes: 3, expected: "abc" },
    { label: "a split two-byte character", text: "aéb", maxBytes: 2, expected: "a" },
    { label: "a whole two-byte character", text: "aéb", maxBytes: 3, expected: "aé" },
    { label: "a split three-byte character", text: "a€b", maxBytes: 3, expected: "a" },
    { label: "a whole three-byte character", text: "a€b", maxBytes: 4, expected: "a€" },
    { label: "a split four-byte character", text: "a🎉b", maxBytes: 4, expected: "a" },
    { label: "a whole four-byte character", text: "a🎉b", maxBytes: 5, expected: "a🎉" },
    { label: "an oversized first character", text: "🎉abc", maxBytes: 3, expected: "" },
  ])("returns the exact prefix for $label", ({ text, maxBytes, expected }) => {
    expect(getUtf8BytePrefix(text, maxBytes)).toBe(expected)
  })

  it("omits a multibyte code point crossing a 102,400-byte boundary", () => {
    const prefix = "x".repeat(102_399)

    expect(getUtf8BytePrefix(prefix + "🎉after", 102_400)).toBe(prefix)
  })
})
