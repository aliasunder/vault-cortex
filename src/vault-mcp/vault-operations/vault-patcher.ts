/** Surgical note editing — heading-targeted patches, find-and-replace, and
 *  anchor-targeted line spans (delete, replace, insert). */

import {
  findBodyStartLine,
  joinNoteKeepingBlock,
  splitNoteKeepingBlock,
} from "../obsidian-markdown/frontmatter.js"
import { resolveSafePath, atomicWriteFile } from "./vault-filesystem.js"
import { assertNoControlCharacters } from "../../utils/assert-no-control-characters.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { readFileOrNull } from "../../utils/fs.js"
import { truncateToCodePointLimit } from "../../utils/truncate-to-code-point-limit.js"
import { withExclusiveFileLock } from "../../utils/file-write-lock.js"
import {
  parseHeadings,
  findHeading,
  linesBeforeFirstHeading,
  type HeadingInfo,
} from "../obsidian-markdown/headings.js"
import {
  splitIntoLines,
  trimBlankEdgeLines,
  collapseEmptyLineRunsAtEdits,
  type EmptyLineEdit,
} from "../obsidian-markdown/lines.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

type Operation = "append" | "prepend" | "replace" | "insert_before"

/** The note's first heading before a patch — enough for a caller to name it as
 *  a placement target. */
type PatchedNoteFirstHeading = Readonly<{
  text: string
  level: number
}>

/** Facts about a no-heading `prepend` that inserted a heading above content
 *  already sitting at the top of the body — that content is now the new
 *  section's body. `firstHeading` is the heading a section could be placed
 *  above instead, or null when the note had none (its whole body was pulled in).
 *  The write still happened; this is advisory, not a rejection. */
export type DisplacedLeadingContent = Readonly<{
  bytes: number
  firstHeading: PatchedNoteFirstHeading | null
}>

/** What a completed patch reports — the confirmation line, plus displacement
 *  facts when the write nested pre-existing content inside a newly inserted
 *  heading. */
type PatchNoteResult = Readonly<{
  message: string
  displacedLeadingContent: DisplacedLeadingContent | null
}>

// ── Internal helpers ────────────────────────────────────────────

/** The heading a content block begins with — the heading on its first non-blank
 *  line (blank: empty or whitespace only) — or null when that line is not a
 *  heading or every line is blank. parseHeadings makes this fence-aware, so a
 *  `## foo` inside an opening code fence is not a heading. */
const leadingHeadingOfContent = (contentLines: readonly string[]): HeadingInfo | null => {
  const firstNonBlankLineIndex = contentLines.findIndex((line) => line.trim() !== "")

  if (firstNonBlankLineIndex === -1) return null
  return (
    parseHeadings(contentLines).find(
      (contentHeading) => contentHeading.startLine === firstNonBlankLineIndex,
    ) ?? null
  )
}

/** What a heading-led, no-heading prepend would swallow: the body above the
 *  note's first heading, which the inserted heading now owns. Null when nothing
 *  sits there (the common, safe case) — including when the note's very first
 *  line is a heading, where a prepended heading of any level terminates at it
 *  and displaces nothing. */
const findDisplacedLeadingContent = (lines: readonly string[]): DisplacedLeadingContent | null => {
  const headings = parseHeadings(lines)
  const regionLines = trimBlankEdgeLines(linesBeforeFirstHeading(lines, headings))

  if (regionLines.length === 0) return null
  const firstHeading = headings[0]
  return {
    bytes: Buffer.byteLength(regionLines.join("\n"), "utf8"),
    firstHeading: firstHeading ? { text: firstHeading.text, level: firstHeading.level } : null,
  }
}

/** Splices new content into a line array at the position determined by operation and target. */
const applySectionOperation = (
  lines: readonly string[],
  contentLines: readonly string[],
  target: HeadingInfo,
  operation: Operation,
): string[] => {
  switch (operation) {
    case "append":
      return [
        ...lines.slice(0, target.bodyEndLine),
        ...contentLines,
        ...lines.slice(target.bodyEndLine),
      ]
    case "prepend":
      return [
        ...lines.slice(0, target.bodyStartLine),
        ...contentLines,
        ...lines.slice(target.bodyStartLine),
      ]
    case "replace":
      return [
        ...lines.slice(0, target.bodyStartLine),
        ...contentLines,
        ...lines.slice(target.bodyEndLine),
      ]
    case "insert_before":
      return [
        ...lines.slice(0, target.startLine),
        ...contentLines,
        ...lines.slice(target.startLine),
      ]
  }
}

