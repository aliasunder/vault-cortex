/** Moment.js → Luxon format-string conversion — Obsidian stores daily-note
 *  formats in moment tokens; the server renders with Luxon. A single-pass
 *  regex tokenizer replaces tokens longest-first so overlapping families
 *  (DDDD/DDD/DD/D) resolve without partial-replacement collisions.
 *  Pure and zero-import so config.ts can validate formats without
 *  fs/logger deps. */

/** Moment token → Luxon token pairs, ordered longest-first. */
const MOMENT_TO_LUXON: ReadonlyArray<readonly [string, string]> = [
  // 4-char tokens
  ["YYYY", "yyyy"],
  ["dddd", "cccc"],
  ["MMMM", "MMMM"],
  ["DDDD", "ooo"], // day of year, zero-padded (001–365)
  // 3-char tokens
  ["ddd", "ccc"],
  ["MMM", "MMM"],
  ["DDD", "o"], // day of year, minimum digits (1–365)
  // 2-char tokens
  ["YY", "yy"],
  ["MM", "MM"],
  ["DD", "dd"],
  ["HH", "HH"],
  ["hh", "hh"],
  ["mm", "mm"],
  ["ss", "ss"],
  // 1-char tokens
  ["D", "d"], // day of month, no padding (1–31)
  ["M", "M"], // month number, no padding (1–12) — identity, pinned
  ["A", "a"],
]

/** Matches Moment.js [literal] escape groups — e.g. [Daily Note]. */
const MOMENT_ESCAPE_RE = /\[([^\]]*)\]/g

/** Matches any known Moment token — alternation order is longest-first
 *  (from MOMENT_TO_LUXON). */
const MOMENT_TOKEN_RE = new RegExp(
  MOMENT_TO_LUXON.map(([momentToken]) => momentToken).join("|"),
  "g",
)

const MOMENT_TOKEN_MAP = new Map(MOMENT_TO_LUXON)

/** Replaces Moment tokens with their Luxon equivalents in a single pass. */
const convertMomentTokens = (formatSpan: string): string =>
  formatSpan.replace(
    MOMENT_TOKEN_RE,
    (match) => MOMENT_TOKEN_MAP.get(match) ?? match,
  )

/** Converts a Moment.js format string to Luxon format tokens. [literal]
 *  escapes become Luxon 'literal' quotes (single quotes doubled), and token
 *  replacement runs only OUTSIDE literals so literal text containing token
 *  letters ("[Week A]") is preserved verbatim. Two Moment tokens have no
 *  Luxon equivalent — Do (ordinal day) and dd (2-letter weekday) — and are
 *  rejected by getDailyNotePath before the converter runs. */
export const momentToLuxonFormat = (momentFormat: string): string => {
  return momentFormat
    .split(MOMENT_ESCAPE_RE)
    .map((segment, segmentIndex) => {
      // Odd indices are the contents of [literal] escapes: splitting on a
      // regex with a capturing group keeps each captured match in the result
      // array, so segments alternate format span / literal contents.
      const isLiteralContent = segmentIndex % 2 === 1
      // Luxon wraps literal text in single quotes and escapes an embedded
      // quote by doubling it ("it's" → 'it''s').
      return isLiteralContent
        ? `'${segment.replace(/'/g, "''")}'`
        : convertMomentTokens(segment)
    })
    .join("")
}

/** Moment tokens with no Luxon equivalent. Each entry is a standalone
 *  regex pattern with boundary guards so it doesn't false-positive inside
 *  a supported token (e.g. dd inside ddd, D inside DD, L inside LL).
 *  Boundary guards use lookahead/lookbehind for the same letter family. */
const UNSUPPORTED_PATTERNS: ReadonlyArray<{ pattern: RegExp; token: string }> =
  [
    { pattern: /DDDo/, token: "DDDo" },
    { pattern: /(?<!D)Do/, token: "Do" },
    { pattern: /Mo/, token: "Mo" },
    { pattern: /wo/, token: "wo" },
    { pattern: /(?<!d)dd(?!d)/, token: "dd" },
    { pattern: /(?<!d)d(?!d)/, token: "d" },
    { pattern: /(?<![A-Za-z])e(?![A-Za-z])/, token: "e" },
    { pattern: /(?<!k)kk(?!k)/, token: "kk" },
    { pattern: /(?<!k)k(?!k)/, token: "k" },
    { pattern: /LLLL/, token: "LLLL" },
    { pattern: /(?<!L)LLL(?!L)/, token: "LLL" },
    { pattern: /(?<!L)LL(?!L)/, token: "LL" },
    { pattern: /(?<!L)L(?![LT])/, token: "L" },
    { pattern: /LTS/, token: "LTS" },
    { pattern: /(?<!L)LT(?!S)/, token: "LT" },
  ]

/** Returns unsupported Moment tokens present in the format string outside
 *  of [literal] escapes, or an empty array if none. Standalone — does not
 *  depend on the supported-token table or its ordering. */
export const findUnsupportedTokens = (momentFormat: string): string[] => {
  const formatSegments = momentFormat
    .split(MOMENT_ESCAPE_RE)
    .filter((_, segmentIndex) => segmentIndex % 2 === 0)
    .join("\0")
  const found = new Set<string>()
  for (const { pattern, token } of UNSUPPORTED_PATTERNS) {
    if (pattern.test(formatSegments)) {
      found.add(token)
    }
  }
  return [...found]
}
