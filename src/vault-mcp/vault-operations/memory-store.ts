/** Memory store factory — heading-aware parser/writer for semantic memory files. */

import { readFile, readdir, mkdir, access } from "node:fs/promises"
import { constants } from "node:fs"
import { join, basename, dirname } from "node:path"
import { parseNote, stringifyNote } from "./frontmatter.js"
import { atomicWriteFile } from "./vault-filesystem.js"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"

// Refuse a memory write that would remove more than half of an existing file's
// bytes — a catastrophic shrink almost always means the on-disk copy diverged
// (e.g. a skeleton template clobbering real content) rather than a legitimate
// single-entry edit. The 200-byte floor sits just
// above the largest empty memory template (Me 152 B, Principles 193 B,
// Opinions 197 B — frontmatter + headings, no entries), so a file with no real
// content is never guarded, while a file with even one dated entry (~240 B+) is.
const SHRINK_FLOOR_BYTES = 200
const SHRINK_RATIO = 0.5
const guardAgainstShrink = (
  beforeBytes: number,
  afterBytes: number,
  context: string,
): void => {
  if (
    beforeBytes > SHRINK_FLOOR_BYTES &&
    afterBytes < beforeBytes * SHRINK_RATIO
  ) {
    throw new Error(
      `refusing memory write: ${context} would shrink content from ${beforeBytes} to ${afterBytes} bytes (>50% reduction); re-read with vault_get_memory to confirm current content before retrying`,
    )
  }
}

// Serializes async read-modify-write cycles per memory file. vault-mcp is a
// single Node process handling concurrent MCP request handlers on one event
// loop; without this, two updateMemory/deleteMemory calls can interleave
// (read, read, write, write) and the second write clobbers the first's entry
// (lost update). A per-path promise chain forces one-at-a-time execution.
// Mutable Map because the chain tail is replaced in place as operations enqueue.
const fileWriteLocks = new Map<string, Promise<unknown>>()

const withFileLock = async <T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = fileWriteLocks.get(key) ?? Promise.resolve()
  // Start our op only after the previous one settles. .then's two args are the
  // fulfilled and rejected handlers; we pass the same fn to both so ours runs
  // whether the previous op succeeded OR threw — a prior failure must not skip
  // our turn or poison the chain. (Our own error still surfaces via `await run`.)
  const run = previous.then(
    () => fn(),
    () => fn(),
  )
  fileWriteLocks.set(key, run)
  try {
    return await run
  } finally {
    // Drop the entry only if no newer op chained on, to bound Map growth.
    if (fileWriteLocks.get(key) === run) fileWriteLocks.delete(key)
  }
}

// Matches dated bullet entries: `- **YYYY-MM-DD**: ...`
// The date portion is the reliable anchor — entry text after `: ` may contain its own **bold**
const ENTRY_PATTERN = /^- \*\*\d{4}-\d{2}-\d{2}\*\*:/

const isString = (value: unknown): value is string => typeof value === "string"

/** Appends "(newest first)" to a section name if not already present (case-insensitive). */
const ensureNewestFirstSuffix = (sectionName: string): string =>
  sectionName.trimEnd().toLowerCase().endsWith("(newest first)")
    ? sectionName
    : `${sectionName} (newest first)`

