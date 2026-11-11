/** Moment.js → Luxon format-string conversion — Obsidian stores daily-note
 *  formats in Moment tokens; the server renders with Luxon. */

import { DateTime } from "luxon"

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
const convertMomentTokens = (formatSpan: string): string => {
  return formatSpan.replace(MOMENT_TOKEN_RE, (match) => MOMENT_TOKEN_MAP.get(match) ?? match)
}

/** Converts a Moment.js format string to Luxon format tokens. [literal]
 *  escapes become Luxon 'literal' quotes (single quotes doubled), and token
 *  replacement runs only OUTSIDE literals so literal text containing token
 *  letters ("[Week A]") is preserved verbatim. Moment tokens with no Luxon
 *  equivalent (see findUnsupportedTokens) are rejected by getDailyNotePath
 *  before the converter runs. */
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
      return isLiteralContent ? `'${segment.replace(/'/g, "''")}'` : convertMomentTokens(segment)
    })
    .join("")
}

/** Moment tokens with no Luxon equivalent. Each entry is a standalone
 *  regex pattern with boundary guards so it doesn't false-positive inside
 *  a supported token (e.g. dd inside ddd, D inside DD, L inside LL).
 *  Boundary guards use lookahead/lookbehind for the same letter family. */
const UNSUPPORTED_PATTERNS: ReadonlyArray<{ pattern: RegExp; token: string }> = [
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
  { pattern: /(?<!Z)ZZ/, token: "ZZ" },
  { pattern: /(?<!Z)Z(?!Z)/, token: "Z" },
  { pattern: /(?<![A-Za-z])Q(?![A-Za-z])/, token: "Q" },
  { pattern: /(?<![A-Za-z])w(?![A-Za-z])/, token: "w" },
]

/** The format's text outside [literal] escapes, each span joined by \0 so a
 *  token can't match across a literal. */
const joinFormatSpans = (momentFormat: string): string => {
  return momentFormat
    .split(MOMENT_ESCAPE_RE)
    .filter((_, segmentIndex) => segmentIndex % 2 === 0)
    .join("\0")
}

/** Returns unsupported Moment tokens present in the format string outside
 *  of [literal] escapes, or an empty array if none. */
export const findUnsupportedTokens = (momentFormat: string): string[] => {
  const formatSegments = joinFormatSpans(momentFormat)
  const found = new Set<string>()
  for (const { pattern, token } of UNSUPPORTED_PATTERNS) {
    if (pattern.test(formatSegments)) {
      found.add(token)
    }
  }
  return [...found]
}

/** Matches a [literal] escape group, or a "/" outside one. */
const LITERAL_OR_SLASH_RE = /\[[^\]]*\]|\//g

/** The format after its last "/" outside [literal] escapes. Obsidian treats
 *  the parts before that slash as folders, so this part names the file. */
const findFileNameFormat = (momentFormat: string): string => {
  const slashMatches = [...momentFormat.matchAll(LITERAL_OR_SLASH_RE)].filter(
    (match) => match[0] === "/",
  )
  const lastSlashIndex = slashMatches.at(-1)?.index ?? -1
  return momentFormat.slice(lastSlashIndex + 1)
}

const YEAR_TOKENS: ReadonlySet<string> = new Set(["YYYY", "YY"])
const MONTH_TOKENS: ReadonlySet<string> = new Set(["MMMM", "MMM", "MM", "M"])
const DAY_OF_MONTH_TOKENS: ReadonlySet<string> = new Set(["DD", "D"])
const DAY_OF_YEAR_TOKENS: ReadonlySet<string> = new Set(["DDDD", "DDD"])

/** Whether the format's tokens fix one calendar day: a year, plus a month
 *  and a day of the month, or a day of the year. Luxon fills a missing unit
 *  from today's date, so a format without one would match names such as
 *  "07" or "1984" that are not dates. */
const namesCompleteDate = (momentFormat: string): boolean => {
  const formatTokens = new Set(joinFormatSpans(momentFormat).match(MOMENT_TOKEN_RE))
  const hasTokenFrom = (tokenGroup: ReadonlySet<string>): boolean => {
    return [...tokenGroup].some((token) => formatTokens.has(token))
  }
  const hasMonthAndDay = hasTokenFrom(MONTH_TOKENS) && hasTokenFrom(DAY_OF_MONTH_TOKENS)
  return hasTokenFrom(YEAR_TOKENS) && (hasMonthAndDay || hasTokenFrom(DAY_OF_YEAR_TOKENS))
}

/** The file-name part of a daily-note format, as a Luxon format. */
type DailyNoteNameFormat = { luxonFormat: string }

/** Converts a daily-note format (Moment tokens) to the Luxon format of the
 *  note's file name, for matchesDailyNoteName. Null when that file name
 *  holds an unsupported token or does not fix one calendar day, since no
 *  name can then be read back as a date. */
export const dailyNoteFormatToNameFormat = (momentFormat: string): DailyNoteNameFormat | null => {
  // Obsidian trims the formatted date before naming the file, so a format
  // with a space at either end still names "2026-05-13.md".
  const fileNameFormat = findFileNameFormat(momentFormat).trim()

  if (findUnsupportedTokens(fileNameFormat).length > 0) return null
  if (!namesCompleteDate(fileNameFormat)) return null

  return { luxonFormat: momentToLuxonFormat(fileNameFormat) }
}

/** Whether a note name (no folder, no extension) is a date written exactly
 *  as the daily-note format writes it, ignoring letter case. */
export const matchesDailyNoteName = (params: {
  name: string
  format: DailyNoteNameFormat
}): boolean => {
  const { name, format } = params
  const parsedDate = DateTime.fromFormat(name, format.luxonFormat)

  if (!parsedDate.isValid) return false

  // Luxon parses "2026-01-07" under "yyyy-M-d", but Obsidian names that day
  // "2026-1-7", so only the date's own rendering is its daily note's name.
  // Letter case is ignored because a link that differs from a file name
  // only in case still resolves to it.
  return parsedDate.toFormat(format.luxonFormat).toLowerCase() === name.toLowerCase()
}
