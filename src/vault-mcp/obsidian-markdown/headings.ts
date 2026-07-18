/** Markdown heading parser — shared section-span logic for read and write.
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

/** Matches markdown headings H1–H6: captures the `#` prefix and heading text. */
const HEADING_REGEX = /^(#{1,6}) (.+)$/

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
 * Single-pass heading parser for H1–H6 with code-block and comment awareness.
 * Section body = heading+1 through next heading of same-or-higher level (or EOF).
 */
export const parseHeadings = (lines: readonly string[]): HeadingInfo[] => {
  // Phase 1: collect headings, skipping content inside fenced code blocks and
  // `%% %%` comment blocks. Fence and comment state are threaded through the
  // accumulator (no mutable external state).
  const { headings: collectedHeadings } = lines.reduce<{
    headings: Array<{ text: string; level: number; startLine: number }>
    openFence: OpenFence
    commentOpen: boolean
  }>(
    (state, line, i) => {
      // Fence/comment precedence: fence state advances only outside comments
      // (inside a comment, fence delimiters are just text); comment toggles
      // run only outside fences (inside a fence, `%%` is just text).
      const fenceResult = state.commentOpen
        ? null
        : advanceFence(line, state.openFence)
      // fenceResult is null when inside a comment (fence processing skipped);
      // fenceResult.openFence is null when a fence just closed — both are valid
      // states, so `??` can't distinguish them.
      const openFence =
        fenceResult !== null ? fenceResult.openFence : state.openFence

      if (fenceResult?.lineIsCode) {
        return { headings: state.headings, openFence, commentOpen: false }
      }

      const commentResult = advanceComment(line, state.commentOpen)
      if (commentResult.lineIsComment) {
        return {
          headings: state.headings,
          openFence,
          commentOpen: commentResult.commentOpen,
        }
      }

      const match = HEADING_REGEX.exec(line)
      const matchedHashes = match?.[1]
      const matchedText = match?.[2]
      if (matchedHashes !== undefined && matchedText !== undefined) {
        return {
          headings: [
            ...state.headings,
            {
              // Strip trailing closing hashes (e.g. "## Title ##" → "Title")
              text: matchedText.replace(/\s+#+\s*$/, "").trim(),
              level: matchedHashes.length,
              startLine: i,
            },
          ],
          openFence,
          commentOpen: false,
        }
      }

      return { headings: state.headings, openFence, commentOpen: false }
    },
    { headings: [], openFence: null, commentOpen: false },
  )

  // Phase 2: compute body ranges — each section's body ends where the next
  // heading of the same or higher level starts. Sections with no such heading
  // run to EOF, but must stop before a trailing `%% %%` comment block (e.g. a
  // Kanban board's `%% kanban:settings %%`) so replace/append don't clobber it.
  const trailingCommentBlockStart = findTrailingCommentBlockStart(lines)
  return collectedHeadings.map((heading, i) => {
    const nextSameOrHigher = collectedHeadings
      .slice(i + 1)
      .find((next) => next.level <= heading.level)
    return {
      text: heading.text,
      level: heading.level,
      startLine: heading.startLine,
      bodyStartLine: heading.startLine + 1,
      // Math.max keeps bodyEndLine >= bodyStartLine for malformed input.
      bodyEndLine:
        nextSameOrHigher?.startLine ??
        Math.max(heading.startLine + 1, trailingCommentBlockStart),
    }
  })
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
