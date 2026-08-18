import { describe, it, expect } from "vitest"
import { momentToLuxonFormat, hasOrdinalDayToken } from "../moment-format.js"

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
      name: "adjacency: unpadded month and day with comma",
      input: "MMM D, YYYY",
      expected: "MMM d, yyyy",
    },
    {
      name: "[literal] containing Do is preserved while token Do is converted",
      input: "[Do] Do",
      expected: "'Do' d",
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(momentToLuxonFormat(input)).toBe(expected)
  })
})

describe("hasOrdinalDayToken", () => {
  it("returns true when Do appears in a format string", () => {
    expect(hasOrdinalDayToken("MMMM Do, YYYY")).toBe(true)
  })

  it("returns false for a standard format without Do", () => {
    expect(hasOrdinalDayToken("YYYY-MM-DD")).toBe(false)
  })

  it("returns false when Do is inside a [literal] escape", () => {
    expect(hasOrdinalDayToken("[Do] DD")).toBe(false)
  })

  it("returns true when Do is outside a literal even if a literal exists", () => {
    expect(hasOrdinalDayToken("[Note] Do")).toBe(true)
  })
})
