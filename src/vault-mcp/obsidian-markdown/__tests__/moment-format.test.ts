import { describe, it, expect } from "vitest"
import { momentToLuxonFormat } from "../moment-format.js"

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
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(momentToLuxonFormat(input)).toBe(expected)
  })
})