/** Reads a note for a body edit: the text before its body (the properties
 *  block, with LF line breaks), which the edit writes back without parsing,
 *  and its body lines. */
const readNoteForPatch = async (
  vaultPath: string,
  path: string,
): Promise<{
  fullPath: string
  textBeforeBody: string
  lines: string[]
  /** The 0-based file line `lines` starts on, so messages can name file lines. */
  bodyStartFileLine: number
  /** Raw on-disk file bytes — used for before/after size logging. */
  beforeBytes: number
}> => {
  assertPathHasExtension(path, ".md")
  const fullPath = resolveSafePath(vaultPath, path)
  const fileContent = await readFileOrNull(fullPath)

  if (fileContent === null) {
    throw new Error(`note not found: "${path}"`)
  }
  const { textBeforeBody, body } = splitNoteKeepingBlock(fileContent)
  return {
    fullPath,
    textBeforeBody,
    // splitIntoLines normalizes CRLF-authored (Windows) notes to LF-only lines
    // so body matching and the empty-line handling after an edit stay
    // consistent, and the note is rewritten as LF.
    lines: splitIntoLines(body),
    bodyStartFileLine: findBodyStartLine(fileContent),
    beforeBytes: Buffer.byteLength(fileContent, "utf8"),
  }
}

/** Writes the edited body back under the note's original properties block
 *  (atomically). Returns the serialized byte length for size logging. */
const writePatchedNote = async (
  fullPath: string,
  textBeforeBody: string,
  lines: readonly string[],
  logger: Logger,
): Promise<number> => {
  const serialized = joinNoteKeepingBlock({ textBeforeBody, body: lines.join("\n") })
  await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)
  return Buffer.byteLength(serialized, "utf8")
}

/** Truncates anchor/preview text to 80 characters to keep error messages and
 *  confirmations short. */
const truncateForMessage = (text: string): string => {
  const preview = truncateToCodePointLimit(text, 80)

  return preview.length < text.length ? preview + "…" : text
}

// ── Gap measurement for collapseEmptyLineRunsAtEdits ────────────

/** Empty lines at the start of `lines`, or all of them when none holds text. */
const countLeadingEmptyLines = (lines: readonly string[]): number => {
  const firstTextIndex = lines.findIndex((line) => line !== "")

  return firstTextIndex === -1 ? lines.length : firstTextIndex
}

/** Empty lines at the end of `lines`, or all of them when none holds text. */
const countTrailingEmptyLines = (lines: readonly string[]): number => {
  const lastTextIndex = lines.findLastIndex((line) => line !== "")

  return lastTextIndex === -1 ? lines.length : lines.length - 1 - lastTextIndex
}

/** Consecutive line breaks in `text` that end just before index `end`. */
const countLineBreaksEndingAt = (text: string, end: number): number => {
  // A cursor walks back one character at a time, so the cost is the run's
  // length rather than the text's; callers measure a run at every match.
  let start = end
  while (start > 0 && text[start - 1] === "\n") {
    start--
  }
  return end - start
}

/** Consecutive line breaks in `text` that start at index `start`. */
const countLineBreaksStartingAt = (text: string, start: number): number => {
  // A cursor walks forward one character at a time, so the cost is the run's
  // length rather than the text's; callers measure a run at every match.
  let end = start
  while (end < text.length && text[end] === "\n") {
    end++
  }
  return end - start
}

/** Empty lines that a run of line breaks puts between a match and the text
 *  beyond the run. Between two lines of text, n breaks leave n − 1 empty lines
 *  (`A\n\nB` has one); with only the body's edge beyond the run, all n count. */
const countEmptyLinesInBreaks = (params: {
  lineBreaks: number
  hasTextBeyond: boolean
}): number => {
  const breaksEndingText = params.hasTextBeyond ? 1 : 0

  return Math.max(0, params.lineBreaks - breaksEndingText)
}

