/** Memory store factory — heading-aware parser/writer for semantic memory files. */

import { readFile, writeFile, readdir } from "node:fs/promises"
import { join, basename } from "node:path"
import matter from "gray-matter"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"

// Matches dated bullet entries: `- **YYYY-MM-DD**: ...`
// The date portion is the reliable anchor — entry text after `: ` may contain its own **bold**
const ENTRY_PATTERN = /^- \*\*\d{4}-\d{2}-\d{2}\*\*:/

const isString = (value: unknown): value is string => typeof value === "string"

// ── Types ───────────────────────────────────────────────────────

type MemoryHeading = Readonly<{
  level: 1 | 2
  text: string
  entryCount?: number
}>

type MemoryFileOutline = Readonly<{
  file: string
  title: string
  headings: MemoryHeading[]
}>

type ParsedSection = Readonly<{
  heading: string
  level: 1 | 2
  startLine: number
  bodyStartLine: number
  bodyEndLine: number
  entryCount: number
}>

// ── Internal helpers ────────────────────────────────────────────

/**
 * Single-pass section parser. Walks lines to identify H1/H2 headings and
 * count dated bullets within each section.
 *
 * Two-phase approach: the reduce collects heading metadata (startLine, entryCount),
 * then the .map() computes bodyEndLine for each section — this requires the *next*
 * section's startLine, which isn't available during the reduce pass.
 */
const parseSections = (lines: readonly string[]): ParsedSection[] => {
  // Phase 1: collect headings and count entries under each
  const raw = lines.reduce<
    Array<{
      heading: string
      level: 1 | 2
      startLine: number
      entryCount: number
    }>
  >((acc, line, lineIndex) => {
    const h1 = /^# (.+)$/.exec(line)
    if (h1) {
      acc.push({
        heading: h1[1].trim(),
        level: 1,
        startLine: lineIndex,
        entryCount: 0,
      })
      return acc
    }
    const h2 = /^## (.+)$/.exec(line)
    if (h2) {
      acc.push({
        heading: h2[1].trim(),
        level: 2,
        startLine: lineIndex,
        entryCount: 0,
      })
      return acc
    }
    // Count dated bullets under the most recently seen heading
    if (acc.length > 0 && ENTRY_PATTERN.test(line)) {
      acc[acc.length - 1].entryCount++
    }
    return acc
  }, [])

  // Phase 2: compute body ranges — each section's body ends where the next heading starts
  return raw.map((section, index) => ({
    heading: section.heading,
    level: section.level,
    startLine: section.startLine,
    bodyStartLine: section.startLine + 1,
    bodyEndLine:
      index + 1 < raw.length ? raw[index + 1].startLine : lines.length,
    entryCount: section.entryCount,
  }))
}

/** Case-insensitive section lookup by heading text. */
const findSection = (
  sections: readonly ParsedSection[],
  sectionName: string,
  level: 1 | 2,
): ParsedSection | undefined => {
  const needle = sectionName.trim().toLowerCase()
  return sections.find(
    (section) =>
      section.level === level && section.heading.toLowerCase() === needle,
  )
}

// ── Factory ────────────────────────────────────────────────────

