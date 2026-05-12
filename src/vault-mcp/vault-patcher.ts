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

// ── Internal helpers ────────────────────────────────────────────

const HEADING_RE = /^(#{1,6}) (.+)$/

/**
 * Single-pass heading parser for H1–H6 with code-block awareness.
 * Section body = heading+1 through next heading of same-or-higher level (or EOF).
 */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})/

const parseHeadings = (lines: readonly string[]): HeadingInfo[] => {
  let fence: { char: string; length: number } | null = null

  const raw = lines.reduce<
    Array<{ text: string; level: number; startLine: number }>
  >((acc, line, i) => {
    const fenceMatch = FENCE_OPEN_RE.exec(line)
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null
      }
      return acc
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      return acc
    }

    const match = HEADING_RE.exec(line)
    if (match) {
      acc.push({
        text: match[2].replace(/\s+#+\s*$/, "").trim(),
        level: match[1].length,
        startLine: i,
      })
    }
    return acc
  }, [])

  return raw.map((h, i) => {
    const nextSameOrHigher = raw
      .slice(i + 1)
      .find((next) => next.level <= h.level)
    return {
      text: h.text,
      level: h.level,
      startLine: h.startLine,
      bodyStartLine: h.startLine + 1,
      bodyEndLine: nextSameOrHigher?.startLine ?? lines.length,
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

  const needle = text.trim()
  const matches = headings.filter(
    (h) => h.text === needle && (level === undefined || h.level === level),
  )

  if (matches.length === 0) {
    const available = headings
      .map((h) => `${"#".repeat(h.level)} ${h.text}`)
      .join(", ")
    throw new Error(
      `heading not found: "${needle}". Available headings: ${available || "(none)"}`,
    )
  }

  if (matches.length > 1) {
    const details = matches
      .map((h) => `${"#".repeat(h.level)} ${h.text} (line ${h.startLine + 1})`)
      .join(", ")
    const allSameLevel = matches.every((h) => h.level === matches[0].level)
    const hint = allSameLevel
      ? "Rename one heading to make it unique, or use vault_replace_in_note to target by text."
      : "Use heading_level to disambiguate."
    throw new Error(
      `ambiguous heading: "${needle}" matches ${matches.length} sections: ${details}. ${hint}`,
    )
  }

  return matches[0]
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
  let raw: string
  try {
    raw = await readFile(fullPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`note not found: "${path}"`, { cause: err })
    }
    throw err
  }
  const parsed = matter(raw)
  return {
    fullPath,
    data: parsed.data as Record<string, unknown>,
    lines: parsed.content.split("\n"),
  }
}

/** Writes modified content back with preserved frontmatter. */
const writePatched = async (
  fullPath: string,
  data: Record<string, unknown>,
  lines: string[],
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

  let updatedLines: string[]
  let targetDesc: string

  if (!heading) {
    if (operation === "replace" || operation === "insert_before") {
      throw new Error(`operation "${operation}" requires a heading target`)
    }
    targetDesc = "file body"
    updatedLines =
      operation === "append"
        ? [...lines, ...contentLines]
        : [...contentLines, ...lines]
  } else {
    const headings = parseHeadings(lines)
    const target = findHeading(headings, heading, headingLevel)
    targetDesc = `${"#".repeat(target.level)} ${target.text}`

    switch (operation) {
      case "append":
        updatedLines = [
          ...lines.slice(0, target.bodyEndLine),
          ...contentLines,
          ...lines.slice(target.bodyEndLine),
        ]
        break
      case "prepend":
        updatedLines = [
          ...lines.slice(0, target.bodyStartLine),
          ...contentLines,
          ...lines.slice(target.bodyStartLine),
        ]
        break
      case "replace":
        updatedLines = [
          ...lines.slice(0, target.bodyStartLine),
          ...contentLines,
          ...lines.slice(target.bodyEndLine),
        ]
        break
      case "insert_before":
        updatedLines = [
          ...lines.slice(0, target.startLine),
          ...contentLines,
          ...lines.slice(target.startLine),
        ]
        break
    }
  }

  await writePatched(fullPath, data, updatedLines)
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
    const preview = oldText.length > 80 ? oldText.slice(0, 80) + "…" : oldText
    throw new Error(`text not found in "${path}": "${preview}"`)
  }

  let updatedBody: string
  let count: number

  if (replaceAllOccurrences) {
    count = body.split(oldText).length - 1
    updatedBody = body.split(oldText).join(newText)
  } else {
    count = 1
    const idx = body.indexOf(oldText)
    updatedBody =
      body.slice(0, idx) + newText + body.slice(idx + oldText.length)
  }

  const updatedLines = updatedBody.split("\n")
  await writePatched(fullPath, data, updatedLines)
  logger.info("replaced in note", { path, count })
  return `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${path}`
}

export const vaultPatcher = { patchNote, replaceInNote }
