import { describe, it, expect } from "vitest"
import { momentToLuxonFormat, findUnsupportedTokens } from "../moment-format.js"

describe("momentToLuxonFormat", () => {
  const scenarios = [
    {
      name: "standard daily note format",
      input: "YYYY-MM-DD",
      expected: "yyyy-MM-dd",
    },
    {
      name: "date with full weekday name",
      input: "YYYY-MM-DD-dddd",
      expected: "yyyy-MM-dd-cccc",
    },
    {
      name: "date with short weekday name",
      input: "YYYY-MM-DD-ddd",
      expected: "yyyy-MM-dd-ccc",
    },
    {
      name: "nested folder format",
      input: "YYYY/MM/DD",
      expected: "yyyy/MM/dd",
    },
    {
      name: "European date format",
      input: "DD-MM-YYYY",
      expected: "dd-MM-yyyy",
    },
    {
      name: "two-digit year",
      input: "YY-MM-DD",
      expected: "yy-MM-dd",
    },
    {
      name: "preserves non-token characters",
      input: "YYYY_MM_DD journal",
      expected: "yyyy_MM_dd journal",
    },
    {
      name: "converts [literal] escapes to Luxon single-quote syntax",
      input: "YYYY-MM-DD [Daily Note]",
      expected: "yyyy-MM-dd 'Daily Note'",
    },
    {
      name: "handles [literal] with apostrophe",
      input: "YYYY-MM-DD [it's]",
      expected: "yyyy-MM-dd 'it''s'",
    },
    {
      name: "handles empty [literal] brackets",
      input: "YYYY-MM-DD []",
      expected: "yyyy-MM-dd ''",
    },
    {
      name: "preserves token letters inside a [literal] escape",
      input: "YYYY-MM-DD [Week A]",
      expected: "yyyy-MM-dd 'Week A'",
    },
    {
      name: "preserves a literal made entirely of token characters",
      input: "[DD] DD",
      expected: "'DD' dd",
    },
    // ── New token mappings ──────────────────────────────────────
    {
      name: "unpadded day of month",
      input: "MMM D, YYYY",
      expected: "MMM d, yyyy",
    },
    {
      name: "unpadded month",
      input: "M/D/YYYY",
      expected: "M/d/yyyy",
    },
    {
      name: "day of year",
      input: "YYYY-DDD",
      expected: "yyyy-o",
    },
    {
      name: "day of year zero-padded",
      input: "YYYY-DDDD",
      expected: "yyyy-ooo",
    },
    {
      name: "ordinal day maps to unpadded day (lossy — suffix dropped)",
      input: "MMMM Do, YYYY",
      expected: "MMMM d, yyyy",
    },
    {
      name: "D does not corrupt Do — tokenizer matches Do before D",
      input: "Do-DD",
      expected: "d-dd",
    },
    {
      name: "all D-family tokens in one format resolve correctly",
      input: "DDDD DDD DD Do D",
      expected: "ooo o dd d d",
    },
    {
      name: "all M-family tokens in one format resolve correctly",
      input: "MMMM MMM MM M",
      expected: "MMMM MMM MM M",
    },
    {
      name: "adjacent tokens without separators resolve correctly",
      input: "DDMM",
      expected: "ddMM",
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(momentToLuxonFormat(input)).toBe(expected)
  })
})

describe("findUnsupportedTokens", () => {
  it("returns Do when ordinal day is in the format", () => {
    expect(findUnsupportedTokens("MMMM Do, YYYY")).toEqual(["Do"])
  })

  it("returns dd when 2-letter weekday is in the format", () => {
    expect(findUnsupportedTokens("YYYY-MM-DD dd")).toEqual(["dd"])
  })

  it("returns both when both appear", () => {
    expect(findUnsupportedTokens("Do dd")).toEqual(["Do", "dd"])
  })

  it("returns empty array for a standard format", () => {
    expect(findUnsupportedTokens("YYYY-MM-DD")).toEqual([])
  })

  it("ignores tokens inside [literal] escapes", () => {
    expect(findUnsupportedTokens("[Do] DD")).toEqual([])
  })

  it("detects tokens outside a literal even when a literal exists", () => {
    expect(findUnsupportedTokens("[Note] Do")).toEqual(["Do"])
  })

  it("does not false-positive on ddd or dddd (mapped tokens)", () => {
    expect(findUnsupportedTokens("YYYY-MM-DD-ddd")).toEqual([])
    expect(findUnsupportedTokens("YYYY-MM-DD-dddd")).toEqual([])
  })
})
