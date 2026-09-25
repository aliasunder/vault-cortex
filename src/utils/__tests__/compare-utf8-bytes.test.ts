import { describe, it, expect } from "vitest"
import { compareByUtf8Bytes } from "../compare-utf8-bytes.js"

describe("compareByUtf8Bytes", () => {
  it("orders by UTF-8 bytes where raw UTF-16 comparison disagrees", () => {
    // U+F8FF (BMP private use, 3 UTF-8 bytes starting 0xEF) sorts before
    // U+1F600 (non-BMP, 4 bytes starting 0xF0) in UTF-8 — a raw UTF-16
    // comparison puts the surrogate-encoded emoji first, diverging from
    // SQLite's BINARY collation.
    expect(compareByUtf8Bytes("", "😀")).toBe(-1)
    expect(compareByUtf8Bytes("😀", "")).toBe(1)
  })

  it("returns 0 for equal strings and orders ASCII lexicographically", () => {
    expect(compareByUtf8Bytes("same", "same")).toBe(0)
    expect(compareByUtf8Bytes("aaa", "zzz")).toBe(-1)
    expect(compareByUtf8Bytes("zzz", "aaa")).toBe(1)
  })
})
