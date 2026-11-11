import { describe, it, expect } from "vitest"
import {
  dailyNoteFormatToNameFormat,
  findUnsupportedTokens,
  matchesDailyNoteName,
  momentToLuxonFormat,
} from "../moment-format.js"

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
      name: "all D-family tokens in one format resolve correctly",
      input: "DDDD DDD DD D",
      expected: "ooo o dd d",
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

  it("does not false-positive on ddd or dddd (supported tokens)", () => {
    expect(findUnsupportedTokens("YYYY-MM-DD-ddd")).toEqual([])
    expect(findUnsupportedTokens("YYYY-MM-DD-dddd")).toEqual([])
  })

  it("detects ordinal tokens (Mo, DDDo, wo)", () => {
    expect(findUnsupportedTokens("Mo")).toEqual(["Mo"])
    expect(findUnsupportedTokens("DDDo")).toEqual(["DDDo"])
    expect(findUnsupportedTokens("wo")).toEqual(["wo"])
  })

  it("detects weekday number d without false-positive on D or DD", () => {
    expect(findUnsupportedTokens("YYYY-MM-DD d")).toEqual(["d"])
    expect(findUnsupportedTokens("YYYY-MM-DD")).toEqual([])
    expect(findUnsupportedTokens("D")).toEqual([])
  })

  it("detects localized format tokens (L, LL, LLL, LLLL, LT, LTS)", () => {
    expect(findUnsupportedTokens("L")).toEqual(["L"])
    expect(findUnsupportedTokens("LLLL")).toEqual(["LLLL"])
    expect(findUnsupportedTokens("LT")).toEqual(["LT"])
    expect(findUnsupportedTokens("LTS")).toEqual(["LTS"])
  })

  it("detects k/kk (1-24 hour)", () => {
    expect(findUnsupportedTokens("kk:mm")).toEqual(["kk"])
    expect(findUnsupportedTokens("k:mm")).toEqual(["k"])
  })

  it("detects e (locale weekday number)", () => {
    expect(findUnsupportedTokens("YYYY e")).toEqual(["e"])
  })
})

describe("dailyNoteFormatToNameFormat", () => {
  it("converts a plain date format", () => {
    expect(dailyNoteFormatToNameFormat("YYYY-MM-DD")).toEqual({ luxonFormat: "yyyy-MM-dd" })
  })

  it("keeps only the part after the last slash, which names the file", () => {
    expect(dailyNoteFormatToNameFormat("YYYY/MM/YYYY-MM-DD")).toEqual({
      luxonFormat: "yyyy-MM-dd",
    })
  })

  it("splits at a slash inside a [literal] escape, which Obsidian also makes a folder", () => {
    expect(dailyNoteFormatToNameFormat("YYYY/[Week/Day] YYYY-MM-DD")).toEqual({
      luxonFormat: "'Day' yyyy-MM-dd",
    })
  })

  it("drops a literal that ends at the slash", () => {
    expect(dailyNoteFormatToNameFormat("[Journal/]YYYY-MM-DD")).toEqual({
      luxonFormat: "yyyy-MM-dd",
    })
  })

  it("trims a space at the end of the format, as Obsidian trims the file name", () => {
    expect(dailyNoteFormatToNameFormat("YYYY-MM-DD ")).toEqual({ luxonFormat: "yyyy-MM-dd" })
  })

  it("trims a space at the start of the format, as Obsidian trims the file name", () => {
    expect(dailyNoteFormatToNameFormat(" YYYY-MM-DD")).toEqual({ luxonFormat: "yyyy-MM-dd" })
  })

  it("ignores an unsupported token in the folder part", () => {
    expect(dailyNoteFormatToNameFormat("YYYY/w/YYYY-MM-DD")).toEqual({
      luxonFormat: "yyyy-MM-dd",
    })
  })

  it("accepts a year with a day of the year", () => {
    expect(dailyNoteFormatToNameFormat("YYYY-DDDD")).toEqual({ luxonFormat: "yyyy-ooo" })
  })

  it("returns null when the file name has no year", () => {
    expect(dailyNoteFormatToNameFormat("YYYY/MM/DD")).toBeNull()
  })

  it("returns null when the file name has a year but no month and day", () => {
    expect(dailyNoteFormatToNameFormat("YYYY")).toBeNull()
  })

  it("returns null when the file name has a month but no day", () => {
    expect(dailyNoteFormatToNameFormat("YYYY-MM")).toBeNull()
  })

  it("returns null when the file name has a day but no month", () => {
    expect(dailyNoteFormatToNameFormat("YYYY-DD")).toBeNull()
  })

  it("returns null when the year appears only inside a [literal]", () => {
    expect(dailyNoteFormatToNameFormat("[YYYY] MM-DD")).toBeNull()
  })

  it("returns null when the file name holds an unsupported token", () => {
    expect(dailyNoteFormatToNameFormat("Do MMMM YYYY")).toBeNull()
  })
})

describe("matchesDailyNoteName", () => {
  /** The name format for a daily-note format the test knows is complete. */
  const toNameFormat = (momentFormat: string): { luxonFormat: string } => {
    const nameFormat = dailyNoteFormatToNameFormat(momentFormat)

    if (!nameFormat) throw new Error(`no name format for "${momentFormat}"`)
    return nameFormat
  }

  it.each([
    { label: "a date in the default format", name: "2026-10-07", momentFormat: "YYYY-MM-DD" },
    {
      label: "the file-name part of a format with folders",
      name: "2026-10-07",
      momentFormat: "YYYY/MM/YYYY-MM-DD",
    },
    {
      label: "the file-name part after a slash inside a literal",
      name: "2026-10-07",
      momentFormat: "[Journal/]YYYY-MM-DD",
    },
    {
      label: "a weekday name in other letter case",
      name: "2026-10-07 wednesday",
      momentFormat: "YYYY-MM-DD dddd",
    },
    { label: "a format with a trailing space", name: "2026-10-07", momentFormat: "YYYY-MM-DD " },
    { label: "unpadded numbers under unpadded tokens", name: "2026-1-7", momentFormat: "YYYY-M-D" },
    { label: "a day of the year", name: "2026-280", momentFormat: "YYYY-DDDD" },
  ])("matches $label", ({ name, momentFormat }) => {
    expect(matchesDailyNoteName({ name, format: toNameFormat(momentFormat) })).toBe(true)
  })

  it.each([
    {
      label: "padded numbers that Obsidian writes unpadded",
      name: "2026-01-07",
      momentFormat: "YYYY-M-D",
    },
    {
      label: "a weekday that is not the date's",
      name: "2026-10-07 Thursday",
      momentFormat: "YYYY-MM-DD dddd",
    },
    { label: "an ordinary note name", name: "Meeting notes", momentFormat: "YYYY-MM-DD" },
    { label: "a day the calendar lacks", name: "2026-13-40", momentFormat: "YYYY-MM-DD" },
  ])("does not match $label", ({ name, momentFormat }) => {
    expect(matchesDailyNoteName({ name, format: toNameFormat(momentFormat) })).toBe(false)
  })
})
