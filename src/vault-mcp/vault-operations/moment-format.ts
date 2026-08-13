/** Moment.js → Luxon format-string conversion.
 *
 *  Obsidian's daily-notes config stores its filename format in Moment.js
 *  tokens (Obsidian bundles moment); the server renders dates with Luxon.
 *  Pure string transform with zero imports so config-time validation
 *  (config.ts) can use it without pulling in filesystem or logger deps. */

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

/** Converts a Moment.js format string to Luxon format tokens.
 *  Handles [literal] escapes (Moment) → 'literal' (Luxon) and
 *  common date/time tokens. Unsupported tokens (Do, d, dd) are
 *  left as-is — Luxon renders unknown tokens literally, so they
 *  appear verbatim in the output rather than failing. */
export const momentToLuxonFormat = (momentFormat: string): string => {
  // First pass: convert Moment [literal] escapes to Luxon 'literal' syntax.
  // Single quotes inside literals are doubled per Luxon's escape convention.
  const withLiteralsConverted = momentFormat.replace(
    MOMENT_ESCAPE_RE,
    (_, literal: string) => {
      const escapedContent = literal.replace(/'/g, "''")
      return `'${escapedContent}'`
    },
  )
  // Second pass: replace date/time tokens from longest to shortest
  return MOMENT_TO_LUXON.reduce(
    (formatString, [momentToken, luxonToken]) =>
      formatString.replaceAll(momentToken, luxonToken),
    withLiteralsConverted,
  )
}