export const createMemoryStore = (options: { memoryDir: string }) => {
  const { memoryDir } = options

  const memoryFilePath = (vaultPath: string, file: string): string =>
    join(vaultPath, memoryDir, `${file}.md`)

  const readMemoryFile = async (
    vaultPath: string,
    file: string,
  ): Promise<string> => {
    try {
      return await readFile(memoryFilePath(vaultPath, file), "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`memory file not found: "${memoryDir}/${file}.md"`, {
          cause: err,
        })
      }
      throw err
    }
  }

  // ── Exported functions ──────────────────────────────────────────

  const getMemory = async (
    params: { vaultPath: string; file?: string; section?: string },
    logger: Logger,
  ): Promise<string> => {
    if (!params.file) {
      const dir = join(params.vaultPath, memoryDir)
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`${memoryDir} directory not found`, { cause: err })
        }
        throw err
      }
      const mdFiles = entries
        .filter((filename) => filename.endsWith(".md"))
        .sort()
      const contents = await Promise.all(
        mdFiles.map(async (filename) => {
          const raw = await readFile(join(dir, filename), "utf8")
          return matter(raw).content.trim()
        }),
      )
      logger.info("get memory", { mode: "all", fileCount: mdFiles.length })
      return contents.join("\n\n---\n\n")
    }

    const raw = await readMemoryFile(params.vaultPath, params.file)
    const parsed = matter(raw)

    if (!params.section) {
      logger.info("get memory", { mode: "file", file: params.file })
      return parsed.content.trim()
    }

    const lines = parsed.content.split("\n")
    const sections = parseSections(lines)
    const match = findSection(sections, params.section, 2)
    if (!match) {
      throw new Error(
        `section not found: "${params.section}" in ${memoryDir}/${params.file}.md`,
      )
    }

    // Extract only the lines between this heading and the next
    const body = lines
      .slice(match.bodyStartLine, match.bodyEndLine)
      .join("\n")
      .trim()
    logger.info("get memory", {
      mode: "section",
      file: params.file,
      section: params.section,
    })
    return body
  }

  const updateMemory = async (
    params: {
      vaultPath: string
      file: string
      section: string
      entry: string
      date?: string
      position?: "top" | "bottom"
    },
    logger: Logger,
  ): Promise<void> => {
    const raw = await readMemoryFile(params.vaultPath, params.file)
    const parsed = matter(raw)
    const lines = parsed.content.split("\n")
    const sections = parseSections(lines)
    const match = findSection(sections, params.section, 2)
    if (!match) {
      throw new Error(
        `section not found: "${params.section}" in ${memoryDir}/${params.file}.md`,
      )
    }

    const date = params.date ?? DateTime.now().toISODate()
    const position = params.position ?? "top"
    const bullet = `- **${date}**: ${params.entry}`

    // Find the first and last dated bullet within the section body to determine
    // where to insert. Offsets are relative to the section's bodyStartLine.
    const bodyLines = lines.slice(match.bodyStartLine, match.bodyEndLine)
    const firstBulletOffset = bodyLines.findIndex((line) =>
      ENTRY_PATTERN.test(line),
    )
    const lastBulletOffset = bodyLines.reduce(
      (last, line, index) => (ENTRY_PATTERN.test(line) ? index : last),
      -1,
    )

    // Compute the absolute line index in the full content array for insertion.
    // "top" inserts before the first existing bullet (newest-first ordering).
    // "bottom" inserts after the last existing bullet.
    // Empty sections (no bullets) fall back to bodyEndLine — appends at section end.
    const insertIndex =
      position === "top"
        ? firstBulletOffset >= 0
          ? match.bodyStartLine + firstBulletOffset
          : match.bodyEndLine
        : lastBulletOffset >= 0
          ? match.bodyStartLine + lastBulletOffset + 1
          : match.bodyEndLine

    // Splice the new bullet into the content lines
    const updatedLines = [
      ...lines.slice(0, insertIndex),
      bullet,
      ...lines.slice(insertIndex),
    ]

    const newContent = updatedLines.join("\n")
    const serialized = matter.stringify(newContent, parsed.data)
    await writeFile(
      memoryFilePath(params.vaultPath, params.file),
      serialized,
      "utf8",
    )
    logger.info("updated memory", {
      file: params.file,
      section: params.section,
      date,
    })
  }

  const listMemoryFiles = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<MemoryFileOutline[]> => {
    const dir = join(params.vaultPath, memoryDir)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }

    const mdFiles = entries
      .filter((filename) => filename.endsWith(".md"))
      .sort()

    const outlines = await Promise.all(
      mdFiles.map(async (filename) => {
        const raw = await readFile(join(dir, filename), "utf8")
        const parsed = matter(raw)
        const name = basename(filename, ".md")
        const title = isString(parsed.data.title) ? parsed.data.title : name
        const lines = parsed.content.split("\n")
        const sections = parseSections(lines)

        const headings: MemoryHeading[] = sections.map((section) =>
          section.level === 1
            ? { level: 1 as const, text: section.heading }
            : {
                level: 2 as const,
                text: section.heading,
                entryCount: section.entryCount,
              },
        )

        return { file: name, title, headings }
      }),
    )

    logger.info("listed memory files", { count: outlines.length })
    return outlines
  }

  const deleteMemory = async (
    params: {
      vaultPath: string
      file: string
      section: string
      date: string
      entry: string
    },
    logger: Logger,
  ): Promise<void> => {
    const raw = await readMemoryFile(params.vaultPath, params.file)
    const parsed = matter(raw)
    const lines = parsed.content.split("\n")
    const sections = parseSections(lines)
    const match = findSection(sections, params.section, 2)
    if (!match) {
      throw new Error(
        `section not found: "${params.section}" in ${memoryDir}/${params.file}.md`,
      )
    }

    // Build the exact bullet string and find matching lines within the section
    const needle = `- **${params.date}**: ${params.entry}`
    const matchingIndices = lines.reduce<number[]>((acc, line, index) => {
      if (
        index >= match.bodyStartLine &&
        index < match.bodyEndLine &&
        line === needle
      ) {
        acc.push(index)
      }
      return acc
    }, [])

    if (matchingIndices.length === 0) {
      throw new Error(
        `no entry matching (${params.date}, "${params.entry}") under ## ${match.heading} in ${memoryDir}/${params.file}.md`,
      )
    }
    if (matchingIndices.length > 1) {
      throw new Error(
        `ambiguous: ${matchingIndices.length} entries match (${params.date}, "${params.entry}") under ## ${match.heading} in ${memoryDir}/${params.file}.md`,
      )
    }

    // Remove the single matched line, preserving everything before and after it
    const updatedLines = [
      ...lines.slice(0, matchingIndices[0]),
      ...lines.slice(matchingIndices[0] + 1),
    ]

    const newContent = updatedLines.join("\n")
    const serialized = matter.stringify(newContent, parsed.data)
    await writeFile(
      memoryFilePath(params.vaultPath, params.file),
      serialized,
      "utf8",
    )
    logger.info("deleted memory entry", {
      file: params.file,
      section: params.section,
      date: params.date,
    })
  }

  return { getMemory, updateMemory, listMemoryFiles, deleteMemory }
}

export type MemoryStore = ReturnType<typeof createMemoryStore>
