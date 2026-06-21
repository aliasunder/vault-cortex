/** Surgical note editing — heading-targeted patches and find-and-replace. */

import { readFile } from "node:fs/promises"
import { parseNote, stringifyNote } from "./frontmatter.js"
import { resolveSafePath, atomicWriteFile } from "./vault-filesystem.js"
import {
  parseHeadings,
  findHeading,
  findTrailingCommentBlockStart,
  type HeadingInfo,
} from "./heading-parser.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

type Operation = "append" | "prepend" | "replace" | "insert_before"

// ── Internal helpers ────────────────────────────────────────────

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
  const fullPath = resolveSafePath(vaultPath, path)
  try {
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = parseNote(fileContent)
    return {
      fullPath,
      data: parsed.data as Record<string, unknown>,
      lines: parsed.content.split("\n"),
      beforeBytes: Buffer.byteLength(fileContent, "utf8"),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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

// ── Exported functions ──────────────────────────────────────────

/** Heading-targeted patch: append, prepend, replace, or insert_before. */
const patchNote = async (
  params: {
    vaultPath: string
    path: string
    operation: Operation
    content: string
    heading?: string
    headingLevel?: number
  },
  logger: Logger,
): Promise<string> => {
  const { path, operation, content, heading, headingLevel } = params
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
    })
    return `Applied ${operation} to ${path} → file body`
  }

  // Section-level operation
  const headings = parseHeadings(lines)
  const target = findHeading(headings, heading, headingLevel)
  const targetDesc = `${"#".repeat(target.level)} ${target.text}`

  // Heading-targeted ops keep the matched heading, so a content that begins
  // with that same heading would duplicate it. Reject with remediation rather
  // than silently doubling it.
  const firstContentLineIndex = contentLines.findIndex(
    (line) => line.trim() !== "",
  )
  const leadingContentHeading = parseHeadings(contentLines).find(
    (contentHeading) => contentHeading.startLine === firstContentLineIndex,
  )
  const contentRepeatsTargetHeading =
    leadingContentHeading !== undefined &&
    leadingContentHeading.level === target.level &&
    leadingContentHeading.text === target.text
  if (contentRepeatsTargetHeading) {
    throw new Error(
      `content begins with the heading "${targetDesc}", which would duplicate it — ` +
        `heading-targeted ops keep the matched heading, so omit the heading line from content.`,
    )
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
  return `Applied ${operation} to ${path} → ${targetDesc}`
}

/** Find-and-replace within a note's body. */
const replaceInNote = async (
  params: {
    vaultPath: string
    path: string
    oldText: string
    newText: string
    replaceAllOccurrences?: boolean
  },
  logger: Logger,
): Promise<string> => {
  const { path, oldText, newText, replaceAllOccurrences } = params

  if (oldText.length === 0) {
    throw new Error("old_text cannot be empty")
  }

  const { fullPath, data, lines, beforeBytes } = await readNoteForPatch(
    params.vaultPath,
    path,
  )

  const body = lines.join("\n")

  if (!body.includes(oldText)) {
    const truncatedOldText =
      oldText.length > 80 ? oldText.slice(0, 80) + "…" : oldText
    throw new Error(`text not found in "${path}": "${truncatedOldText}"`)
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
    newText.length === 0 ? updatedBody.replace(/\n{3,}/g, "\n\n") : updatedBody

  const updatedLines = normalizedBody.split("\n")
  const afterBytes = await writePatchedNote(fullPath, data, updatedLines)
  logger.info("replaced in note", { path, count, beforeBytes, afterBytes })
  return `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${path}`
}

export const vaultPatcher = {
  patchNote,
  replaceInNote,
  findTrailingCommentBlockStart,
}