/** A run of consecutive line breaks in a string, as a half-open offset range. */
type LineBreakRun = Readonly<{ start: number; end: number }>

/** Edit points for a `replaceInNote` deletion. `bodyParts` is the body split at
 *  every removed match, so `bodyParts.join(removedText)` is the original body.
 *  - Every line break is a single `\n`: the body comes from splitIntoLines, and
 *    replaceInNote converts old_text's `\r\n` breaks before matching.
 *  - Only a match whose removal leaves an empty line where it sat gets an edit
 *    point; any other removal is written exactly as asked.
 *  - Each gap counts the empty lines between the match's text and the nearest
 *    text on that side of the original body. */
const listTextDeletionEdits = (params: {
  body: string
  bodyParts: readonly string[]
  removedText: string
}): EmptyLineEdit[] => {
  const { body, bodyParts, removedText } = params

  const updatedBody = bodyParts.join("")
  const removedLeadingBreaks = countLineBreaksStartingAt(removedText, 0)
  const removedTrailingBreaks = countLineBreaksEndingAt(removedText, removedText.length)
  const edits: EmptyLineEdit[] = []

  // Matches made only of line breaks all sit in one run of them, so a position
  // inside the last run measured reuses it; rescanning the run for every match
  // would be quadratic in its length. Starts as an empty range before the body.
  let lastLineBreakRun: LineBreakRun = { start: -1, end: -1 }
  /** The run of line breaks in `body` around `position`. Reuses the last run
   *  measured when `position` falls inside it, and remembers each new one. */
  const findLineBreakRunAt = (position: number): LineBreakRun => {
    // The run found around a position always has start <= position <= end, so
    // a position at either end of the last run measures that same run.
    const isInLastRun = position >= lastLineBreakRun.start && position <= lastLineBreakRun.end

    if (isInLastRun) return lastLineBreakRun
    lastLineBreakRun = {
      start: position - countLineBreaksEndingAt(body, position),
      end: position + countLineBreaksStartingAt(body, position),
    }
    return lastLineBreakRun
  }

  // The last part has no match after it.
  const partsBeforeMatches = bodyParts.slice(0, -1)

  // Each match's position depends on every part before it, so the walk carries
  // two running totals; recomputing them per match would be quadratic in
  // matches. They locate the point where the removed match's two sides meet,
  // as an offset into updatedBody and as the index of its updated line.
  let updatedBodyOffset = 0
  let updatedLineIndex = 0
  for (const [earlierMatchCount, partBeforeMatch] of partsBeforeMatches.entries()) {
    updatedBodyOffset += partBeforeMatch.length
    updatedLineIndex += partBeforeMatch.split("\n").length - 1

    // The removal leaves an empty line when a line break or the body's edge
    // sits on both sides of the point where the match was.
    const startsLine = updatedBodyOffset === 0 || updatedBody[updatedBodyOffset - 1] === "\n"
    const endsLine =
      updatedBodyOffset === updatedBody.length || updatedBody[updatedBodyOffset] === "\n"
    const leavesEmptyLine = startsLine && endsLine

    if (!leavesEmptyLine) continue

    // Offsets into the original body add back the text of every earlier match.
    const matchStart = updatedBodyOffset + earlierMatchCount * removedText.length
    const matchEnd = matchStart + removedText.length
    const breaksAboveMatch = matchStart - findLineBreakRunAt(matchStart).start
    const breaksBelowMatch = findLineBreakRunAt(matchEnd).end - matchEnd
    const hasTextAboveRun = breaksAboveMatch < matchStart
    const hasTextBelowRun = matchEnd + breaksBelowMatch < body.length

    // - Each gap is measured to the match's text, not its edge, so line breaks
    //   at the match's own start or end count toward the gap they sat in.
    // - A match made only of line breaks counts them on both sides. Its gap
    //   below then covers every break from the match to the end of its run,
    //   more than the removal leaves there, so none of that run is dropped:
    //   removing `\n\n` from the start of `\n\n\n\nB` leaves two empty lines,
    //   and the gap below counts three.
    edits.push({
      boundary: updatedLineIndex,
      gapAbove: countEmptyLinesInBreaks({
        lineBreaks: breaksAboveMatch + removedLeadingBreaks,
        hasTextBeyond: hasTextAboveRun,
      }),
      gapBelow: countEmptyLinesInBreaks({
        lineBreaks: removedTrailingBreaks + breaksBelowMatch,
        hasTextBeyond: hasTextBelowRun,
      }),
    })
  }
  return edits
}

