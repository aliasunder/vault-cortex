/** Low-level Markdown line primitives shared across the parsing domain: the link
 *  grammar (links.ts), the heading/section parser (headings.ts), and — via
 *  splitIntoLines — the note-editing layer that turns raw note content into lines.
 *
 *  Two per-line state machines live here — advanceFence (CommonMark §4.5 fenced-code)
 *  and advanceComment (Obsidian `%% %%` comments) — so every consumer threads the
 *  same logic and they can never disagree about where code or comments begin.
 *
 *  pageTextByLines is the shared line-paging primitive used by both vault_read_note
 *  and vault_read_file to deliver text in 1-based line windows, and
 *  collapseEmptyLineRunsAtEdits shrinks the run of empty lines a note edit leaves. */

// ── Line splitting ──────────────────────────────────────────────

/** Splits note content into lines, stripping a trailing CR so CRLF-authored
 *  (Windows) notes split into LF-only lines. The single home for this
 *  normalization: every site that turns a note's body into lines for parsing or
 *  editing should use it, so heading/section/callout parsing and empty-line
 *  handling behave identically regardless of the file's line endings. */
export const splitIntoLines = (content: string): string[] =>
  content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))

// ── Line paging ────────────────────────────────────────────────

/** The 1-based line window a paged text read covered, plus the rendition's
 *  total line count so the caller can tell a final page from a mid-file one. */
export type LineWindow = Readonly<{
  startLine: number
  endLine: number
  totalLines: number
}>

/** A paged text result: the windowed text (LF-joined) and the line window
 *  metadata describing what was served and how much remains. */
export type PagedTextResult = Readonly<{
  text: string
  lineWindow: LineWindow
}>

/**
 * Pages a text string by line range — the shared primitive behind both
 * vault_read_note and vault_read_file paging. Lines are counted wc -l style
 * (a trailing newline's empty final element is not a line of content) and the
 * window is rejoined with "\n", so CRLF sources come back LF-normalized.
 *
 * `path` is used only in error messages — the function does no I/O.
 */
export const pageTextByLines = (params: {
  text: string
  path: string
  startLine?: number | undefined
  limit?: number | undefined
}): PagedTextResult => {
  const { text, path, startLine, limit } = params

  const splitLines = splitIntoLines(text)
  // wc -l semantics: a rendition ending in "\n" splits into a trailing ""
  // that isn't a line of content — drop exactly that one element.
  const hasTrailingNewlineArtifact =
    splitLines.length > 0 && splitLines[splitLines.length - 1] === ""
  const contentLines = hasTrailingNewlineArtifact ? splitLines.slice(0, -1) : splitLines
  const totalLines = contentLines.length

  const firstLine = startLine ?? 1
  // The tool schema already enforces >= 1, but a negative slice start would
  // silently serve lines from the END of the rendition — guard here too so a
  // future direct caller gets a loud error, never the wrong window.
  const hasInvalidLineRange = firstLine < 1 || (limit !== undefined && limit < 1)

  if (hasInvalidLineRange) {
    throw new Error(`invalid line range: "${path}" needs a start line and limit of at least 1`)
  }
  // An empty rendition has no lines to overshoot — any window of it is the
  // empty window; only a non-empty rendition can have a start past its end.
  const isStartPastEnd = totalLines > 0 && firstLine > totalLines

  if (isStartPastEnd) {
    throw new Error(`start line past the end: "${path}" renders to ${totalLines} lines`)
  }

  const windowLines = contentLines.slice(
    firstLine - 1,
    limit === undefined ? undefined : firstLine - 1 + limit,
  )
  const windowText = windowLines.join("\n")
  const endLine = firstLine - 1 + windowLines.length

  return {
    text: windowText,
    lineWindow: { startLine: firstLine, endLine, totalLines },
  }
}

// ── Blank-edge trimming ─────────────────────────────────────────

/** Drops blank lines from both ends of a line array, keeping interior blanks
 *  intact. A caller that turns a line region into reportable text — an outline's
 *  leading content, a byte count in a write confirmation — wants the region's
 *  real extent, not the blank padding that separates it from its neighbours. */
export const trimBlankEdgeLines = (lines: readonly string[]): readonly string[] => {
  const firstContentIndex = lines.findIndex((line) => line.trim() !== "")

  if (firstContentIndex === -1) return []
  const lastContentIndex = lines.findLastIndex((line) => line.trim() !== "")
  return lines.slice(firstContentIndex, lastContentIndex + 1)
}

// ── Edit-gap collapsing ─────────────────────────────────────────

/** A point where an edit brought two sides together. A side is note text that
 *  stayed, or content the edit inserted.
 *  - `boundary`: the index, in the edited lines, where the side below starts.
 *  - `gapAbove` / `gapBelow`: the empty lines each side had at its facing edge
 *    before the edit, up to its nearest line of text or the body's edge. */
export type EmptyLineEdit = Readonly<{ boundary: number; gapAbove: number; gapBelow: number }>

/** A run of consecutive empty lines, as a half-open index range. */
type EmptyLineRun = Readonly<{ start: number; end: number }>

/** A run of empty lines that one or more edits touch, with the widest gap any of
 *  those edits brought to it. */
type PooledRun = Readonly<{ run: EmptyLineRun; widestGap: number }>

