/** Markdown leading-callout parser — extracts the first callout block at the
 * top of a note body (an info/warning/etc. block flagging context or state),
 * so it can be surfaced cheaply
 * (outline, discovery, search) without reading the whole file.
 *
 * A "leading callout" is the first Obsidian callout block appearing before any
 * other body content, allowing a single optional H1 title line above it. This
 * covers both "callout immediately after frontmatter" and "callout right after
 * the H1" (the About Me/ memory-file pattern). Frontmatter is assumed already
 * stripped by the caller (parseNote), matching headings.ts.
 */

// ── Types ───────────────────────────────────────────────────────

export type LeadingCallout = Readonly<{
  type: string
  title: string
  body: string
}>

// ── Internal regexes ────────────────────────────────────────────

/** Matches a callout opener line `> [!type] Title`: captures the type, an
 *  optional fold marker (+/-), and the (possibly empty) title. */
const CALLOUT_OPENER_REGEX = /^>\s*\[!([A-Za-z][\w-]*)\]([+-]?)\s*(.*)$/

/** Matches any blockquote/callout body line `> text` (one optional space). A
 *  blank line has no `>` and so does not match — it ends the callout body. */
const CALLOUT_BODY_REGEX = /^>\s?(.*)$/

/** Matches an H1 heading line (`# Title`). Only one leading H1 is skipped. */
const H1_REGEX = /^# .+$/

/**
 * Returns the index of the first body line — the first line that is neither
 * blank nor the note's single leading H1 title. Returns lines.length when no
 * such line exists (an empty, blank-only, or H1-only note).
 *
 * `index` and `skippedH1` are recursion accumulators; callers pass neither.
 */
const firstBodyLineIndex = (
  lines: readonly string[],
  index = 0,
  skippedH1 = false,
): number => {
  if (index >= lines.length) return index
  const line = lines[index]
  if (line === undefined) return index
  if (line.trim() === "") return firstBodyLineIndex(lines, index + 1, skippedH1)
  if (!skippedH1 && H1_REGEX.test(line))
    return firstBodyLineIndex(lines, index + 1, true)
  return index
}

// ── Exported parser ─────────────────────────────────────────────

/**
 * Returns the note's leading callout, or null when the first body content is
 * not a callout. Walks from the top, skipping blank lines and at most one H1
 * title line; the next non-blank line must be a callout opener (so a leading
 * code fence or prose yields null). The body is the run of following `>` lines,
 * stopping at the next callout opener (a stacked sibling callout), the first
 * non-blockquote line, or EOF.
 */
export const parseLeadingCallout = (
  lines: readonly string[],
): LeadingCallout | null => {
  // Callers split on "\n", so a CRLF (Windows-authored) file leaves a trailing
  // "\r" on each line. `.` never matches "\r" and a non-multiline `$` only
  // anchors at end-of-input, so a stray "\r" would defeat the regexes below
  // (and leak into the captured body) — strip it once, up front.
  const normalizedLines = lines.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  )

  // Find where the first real body content begins (past blank lines + one H1).
  const cursor = firstBodyLineIndex(normalizedLines)

  const openerLine = normalizedLines[cursor]
  const openerMatch =
    openerLine !== undefined ? CALLOUT_OPENER_REGEX.exec(openerLine) : null
  if (!openerMatch) return null

  const capturedType = openerMatch[1]
  const capturedTitle = openerMatch[3]
  if (capturedType === undefined || capturedTitle === undefined) return null
  const type = capturedType.toLowerCase()
  const title = capturedTitle.trim()

  // Body = consecutive `>` lines after the opener, until the next callout
  // opener (stacked callout), a non-blockquote line (incl. a blank line), or EOF.
  const afterOpener = normalizedLines.slice(cursor + 1)
  const stopIndex = afterOpener.findIndex(
    (line) => CALLOUT_OPENER_REGEX.test(line) || !CALLOUT_BODY_REGEX.test(line),
  )
  const bodyRange =
    stopIndex === -1 ? afterOpener : afterOpener.slice(0, stopIndex)
  const bodyLines = bodyRange.map(
    (line) => CALLOUT_BODY_REGEX.exec(line)?.[1] ?? "",
  )

  // Drop trailing blank body lines so the body ends cleanly.
  const lastContentIndex = bodyLines.findLastIndex((line) => line.trim() !== "")
  const body = bodyLines.slice(0, lastContentIndex + 1).join("\n")

  return { type, title, body }
}