/** Resolves an anchor substring to the single body line that contains it,
 *  searching at or after `fromLine`. The match must be unique by default:
 *  throws a not-found error on no match, or an ambiguous error on more than
 *  one — unless `firstMatch` allows taking the first. `role` labels the error
 *  messages ("start"/"end") and notes the end anchor's restricted search;
 *  omit it for a single-anchor tool where the qualifier would be misleading. */
const resolveAnchorLine = (params: {
  lines: readonly string[]
  anchor: string
  fromLine: number
  firstMatch: boolean | undefined
  path: string
  role?: "start" | "end"
}): number => {
  const { lines, anchor, fromLine, firstMatch, path, role } = params
  const anchorLabel = role ? `${role} anchor` : "anchor"
  // Anchors get no line-break conversion, unlike old_text: an anchor is part
  // of one line, so a line break in it would match no line either way.
  const matchingLineIndices = lines.flatMap((line, index) => {
    return index >= fromLine && line.includes(anchor) ? [index] : []
  })
  // The end anchor is searched only at or after the start line; its errors say so.
  const regionSuffix = role === "end" ? " at or after the start anchor" : ""

  const matchedIndex = matchingLineIndices[0]

  if (matchedIndex === undefined) {
    throw new Error(
      `${anchorLabel} not found in "${path}"${regionSuffix}: "${truncateForMessage(anchor)}"`,
    )
  }
  if (matchingLineIndices.length > 1 && !firstMatch) {
    throw new Error(
      `ambiguous ${anchorLabel} in "${path}": "${truncateForMessage(anchor)}" matches ${matchingLineIndices.length} lines${regionSuffix}`,
    )
  }
  return matchedIndex
}

/** Resolves the inclusive line range of a span: `startAnchor` locates the
 *  first line; `endAnchor`, when given, locates the last line at or after it —
 *  omitted, the span is just the start line. */
const resolveSpanLines = (params: {
  lines: readonly string[]
  startAnchor: string
  endAnchor: string | undefined
  firstMatch: boolean | undefined
  path: string
}): { startLine: number; endLine: number } => {
  const { lines, startAnchor, endAnchor, firstMatch, path } = params
  const startLine = resolveAnchorLine({
    lines,
    anchor: startAnchor,
    fromLine: 0,
    firstMatch,
    path,
    role: "start",
  })

  if (endAnchor === undefined) {
    return { startLine, endLine: startLine }
  }
  const endLine = resolveAnchorLine({
    lines,
    anchor: endAnchor,
    fromLine: startLine,
    firstMatch,
    path,
    role: "end",
  })
  return { startLine, endLine }
}

// ── Exported functions ──────────────────────────────────────────

/** Edits the section under a target heading by one of four operations — append,
 *  prepend, replace, or insert_before. */
