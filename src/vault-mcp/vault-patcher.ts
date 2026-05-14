/** Surgical note editing — heading-targeted patches and find-and-replace. */

import { readFile, writeFile } from "node:fs/promises"
import matter from "gray-matter"
import { resolveSafePath } from "./vault-filesystem.js"
import type { Logger } from "../logger.js"

// ── Types ───────────────────────────────────────────────────────

type Operation = "append" | "prepend" | "replace" | "insert_before"

type HeadingInfo = Readonly<{
  text: string
  level: number
  startLine: number
  bodyStartLine: number
  bodyEndLine: number
}>

type FenceState = Readonly<{ char: string; length: number }> | null

// ── Internal helpers ────────────────────────────────────────────

/** Matches markdown headings H1–H6: captures the `#` prefix and heading text. */
const HEADING_REGEX = /^(#{1,6}) (.+)$/

/** Matches fenced code block openers: 3+ backticks or 3+ tildes (CommonMark §4.5). */
const FENCE_OPEN_REGEX = /^(`{3,}|~{3,})/

/** Obsidian comment delimiter — each `%%` occurrence toggles comment state. */
const COMMENT_DELIMITER = "%%"

/**
 * Finds the line index where a trailing Obsidian comment block begins, so the
 * final section's body can stop short of it. Returns `lines.length` when none
 * exists. A block is "trailing" when only blank lines follow its closing `%%`
 * (or when an unclosed comment runs to EOF).
 *
 * Known limitation: heading detection in `parseHeadings` is NOT comment-aware,
 * so a `## heading` inside a `%% %%` block is still treated as a real heading.
 */
const findTrailingCommentBlockStart = (lines: readonly string[]): number => {
  // `let` carries fence + comment parser state across lines — a per-line
  // reduce can't express the per-`%%` toggle cleanly.
  let fence: FenceState = null
  let comment: { openLine: number } | null = null
  let lastClosedBlock: { startLine: number; endLine: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = FENCE_OPEN_REGEX.exec(line)

    // Inside a fenced code block (outside comments): only a matching close
    // fence matters — `%%` is code and ignored.
    if (fence && !comment) {
      const isFenceClose =
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      if (isFenceClose) fence = null
      continue
    }

    if (fenceMatch && !comment) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      continue
    }

    // Outside fences (or inside a comment where `%%` takes precedence over
    // fences, matching Obsidian's parser): each `%%` toggles comment state.
    const delimiterCount = (line.match(/%%/g) ?? []).length
    for (let occurrence = 0; occurrence < delimiterCount; occurrence++) {
      if (comment) {
        // Validate that the closer ends its own line — otherwise the block
        // isn't cleanly separable from body text and can't be preserved.
        const validCloser = lines[i].trimEnd().endsWith(COMMENT_DELIMITER)
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
  if (
    !lines[trailingBlock.startLine].trimStart().startsWith(COMMENT_DELIMITER)
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

/**
 * Single-pass heading parser for H1–H6 with code-block awareness.
 * Section body = heading+1 through next heading of same-or-higher level (or EOF).
 */
const parseHeadings = (lines: readonly string[]): HeadingInfo[] => {
  // Phase 1: collect headings, skipping content inside fenced code blocks.
  // Fence state is carried in the accumulator to avoid mutable external state.
  const { headings: collectedHeadings } = lines.reduce<{
    headings: Array<{ text: string; level: number; startLine: number }>
    fence: FenceState
  }>(
    (state, line, i) => {
      const fenceMatch = FENCE_OPEN_REGEX.exec(line)

      if (state.fence) {
        // Inside a fenced block — only exit when we see a closing fence of the
        // same character with length >= the opener, and nothing else on the line
        const isFenceClose =
          fenceMatch &&
          fenceMatch[1][0] === state.fence.char &&
          fenceMatch[1].length >= state.fence.length &&
          line.trim() === fenceMatch[1]
        return isFenceClose ? { headings: state.headings, fence: null } : state
      }

      // Opening a new fenced code block
      if (fenceMatch) {
        return {
          headings: state.headings,
          fence: { char: fenceMatch[1][0], length: fenceMatch[1].length },
        }
      }

      const match = HEADING_REGEX.exec(line)
      if (match) {
        return {
          headings: [
            ...state.headings,
            {
              // Strip trailing closing hashes (e.g. "## Title ##" → "Title")
              text: match[2].replace(/\s+#+\s*$/, "").trim(),
              level: match[1].length,
              startLine: i,
            },
          ],
          fence: null,
        }
      }

      return state
    },
    { headings: [], fence: null },
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
const findHeading = (
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
    const allSameLevel = matches.every((h) => h.level === matches[0].level)
    const hint = allSameLevel
      ? "Rename one heading to make it unique, or use vault_replace_in_note to target by text."
      : "Use heading_level to disambiguate."
    throw new Error(
      `ambiguous heading: "${searchText}" matches ${matches.length} sections: ${matchedHeadings}. ${hint}`,
    )
  }

  return matches[0]
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
}> => {
  const fullPath = resolveSafePath(vaultPath, path)
  try {
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = matter(fileContent)
    return {
      fullPath,
      data: parsed.data as Record<string, unknown>,
      lines: parsed.content.split("\n"),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`note not found: "${path}"`, { cause: err })
    }
    throw err
  }
}

/** Writes modified content back with preserved frontmatter. */
const writePatchedNote = async (
  fullPath: string,
  data: Record<string, unknown>,
  lines: readonly string[],
): Promise<void> => {
  const serialized = matter.stringify(lines.join("\n"), data)
  await writeFile(fullPath, serialized, "utf8")
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
  const { fullPath, data, lines } = await readNoteForPatch(
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
    await writePatchedNote(fullPath, data, updatedLines)
    logger.info("patched note", {
      path,
      operation,
      target: "file body",
    })
    return `Applied ${operation} to ${path} → file body`
  }

  // Section-level operation
  const headings = parseHeadings(lines)
  const target = findHeading(headings, heading, headingLevel)
  const targetDesc = `${"#".repeat(target.level)} ${target.text}`
  const updatedLines = applySectionOperation(
    lines,
    contentLines,
    target,
    operation,
  )

  await writePatchedNote(fullPath, data, updatedLines)
  logger.info("patched note", { path, operation, target: targetDesc })
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

  const { fullPath, data, lines } = await readNoteForPatch(
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

  const updatedLines = updatedBody.split("\n")
  await writePatchedNote(fullPath, data, updatedLines)
  logger.info("replaced in note", { path, count })
  return `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${path}`
}

export const vaultPatcher = {
  patchNote,
  replaceInNote,
  findTrailingCommentBlockStart,
}
