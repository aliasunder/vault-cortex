/** Memory-entry grammar parser — the dated-bullet format of About Me/ memory files.
 *
 * Memory files record facts as dated bullets (`- **YYYY-MM-DD**: text…`) under
 * H2 topic sections. This module parses a file's body into individual entries so
 * consumers can work at entry granularity — the search index embeds each entry
 * for `vault_memory_recall` — where the heading parser stops at section
 * granularity and the chunker (chunker.ts) deliberately merges whole sections.
 *
 * Like the task-line grammar in tasks.ts, this is a vault convention rather than
 * Obsidian-native syntax, but it lives here because it is a pure lines→data
 * transform composing the shared heading and fence/comment machinery.
 */

import { parseHeadings } from "./headings.js"
import {
  advanceComment,
  advanceFence,
  type CommentResult,
  type OpenFence,
} from "./lines.js"

// ── Types ───────────────────────────────────────────────────────

export type MemoryEntry = Readonly<{
  /** H2 heading text the entry sits under, verbatim (including any
   *  "(newest first)" suffix as written). */
  section: string
  /** The bullet's date in YYYY-MM-DD shape, exactly as written. Shape-only:
   *  a calendar-invalid date like "2026-13-45" is kept verbatim — entries
   *  exist only via hand edits or the validated write path, and dropping one
   *  would silently lose memory content. */
  date: string
  /** Raw entry markdown: the dated bullet line plus every continuation line
   *  (wrapped prose, sub-bullets, fenced code examples) up to the next entry
   *  or section boundary, with trailing blank lines trimmed. */
  text: string
  /** 0-based document order across the whole file, spanning sections. */
  entryIndex: number
}>

// ── Entry grammar ───────────────────────────────────────────────

/** Matches the first line of a dated memory entry (`- **YYYY-MM-DD**: …`) and
 *  captures the date. The bold date is the reliable anchor — entry text after
 *  the colon may contain its own `**bold**`. Same shape as memory-store's
 *  ENTRY_PATTERN, with a capture group added. */
const ENTRY_START_PATTERN = /^- \*\*(\d{4}-\d{2}-\d{2})\*\*:/

/** Matches any ATX heading line (H1–H6). Inside an H2 span this can only be a
 *  deeper heading (H3+) — parseHeadings ends the span at the next H1/H2 — and
 *  a sub-heading starts new content, so it closes the open entry rather than
 *  being absorbed as continuation text. */
const HEADING_LINE_PATTERN = /^#{1,6} /

// ── Parser ──────────────────────────────────────────────────────

/** One entry being accumulated while walking a section span. */
type OpenEntry = { date: string; textLines: string[] }

/** Closes an accumulating entry into a MemoryEntry, trimming trailing blank
 *  lines (the gap before the next entry belongs to neither). findLastIndex
 *  returns -1 when every line is blank, so +1 slices to empty — though the
 *  first line is always the dated bullet, so that case cannot arise here. */
const closeEntry = (
  openEntry: OpenEntry,
  section: string,
  entryIndex: number,
): MemoryEntry => {
  const lastContentIndex = openEntry.textLines.findLastIndex(
    (textLine) => textLine.trim() !== "",
  )
  return {
    section,
    date: openEntry.date,
    text: openEntry.textLines.slice(0, lastContentIndex + 1).join("\n"),
    entryIndex,
  }
}

/**
 * Parses a memory file's body lines into dated entries, in document order.
 *
 * Takes body lines (frontmatter already stripped — same contract as
 * parseHeadings; use splitIntoLines on parsed note content). Only H2 sections
 * hold entries, per the memory-file grammar; an H3 nested inside an H2 stays
 * within the H2's span, so its entries are still captured and attributed to
 * the H2. Prose before a section's first entry (intro text, scope callouts)
 * belongs to no entry and is ignored; every line after an entry's bullet —
 * wrapped prose, sub-bullets, fenced code — is that entry's continuation
 * until the next entry starts or the section ends.
 *
 * Fence/comment awareness works one way by design: a line that *looks* like a
 * dated bullet inside a fenced code block or `%% %%` comment never starts an
 * entry, but code and comment lines inside an entry are absorbed verbatim —
 * entries legitimately contain code examples, and text is raw markdown.
 */
export const parseMemoryEntries = (lines: readonly string[]): MemoryEntry[] => {
  const sectionSpans = parseHeadings(lines).filter(
    (heading) => heading.level === 2,
  )

  const entries: MemoryEntry[] = []
  for (const span of sectionSpans) {
    // Fence and comment state start closed at each span: parseHeadings only
    // recognizes headings outside fences/comments, so a span can never begin
    // mid-fence. The walk is inherently sequential parser state.
    let openFence: OpenFence = null
    let commentOpen = false
    let openEntry: OpenEntry | null = null

    for (
      let lineIndex = span.bodyStartLine;
      lineIndex < span.bodyEndLine;
      lineIndex++
    ) {
      const line = lines[lineIndex]
      if (line === undefined) continue

      // Fence/comment precedence, as in parseHeadings: fences advance only
      // outside comments, comment toggles run only outside fences. Explicit
      // annotations break the inference cycle through the loop-carried state.
      const fenceResult: ReturnType<typeof advanceFence> | null = commentOpen
        ? null
        : advanceFence(line, openFence)
      openFence = fenceResult !== null ? fenceResult.openFence : openFence

      const commentResult: CommentResult | null = fenceResult?.lineIsCode
        ? null
        : advanceComment(line, commentOpen)
      commentOpen =
        commentResult !== null ? commentResult.commentOpen : commentOpen

      // Inside code or a comment this line cannot START an entry, but it is
      // legitimate continuation content for one already open.
      const lineCannotStartEntry =
        (fenceResult?.lineIsCode ?? false) ||
        (commentResult?.lineIsComment ?? false)
      if (lineCannotStartEntry) {
        if (openEntry !== null) openEntry.textLines.push(line)
        continue
      }

      const entryStartMatch = ENTRY_START_PATTERN.exec(line)
      const entryDate = entryStartMatch?.[1]
      if (entryDate !== undefined) {
        if (openEntry !== null) {
          entries.push(closeEntry(openEntry, span.text, entries.length))
        }
        openEntry = { date: entryDate, textLines: [line] }
        continue
      }

      // A deeper heading (H3+) closes the open entry — it starts new content
      // within the section, not continuation text — and belongs to no entry.
      if (HEADING_LINE_PATTERN.test(line)) {
        if (openEntry !== null) {
          entries.push(closeEntry(openEntry, span.text, entries.length))
          openEntry = null
        }
        continue
      }

      // Continuation of the open entry, or pre-entry prose (ignored).
      if (openEntry !== null) openEntry.textLines.push(line)
    }

    if (openEntry !== null) {
      entries.push(closeEntry(openEntry, span.text, entries.length))
    }
  }

  return entries
}
