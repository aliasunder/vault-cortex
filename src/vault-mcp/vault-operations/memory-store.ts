/** Memory store factory — heading-aware parser/writer for semantic memory files. */

import { readFile, readdir, mkdir, access } from "node:fs/promises"
import { constants } from "node:fs"
import { join, basename, dirname } from "node:path"
import { parseNote, stringifyNote } from "../obsidian-markdown/frontmatter.js"
import { atomicWriteFile } from "./vault-filesystem.js"
import { readFileOrNull } from "../../utils/fs.js"
import { withFileLock } from "../../utils/file-write-lock.js"
import { parseLeadingCallout } from "../obsidian-markdown/callouts.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { parseHeadings } from "../obsidian-markdown/headings.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
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

// Matches dated bullet entries: `- **YYYY-MM-DD**: ...`
// The date portion is the reliable anchor — entry text after `: ` may contain its own **bold**
const ENTRY_PATTERN = /^- \*\*\d{4}-\d{2}-\d{2}\*\*:/

const isString = (value: unknown): value is string => typeof value === "string"

/** Returns the heading name with the "(newest first)" suffix, appending it if absent (case-insensitive). */
const headingWithNewestFirstSuffix = (sectionName: string): string =>
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

export type MemoryHeading = Readonly<{
  level: 1 | 2
  text: string
  entryCount?: number
}>

export type MemoryFileOutline = Readonly<{
  file: string
  title: string
  bytes: number
  leading_callout: LeadingCallout | null
  headings: MemoryHeading[]
}>

/** What an updateMemory call did — lets the tool layer tailor its confirmation
 *  (e.g. nudge the caller to fill in a new file's scope callout). */
export type UpdateMemoryOutcome =
  | "created-file"
  | "created-section"
  | "appended"

type ParsedSection = Readonly<{
  heading: string
  level: 1 | 2
  startLine: number
  bodyStartLine: number
  bodyEndLine: number
  entryCount: number
}>

// ── Internal helpers ────────────────────────────────────────────

/** Counts dated bullet entries within a section's body span [start, end). A plain
 *  loop — a sequential count with no slice/filter allocations over what can be a
 *  large memory file. */
const countDatedEntries = (
  lines: readonly string[],
  start: number,
  end: number,
): number => {
  let count = 0
  for (let lineIndex = start; lineIndex < end; lineIndex++) {
    if (ENTRY_PATTERN.test(lines[lineIndex])) count += 1
  }
  return count
}

/**
 * Parses a memory file's H1/H2 sections, with a dated-bullet count per H2.
 *
 * Section spans come from the shared heading parser (headings.ts), so memory
 * files resolve sections exactly the way vault_read_note and vault_patch_note do
 * — including its fence-awareness, so a "## ..."-looking line inside a code block
 * is not mistaken for a section. Memory headings are only ever H1 (title) or H2,
 * so deeper headings are filtered out. Only H2 sections expose an entry count (the
 * sole consumer, listMemoryFiles, discards the H1's), so the H1 — whose span runs
 * to EOF — is not scanned.
 */
const parseSections = (lines: readonly string[]): ParsedSection[] =>
  parseHeadings(lines)
    .filter((heading) => heading.level <= 2)
    .map((heading) => ({
      heading: heading.text,
      level: heading.level as 1 | 2,
      startLine: heading.startLine,
      bodyStartLine: heading.bodyStartLine,
      bodyEndLine: heading.bodyEndLine,
      entryCount:
        heading.level === 2
          ? countDatedEntries(lines, heading.bodyStartLine, heading.bodyEndLine)
          : 0,
    }))

/** Case-insensitive section lookup by heading text. */
const findSection = (
  sections: readonly ParsedSection[],
  sectionName: string,
  level: 1 | 2,
): ParsedSection | undefined => {
  // Memory headings are canonically suffixed "(newest first)"; resolve the
  // caller's name to that form so a short name matches the stored heading
  // (and update_memory doesn't append a duplicate section).
  const normalizedSectionName = headingWithNewestFirstSuffix(sectionName)
    .trim()
    .toLowerCase()
  return sections.find(
    (section) =>
      section.level === level &&
      section.heading.toLowerCase() === normalizedSectionName,
  )
}

// ── Factory ────────────────────────────────────────────────────

