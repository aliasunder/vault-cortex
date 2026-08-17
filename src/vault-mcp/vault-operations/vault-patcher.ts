/** Surgical note editing — heading-targeted patches and find-and-replace. */

import { readFile } from "node:fs/promises"
import { parseNote, stringifyNote } from "../obsidian-markdown/frontmatter.js"
import { resolveSafePath, atomicWriteFile } from "./vault-filesystem.js"
import { assertNoControlCharacters } from "../../utils/assert-no-control-characters.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { withExclusiveFileLock } from "../../utils/file-write-lock.js"
import {
  parseHeadings,
  findHeading,
  findTrailingCommentBlockStart,
  linesBeforeFirstHeading,
  type HeadingInfo,
} from "../obsidian-markdown/headings.js"
import {
  splitIntoLines,
  trimBlankEdgeLines,
} from "../obsidian-markdown/lines.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

type Operation = "append" | "prepend" | "replace" | "insert_before"

/** The note's first heading before a patch — enough for a caller to name it as
 *  a placement target. */
export type PatchedNoteFirstHeading = Readonly<{
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

/** A completed patch: the confirmation line, plus displacement facts when the
 *  write nested pre-existing content inside a newly inserted heading. */
export type PatchNoteResult = Readonly<{
  message: string
  displacedLeadingContent: DisplacedLeadingContent | null
}>

// ── Internal helpers ────────────────────────────────────────────

/** The heading a content block begins with — the heading on its first non-blank
 *  line — or null when it starts with anything else. parseHeadings makes this
 *  fence-aware, so a `## foo` inside an opening code fence is not a heading.
 *
 *  Strips a trailing CR before parsing: HEADING_REGEX uses `(.*)` where `.`
 *  excludes CR, so a CRLF-authored `## New\r` would otherwise read as ordinary
 *  text and report nothing. Detection only — callers insert the caller's own
 *  lines verbatim, line endings untouched. */
const leadingHeadingOfContent = (
  contentLines: readonly string[],
): HeadingInfo | null => {
  const normalizedLines = contentLines.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  )
  const firstContentLineIndex = normalizedLines.findIndex(
    (line) => line.trim() !== "",
  )
  return (
    parseHeadings(normalizedLines).find(
      (contentHeading) => contentHeading.startLine === firstContentLineIndex,
    ) ?? null
  )
}

/** What a heading-led, no-heading prepend would swallow: the body above the
 *  note's first heading, which the inserted heading now owns. Null when nothing
 *  sits there (the common, safe case) — including when the note's very first
 *  line is a heading, where a prepended heading of any level terminates at it
 *  and displaces nothing. */