/** The empty lines directly above `boundary` plus those at and below it. */
const findEmptyRunAt = (lines: readonly string[], boundary: number): EmptyLineRun => {
  // Two cursors walk outward from the boundary until each meets text or the
  // body's edge, so the cost is the run's length rather than the note's.
  let start = boundary
  while (start > 0 && lines[start - 1] === "") {
    start--
  }
  let end = boundary
  while (end < lines.length && lines[end] === "") {
    end++
  }
  return { start, end }
}

/** The indexes, in the edited lines, of the empty lines a run drops: every line
 *  after the ones it keeps. */
const listExcessEmptyLineIndexes = ({ run, widestGap }: PooledRun): number[] => {
  const runLength = run.end - run.start

  // The run keeps its widest gap, bounded on both sides:
  // - at least one line, because lines emptied by removing their text can form
  //   a run with no gap on either side, and two emptied lines should leave the
  //   same single empty line that one emptied line leaves;
  // - at most the run's length, because a gap can count line breaks the edit
  //   removed (a match's own leading or trailing breaks).
  const keptLength = Math.min(runLength, Math.max(widestGap, 1))

  return Array.from(
    { length: runLength - keptLength },
    (_, offset) => run.start + keptLength + offset,
  )
}

/** Shrinks each run of empty lines that an edit point touches to the widest gap
 *  among its edits (`gapAbove` or `gapBelow`), and never below one line. Runs no
 *  edit touches stay as they are.
 *
 *  - "Empty" means exactly `""`: a line of spaces is text here, unlike in
 *    trimBlankEdgeLines.
 *  - Every run is measured on the lines as given, so dropping lines in one run
 *    never shifts another edit's boundary. */
export const collapseEmptyLineRunsAtEdits = (params: {
  lines: readonly string[]
  edits: readonly EmptyLineEdit[]
}): string[] => {
  const { lines, edits } = params

  // Keyed by the run's first line, so a second edit in the same run widens the
  // pooled gap instead of replacing it.
  const pooledRunsByStart = new Map<number, PooledRun>()

  // Many edits can land in one long run (every match of a replace-all), so an
  // edit inside the previous edit's run reuses it rather than rescanning it,
  // which would be quadratic. Starts as an empty range before line 0.
  let previousRun: EmptyLineRun = { start: -1, end: -1 }
  for (const edit of edits) {
    // The run found around a boundary always has start <= boundary <= end, so a
    // boundary at either end of the previous run touches that same run.
    const isInPreviousRun = edit.boundary >= previousRun.start && edit.boundary <= previousRun.end
    const run = isInPreviousRun ? previousRun : findEmptyRunAt(lines, edit.boundary)
    const pooledGap = pooledRunsByStart.get(run.start)?.widestGap ?? 0
    const widestGap = Math.max(pooledGap, edit.gapAbove, edit.gapBelow)
    pooledRunsByStart.set(run.start, { run, widestGap })
    previousRun = run
  }

  const excessLineIndexes = [...pooledRunsByStart.values()].flatMap(listExcessEmptyLineIndexes)
  const droppedIndexes = new Set(excessLineIndexes)
  return lines.filter((_, index) => !droppedIndexes.has(index))
}

// ── Blockquote prefix stripping ─────────────────────────────────

/** Matches one blockquote marker: up to 3 spaces indent + `>` + optional
 *  space or tab (CommonMark §5.1). Applied iteratively to count nesting depth. */
const BLOCKQUOTE_MARKER = /^ {0,3}>[ \t]?/

/** Counts the blockquote nesting depth of a line and returns the content
 *  after all markers are stripped, so fence matching runs on the inner
 *  content — a `> \`\`\`` line has depth 1 and inner content `\`\`\``. */
const stripBlockquotePrefix = (line: string): { depth: number; innerContent: string } => {
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
const tryOpenFence = (innerContent: string, quoteDepth: number): FenceResult | null => {
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
 *  The line's `> ` markers are stripped before fence matching, so fences inside
 *  callouts/blockquotes (e.g. `> \`\`\``) are recognized. A fence opened at
 *  blockquote depth N closes only at the same depth; a line at lower depth
 *  closes it implicitly (the blockquote container ended), and a line at higher
 *  depth is content inside the fence.
 *
 *  Returns `lineIsCode` — whether this line is inside a fenced code block —
 *  which accounts for depth changes. Callers should use it rather than
 *  recomputing it from `isFenceDelimiter` and `openFence`.
 *
 *  Lazy continuation (CommonMark allows omitting `> ` on continuation lines
 *  inside a blockquote) is out of scope: Obsidian's own renderer does not fully
 *  support it either, and real vaults almost always include the `> ` prefix on
 *  every line. */
export const advanceFence = (line: string, openFence: OpenFence): FenceResult => {
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
export const advanceComment = (line: string, commentOpen: boolean): CommentResult => {
  const toggleCount = countCommentToggles(line)
  // Each toggle flips the state; an even count nets no change.
  const currentlyOpen = toggleCount % 2 === 0 ? commentOpen : !commentOpen
  return {
    commentOpen: currentlyOpen,
    lineIsComment: commentOpen || toggleCount > 0,
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
export const classifyLines = function* (content: string): Generator<ClassifiedLine> {
  // A fenced-code scan is inherently sequential, so this generator threads one
  // mutable open fence across the loop rather than folding line-state pairs.
  let openFence: OpenFence = null
  for (const text of content.split("\n")) {
    const result = advanceFence(text, openFence)
    openFence = result.openFence
    yield { text, inCode: result.lineIsCode }
  }
}
