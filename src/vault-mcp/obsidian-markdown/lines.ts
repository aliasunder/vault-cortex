/** Low-level Markdown line primitives shared across the parsing domain: the link
 *  grammar (links.ts), the heading/section parser (headings.ts), and — via
 *  splitIntoLines — the note-editing layer that turns raw note content into lines.
 *
 *  Two per-line state machines live here — advanceFence (CommonMark §4.5 fenced-code)
 *  and advanceComment (Obsidian `%% %%` comments) — so every consumer threads the
 *  same logic and they can never disagree about where code or comments begin. */

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

// ── Blockquote prefix stripping ─────────────────────────────────

/** Matches one blockquote marker: up to 3 spaces indent + `>` + optional
 *  space or tab (CommonMark §5.1). Applied iteratively to count nesting depth. */
const BLOCKQUOTE_MARKER = /^ {0,3}>[ \t]?/

/** Counts the blockquote nesting depth of a line and returns the content
 *  after all markers are stripped, so fence matching runs on the inner
 *  content — a `> \`\`\`` line has depth 1 and inner content `\`\`\``. */
const stripBlockquotePrefix = (
  line: string,
): { depth: number; innerContent: string } => {
  // Iterative prefix stripping — depth and remaining track the cursor across
  // successive `> ` markers.
  let depth = 0
  let remaining = line
  for (;;) {
    const match = BLOCKQUOTE_MARKER.exec(remaining)
    if (match === null) break
    depth++
    remaining = remaining.slice(match[0].length)
  }
  return { depth, innerContent: remaining }
}

// ── Fenced-code state machine ───────────────────────────────────

/** Matches fenced code block openers: 0-3 spaces indent + 3+ backticks or tildes
 *  (CommonMark §4.5). Applied to the inner content after blockquote markers are
 *  stripped. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/** The currently-open fence: its delimiter run (e.g. "```") plus the blockquote
 *  depth it opened at, or null when not inside a fenced code block. A fence
 *  opened at depth N closes only at the same depth; a line at lower depth
 *  closes it implicitly (the container ended per CommonMark §5.1). */
export type OpenFence = { delimiter: string; quoteDepth: number } | null

type FenceResult = {
  openFence: OpenFence
  isFenceDelimiter: boolean
  /** Whether this line is inside a fenced code block — accounts for blockquote
   *  depth, including implicit fence closure when the container ends. Consumers
   *  should use this instead of computing `isFenceDelimiter || openFence !== null`. */
  lineIsCode: boolean
}

/** Attempts to match a fence delimiter in `innerContent` and, if matched,
 *  returns a new fence opened at `quoteDepth`. */
const tryOpenFence = (
  innerContent: string,
  quoteDepth: number,
): FenceResult | null => {
  const fenceMatch = FENCE_OPEN.exec(innerContent)
  const fenceChars = fenceMatch?.[1]
  if (fenceChars === undefined) return null
  return {
    openFence: { delimiter: fenceChars, quoteDepth },
    isFenceDelimiter: true,
    lineIsCode: true,
  }
}

/** Advances the fenced-code state machine by one line — the single CommonMark
 *  §4.5 fence transition shared by every fence-aware walk.
 *
 *  Blockquote-aware: the line's `> ` markers are stripped before fence matching,
 *  so fences inside callouts/blockquotes (e.g. `> \`\`\``) are recognized. A
 *  fence opened at blockquote depth N closes only at the same depth; a line at
 *  lower depth closes it implicitly (the blockquote container ended), and a line
 *  at higher depth is content inside the fence.
 *
 *  Returns `lineIsCode` — whether this line is inside a fenced code block —
 *  which accounts for depth changes. Callers should use it instead of the
 *  previous `isFenceDelimiter || openFence !== null` pattern.
 *
 *  Lazy continuation (CommonMark allows omitting `> ` on continuation lines
 *  inside a blockquote) is out of scope: Obsidian's own renderer does not fully
 *  support it either, and real vaults almost always include the `> ` prefix on
 *  every line. */
