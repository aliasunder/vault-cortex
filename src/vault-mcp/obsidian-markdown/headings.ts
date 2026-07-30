/** Markdown heading parser (ATX + setext) — shared section-span logic for read
 * and write.
 *
 * Both the read side (`vault_read_note` outline + section reads) and the write
 * side (`vault_patch_note`) target sections by heading, so they share one
 * parser: "read section X" and "edit section X" resolve to the exact same span.
 */

import {
  advanceComment,
  advanceFence,
  COMMENT_DELIMITER,
  type OpenFence,
} from "./lines.js"

// ── Types ───────────────────────────────────────────────────────

export type HeadingInfo = Readonly<{
  text: string
  level: number
  startLine: number
  bodyStartLine: number
  bodyEndLine: number
}>

// ── Internal helpers ────────────────────────────────────────────

/** Matches ATX headings H1–H6 per CommonMark §4.2: 0-3 leading spaces,
 *  1-6 `#` characters, then optionally a space/tab separator and heading text.
 *  Empty headings (`##` alone on a line) are valid — group 2 is undefined. */
const HEADING_REGEX = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/

/** Matches setext heading underlines per CommonMark §4.3: 0-3 leading spaces,
 *  one or more `=` (H1) or `-` (H2) characters, optional trailing whitespace.
 *  A valid setext heading requires a non-blank text line immediately above.
 *  Multi-line content before the underline is not supported — only the single
 *  immediately preceding line becomes the heading text. This matches Obsidian,
 *  which renders multi-line setext inconsistently (Edit mode ≠ Reading mode). */
const SETEXT_UNDERLINE_REGEX = /^ {0,3}(=+|-+)[ \t]*$/

/** Matches block-level line openers (list items, blockquotes) that can't be
 *  setext heading content per CommonMark §4.3 — only paragraph text qualifies. */
const BLOCK_LEVEL_LINE_REGEX = /^[-*+] |^\d+[.)] |^>/

/**
 * Finds the line index where a trailing Obsidian comment block begins, so the
 * final section's body can stop short of it. Returns `lines.length` when none
 * exists. A block is "trailing" when only blank lines follow its closing `%%`
 * (or when an unclosed comment runs to EOF).
 */
export const findTrailingCommentBlockStart = (
  lines: readonly string[],
): number => {
  // `let` carries fence + comment parser state and block-tracking across
  // lines — the block-tracking logic (where a comment opened/closed) is
  // domain-specific to trailing-block detection, layered on top of the
  // shared advanceComment state machine.
  let openFence: OpenFence = null
  let commentOpen = false
  let commentOpenLine = -1
  let lastClosedBlock: { startLine: number; endLine: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // Fence/comment precedence: fence state advances only outside comments;
    // comment toggles run only outside fences.
    if (!commentOpen) {
      const fenceResult = advanceFence(line, openFence)
      openFence = fenceResult.openFence
      if (fenceResult.lineIsCode) continue
    }

    const wasOpen = commentOpen
    const commentResult = advanceComment(line, commentOpen)
    commentOpen = commentResult.commentOpen

    // Derive block-tracking transitions from before/after state.
    if (!wasOpen && commentOpen) {
      commentOpenLine = i
      continue
    }

    if (wasOpen && !commentOpen) {
      const validCloser = line.trimEnd().endsWith(COMMENT_DELIMITER)
      lastClosedBlock = validCloser
        ? { startLine: commentOpenLine, endLine: i }
        : null
      continue
    }

    const isInlineComment =
      !wasOpen && !commentOpen && commentResult.lineIsComment
    if (isInlineComment) {
      const validCloser = line.trimEnd().endsWith(COMMENT_DELIMITER)
      lastClosedBlock = validCloser ? { startLine: i, endLine: i } : null
    }
  }

  // An unclosed comment runs to EOF and is trailing by definition. A closed
  // block is trailing only when nothing but blank lines follow it.
  const trailingBlock = commentOpen
    ? { startLine: commentOpenLine }
    : lastClosedBlock &&
        lines
          .slice(lastClosedBlock.endLine + 1)
          .every((trailingLine) => trailingLine.trim() === "")
      ? lastClosedBlock
      : null

  if (!trailingBlock) return lines.length

  // The opener must start its own line.
  const blockOpenerLine = lines[trailingBlock.startLine]
  if (
    blockOpenerLine === undefined ||
    !blockOpenerLine.trimStart().startsWith(COMMENT_DELIMITER)
  ) {
    return lines.length
  }

  // Absorb blank lines before the block so the section body keeps no dangling
  // blanks. findLastIndex returns -1 when only blanks precede it, so +1 → 0.
  return (
    lines
      .slice(0, trailingBlock.startLine)
      .findLastIndex((line) => line.trim() !== "") + 1
  )
}

// ── Exported parser ─────────────────────────────────────────────

/**
 * Heading parser for H1–H6 with code-block and comment awareness. Recognizes
 * both ATX (`## Title`) and setext (`Title` over `===`/`---`) headings.
 * Skips content inside fenced code blocks and `%% %%` comment blocks.
 * Section body = heading line(s)+1 through next same-or-higher heading (or EOF).
 */
