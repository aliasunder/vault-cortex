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
  type FenceResult,
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
   *  (wrapped prose, sub-bullets, fenced code examples) up to the next entry,
   *  a deeper heading or the section's end, with trailing blank lines trimmed. */
  text: string
  /** 0-based document order across the whole file, spanning sections. */
  entryIndex: number
  /** 0-based index of the entry's H2 heading line in the lines parsed. Two
   *  H2s with the same text have different values, so a caller holding one
   *  resolved heading picks out exactly that section's entries. */
  sectionStartLine: number
  /** 0-based index of the dated bullet line. */
  startLine: number
  /** Exclusive end index: `text` is `lines.slice(startLine, endLine).join("\n")`. */
  endLine: number
}>

// ── Entry grammar ───────────────────────────────────────────────

/** Matches the first line of a dated memory entry (`- **YYYY-MM-DD**: …`) and
 *  captures the date. The bold date is the reliable anchor — entry text after
 *  the colon may contain its own `**bold**`. */
const ENTRY_START_PATTERN = /^- \*\*(\d{4}-\d{2}-\d{2})\*\*:/

/** The date of the memory entry the line opens, as written, or undefined
 *  when the line opens no entry. The date is checked for shape only. */
export const memoryEntryLineDate = (line: string): string | undefined => {
  return ENTRY_START_PATTERN.exec(line)?.[1]
}

/** True for a file name that ends in .md twice, in any letter case, such as
 *  "Opinions.md.md".
 *  - The memory tools add .md to a bare name and refuse a name that already
 *    ends in .md, so no memory tool can reach such a file, and the memory
 *    listings and recall leave it out instead of offering its name.
 *  - The memory store and the search index both apply this rule, so it lives
 *    here with the rest of the memory-file convention. */
export const isDoubledMarkdownFileName = (fileName: string): boolean => {
  return fileName.toLowerCase().endsWith(".md.md")
}

/** Matches any ATX heading line (H1–H6) per CommonMark §4.2: 0-3 leading
 *  spaces, hashes, then a space/tab separator or end of line (empty headings
 *  are valid). Inside an H2 section's body this can only be a deeper heading
 *  (H3+) — parseHeadings ends the body at the next H1/H2 — and a sub-heading
 *  starts new content, so it closes the open entry rather than being absorbed
 *  as continuation text. */
const HEADING_LINE_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/

// ── Parser ──────────────────────────────────────────────────────

/** One entry being accumulated while walking a section's body. Its lines are
 *  contiguous from the bullet at `startLine`. */
type OpenEntry = { date: string; startLine: number; textLines: string[] }

/** Closes an accumulating entry into a MemoryEntry, trimming trailing blank
 *  lines (the gap before the next entry belongs to neither). The first line
 *  is the dated bullet, so at least that line is kept. */
const closeEntry = (params: {
  openEntry: OpenEntry
  section: Readonly<{ text: string; startLine: number }>
  entryIndex: number
}): MemoryEntry => {
  const { openEntry, section, entryIndex } = params
  const lastContentIndex = openEntry.textLines.findLastIndex((textLine) => textLine.trim() !== "")
  const keptLineCount = lastContentIndex + 1

  return {
    section: section.text,
    date: openEntry.date,
    text: openEntry.textLines.slice(0, keptLineCount).join("\n"),
    entryIndex,
    sectionStartLine: section.startLine,
    startLine: openEntry.startLine,
    endLine: openEntry.startLine + keptLineCount,
  }
}

/**
 * Parses a memory file's body lines into dated entries, in document order.
 *
 * Takes body lines (frontmatter already stripped — same contract as
 * parseHeadings; use splitIntoLines on parsed note content). Only H2 sections
 * hold entries, per the memory-file grammar; an H3 nested inside an H2 stays
 * within the H2's body, so its entries are still captured and attributed to
 * the H2. Prose before a section's first entry (intro text, scope callouts)
 * belongs to no entry and is ignored; every line after an entry's bullet —
 * wrapped prose, sub-bullets, fenced code — is that entry's continuation
 * until the next entry starts, a deeper heading opens, or the section ends.
 *
 * Fence/comment awareness works one way by design: a line that *looks* like a
 * dated bullet inside a fenced code block or `%% %%` comment never starts an
 * entry, but code and comment lines inside an entry are absorbed verbatim —
 * entries legitimately contain code examples, and text is raw markdown.
 */
export const parseMemoryEntries = (lines: readonly string[]): MemoryEntry[] => {
  const h2Sections = parseHeadings(lines).filter((heading) => heading.level === 2)

  const entries: MemoryEntry[] = []
  for (const section of h2Sections) {
    // Fence and comment state start closed at each section: parseHeadings
    // only recognizes headings outside fences/comments, so a section body can
    // never begin mid-fence. The walk is inherently sequential parser state.
    let openFence: OpenFence = null
    let commentOpen = false
    let openEntry: OpenEntry | null = null

    const bodyLines = lines.slice(section.bodyStartLine, section.bodyEndLine)

    for (const [bodyOffset, line] of bodyLines.entries()) {
      const lineIndex = section.bodyStartLine + bodyOffset

      // Fence/comment precedence follows advanceComment's contract: fences
      // advance only outside comments, comment toggles run only outside
      // fences. TypeScript cannot infer these two results' types, because
      // each depends on state the loop assigns from the other.
      const fenceResult: FenceResult | null = commentOpen ? null : advanceFence(line, openFence)

      if (fenceResult) openFence = fenceResult.openFence

      const commentResult: CommentResult | null = fenceResult?.lineIsCode
        ? null
        : advanceComment(line, commentOpen)

      if (commentResult) commentOpen = commentResult.commentOpen

      // Inside code or a comment this line cannot START an entry, but it is
      // legitimate continuation content for one already open.
      const lineCannotStartEntry =
        (fenceResult?.lineIsCode ?? false) || (commentResult?.lineIsComment ?? false)

      if (lineCannotStartEntry) {
        if (openEntry !== null) openEntry.textLines.push(line)
        continue
      }

      const entryDate = memoryEntryLineDate(line)

      if (entryDate) {
        if (openEntry !== null) {
          entries.push(closeEntry({ openEntry, section, entryIndex: entries.length }))
        }
        openEntry = { date: entryDate, startLine: lineIndex, textLines: [line] }
        continue
      }

      // A deeper heading (H3+) closes the open entry — it starts new content
      // within the section, not continuation text — and belongs to no entry.
      if (HEADING_LINE_PATTERN.test(line)) {
        if (openEntry !== null) {
          entries.push(closeEntry({ openEntry, section, entryIndex: entries.length }))
          openEntry = null
        }
        continue
      }

      // Continuation of the open entry, or pre-entry prose (ignored).
      if (openEntry !== null) openEntry.textLines.push(line)
    }

    if (openEntry !== null) {
      entries.push(closeEntry({ openEntry, section, entryIndex: entries.length }))
    }
  }

  return entries
}