const patchNote = async (
  params: {
    vaultPath: string
    path: string
    operation: Operation
    content: string
    heading?: string | undefined
    headingLevel?: number | undefined
    includeChildren?: boolean | undefined
  },
  logger: Logger,
): Promise<PatchNoteResult> => {
  const { path, operation, content, heading, headingLevel, includeChildren } = params
  assertNoControlCharacters(content, "content")
  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, textBeforeBody, lines, bodyStartFileLine, beforeBytes } =
      await readNoteForPatch(params.vaultPath, path)
    // The control-character check allows `\r`, so content may hold `\r\n`
    // breaks; splitIntoLines turns them into the LF lines the body uses.
    const contentLines = splitIntoLines(content)

    // File-level operation (no heading target)
    if (!heading) {
      if (operation === "replace" || operation === "insert_before") {
        throw new Error(`operation "${operation}" requires a heading target`)
      }

      // A no-heading prepend inserts at body line 0. When the inserted block
      // starts with a heading and the note already has content above its first
      // heading, that content silently becomes the new section's body. The write
      // is what was asked for, so report it rather than reject it. Guards run
      // cheapest-first: only a heading-led prepend pays for the body parse.
      // Detection runs on the pre-patch lines — afterwards the note's first
      // heading is the inserted one.
      const insertsLeadingHeading =
        operation === "prepend" && leadingHeadingOfContent(contentLines) !== null
      const displacedLeadingContent = insertsLeadingHeading
        ? findDisplacedLeadingContent(lines)
        : null

      const updatedLines =
        operation === "append" ? [...lines, ...contentLines] : [...contentLines, ...lines]
      const afterBytes = await writePatchedNote(fullPath, textBeforeBody, updatedLines, logger)
      logger.info("patched note", {
        path,
        operation,
        target: "file body",
        beforeBytes,
        afterBytes,
        displacedBytes: displacedLeadingContent?.bytes,
      })
      return {
        message: `Applied ${operation} to ${path} → file body`,
        displacedLeadingContent,
      }
    }

    // Section-level operation
    const headings = parseHeadings(lines)
    const target = findHeading({
      headings,
      text: heading,
      level: headingLevel,
      bodyStartFileLine,
    })
    const targetDesc = `${"#".repeat(target.level)} ${target.text}`

    // Heading-targeted ops keep the matched heading, so a content that begins
    // with that same heading would duplicate it. Reject with remediation rather
    // than silently doubling it.
    const leadingContentHeading = leadingHeadingOfContent(contentLines)
    const contentRepeatsTargetHeading =
      leadingContentHeading !== null &&
      leadingContentHeading.level === target.level &&
      leadingContentHeading.text === target.text

    if (contentRepeatsTargetHeading) {
      throw new Error(
        `content begins with the heading "${targetDesc}", which would duplicate it — ` +
          `heading-targeted ops keep the matched heading, so omit the heading line from content.`,
      )
    }

    // Replace on a section with child headings requires explicit opt-in —
    // without it, the caller may not realize children will be destroyed.
    if (operation === "replace" && !includeChildren) {
      // A section's body runs to the next heading of the same or higher level,
      // so every heading inside that range is a child of the target.
      const childHeadings = headings.filter((candidate) => {
        return (
          candidate.startLine >= target.bodyStartLine && candidate.startLine < target.bodyEndLine
        )
      })

      if (childHeadings.length > 0) {
        const childList = childHeadings.map((child) => child.text).join(", ")
        const noun = childHeadings.length === 1 ? "child heading" : "child headings"
        throw new Error(
          `section "${targetDesc}" has ${childHeadings.length} ${noun} (${childList})`,
        )
      }
    }

    const updatedLines = applySectionOperation(lines, contentLines, target, operation)

    const afterBytes = await writePatchedNote(fullPath, textBeforeBody, updatedLines, logger)
    logger.info("patched note", {
      path,
      operation,
      target: targetDesc,
      beforeBytes,
      afterBytes,
    })
    return {
      message: `Applied ${operation} to ${path} → ${targetDesc}`,
      displacedLeadingContent: null,
    }
  })
}

