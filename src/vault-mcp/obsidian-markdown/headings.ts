/** Markdown heading parser — shared section-span logic for read and write.
 *
 * Both the read side (`vault_read_note` outline + section reads) and the write
 * side (`vault_patch_note`) target sections by heading, so they share one
 * parser: "read section X" and "edit section X" resolve to the exact same span.
 */

import { advanceFence, type OpenFence } from "./lines.js"

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

/** Obsidian comment delimiter — toggles comment state when it occurs at a
 * line boundary (start or end of trimmed line). Mid-line `%%` (e.g. `100%%`
 * embedded in card text) is not a delimiter. */
const COMMENT_DELIMITER = "%%"

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

/**
 * Finds the line index where a trailing Obsidian comment block begins, so the
 * final section's body can stop short of it. Returns `lines.length` when none
 * exists. A block is "trailing" when only blank lines follow its closing `%%`
 * (or when an unclosed comment runs to EOF).
 *
 * Known limitation: heading detection in `parseHeadings` is NOT comment-aware,
 * so a `## heading` inside a `%% %%` block is still treated as a real heading.
 */
export const findTrailingCommentBlockStart = (
  lines: readonly string[],
): number => {
  // `let` carries fence + comment parser state across lines — a per-line
  // reduce can't express the per-`%%` toggle cleanly.
  let openFence: OpenFence = null
  let comment: { openLine: number } | null = null
  let lastClosedBlock: { startLine: number; endLine: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // Fence state advances only outside comments: inside a `%%` comment, `%%`
    // takes precedence and fence delimiters are just comment text (matching
    // Obsidian's parser). A fence-delimiter line never toggles comment state.
    if (!comment) {
      const fenceResult = advanceFence(line, openFence)
      openFence = fenceResult.openFence
      if (fenceResult.lineIsCode) continue
    }

    // Outside fences (or inside a comment): `%%` at the start or end of the
    // trimmed line toggles comment state. Mid-line `%%` (e.g. `100%%` in card
    // text) is not a delimiter and is ignored.
    const toggleCount = countCommentToggles(line)
    for (let occurrence = 0; occurrence < toggleCount; occurrence++) {
      if (comment) {
        // Validate that the closer ends its own line — otherwise the block
        // isn't cleanly separable from body text and can't be preserved.
        const validCloser = line.trimEnd().endsWith(COMMENT_DELIMITER)
        lastClosedBlock = validCloser
          ? { startLine: comment.openLine, endLine: i }
          : null
        comment = null
      } else {
        comment = { openLine: i }
      }
    }
  }

  // An unclosed comment runs to EOF and is trailing by definition. A closed
  // block is trailing only when nothing but blank lines follow it.
  const trailingBlock = comment
    ? { startLine: comment.openLine }
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
 * Single-pass heading parser for H1–H6 with code-block awareness.
 * Section body = heading+1 through next heading of same-or-higher level (or EOF).
 */
export const parseHeadings = (lines: readonly string[]): HeadingInfo[] => {
  // Phase 1: collect headings, skipping content inside fenced code blocks. Fence
  // state is threaded through advanceFence in the accumulator (no mutable
  // external state).
  const { headings: collectedHeadings } = lines.reduce<{
    headings: Array<{ text: string; level: number; startLine: number }>
    openFence: OpenFence
  }>(
    (state, line, i) => {
      const fenceResult = advanceFence(line, state.openFence)

      if (fenceResult.lineIsCode) {
        return { headings: state.headings, openFence: fenceResult.openFence }
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
          openFence: fenceResult.openFence,
        }
      }

      return { headings: state.headings, openFence: fenceResult.openFence }
    },
    { headings: [], openFence: null },
  )

  // Phase 2: compute body ranges — each section's body ends where the next
  // heading of the same or higher level starts. Sections with no such heading
  // run to EOF, but must stop before a trailing `%% %%` comment block (e.g. a
  // Kanban board's `%% kanban:settings %%`) so replace/append don't clobber it.
  const trailingCommentBlockStart = findTrailingCommentBlockStart(lines)
  return collectedHeadings.map((h, i) => {
    const nextSameOrHigher = collectedHeadings
      .slice(i + 1)
      .find((next) => next.level <= h.level)
    return {
      text: h.text,
      level: h.level,
      startLine: h.startLine,
      bodyStartLine: h.startLine + 1,
      // Math.max keeps bodyEndLine >= bodyStartLine for malformed input.
      bodyEndLine:
        nextSameOrHigher?.startLine ??
        Math.max(h.startLine + 1, trailingCommentBlockStart),
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
    (h) => h.text === searchText && (level === undefined || h.level === level),
  )

  if (matches.length === 0) {
    const availableHeadings = headings
      .map((h) => `${"#".repeat(h.level)} ${h.text}`)
      .join(", ")
    throw new Error(
      `heading not found: "${searchText}". Available headings: ${availableHeadings || "(none)"}`,
    )
  }

  if (matches.length > 1) {
    const matchedHeadings = matches
      .map((h) => `${"#".repeat(h.level)} ${h.text} (line ${h.startLine + 1})`)
      .join(", ")
    const firstMatch = matches[0]
    const allSameLevel =
      firstMatch !== undefined &&
      matches.every((h) => h.level === firstMatch.level)
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
