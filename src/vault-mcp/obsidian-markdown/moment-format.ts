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
 *  letters ("[Week A]") is preserved verbatim. Do (ordinal day) is mapped
 *  to d (day number) as a best-effort fallback — the ordinal suffix is
 *  lost, so filenames will differ from Obsidian's. Unmapped tokens (dd —
 *  Moment's 2-letter weekday abbreviation) pass through into Luxon's token
 *  grammar and may render differently than Obsidian would — config.ts's
 *  probe-render rejects only structurally unsafe results. */
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

/** Returns true if the format contains the Moment `Do` (ordinal day) token
 *  outside of [literal] escapes. Do maps to `d` (day number without suffix)
 *  as a best-effort fallback — filenames will differ from Obsidian's. */
export const hasOrdinalDayToken = (momentFormat: string): boolean =>
  momentFormat
    .split(MOMENT_ESCAPE_RE)
    .some(
      (segment, segmentIndex) =>
        segmentIndex % 2 === 0 && segment.includes("Do"),
    )