const findDisplacedLeadingContent = (
  lines: readonly string[],
): DisplacedLeadingContent | null => {
  const headings = parseHeadings(lines)
  const regionLines = trimBlankEdgeLines(
    linesBeforeFirstHeading(lines, headings),
  )
  if (regionLines.length === 0) return null
  const firstHeading = headings[0]
  return {
    bytes: Buffer.byteLength(regionLines.join("\n"), "utf8"),
    firstHeading: firstHeading
      ? { text: firstHeading.text, level: firstHeading.level }
      : null,
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

/** Reads a note, returning parsed frontmatter data and content lines. */
const readNoteForPatch = async (
  vaultPath: string,
  path: string,
): Promise<{
  fullPath: string
  data: Record<string, unknown>
  lines: string[]
  /** Raw on-disk file bytes — used for before/after size logging. */
  beforeBytes: number
}> => {
  assertPathHasExtension(path, ".md")
  const fullPath = resolveSafePath(vaultPath, path)
  try {
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = parseNote(fileContent)
    return {
      fullPath,
      data: parsed.data,
      // splitIntoLines normalizes CRLF-authored (Windows) notes to LF-only lines
      // so body matching and blank-run collapse (collapseBlankRuns) stay
      // consistent, and the note is rewritten as LF.
      lines: splitIntoLines(parsed.content),
      beforeBytes: Buffer.byteLength(fileContent, "utf8"),
    }
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) {
      throw new Error(`note not found: "${path}"`, { cause: err })
    }
    throw err
  }
}

/** Writes modified content back with preserved frontmatter (atomically).
 *  Returns the serialized byte length for size logging. */
const writePatchedNote = async (
  fullPath: string,
  data: Record<string, unknown>,
  lines: readonly string[],
): Promise<number> => {
  const serialized = stringifyNote(lines.join("\n"), data)
  await atomicWriteFile(fullPath, serialized)
  return Buffer.byteLength(serialized, "utf8")
}

/** Truncates anchor/preview text to keep error messages and confirmations short. */
const truncateForMessage = (text: string): string =>
  text.length > 80 ? text.slice(0, 80) + "…" : text

/** Collapses runs of 3+ newlines down to one blank line, so removing content
 *  doesn't leave a visible multi-line gap. */
const collapseBlankRuns = (body: string): string =>
  body.replace(/\n{3,}/g, "\n\n")

/** Resolves an anchor substring to the single body line that contains it,
 *  searching at or after `fromLine`. The match must be unique by default:
 *  throws a not-found error on no match, or an ambiguous error on more than
 *  one — unless `firstMatch` allows taking the first. `role` labels the error
 *  messages ("start"/"end") and notes the end anchor's restricted search. */
const resolveAnchorLine = (params: {
  lines: readonly string[]
  anchor: string
  fromLine: number
  firstMatch: boolean | undefined
  path: string
  role: "start" | "end"
}): number => {
  const { lines, anchor, fromLine, firstMatch, path, role } = params
  const matchingLineIndices = lines.flatMap((line, index) =>
    index >= fromLine && line.includes(anchor) ? [index] : [],
  )
  // The end anchor is searched only at or after the start line; its errors say so.
  const regionSuffix = role === "end" ? " at or after the start anchor" : ""
  if (matchingLineIndices.length === 0) {
    throw new Error(
      `${role} anchor not found in "${path}"${regionSuffix}: "${truncateForMessage(anchor)}"`,
    )
  }
  if (matchingLineIndices.length > 1 && !firstMatch) {
    throw new Error(
      `ambiguous ${role} anchor in "${path}": "${truncateForMessage(anchor)}" matches ${matchingLineIndices.length} lines${regionSuffix}. Use a longer, unique anchor, or set first_match: true.`,
    )
  }
  const matchedIndex = matchingLineIndices[0]
  if (matchedIndex === undefined) {
    throw new Error(
      `${role} anchor not found in "${path}"${regionSuffix}: "${truncateForMessage(anchor)}"`,
    )
  }
  return matchedIndex
}

// ── Exported functions ──────────────────────────────────────────

/** Heading-targeted patch: append, prepend, replace, or insert_before. */
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
  const { path, operation, content, heading, headingLevel, includeChildren } =
    params
  assertNoControlCharacters(content, "content")
  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, data, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )
    const contentLines = content.split("\n")

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
        operation === "prepend" &&
        leadingHeadingOfContent(contentLines) !== null
      const displacedLeadingContent = insertsLeadingHeading
        ? findDisplacedLeadingContent(lines)
        : null

      const updatedLines =
        operation === "append"
          ? [...lines, ...contentLines]
          : [...contentLines, ...lines]
      const afterBytes = await writePatchedNote(fullPath, data, updatedLines)
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
    const target = findHeading(headings, heading, headingLevel)
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
      const childHeadings = headings.filter(
        (candidate) =>
          candidate.startLine >= target.bodyStartLine &&
          candidate.startLine < target.bodyEndLine,
      )
      if (childHeadings.length > 0) {
        const childList = childHeadings.map((child) => child.text).join(", ")
        const noun =
          childHeadings.length === 1 ? "child heading" : "child headings"
        throw new Error(
          `section "${targetDesc}" has ${childHeadings.length} ${noun} (${childList})`,
        )
      }
    }

    const updatedLines = applySectionOperation(
      lines,
      contentLines,
      target,
      operation,
    )

    const afterBytes = await writePatchedNote(fullPath, data, updatedLines)
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

  if (oldText.length === 0) {
    throw new Error("oldText cannot be empty")
  }
  assertNoControlCharacters(newText, "new_text")

  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, data, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )

    const body = lines.join("\n")

    if (!body.includes(oldText)) {
      throw new Error(
        `text not found in "${path}": "${truncateForMessage(oldText)}"`,
      )
    }

    const idx = body.indexOf(oldText)
    const { updatedBody, count } = replaceAllOccurrences
      ? {
          count: body.split(oldText).length - 1,
          updatedBody: body.split(oldText).join(newText),
        }
      : {
          count: 1,
          updatedBody:
            body.slice(0, idx) + newText + body.slice(idx + oldText.length),
        }

    // When deleting text (newText is empty), collapse runs of 3+ blank
    // lines down to 1 blank line so removals don't leave visible gaps.
    const normalizedBody =
      newText.length === 0 ? collapseBlankRuns(updatedBody) : updatedBody

    const updatedLines = normalizedBody.split("\n")
    const afterBytes = await writePatchedNote(fullPath, data, updatedLines)
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

  if (startAnchor.length === 0) {
    throw new Error("startAnchor cannot be empty")
  }
  if (endAnchor !== undefined && endAnchor.length === 0) {
    throw new Error("endAnchor cannot be empty")
  }

  const lockPath = resolveSafePath(params.vaultPath, path)
  return withExclusiveFileLock(lockPath, async () => {
    const { fullPath, data, lines, beforeBytes } = await readNoteForPatch(
      params.vaultPath,
      path,
    )

    const startLine = resolveAnchorLine({
      lines,
      anchor: startAnchor,
      fromLine: 0,
      firstMatch,
      path,
      role: "start",
    })
    // Omitting end_anchor deletes just the start line; otherwise the span runs
    // through the end anchor's line, searched at or after the start.
    const endLine =
      endAnchor === undefined
        ? startLine
        : resolveAnchorLine({
            lines,
            anchor: endAnchor,
            fromLine: startLine,
            firstMatch,
            path,
            role: "end",
          })

    const removedLines = lines.slice(startLine, endLine + 1)
    const remainingLines = [
      ...lines.slice(0, startLine),
      ...lines.slice(endLine + 1),
    ]
    const normalizedBody = collapseBlankRuns(remainingLines.join("\n"))
    const afterBytes = await writePatchedNote(
      fullPath,
      data,
      normalizedBody.split("\n"),
    )

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

export const vaultPatcher = {
  patchNote,
  replaceInNote,
  deleteSpan,
  findTrailingCommentBlockStart,
}
