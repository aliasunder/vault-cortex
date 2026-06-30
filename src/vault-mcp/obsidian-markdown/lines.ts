/** Low-level Markdown line and fenced-code primitives, shared across the parsing
 *  domain: the link grammar (links.ts), the heading/section parser (headings.ts),
 *  and — via splitIntoLines — the note-editing layer that turns raw note content
 *  into lines.
 *
 *  This is the single home of the CommonMark §4.5 fenced-code state machine
 *  (advanceFence). classifyLines (a content -> {text, inCode} generator) and the
 *  heading parser both thread their fence state through advanceFence, so they can
 *  never disagree about where a code fence opens or closes. */

// ── Line splitting ──────────────────────────────────────────────

/** Splits note content into lines, stripping a trailing CR so CRLF-authored
 *  (Windows) notes split into LF-only lines. The single home for this
 *  normalization: every site that turns a note's body into lines for parsing or
 *  editing should use it, so heading/section/callout parsing and blank-run
 *  handling behave identically regardless of the file's line endings. */
export const splitIntoLines = (content: string): string[] =>
  content
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))

// ── Fenced-code state machine ───────────────────────────────────

/** Matches fenced code block openers: 0-3 spaces indent + 3+ backticks or tildes
 *  (CommonMark §4.5). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/** The currently-open fence's delimiter run (e.g. "```" or "~~~~"), or null when
 *  not inside a fenced code block. */
export type OpenFence = string | null

/** Advances the fenced-code state machine by one line — the single CommonMark
 *  §4.5 fence transition shared by every fence-aware walk.
 *
 *  Given the fence open before this line (null outside a fence) and the line,
 *  returns the fence open after it plus whether the line is itself a fence
 *  delimiter (any line matching the opener grammar — an opener, a closer, or a
 *  fence-looking line inside a fence). Delimiter lines are always code, never
 *  heading- or link-bearing content, so callers skip them.
 *
 *  A closer must use the opener's character (backtick vs tilde), be at least as
 *  long, and once trimmed hold only fence characters (no trailing info string). */
export const advanceFence = (
  line: string,
  openFence: OpenFence,
): { openFence: OpenFence; isFenceDelimiter: boolean } => {
  const fenceMatch = FENCE_OPEN.exec(line)
  if (!fenceMatch) return { openFence, isFenceDelimiter: false }

  const fenceChars = fenceMatch[1]!
  // Outside a fence: this line opens one.
  if (openFence === null) {
    return { openFence: fenceChars, isFenceDelimiter: true }
  }

  // Inside a fence: only a matching closer ends it; any other fence-looking line
  // is code content and leaves the fence open.
  const closesFence =
    fenceChars[0] === openFence[0] &&
    fenceChars.length >= openFence.length &&
    line.trim() === fenceChars
  return { openFence: closesFence ? null : openFence, isFenceDelimiter: true }
}

// ── Line classification ─────────────────────────────────────────

/** One line tagged with whether it sits in a fenced code block (a fence
 *  delimiter line counts as code — it never bears links or headings). */
type ClassifiedLine = { text: string; inCode: boolean }

/** Walks markdown content line by line, threading fence state via advanceFence
 *  and tagging each line as code or not. Used by link extraction (skips code
 *  lines) and link rewriting (passes code lines through unchanged).
 *
 *  Splits on raw "\n", preserving each line verbatim (including any trailing CR),
 *  so a rewriter that rejoins with "\n" round-trips the content unchanged. A
 *  caller that wants CRLF normalized should splitIntoLines first. */
export const classifyLines = function* (
  content: string,
): Generator<ClassifiedLine> {
  // A fenced-code scan is inherently sequential, so this generator threads one
  // mutable open fence across the loop rather than folding line-state pairs.
  let openFence: OpenFence = null
  for (const text of content.split("\n")) {
    const result = advanceFence(text, openFence)
    // A fence delimiter is code; so is any line while a fence is already open.
    const inCode = result.isFenceDelimiter || openFence !== null
    openFence = result.openFence
    yield { text, inCode }
  }
}
