/** Moment.js → Luxon format-string conversion — Obsidian stores daily-note
 *  formats in moment tokens; the server renders with Luxon. Pure and
 *  zero-import so config.ts can validate formats without fs/logger deps. */

/** Sorted longest-first to avoid partial replacement collisions
 *  (e.g. YYYY before YY, dddd before ddd). */
const MOMENT_TO_LUXON: ReadonlyArray<readonly [string, string]> = [
  ["YYYY", "yyyy"],
  ["dddd", "cccc"],
  ["MMMM", "MMMM"],
  ["ddd", "ccc"],
  ["MMM", "MMM"],
  ["YY", "yy"],
  ["MM", "MM"],
  ["DD", "dd"],
  ["HH", "HH"],
  ["hh", "hh"],
  ["mm", "mm"],
  ["ss", "ss"],
  ["A", "a"],
]

/** Matches Moment.js [literal] escape groups — e.g. [Daily Note]. */
const MOMENT_ESCAPE_RE = /\[([^\]]*)\]/g

/** Replaces moment date/time tokens with their Luxon equivalents. */
const convertMomentTokens = (formatSpan: string): string =>
  MOMENT_TO_LUXON.reduce(
    (convertedSpan, [momentToken, luxonToken]) =>
      convertedSpan.replaceAll(momentToken, luxonToken),
    formatSpan,
  )

/** Converts a Moment.js format string to Luxon format tokens. [literal]
 *  escapes become Luxon 'literal' quotes (single quotes doubled), and token
 *  replacement runs only OUTSIDE literals so literal text containing token
 *  letters ("[Week A]") is preserved verbatim. Moment tokens without a
 *  mapping (Do, dd, DDD) pass through into Luxon's token grammar and may
 *  render differently than Obsidian would — config.ts's probe-render
 *  rejects only structurally unsafe results. */
export const momentToLuxonFormat = (momentFormat: string): string => {
  // split() with a capturing group alternates non-literal spans (even
  // indices) with literal contents (odd indices).
  return momentFormat
    .split(MOMENT_ESCAPE_RE)
    .map((segment, segmentIndex) => {
      const isLiteralContent = segmentIndex % 2 === 1
      return isLiteralContent
        ? `'${segment.replace(/'/g, "''")}'`
        : convertMomentTokens(segment)
    })
    .join("")
}