export const createMemoryStore = (options: { memoryDir: string }) => {
  const { memoryDir } = options

  const memoryFilePath = (vaultPath: string, file: string): string =>
    join(vaultPath, memoryDir, `${file}.md`)

  type MemoryTemplateSpec = {
    fileName: string
    title: string
    tag: string
    related: string[]
    scope: string
    sections: string[]
  }

  const MEMORY_TEMPLATE_SPECS: readonly MemoryTemplateSpec[] = [
    {
      fileName: "Me",
      title: "Me",
      tag: "identity",
      related: ["Opinions", "Principles", "Routines"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Identity, interests, and durable context about the user — who they are, what they're into, situational facts.",
        "> **Does NOT contain:** Opinions or preferences (→ Opinions), guiding principles (→ Principles), recurring routines (→ Routines).",
        '> **Section structure:** H2 sections grouped by theme, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only.",
      ].join("\n"),
      sections: [
        "Identity (newest first)",
        "Interests (newest first)",
        "Context (newest first)",
      ],
    },
    {
      fileName: "Opinions",
      title: "Opinions",
      tag: "opinions",
      related: ["Principles", "Me"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Evolving views on tools, patterns, methods, and processes — stances that may shift over time.",
        "> **Does NOT contain:** Stable values or decision heuristics (→ Principles), identity or interests (→ Me).",
        '> **Section structure:** H2 sections by topic, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only.",
      ].join("\n"),
      sections: [
        "Tools and workflows (newest first)",
        "Code patterns (newest first)",
        "Communication preferences (newest first)",
      ],
    },
    {
      fileName: "Principles",
      title: "Principles",
      tag: "principles",
      related: ["Opinions", "Me"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Stable values, decision heuristics, and non-negotiables — how the user thinks and what they hold firm.",
        "> **Does NOT contain:** Evolving opinions on tools or methods (→ Opinions), identity facts (→ Me).",
        '> **Section structure:** H2 sections by theme, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only.",
      ].join("\n"),
      sections: [
        "Decision heuristics (newest first)",
        "Working style (newest first)",
        "Non-negotiables (newest first)",
      ],
    },
    {
      fileName: "Routines",
      title: "Routines",
      tag: "routines",
      related: ["Me"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Recurring routines, cadences, and practiced habits — what the user actually does on a regular rhythm.",
        "> **Does NOT contain:** One-off events or plans, identity facts (→ Me), principles (→ Principles).",
        '> **Section structure:** H2 sections by cadence, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only.",
      ].join("\n"),
      sections: [
        "Daily (newest first)",
        "Weekly (newest first)",
        "Commitments (newest first)",
      ],
    },
  ]

  /** Renders a memory template with the current timestamp so bootstrapped files
   *  carry a `created` property from the moment the server first seeds them. */
  const renderMemoryTemplate = (
    spec: MemoryTemplateSpec,
    created: string,
  ): { fileName: string; content: string } => ({
    fileName: spec.fileName,
    content: [
      "---",
      `title: ${spec.title}`,
      `created: ${created}`,
      "type: profile",
      "tags:",
      "  - memory",
      `  - ${spec.tag}`,
      "related:",
      ...spec.related.map((sibling) => `  - "[[${memoryDir}/${sibling}]]"`),
      "---",
      "",
      `# ${spec.title}`,
      "",
      spec.scope,
      "",
      ...spec.sections.flatMap((section) => [`## ${section}`, ""]),
    ].join("\n"),
  })

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
  const readMemoryFileOrNull = (
    vaultPath: string,
    file: string,
  ): Promise<string | null> => readFileOrNull(memoryFilePath(vaultPath, file))

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
    // A programmatically-created file has an unknown purpose, so seed only the
    // generic convention + a Contains placeholder for the caller to fill in
    // (the full scope callout — Does NOT contain / Section structure — is
    // authored per-file in MEMORY_TEMPLATES for the known seed files).
    const body = [
      "",
      `# ${params.fileName}`,
      "",
      "> [!info] Scope of this file",
      "> **Contains:** (describe what belongs in this file — and what doesn't)",
      "> **Convention:** append newest first; never overwrite dated entries; ISO dates only.",
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

    const lines = splitIntoLines(parsed.content)
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
  ): Promise<UpdateMemoryOutcome> =>
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
        const newSection = headingWithNewestFirstSuffix(params.section)
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
          outcome: "created-file",
          beforeBytes: 0,
          afterBytes: Buffer.byteLength(content, "utf8"),
        })
        return "created-file"
      }

      const parsed = parseNote(existingContent)
      const contentLines = splitIntoLines(parsed.content)
      const sections = parseSections(contentLines)
      const match = findSection(sections, params.section, 2)

      // File exists but section does not — append new H2 + entry at end
      if (!match) {
        const newSection = headingWithNewestFirstSuffix(params.section)
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
          outcome: "created-section",
          beforeBytes,
          afterBytes,
        })
        return "created-section"
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
        outcome: "appended",
        beforeBytes,
        afterBytes,
      })
      return "appended"
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
        const lines = splitIntoLines(parsed.content)
        const leadingCallout = parseLeadingCallout(lines)
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

        const bytes = Buffer.byteLength(raw, "utf8")
        return {
          file: name,
          title,
          bytes,
          leading_callout: leadingCallout,
          headings,
        }
      }),
    )

    logger.info("listed memory files", { count: outlines.length })
    return outlines
  }

  /** Lists memory file names (without .md), sorted. Cheap by design — a
   *  readdir + filter with no file reads or parsing — so it's safe to call
   *  on a hot path like prompt-arg autocomplete, which fires per keystroke. */
  const listMemoryFileNames = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<string[]> => {
    const dir = join(params.vaultPath, memoryDir)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
    const names = entries
      .filter((filename) => filename.endsWith(".md"))
      .map((filename) => basename(filename, ".md"))
      .sort()
    logger.debug("listed memory file names", { count: names.length })
    return names
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
      const lines = splitIntoLines(parsed.content)
      const sections = parseSections(lines)
      const match = findSection(sections, params.section, 2)
      if (!match) {
        throw new Error(
          `section not found: "${params.section}" in ${memoryDir}/${params.file}.md`,
        )
      }

      // Build the exact bullet string and find matching lines within the section
      const targetBullet = `- **${params.date}**: ${params.entry}`
      const matchingIndices = lines.flatMap((line, index) =>
        index >= match.bodyStartLine &&
        index < match.bodyEndLine &&
        line === targetBullet
          ? [index]
          : [],
      )

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
    const created = DateTime.now().toISO()!
    const templates = MEMORY_TEMPLATE_SPECS.map((spec) =>
      renderMemoryTemplate(spec, created),
    )
    await Promise.all(
      templates.map((template) =>
        atomicWriteFile(
          join(dirPath, `${template.fileName}.md`),
          template.content,
        ),
      ),
    )
    logger.info("bootstrapped memory directory", {
      memoryDir,
      fileCount: templates.length,
    })
  }

  return {
    getMemory,
    updateMemory,
    listMemoryFiles,
    listMemoryFileNames,
    deleteMemory,
    bootstrapMemoryDir,
  }
}