export const parseHeadings = (lines: readonly string[]): HeadingInfo[] => {
  // Phase 1: collect headings. Setext detection needs two-line lookahead
  // (text line + underline), so the parser uses a for-loop with mutable
  // state rather than a reduce.
  const collectedHeadings: Array<{
    text: string
    level: number
    startLine: number
    bodyStartLine: number
  }> = []
  // `let` carries fence, comment, and setext-candidate state across lines.
  let openFence: OpenFence = null
  let commentOpen = false
  // The previous non-blank, non-heading, non-fence/comment content line — a
  // candidate for setext heading text if the current line is an underline.
  let setextCandidate: { text: string; index: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // Fence/comment precedence: fence state advances only outside comments
    // (inside a comment, fence delimiters are just text); comment toggles
    // run only outside fences (inside a fence, `%%` is just text).
    if (!commentOpen) {
      const fenceResult = advanceFence(line, openFence)
      openFence = fenceResult.openFence
      if (fenceResult.lineIsCode) {
        setextCandidate = null
        continue
      }
    }

    const commentResult = advanceComment(line, commentOpen)
    commentOpen = commentResult.commentOpen
    if (commentResult.lineIsComment) {
      setextCandidate = null
      continue
    }

    const atxMatch = HEADING_REGEX.exec(line)
    const matchedHashes = atxMatch?.[1]
    if (matchedHashes) {
      const matchedText = atxMatch?.[2] ?? ""
      collectedHeadings.push({
        // Strip trailing closing hashes (e.g. "## Title ##" → "Title")
        text: matchedText.replace(/\s+#+\s*$/, "").trim(),
        level: matchedHashes.length,
        startLine: i,
        bodyStartLine: i + 1,
      })
      setextCandidate = null
      continue
    }

    // Setext underline check — a setext heading is a non-blank content line
    // followed by a `===` (H1) or `---` (H2) underline (CommonMark §4.3).
    if (setextCandidate !== null) {
      const setextMatch = SETEXT_UNDERLINE_REGEX.exec(line)
      const underlineChars = setextMatch?.[1]
      if (underlineChars) {
        collectedHeadings.push({
          text: setextCandidate.text.trim(),
          level: underlineChars.startsWith("=") ? 1 : 2,
          startLine: setextCandidate.index,
          bodyStartLine: i + 1,
        })
        setextCandidate = null
        continue
      }
    }

    // Track setext candidate: non-blank content → candidate; blank → reset.
    if (line.trim() === "") {
      setextCandidate = null
    } else {
      setextCandidate = BLOCK_LEVEL_LINE_REGEX.test(line.trimStart())
        ? null
        : { text: line, index: i }
    }
  }

  // Phase 2: compute body ranges — each section's body ends where the next
  // heading of the same or higher level starts. Sections with no such heading
  // run to EOF, but must stop before a trailing `%% %%` comment block (e.g. a
  // Kanban board's `%% kanban:settings %%`) so replace/append don't clobber it.
  const trailingCommentBlockStart = findTrailingCommentBlockStart(lines)
  return collectedHeadings.map((heading, index) => {
    const nextSameOrHigher = collectedHeadings
      .slice(index + 1)
      .find((next) => next.level <= heading.level)
    return {
      text: heading.text,
      level: heading.level,
      startLine: heading.startLine,
      bodyStartLine: heading.bodyStartLine,
      // Math.max keeps bodyEndLine >= bodyStartLine for malformed input.
      bodyEndLine:
        nextSameOrHigher?.startLine ??
        Math.max(heading.bodyStartLine, trailingCommentBlockStart),
    }
  })
}

/**
 * Returns the body lines above the note's first heading of any level (H1–H6) —
 * the region a no-heading `prepend` lands in, and the only content a prepended
 * heading can pull into its own section. A note whose first line is a heading
 * returns an empty array.
 *
 * With no headings the region runs to the start of any trailing `%% %%` comment
 * block rather than to EOF, mirroring how parseHeadings bounds a final section's
 * bodyEndLine. Without that, an empty Kanban board — no lanes yet, just its
 * trailing `%% kanban:settings %%` block — would report the settings JSON as
 * body content.
 *
 * Takes an already-parsed heading list so a caller holding one (an outline read)
 * doesn't parse twice. Deriving the boundary from parseHeadings also makes the
 * region fence- and comment-aware for free: a `## foo` inside a code fence is
 * not the first heading, so the fenced block stays inside the region.
 */
export const linesBeforeFirstHeading = (
  lines: readonly string[],
  headings: readonly HeadingInfo[],
): readonly string[] => {
  const regionEndLine =
    headings[0]?.startLine ?? findTrailingCommentBlockStart(lines)
  return lines.slice(0, regionEndLine)
}

/** Case-sensitive heading lookup. Errors on 0 or 2+ matches. */
export const findHeading = (
  headings: readonly HeadingInfo[],
  text: string,
  level?: number,
): HeadingInfo => {
  if (!text.trim()) {
    throw new Error("heading cannot be empty")
  }

  const searchText = text.trim()
  const matches = headings.filter(
    (heading) =>
      heading.text === searchText &&
      (level === undefined || heading.level === level),
  )

  if (matches.length === 0) {
    const availableHeadings = headings
      .map((heading) => `${"#".repeat(heading.level)} ${heading.text}`)
      .join(", ")
    throw new Error(
      `heading not found: "${searchText}". Available headings: ${availableHeadings || "(none)"}`,
    )
  }

  if (matches.length > 1) {
    const matchedHeadings = matches
      .map(
        (heading) =>
          `${"#".repeat(heading.level)} ${heading.text} (line ${heading.startLine + 1})`,
      )
      .join(", ")
    const firstMatch = matches[0]
    const allSameLevel =
      firstMatch !== undefined &&
      matches.every((heading) => heading.level === firstMatch.level)
    const hint = allSameLevel
      ? "Rename one heading to make it unique, or use vault_replace_in_note to target by text."
      : "Use heading_level to disambiguate."
    throw new Error(
      `ambiguous heading: "${searchText}" matches ${matches.length} sections: ${matchedHeadings}. ${hint}`,
    )
  }

  const result = matches[0]
  if (result === undefined) {
    throw new Error(`heading not found: "${searchText}"`)
  }
  return result
}