/** Converts a string to kebab-case for use as a tag. */
const toKebabCase = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

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

  const MEMORY_TEMPLATES: ReadonlyArray<{
    fileName: string
    content: string
  }> = [
    {
      fileName: "Me",
      content: [
        "---",
        "title: Me",
        "type: profile",
        "tags:",
        "  - memory",
        "  - identity",
        "---",
        "",
        "# Me",
        "",
        "## Identity (newest first)",
        "",
        "## Interests (newest first)",
        "",
        "## Context (newest first)",
        "",
      ].join("\n"),
    },
    {
      fileName: "Opinions",
      content: [
        "---",
        "title: Opinions",
        "type: profile",
        "tags:",
        "  - memory",
        "  - opinions",
        "---",
        "",
        "# Opinions",
        "",
        "## Tools and workflows (newest first)",
        "",
        "## Code patterns (newest first)",
        "",
        "## Communication preferences (newest first)",
        "",
      ].join("\n"),
    },
    {
      fileName: "Principles",
      content: [
        "---",
        "title: Principles",
        "type: profile",
        "tags:",
        "  - memory",
        "  - principles",
        "---",
        "",
        "# Principles",
        "",
        "## Decision heuristics (newest first)",
        "",
        "## Working style (newest first)",
        "",
        "## Non-negotiables (newest first)",
        "",
      ].join("\n"),
    },
  ]

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

  /** Like readMemoryFile, but returns null when the file does not exist. */
  const readMemoryFileOrNull = async (
    vaultPath: string,
    file: string,
  ): Promise<string | null> => {
    try {
      return await readFile(memoryFilePath(vaultPath, file), "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  }

  /** Builds a new memory file with frontmatter, H1 title, H2 section, and initial entry. */
  const buildNewMemoryFile = (params: {
    fileName: string
    section: string
    bullet: string
  }): string => {
    const frontmatter = {
      title: params.fileName,
      type: "profile",
      tags: ["memory", toKebabCase(params.fileName)],
      created: DateTime.now().toISO(),
    }
    const body = [
      "",
      `# ${params.fileName}`,
      "",
      `## ${params.section}`,
      params.bullet,
      "",
    ].join("\n")
    return stringifyNote(body, frontmatter)
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
          logger.info("get memory", { mode: "all", fileCount: 0 })
          return ""
        }
        throw err
      }
      const mdFiles = entries
        .filter((filename) => filename.endsWith(".md"))
        .sort()
      const contents = await Promise.all(
        mdFiles.map(async (filename) => {
          const raw = await readFile(join(dir, filename), "utf8")
          return parseNote(raw).content.trim()
        }),
      )
      logger.info("get memory", { mode: "all", fileCount: mdFiles.length })
      return contents.join("\n\n---\n\n")
    }

    const raw = await readMemoryFile(params.vaultPath, params.file)
    const parsed = parseNote(raw)

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
  ): Promise<void> =>
    // Serialize the read-modify-write so concurrent appends to the same file
    // don't clobber each other's entries (lost update).
    withFileLock(memoryFilePath(params.vaultPath, params.file), async () => {
      const date = params.date ?? DateTime.now().toISODate()
      const position = params.position ?? "top"
      const bullet = `- **${date}**: ${params.entry}`

      const existingContent = await readMemoryFileOrNull(
        params.vaultPath,
        params.file,
      )

      // File does not exist — create directory + file with section and entry
      if (existingContent === null) {
        const newSection = ensureNewestFirstSuffix(params.section)
        const filePath = memoryFilePath(params.vaultPath, params.file)
        await mkdir(dirname(filePath), { recursive: true })
        const content = buildNewMemoryFile({
          fileName: params.file,
          section: newSection,
          bullet,
        })
        await atomicWriteFile(filePath, content)
        logger.info("created memory file", {
          file: params.file,
          section: newSection,
          date,
          beforeBytes: 0,
          afterBytes: Buffer.byteLength(content, "utf8"),
        })
        return
      }

      const parsed = parseNote(existingContent)
      const contentLines = parsed.content.split("\n")
      const sections = parseSections(contentLines)
      const match = findSection(sections, params.section, 2)

      // File exists but section does not — append new H2 + entry at end
      if (!match) {
        const newSection = ensureNewestFirstSuffix(params.section)
        const appendedLines = [...contentLines, `## ${newSection}`, bullet]
        const newContent = appendedLines.join("\n")
        const serialized = stringifyNote(newContent, parsed.data)
        const beforeBytes = Buffer.byteLength(existingContent, "utf8")
        const afterBytes = Buffer.byteLength(serialized, "utf8")
        guardAgainstShrink(beforeBytes, afterBytes, "creating memory section")
        await atomicWriteFile(
          memoryFilePath(params.vaultPath, params.file),
          serialized,
        )
        logger.info("created memory section", {
          file: params.file,
          section: newSection,
          date,
          beforeBytes,
          afterBytes,
        })
        return
      }

      // File + section exist — find the first and last dated bullet within the
      // section body to determine where to insert. Offsets are relative to bodyStartLine.
      const bodyLines = contentLines.slice(
        match.bodyStartLine,
        match.bodyEndLine,
      )
      const firstBulletOffset = bodyLines.findIndex((line) =>
        ENTRY_PATTERN.test(line),
      )
      const lastBulletOffset = bodyLines.reduce(
        (lastMatchIndex, line, index) =>
          ENTRY_PATTERN.test(line) ? index : lastMatchIndex,
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
        ...contentLines.slice(0, insertIndex),
        bullet,
        ...contentLines.slice(insertIndex),
      ]

      const newContent = updatedLines.join("\n")
      const serialized = stringifyNote(newContent, parsed.data)
      const beforeBytes = Buffer.byteLength(existingContent, "utf8")
      const afterBytes = Buffer.byteLength(serialized, "utf8")
      guardAgainstShrink(beforeBytes, afterBytes, "updating memory entry")
      await atomicWriteFile(
        memoryFilePath(params.vaultPath, params.file),
        serialized,
      )
      logger.info("updated memory", {
        file: params.file,
        section: params.section,
        date,
        beforeBytes,
        afterBytes,
      })
    })

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
        const parsed = parseNote(raw)
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
  ): Promise<void> =>
    // Serialize with concurrent updates/deletes to the same file so the
    // read-modify-write can't be interleaved and lose a write.
    withFileLock(memoryFilePath(params.vaultPath, params.file), async () => {
      const raw = await readMemoryFile(params.vaultPath, params.file)
      const parsed = parseNote(raw)
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
      const serialized = stringifyNote(newContent, parsed.data)
      const beforeBytes = Buffer.byteLength(raw, "utf8")
      const afterBytes = Buffer.byteLength(serialized, "utf8")
      guardAgainstShrink(beforeBytes, afterBytes, "deleting memory entry")
      await atomicWriteFile(
        memoryFilePath(params.vaultPath, params.file),
        serialized,
      )
      logger.info("deleted memory entry", {
        file: params.file,
        section: params.section,
        date: params.date,
        beforeBytes,
        afterBytes,
      })
    })

  /** Creates the memory directory with template files if it doesn't exist. Idempotent. */
  const bootstrapMemoryDir = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<void> => {
    const dirPath = join(params.vaultPath, memoryDir)
    try {
      await access(dirPath, constants.F_OK)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    await mkdir(dirPath, { recursive: true })
    await Promise.all(
      MEMORY_TEMPLATES.map((template) =>
        atomicWriteFile(
          join(dirPath, `${template.fileName}.md`),
          template.content,
        ),
      ),
    )
    logger.info("bootstrapped memory directory", {
      memoryDir,
      fileCount: MEMORY_TEMPLATES.length,
    })
  }

  return {
    getMemory,
    updateMemory,
    listMemoryFiles,
    deleteMemory,
    bootstrapMemoryDir,
  }
}