export const advanceFence = (
  line: string,
  openFence: OpenFence,
): FenceResult => {
  const { depth: lineQuoteDepth, innerContent } = stripBlockquotePrefix(line)

  // Fence implicitly closed — this line's blockquote depth is below the fence's,
  // so the container that held the fence has ended. The line itself is NOT code;
  // check whether it opens a new fence at its own depth.
  if (openFence !== null && lineQuoteDepth < openFence.quoteDepth) {
    return (
      tryOpenFence(innerContent, lineQuoteDepth) ?? {
        openFence: null,
        isFenceDelimiter: false,
        lineIsCode: false,
      }
    )
  }

  // Deeper depth — content inside the fence, not a delimiter at this depth.
  if (openFence !== null && lineQuoteDepth > openFence.quoteDepth) {
    return { openFence, isFenceDelimiter: false, lineIsCode: true }
  }

  // Same depth (or no fence open) — normal fence matching on inner content.
  const fenceMatch = FENCE_OPEN.exec(innerContent)
  const fenceChars = fenceMatch?.[1]
  if (fenceChars === undefined) {
    return {
      openFence,
      isFenceDelimiter: false,
      lineIsCode: openFence !== null,
    }
  }

  if (openFence === null) {
    return {
      openFence: { delimiter: fenceChars, quoteDepth: lineQuoteDepth },
      isFenceDelimiter: true,
      lineIsCode: true,
    }
  }

  // Inside a fence at the same depth: only a matching closer ends it.
  const closesFence =
    fenceChars[0] === openFence.delimiter[0] &&
    fenceChars.length >= openFence.delimiter.length &&
    innerContent.trim() === fenceChars
  return {
    openFence: closesFence ? null : openFence,
    isFenceDelimiter: true,
    lineIsCode: true,
  }
}

// ── Obsidian comment state machine ─────────────────────────────

/** Obsidian comment delimiter — toggles comment state when it occurs at a
 *  line boundary (start or end of trimmed line). Mid-line `%%` (e.g. `100%%`
 *  embedded in card text) is not a delimiter. */
export const COMMENT_DELIMITER = "%%"

/**
 * Counts how many comment-state toggles a single line produces. Obsidian
 * treats `%%` as a comment delimiter only at line boundaries — mid-line
 * occurrences like `100%%` or `text %% mid` do not toggle state.
 *
 * Returns 0, 1, or 2:
 * - 0 — trimmed line has no `%%` at start or end
 * - 1 — trimmed line is exactly `%%`, OR starts XOR ends with `%%`
 * - 2 — trimmed line both starts and ends with `%%` (inline `%% comment %%`)
 */
const countCommentToggles = (line: string): number => {
  const trimmed = line.trim()
  if (trimmed === COMMENT_DELIMITER) return 1
  const startsWithDelimiter = trimmed.startsWith(COMMENT_DELIMITER)
  const endsWithDelimiter = trimmed.endsWith(COMMENT_DELIMITER)
  return (startsWithDelimiter ? 1 : 0) + (endsWithDelimiter ? 1 : 0)
}

export type CommentResult = {
  commentOpen: boolean
  lineIsComment: boolean
}

/** Advances the Obsidian `%% %%` comment state machine by one line — the
 *  single comment transition shared by every comment-aware walk.
 *
 *  `lineIsComment` is true when the line is inside a comment block (the entry
 *  state was open) OR the line contains a `%%` delimiter (opener, closer, or
 *  inline `%% text %%`). Delimiter lines themselves are comment content because
 *  Obsidian does not render them.
 *
 *  Callers orchestrate fence/comment precedence: advance fences only outside
 *  comments, and call advanceComment only outside fences. This matches
 *  Obsidian's parser — inside a comment, fence delimiters are just text;
 *  inside a fence, `%%` is just text. */
export const advanceComment = (
  line: string,
  commentOpen: boolean,
): CommentResult => {
  const toggleCount = countCommentToggles(line)
  const wasOpen = commentOpen
  // Apply toggles sequentially: each occurrence flips the state.
  // For 2 toggles (inline `%% text %%`), the state flips twice — net
  // unchanged when starting closed, net unchanged when starting open.
  let currentlyOpen = commentOpen
  for (let toggle = 0; toggle < toggleCount; toggle++) {
    currentlyOpen = !currentlyOpen
  }
  return {
    commentOpen: currentlyOpen,
    lineIsComment: wasOpen || toggleCount > 0,
  }
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
    openFence = result.openFence
    yield { text, inCode: result.lineIsCode }
  }
}