/** Find-and-replace within a note's body. */
const replaceInNote = async (
  params: {
    vaultPath: string
    path: string
    oldText: string
    newText: string
    replaceAllOccurrences?: boolean | undefined
  },
  logger: Logger,
): Promise<{ message: string; count: number }> => {
  const { path, oldText, newText, replaceAllOccurrences } = params

  if (oldText === "") {
    throw new Error("oldText cannot be empty")
  }
  // Only new_text is written to the note; old_text is only matched against it
  assertNoControlCharacters(newText, "new_text")

  // The body is matched with LF line breaks (readNoteForPatch splits it with
  // splitIntoLines), so old_text's `\r\n` breaks become `\n` too:
  // - text copied from a raw read of a CRLF note then matches;
  // - replaceAll never empties a non-empty string, unlike splitIntoLines, which
  //   would turn old_text "\r" into "", a search text that matches at offset 0.
  const searchText = oldText.replaceAll("\r\n", "\n")

  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, textBeforeBody, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )

    const body = lines.join("\n")
    const firstMatchOffset = body.indexOf(searchText)

    // The message quotes the text the caller sent, before line-break conversion
    if (firstMatchOffset === -1) {
      throw new Error(`text not found in "${path}": "${truncateForMessage(oldText)}"`)
    }

    const bodyParts = replaceAllOccurrences
      ? body.split(searchText)
      : [body.slice(0, firstMatchOffset), body.slice(firstMatchOffset + searchText.length)]
    const count = bodyParts.length - 1
    // Split as patchNote, replaceSpan and insertAtAnchor split content: a `\r`
    // the edit leaves before a line break is dropped, one inside a line stays
    const updatedLines = splitIntoLines(bodyParts.join(newText))

    // A deletion stacks the empty lines from both sides of each match into one
    // run, so that run is shrunk back. A replacement keeps new text between
    // them, and its line breaks are written where the caller put them. A
    // new_text of "\r" is dropped before a line break, but is not a deletion
    // the caller asked for.
    const isDeletion = newText === ""
    const writtenLines = isDeletion
      ? collapseEmptyLineRunsAtEdits({
          lines: updatedLines,
          edits: listTextDeletionEdits({ body, bodyParts, removedText: searchText }),
        })
      : updatedLines

    const afterBytes = await writePatchedNote(fullPath, textBeforeBody, writtenLines, logger)
    logger.info("replaced in note", { path, count, beforeBytes, afterBytes })
    return {
      message: `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${path}`,
      count,
    }
  })
}

/** Deletes a contiguous block of whole lines from a note's body, identified by
 *  short anchor substrings rather than the block's full text — so a large block
 *  can be removed without reproducing it.
 *
 *  `startAnchor` resolves to the single line containing it (unique unless
 *  `firstMatch`). `endAnchor`, when given, resolves to the single line containing
 *  it at or after the start line; omitted, the span is just the start line. The
 *  span covers whole lines, inclusive, and the removed block is reported back. */
const deleteSpan = async (
  params: {
    vaultPath: string
    path: string
    startAnchor: string
    endAnchor?: string | undefined
    firstMatch?: boolean | undefined
  },
  logger: Logger,
): Promise<string> => {
  const { path, startAnchor, endAnchor, firstMatch } = params

  if (startAnchor === "") {
    throw new Error("startAnchor cannot be empty")
  }
  if (endAnchor === "") {
    throw new Error("endAnchor cannot be empty")
  }

  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, textBeforeBody, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )

    const { startLine, endLine } = resolveSpanLines({
      lines,
      startAnchor,
      endAnchor,
      firstMatch,
      path,
    })

    const removedLines = lines.slice(startLine, endLine + 1)
    const remainingLines = lines.toSpliced(startLine, removedLines.length)

    // Anchors are non-empty, so they never match an empty line: the empty lines
    // around the span stay behind and meet at startLine, and that joined run
    // keeps the wider side's count.
    const writtenLines = collapseEmptyLineRunsAtEdits({
      lines: remainingLines,
      edits: [
        {
          boundary: startLine,
          gapAbove: countTrailingEmptyLines(lines.slice(0, startLine)),
          gapBelow: countLeadingEmptyLines(lines.slice(endLine + 1)),
        },
      ],
    })
    const afterBytes = await writePatchedNote(fullPath, textBeforeBody, writtenLines, logger)

    logger.info("deleted span", {
      path,
      startAnchor: truncateForMessage(startAnchor),
      endAnchor: endAnchor ? truncateForMessage(endAnchor) : undefined,
      removedLines: removedLines.length,
      beforeBytes,
      afterBytes,
    })
    const lineWord = removedLines.length === 1 ? "line" : "lines"
    return `Deleted ${removedLines.length} ${lineWord} from ${path}: "${truncateForMessage(removedLines.join("\n"))}"`
  })
}

/** Replaces a contiguous block of whole lines identified by anchor substrings
 *  with new content — same anchor semantics as `deleteSpan`, but splices in
 *  replacement content instead of just removing. */
