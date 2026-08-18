/** Moment.js → Luxon format-string conversion — Obsidian stores daily-note
 *  formats in moment tokens; the server renders with Luxon. A single-pass
 *  regex tokenizer replaces tokens longest-first so overlapping families
 *  (DDDD/DDD/DD/Do/D) resolve without partial-replacement collisions.
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
  ["Do", "d"], // ordinal day — lossy: suffix ("st","nd","th") dropped
  ["dd", "ccc"], // 2-letter weekday — no Luxon equivalent; mapped to 3-letter as closest
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
 *  letters ("[Week A]") is preserved verbatim. Two tokens are unsupported: Do (ordinal day, mapped to d — suffix
 *  dropped) and dd (2-letter weekday, mapped to ccc — 3-letter). Both
 *  produce filenames that differ from Obsidian's, so getDailyNotePath
 *  rejects formats containing them before the converter runs. */
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

/** Tokens that produce filenames differing from Obsidian's — Do is mapped
 *  to d (suffix dropped), dd passes through as Luxon's dd (day-of-month,
 *  not weekday). Neither can match the note Obsidian created. */
const UNSUPPORTED_TOKEN_SET = new Set(["Do", "dd"])

/** Returns unsupported tokens present in the format string outside of
 *  [literal] escapes, or an empty array if none. Uses the same regex
 *  tokenizer as the converter so ddd/dddd don't false-positive on dd. */
export const findUnsupportedTokens = (momentFormat: string): string[] => {
  const found = new Set<string>()
  momentFormat.split(MOMENT_ESCAPE_RE).forEach((segment, segmentIndex) => {
    if (segmentIndex % 2 === 1) return
    for (const match of segment.matchAll(MOMENT_TOKEN_RE)) {
      if (UNSUPPORTED_TOKEN_SET.has(match[0])) {
        found.add(match[0])
      }
    }
  })
  return [...found]
}