const replaceSpan = async (
  params: {
    vaultPath: string
    path: string
    startAnchor: string
    endAnchor?: string | undefined
    content: string
    firstMatch?: boolean | undefined
  },
  logger: Logger,
): Promise<string> => {
  const { path, startAnchor, endAnchor, content, firstMatch } = params

  if (startAnchor === "") {
    throw new Error("startAnchor cannot be empty")
  }
  if (endAnchor === "") {
    throw new Error("endAnchor cannot be empty")
  }
  if (content === "") {
    throw new Error("content cannot be empty")
  }
  assertNoControlCharacters(content, "content")

  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, textBeforeBody, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )

    const { startLine, endLine } = resolveSpanLines({
      lines,
      startAnchor,
      endAnchor,
      firstMatch,
      path,
    })

    const replacedLineCount = endLine - startLine + 1
    // splitIntoLines turns content's `\r\n` breaks into the LF lines the body uses
    const contentLines = splitIntoLines(content)
    const updatedLines = lines.toSpliced(startLine, replacedLineCount, ...contentLines)

    // Content is a side of both edits: its leading empty lines meet the note's
    // empty lines above the old span, and its trailing ones meet those below.
    // Each joined run keeps the wider side's count, and the content's interior
    // is written as given. Both boundaries index updatedLines before any run
    // is collapsed.
    const writtenLines = collapseEmptyLineRunsAtEdits({
      lines: updatedLines,
      edits: [
        {
          boundary: startLine,
          gapAbove: countTrailingEmptyLines(lines.slice(0, startLine)),
          gapBelow: countLeadingEmptyLines(contentLines),
        },
        {
          boundary: startLine + contentLines.length,
          gapAbove: countTrailingEmptyLines(contentLines),
          gapBelow: countLeadingEmptyLines(lines.slice(endLine + 1)),
        },
      ],
    })
    const afterBytes = await writePatchedNote(fullPath, textBeforeBody, writtenLines, logger)

    logger.info("replaced span", {
      path,
      startAnchor: truncateForMessage(startAnchor),
      endAnchor: endAnchor ? truncateForMessage(endAnchor) : undefined,
      replacedLines: replacedLineCount,
      insertedLines: contentLines.length,
      beforeBytes,
      afterBytes,
    })
    const replacedWord = replacedLineCount === 1 ? "line" : "lines"
    const insertedWord = contentLines.length === 1 ? "line" : "lines"
    return `Replaced ${replacedLineCount} ${replacedWord} with ${contentLines.length} ${insertedWord} in ${path}`
  })
}

/** Inserts content before or after a specific line identified by a short
 *  anchor substring — same resolution as `deleteSpan`, but adds content
 *  without removing the anchor line. */
const insertAtAnchor = async (
  params: {
    vaultPath: string
    path: string
    anchor: string
    position: "before" | "after"
    content: string
    firstMatch?: boolean | undefined
  },
  logger: Logger,
): Promise<string> => {
  const { path, anchor, position, content, firstMatch } = params

  if (anchor === "") {
    throw new Error("anchor cannot be empty")
  }
  if (content === "") {
    throw new Error("content cannot be empty")
  }
  assertNoControlCharacters(content, "content")

  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, textBeforeBody, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )

    const anchorLine = resolveAnchorLine({
      lines,
      anchor,
      fromLine: 0,
      firstMatch,
      path,
    })

    // splitIntoLines turns content's `\r\n` breaks into the LF lines the body uses
    const contentLines = splitIntoLines(content)
    const insertIndex = position === "before" ? anchorLine : anchorLine + 1
    const updatedLines = lines.toSpliced(insertIndex, 0, ...contentLines)

    // No empty-line collapse, unlike the span edits: no text is removed, so no
    // two runs of the note's empty lines end up touching, and the content's
    // own empty lines are written as given.
    const afterBytes = await writePatchedNote(fullPath, textBeforeBody, updatedLines, logger)

    logger.info("inserted at anchor", {
      path,
      anchor: truncateForMessage(anchor),
      position,
      insertedLines: contentLines.length,
      beforeBytes,
      afterBytes,
    })
    const lineWord = contentLines.length === 1 ? "line" : "lines"
    return `Inserted ${contentLines.length} ${lineWord} ${position} anchor in ${path}`
  })
}

export const vaultPatcher = {
  patchNote,
  replaceInNote,
  deleteSpan,
  replaceSpan,
  insertAtAnchor,
}
