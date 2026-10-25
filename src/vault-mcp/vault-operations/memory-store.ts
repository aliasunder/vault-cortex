/** Memory store factory — heading-aware parser/writer for semantic memory files. */

import { readFile, readdir, mkdir, access } from "node:fs/promises"
import { constants, type Dirent } from "node:fs"
import { join, basename, dirname, resolve } from "node:path"
import {
  joinNoteKeepingBlock,
  parseNoteSkippingUnreadableBlock,
  splitNoteKeepingBlock,
  splitPropertiesBlock,
  stringifyNote,
  UnkeepableOpeningBlockError,
} from "../obsidian-markdown/frontmatter.js"
import type { ParsedNote } from "../obsidian-markdown/frontmatter.js"
import { atomicWriteFile } from "./vault-filesystem.js"
import { readFileOrNull, statOrNull } from "../../utils/fs.js"
import { filterValidSymlinks } from "../../utils/filter-valid-symlinks.js"
import { mapWithConcurrency } from "../../utils/map-with-concurrency.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { describeError } from "../../utils/describe-error.js"
import { assertNoControlCharacters } from "../../utils/assert-no-control-characters.js"
import { withFileLock } from "../../utils/file-write-lock.js"
import { parseMemoryEntries, type MemoryEntry } from "../obsidian-markdown/memory-entries.js"
import { parseLeadingCallout } from "../obsidian-markdown/callouts.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { parseHeadings } from "../obsidian-markdown/headings.js"
import {
  splitIntoLines,
  advanceFence,
  advanceComment,
  type OpenFence,
  type CommentResult,
} from "../obsidian-markdown/lines.js"
import { levenshteinDistance } from "../../utils/levenshtein-distance.js"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"

// Refuse a memory write that would remove more than half of an existing file's
// bytes — a catastrophic shrink almost always means the on-disk copy diverged
// (e.g. a skeleton template clobbering real content) rather than a legitimate
// single-entry edit. The 1250-byte floor sits just above the largest empty
// memory template once rendered (Routines: frontmatter, scope callout and
// headings, no entries), so a file with no real content is never guarded,
// while a file with even one dated entry is.
const SHRINK_FLOOR_BYTES = 1250
const SHRINK_RATIO = 0.5
const guardAgainstShrink = (beforeBytes: number, afterBytes: number, context: string): void => {
  if (beforeBytes > SHRINK_FLOOR_BYTES && afterBytes < beforeBytes * SHRINK_RATIO) {
    const refusedReductionPercent = (1 - SHRINK_RATIO) * 100
    throw new Error(
      `refusing memory write: ${context} would shrink content from ${beforeBytes} to ${afterBytes} bytes (>${refusedReductionPercent}% reduction) — the on-disk content has likely diverged from the copy this write was based on`,
    )
  }
}

// Matches dated bullet entries: `- **YYYY-MM-DD**: ...`
// The date portion is the reliable anchor — entry text after `: ` may contain its own **bold**
const ENTRY_PATTERN = /^- \*\*\d{4}-\d{2}-\d{2}\*\*:/

/** Matches CR/LF anywhere in a string — memory entries are single-line dated
 *  bullets, so any line break in an input would corrupt the format. */
const MEMORY_ENTRY_LINE_BREAK_PATTERN = /[\r\n]/

/** True when the text is a real ISO calendar date in bare YYYY-MM-DD form —
 *  or undefined, which callers treat as "not supplied" (updateMemory defaults
 *  it to today). fromFormat enforces both the exact shape (zero-padded,
 *  rejects timestamps and week/ordinal forms that the permissive fromISO
 *  would accept) and calendar validity ("2026-02-30" parses as out of range). */
const isValidMemoryEntryDate = (dateText: string | undefined): boolean => {
  if (dateText === undefined) return true

  return DateTime.fromFormat(dateText, "yyyy-MM-dd").isValid
}

/** Thrown by updateMemory and getMemoryEntries when a supplied date fails
 *  isValidMemoryEntryDate — one string so the two sites can't drift. */
const INVALID_MEMORY_ENTRY_DATE_MESSAGE =
  "date must be a real ISO calendar date (YYYY-MM-DD, e.g. 2026-07-02)"

/** The date shape ENTRY_PATTERN reads as an entry. A hand edit can leave an
 *  impossible date such as 2026-02-30 in a memory file, so deleteMemory
 *  checks only the shape. */
const MEMORY_ENTRY_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

const isString = (value: unknown): value is string => typeof value === "string"

/** Appends "(newest first)" when absent (case-insensitive match). Trailing
 *  spaces are dropped, so "Notes " writes the heading a later "Notes" finds. */
const headingWithNewestFirstSuffix = (sectionName: string): string => {
  const trimmedName = sectionName.trimEnd()

  return trimmedName.toLowerCase().endsWith("(newest first)")
    ? trimmedName
    : `${trimmedName} (newest first)`
}

/** Matches runs of non-alphanumeric characters (replaced with hyphens in kebab-case). */
const NON_ALPHANUMERIC_RUN_PATTERN = /[^a-z0-9]+/g

/** Matches a leading or trailing hyphen left over after kebab-case replacement. */
const LEADING_TRAILING_HYPHEN_PATTERN = /^-|-$/g

/** Converts a string to kebab-case for use as a tag. */
const toKebabCase = (text: string): string => {
  return text
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN_PATTERN, "-")
    .replace(LEADING_TRAILING_HYPHEN_PATTERN, "")
}

// ── Types ───────────────────────────────────────────────────────

type MemoryHeading = Readonly<{
  level: 1 | 2
  text: string
  entry_count?: number
}>

/** How a memory file's entries may be maintained. Append-only is the layer's
 *  default: entries are never edited or deleted, and corrections arrive as new
 *  dated entries. A file declares `entry-policy: living` in frontmatter when it
 *  is a current-state snapshot (e.g. a Routines file) — there, expired entries
 *  are pruned rather than left as history, so agents must not assume its
 *  timeline is complete. */
export type MemoryEntryPolicy = "append-only" | "living"

/** Resolves a frontmatter `entry-policy` value to a policy, treating anything
 *  other than the explicit "living" opt-in (missing, misspelled, wrong type)
 *  as the append-only default — the safe reading, since append-only forbids
 *  destructive maintenance. */
const entryPolicyFromFrontmatter = (value: unknown): MemoryEntryPolicy => {
  return value === "living" ? "living" : "append-only"
}

export type MemoryFileOutline = Readonly<{
  file: string
  title: string
  bytes: number
  entry_policy: MemoryEntryPolicy
  leading_callout: LeadingCallout | null
  headings: MemoryHeading[]
}>

/** What an updateMemory call did — lets the tool layer tailor its confirmation
 *  (e.g. nudge the caller to fill in a new file's scope callout, or report
 *  that an identical entry already existed and nothing was written). */
type UpdateMemoryOutcome = "created-file" | "created-section" | "appended" | "unchanged"

type ParsedSection = Readonly<{
  heading: string
  level: 1 | 2
  startLine: number
  bodyStartLine: number
  bodyEndLine: number
  entryCount: number
}>

// ── Internal helpers ────────────────────────────────────────────

/** Walks section body lines with fence/comment awareness and returns the
 *  0-based offsets of genuine entry bullets (lines matching ENTRY_PATTERN that
 *  are not inside a code fence or %% comment). Used by updateMemory's insertion
 *  scan, deleteMemory's bullet match, and parseSections' entry count — all three
 *  must agree on what counts as a real entry. */
const scanGenuineEntryOffsets = (bodyLines: readonly string[]): number[] => {
  const offsets: number[] = []
  // Loop-carried parser state — each iteration reads the previous
  // iteration's fence/comment position (same pattern as parseMemoryEntries).
  let scanFence: OpenFence = null
  let scanCommentOpen = false

  // - Fence and comment detection are mutually exclusive: fence state is
  //   skipped inside comments, and comment state is skipped inside fences.
  // - Empty lines advance the state too, because an empty line ends a fence
  //   opened inside a blockquote, and parseMemoryEntries reads them the same way.
  for (const [offsetIndex, bodyLine] of bodyLines.entries()) {
    const fenceResult: ReturnType<typeof advanceFence> | null = scanCommentOpen
      ? null
      : advanceFence(bodyLine, scanFence)
    scanFence = fenceResult ? fenceResult.openFence : scanFence

    const commentResult: CommentResult | null = fenceResult?.lineIsCode
      ? null
      : advanceComment(bodyLine, scanCommentOpen)
    scanCommentOpen = commentResult ? commentResult.commentOpen : scanCommentOpen

    const insideCodeOrComment =
      (fenceResult?.lineIsCode ?? false) || (commentResult?.lineIsComment ?? false)

    if (insideCodeOrComment) continue

    if (ENTRY_PATTERN.test(bodyLine)) {
      offsets.push(offsetIndex)
    }
  }

  return offsets
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
const parseSections = (lines: readonly string[]): ParsedSection[] => {
  const sections: ParsedSection[] = []
  for (const heading of parseHeadings(lines)) {
    if (heading.level !== 1 && heading.level !== 2) continue
    sections.push({
      heading: heading.text,
      level: heading.level,
      startLine: heading.startLine,
      bodyStartLine: heading.bodyStartLine,
      bodyEndLine: heading.bodyEndLine,
      entryCount:
        heading.level === 2
          ? scanGenuineEntryOffsets(lines.slice(heading.bodyStartLine, heading.bodyEndLine)).length
          : 0,
    })
  }
  return sections
}

/** Case-insensitive section lookup by heading text. */
const findSection = (
  sections: readonly ParsedSection[],
  sectionName: string,
  level: 1 | 2,
): ParsedSection | undefined => {
  // Memory headings are canonically suffixed "(newest first)"; resolve the
  // caller's name to that form so a short name matches the stored heading
  // (and update_memory doesn't append a duplicate section).
  const normalizedSectionName = headingWithNewestFirstSuffix(sectionName).trim().toLowerCase()
  return sections.find((section) => {
    return section.level === level && section.heading.toLowerCase() === normalizedSectionName
  })
}

/** Matches the HTML character entities the decoder understands — decimal
 *  ("&#38;"), hex ("&#x26;"), and the common named forms — capturing the
 *  entity body between "&" and ";". */
const HTML_ENTITY_PATTERN = /&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi

/** Replacement values for the named entities in HTML_ENTITY_PATTERN. */
const NAMED_ENTITY_VALUES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/** Decodes the common HTML character entities (named, decimal, and hex) that
 *  agents occasionally introduce into section names (e.g. "&amp;" for "&").
 *  Used only to *detect* near-duplicate section names — stored headings are
 *  never rewritten. Decoding is a single pass over the input, so produced
 *  text is never re-scanned ("&amp;lt;" yields the literal "&lt;", not "<" —
 *  double-unescaping would misread deliberately double-encoded names). An
 *  out-of-range numeric entity is left as-is rather than thrown on: this
 *  feeds a similarity comparison, not a renderer. */
const decodeBasicHtmlEntities = (text: string): string => {
  return text.replace(HTML_ENTITY_PATTERN, (entity, entityBody: string) => {
    const loweredEntityBody = entityBody.toLowerCase()

    if (loweredEntityBody.startsWith("#x")) {
      const codePoint = Number.parseInt(loweredEntityBody.slice(2), 16)
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity
    }
    if (loweredEntityBody.startsWith("#")) {
      const codePoint = Number(loweredEntityBody.slice(1))
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity
    }
    return NAMED_ENTITY_VALUES[loweredEntityBody] ?? entity
  })
}

/** Matches the canonical "(newest first)" suffix at the end of a section
 *  name, with any surrounding whitespace. */
const NEWEST_FIRST_SUFFIX_PATTERN = /\s*\(newest first\)\s*$/i

/** Canonical comparison form for near-duplicate detection: entity decoding,
 *  case folding, whitespace collapsing, and the "(newest first)" suffix
 *  stripped — so an entity-encoded or lightly mangled name lands next to the
 *  heading it was meant to be, and edit distances measure the meaningful part
 *  of the name rather than the shared suffix. Deliberately broader than
 *  findSection's own normalization — the matcher stays strict; only the
 *  create-guard uses this looser fold. */
const sectionComparisonForm = (sectionName: string): string => {
  return decodeBasicHtmlEntities(sectionName)
    .toLowerCase()
    .replace(NEWEST_FIRST_SUFFIX_PATTERN, "")
    .trim()
    .replace(/\s+/g, " ")
}

/** Matches every digit run so the near-miss guard can exempt sections that
 *  differ only in their numbers ("2025" vs "2026"). */
const DIGIT_RUN_PATTERN = /\d+/g

/** Edit-distance budget for fuzzy near-miss detection, scaled to the shorter
 *  of the two names (canonical suffix excluded). Very short names get no
 *  fuzzy budget — "A" and "B" are distinct sections, not typos of each other
 *  — while long prose headings tolerate the common slips (dropped letter,
 *  stray plural, transposed pair). */
const nearMissEditBudget = (shorterNameLength: number): number => {
  if (shorterNameLength <= 3) return 0
  if (shorterNameLength <= 7) return 1
  return 2
}

/** Finds an existing H2 section whose heading the requested name is likely a
 *  mangled form of — an HTML-entity slip, a case/whitespace/suffix variation,
 *  or a typo within the length-scaled edit budget. Names that differ only in
 *  digits are deliberately NOT near misses: numeric pairs ("2025" / "2026")
 *  are how distinct year- or version-named sections legitimately coexist. */
const findNearMissSection = (
  sections: readonly ParsedSection[],
  sectionName: string,
): ParsedSection | undefined => {
  const requestedForm = sectionComparisonForm(sectionName)
  const requestedFormWithoutDigits = requestedForm.replace(DIGIT_RUN_PATTERN, "")
  const isNearMissOfRequested = (section: ParsedSection): boolean => {
    if (section.level !== 2) return false
    const existingForm = sectionComparisonForm(section.heading)

    // Catches what findSection's stricter normalization misses — e.g.
    // "&amp;" decoded to "&", or extra whitespace collapsed.
    if (existingForm === requestedForm) return true
    const differsOnlyInDigits =
      existingForm.replace(DIGIT_RUN_PATTERN, "") === requestedFormWithoutDigits

    if (differsOnlyInDigits) return false
    const shorterNameLength = Math.min(existingForm.length, requestedForm.length)
    const editBudget = nearMissEditBudget(shorterNameLength)

    if (editBudget === 0) return false
    return levenshteinDistance(existingForm, requestedForm) <= editBudget
  }
  return sections.find(isNearMissOfRequested)
}

/** Comma-joined H2 headings for error messages — mirrors the heading
 *  parser's "Available headings" remediation so a caller can self-correct
 *  without a second lookup call. */
const listSectionHeadings = (sections: readonly ParsedSection[]): string => {
  const sectionHeadings = sections
    .filter((section) => section.level === 2)
    .map((section) => section.heading)
    .join(", ")
  return sectionHeadings || "(none)"
}

// ── Factory ────────────────────────────────────────────────────

export const createMemoryStore = (options: { memoryDir: string }) => {
  const { memoryDir } = options

  /** Large memory folders must not exhaust file handles by reading every file at once. */
  const memoryReadConcurrency = 16

  /** True for the .md entries the memory layer serves — excludes dot-prefixed
   *  (hidden) filenames so a pre-existing hidden file on disk never leaks
   *  through the no-file read or the list surfaces, mirroring the write-side
   *  rejection in memoryFilePath. */
  const isVisibleMemoryFile = (filename: string): boolean => {
    return filename.endsWith(".md") && !filename.startsWith(".")
  }

  /** Reads the memory folder's direct entries.
   *  - Returns [] when the folder does not exist yet.
   *  - Throws with the folder's vault-relative path on any other failure,
   *    such as a file sitting where the folder belongs. The raw error names
   *    the server's absolute path, so it goes to the log instead. */
  const readMemoryFolderEntries = async (vaultPath: string, logger: Logger): Promise<Dirent[]> => {
    try {
      return await readdir(join(vaultPath, memoryDir), { withFileTypes: true })
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) return []

      logger.warn("cannot list memory folder", { folder: memoryDir, error: describeError(error) })
      throw new Error(`cannot list memory folder "${memoryDir}"`, { cause: error })
    }
  }

  /** The memory folder's visible .md files as sorted filenames ("Opinions.md").
   *  Reads each entry's type, because a folder named "Archive.md" passes the
   *  name test and would fail every read; a symlink is kept only when it
   *  points at a file, as the vault listings do. Returns [] when the memory
   *  folder does not exist. */
  const listVisibleMemoryFilenames = async (
    vaultPath: string,
    logger: Logger,
  ): Promise<string[]> => {
    const entries = await readMemoryFolderEntries(vaultPath, logger)
    const namedEntries = entries.filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && isVisibleMemoryFile(entry.name),
    )
    const readableEntries = await filterValidSymlinks({
      entries: namedEntries,
      normalizedRoot: resolve(vaultPath),
      logger,
    })
    return readableEntries.map((entry) => entry.name).toSorted()
  }

  /** Reads a file the listing returned. A failure throws with the file's
   *  vault-relative path; the raw error names the server's absolute path, so
   *  it goes to the log instead. */
  const readListedMemoryFile = async (
    params: { vaultPath: string; filename: string },
    logger: Logger,
  ): Promise<string> => {
    try {
      return await readFile(join(params.vaultPath, memoryDir, params.filename), "utf8")
    } catch (error) {
      logger.warn("cannot read memory file", { file: params.filename, error: describeError(error) })
      throw new Error(`cannot read memory file "${memoryDir}/${params.filename}"`, { cause: error })
    }
  }

  /** Parses a memory file for its listing. A block that is not valid YAML
   *  reads as no properties, as Obsidian reads it, so one broken file does not
   *  hide the others; the refusal is logged with the file. */
  const parseMemoryFileForListing = (
    params: { content: string; filename: string },
    logger: Logger,
  ): ParsedNote => {
    const { data, content, unreadableBlockError } = parseNoteSkippingUnreadableBlock(params.content)

    if (unreadableBlockError) {
      logger.warn("memory file properties block unreadable", {
        file: params.filename,
        error: describeError(unreadableBlockError),
      })
    }
    return { data, content }
  }

  /** Serializes a memory file's edited body under its original properties
   *  block. The refusal of a file that would open with `---` lines is
   *  rethrown naming the file, because a caller asking by bare name cannot
   *  otherwise tell which file it was. */
  const joinMemoryFile = (params: {
    textBeforeBody: string
    body: string
    filename: string
  }): string => {
    try {
      return joinNoteKeepingBlock({ textBeforeBody: params.textBeforeBody, body: params.body })
    } catch (error) {
      if (!(error instanceof UnkeepableOpeningBlockError)) throw error

      throw new UnkeepableOpeningBlockError(
        `memory file "${memoryDir}/${params.filename}": ${error.message}`,
        { cause: error },
      )
    }
  }

  // A memory file is a bare name, never a path, and every memory path built
  // from a caller's name goes through this one check:
  // - a separator would let a name like "../../outside" escape the memory
  //   directory (and the vault);
  // - a dot-prefixed name would create a hidden file, invisible in Obsidian
  //   and left out of listings and the index (memory paths are joined
  //   directly, so resolveSafePath's hidden-path guard never sees them);
  // - a name ending in .md, in any letter case, already carries the
  //   extension and would get a second one, creating "Opinions.md.md" beside
  //   "Opinions.md".
  const memoryFilePath = (vaultPath: string, file: string): string => {
    if (file.includes("/") || file.includes("\\")) {
      throw new Error(`memory file must be a bare name without path separators: "${file}"`)
    }
    if (file.startsWith(".")) {
      throw new Error(`memory file must not start with a dot: "${file}" would be a hidden file`)
    }
    if (file.toLowerCase().endsWith(".md")) {
      throw new Error(`memory file must be named without .md: "${file}"`)
    }
    return join(vaultPath, memoryDir, `${file}.md`)
  }

  /** The first path on the way to the memory folder, from the vault root,
   *  that exists but is not a folder. Undefined when each path is a folder or
   *  missing; one can be missing after mkdir failed because it changed since,
   *  or because a symlink there points nowhere. */
  const findMemoryFolderBlocker = async (vaultPath: string): Promise<string | undefined> => {
    // "Meta/About Me" → ["Meta", "Meta/About Me"]
    const folderSegments = memoryDir.split("/")
    const foldersFromRoot = folderSegments.map((_, index) => {
      return folderSegments.slice(0, index + 1).join("/")
    })

    for (const folder of foldersFromRoot) {
      const folderStats = await statOrNull(join(vaultPath, folder))

      if (folderStats && !folderStats.isDirectory()) return folder
    }
    return undefined
  }

  type MemoryTemplateSpec = {
    fileName: string
    title: string
    tag: string
    entryPolicy: MemoryEntryPolicy
    related: string[]
    scope: string
    sections: string[]
  }

  const MEMORY_TEMPLATE_SPECS: readonly MemoryTemplateSpec[] = [
    {
      fileName: "Me",
      title: "Me",
      tag: "identity",
      entryPolicy: "append-only",
      related: ["Opinions", "Principles", "Routines", "Agents"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Identity, interests, and durable context about the user — who they are, what they're into, situational facts.",
        "> **Does NOT contain:** Opinions or preferences (→ Opinions), guiding principles (→ Principles), recurring routines (→ Routines), directives for AI agents (→ Agents).",
        '> **Section structure:** H2 sections grouped by theme, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only. Entry policy: append-only (declared in frontmatter).",
      ].join("\n"),
      sections: ["Identity (newest first)", "Interests (newest first)", "Context (newest first)"],
    },
    {
      fileName: "Opinions",
      title: "Opinions",
      tag: "opinions",
      entryPolicy: "append-only",
      related: ["Principles", "Me", "Agents"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Evolving views on tools, patterns, methods, and processes — stances that may shift over time.",
        "> **Does NOT contain:** Stable values or decision heuristics (→ Principles), identity or interests (→ Me), directives for AI agents (→ Agents).",
        '> **Section structure:** H2 sections by topic, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only. Entry policy: append-only (declared in frontmatter).",
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
      entryPolicy: "append-only",
      related: ["Opinions", "Me", "Agents"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Stable values, decision heuristics, and non-negotiables — how the user thinks and what they hold firm.",
        "> **Does NOT contain:** Evolving opinions on tools or methods (→ Opinions), identity facts (→ Me), directives for AI agents (→ Agents).",
        '> **Section structure:** H2 sections by theme, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only. Entry policy: append-only (declared in frontmatter).",
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
      entryPolicy: "living",
      related: ["Me", "Agents"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Active commitments, upcoming plans, recurring rhythms, and recent-past events kept for context — the time-sensitive logistics of the user's current life. A **current-state snapshot**, not a history ledger.",
        "> **Does NOT contain:** One-off events or reference material, identity facts (→ Me), principles (→ Principles), directives for AI agents (→ Agents).",
        '> **Section structure:** H2 sections by cadence, each suffixed "(newest first)".',
        "> **Convention:** append newest first; ISO dates only. Entry policy: **living** (declared in frontmatter) — a deliberate exception to the memory layer's append-only default. When an Upcoming or Active commitments entry expires, delete it and, if the outcome is worth keeping, append it to Recent past. Recent past entries are dated history and are not pruned.",
      ].join("\n"),
      sections: [
        "Active commitments (newest first)",
        "Upcoming (newest first)",
        "Daily/weekly rhythm (newest first)",
        "Recent past (newest first)",
      ],
    },
    {
      fileName: "Agents",
      title: "Agents",
      tag: "agents",
      entryPolicy: "append-only",
      related: ["Me", "Principles", "Opinions", "Routines"],
      scope: [
        "> [!info] Scope of this file",
        "> **Contains:** Directives for AI agents working with the user — how to communicate, how to run work, and how to verify and scope changes. The subject of every entry is *agent behavior*; if an entry states a fact about the user, it belongs in another memory file.",
        "> **Does NOT contain:** Identity facts (→ Me), the user's values (→ Principles), their evolving stances on tools (→ Opinions), current-life logistics (→ Routines).",
        '> **Section structure:** H2 sections by domain, each suffixed "(newest first)".',
        "> **Convention:** append newest first; never overwrite dated entries; ISO dates only. Entry policy: append-only (declared in frontmatter).",
      ].join("\n"),
      sections: [
        "Communication (newest first)",
        "Working style (newest first)",
        "Verification & scope (newest first)",
      ],
    },
  ]

  /** Renders a memory template with the current timestamp so bootstrapped files
   *  carry a `created` property from the moment the server first seeds them. */
  const renderMemoryTemplate = (
    spec: MemoryTemplateSpec,
    created: string,
  ): { fileName: string; content: string } => {
    return {
      fileName: spec.fileName,
      content: [
        "---",
        `title: ${spec.title}`,
        `created: ${created}`,
        "type: profile",
        `entry-policy: ${spec.entryPolicy}`,
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
    }
  }

  /** Reads one memory file by bare name.
   *  - Returns null when no file is there. That covers nothing at the path, a
   *    memory folder that is itself a file, and a folder named like the file.
   *  - Any other failure throws with the file's vault-relative path. The raw
   *    error names the server's absolute path, so it goes to the log instead.
   *    The thrown error carries no Node code, so the tool boundary adds no
   *    remedy to it. */
  const readMemoryFileOrNull = async (
    params: { vaultPath: string; file: string },
    logger: Logger,
  ): Promise<string | null> => {
    const filePath = memoryFilePath(params.vaultPath, params.file)
    const filename = `${params.file}.md`
    try {
      return await readFileOrNull(filePath)
    } catch (error) {
      logger.warn("cannot read memory file", { file: filename, error: describeError(error) })
      throw new Error(`cannot read memory file "${memoryDir}/${filename}"`, { cause: error })
    }
  }

  /** Like readMemoryFileOrNull, but a missing file throws the vault-relative
   *  not-found error. */
  const readMemoryFile = async (
    params: { vaultPath: string; file: string },
    logger: Logger,
  ): Promise<string> => {
    const content = await readMemoryFileOrNull(params, logger)

    if (content === null) {
      throw new Error(`memory file not found: "${memoryDir}/${params.file}.md"`)
    }
    return content
  }

  /** Resolves a named H2 section, throwing with the file's available headings
   *  when none matches. Shared so the section, entries, and delete reads
   *  resolve a section name by the same rules. */
  const resolveSection = ({
    lines,
    section,
    file,
  }: {
    lines: readonly string[]
    section: string
    file: string
  }): ParsedSection => {
    const sections = parseSections(lines)
    const match = findSection(sections, section, 2)

    if (!match) {
      throw new Error(
        `section not found: "${section}" in ${memoryDir}/${file}.md. Available sections: ${listSectionHeadings(sections)}`,
      )
    }
    return match
  }

  /** Selects the entries belonging to a named H2 section. Sections and entries
   *  both read H2 heading text through parseHeadings, so an entry's section
   *  text equals the resolved heading exactly. */
  const entriesInSection = ({
    lines,
    entries,
    section,
    file,
  }: {
    lines: readonly string[]
    entries: readonly MemoryEntry[]
    section: string
    file: string
  }): MemoryEntry[] => {
    const match = resolveSection({ lines, section, file })
    return entries.filter((entry) => entry.section === match.heading)
  }

  /** Builds a new memory file with frontmatter, H1 title, H2 section, and initial entry. */
  const buildNewMemoryFile = (params: {
    fileName: string
    section: string
    bullet: string
  }): string => {
    const created = DateTime.now().toISO()

    if (!created) {
      throw new Error("DateTime.now().toISO() returned null")
    }
    const frontmatter = {
      title: params.fileName,
      type: "profile",
      // Programmatically-created files get the safe default; a user opts a
      // file into "living" by editing the property deliberately.
      "entry-policy": "append-only",
      tags: ["memory", toKebabCase(params.fileName)],
      created,
    }
    // New file names have no known scope, so seed a placeholder for the caller.
    // Known bootstrap files use the scopes in MEMORY_TEMPLATE_SPECS.
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
    params: {
      vaultPath: string
      file?: string | undefined
      section?: string | undefined
    },
    logger: Logger,
  ): Promise<string> => {
    if (!params.file) {
      const mdFiles = await listVisibleMemoryFilenames(params.vaultPath, logger)
      const contents = await mapWithConcurrency({
        items: mdFiles,
        concurrency: memoryReadConcurrency,
        mapper: async (filename) => {
          const raw = await readListedMemoryFile({ vaultPath: params.vaultPath, filename }, logger)
          return splitPropertiesBlock(raw).body.trim()
        },
      })
      logger.info("get memory", { mode: "all", fileCount: mdFiles.length })
      return contents.join("\n\n---\n\n")
    }

    const raw = await readMemoryFile({ vaultPath: params.vaultPath, file: params.file }, logger)
    const fileBody = splitPropertiesBlock(raw).body

    if (!params.section) {
      logger.info("get memory", { mode: "file", file: params.file })
      return fileBody.trim()
    }

    const lines = splitIntoLines(fileBody)
    const match = resolveSection({ lines, section: params.section, file: params.file })

    // Extract only the lines between this heading and the next
    const body = lines.slice(match.bodyStartLine, match.bodyEndLine).join("\n").trim()
    logger.info("get memory", {
      mode: "section",
      file: params.file,
      section: params.section,
    })
    return body
  }

  const getMemoryEntries = async (
    params: {
      vaultPath: string
      file: string
      section?: string | undefined
      onOrAfter?: string | undefined
    },
    logger: Logger,
  ): Promise<MemoryEntry[]> => {
    const { onOrAfter } = params

    if (onOrAfter && !isValidMemoryEntryDate(onOrAfter)) {
      throw new Error(INVALID_MEMORY_ENTRY_DATE_MESSAGE)
    }

    const raw = await readMemoryFile({ vaultPath: params.vaultPath, file: params.file }, logger)
    const lines = splitIntoLines(splitPropertiesBlock(raw).body)

    // parseMemoryEntries returns every H2 entry in document order, each
    // carrying its verbatim section heading — so an omitted section is every
    // entry in the file, with no second heading scan needed.
    const allEntries = parseMemoryEntries(lines)

    const scopedEntries = params.section
      ? entriesInSection({ lines, entries: allEntries, section: params.section, file: params.file })
      : allEntries

    // YYYY-MM-DD strings sort lexicographically in chronological order;
    // onOrAfter is validated above, and entry dates are YYYY-MM-DD by construction.
    const filteredEntries = onOrAfter
      ? scopedEntries.filter((entry) => entry.date >= onOrAfter)
      : scopedEntries

    logger.info("get memory entries", {
      file: params.file,
      section: params.section ?? null,
      onOrAfter,
      totalInScope: scopedEntries.length,
      returned: filteredEntries.length,
    })

    return filteredEntries
  }

  const updateMemory = async (
    params: {
      vaultPath: string
      file: string
      section: string
      entry: string
      date?: string | undefined
      position?: "top" | "bottom" | undefined
    },
    logger: Logger,
  ): Promise<UpdateMemoryOutcome> => {
    // Memory entries are single dated bullets. A multiline entry would write
    // a block that neither the duplicate guard below nor deleteMemory's
    // exact line match can ever see — reject loudly at the boundary instead
    // of writing an entry the memory tools can't detect or delete.
    if (MEMORY_ENTRY_LINE_BREAK_PATTERN.test(params.entry)) {
      throw new Error(
        "entry must be a single line: memory entries are single dated bullets — collapse newlines or append multiple entries",
      )
    }
    // An omitted date is fine (it defaults to today below); anything supplied
    // that isn't a real bare YYYY-MM-DD date (a line break, a timestamp, free
    // text, an impossible calendar value) would corrupt the bullet the same
    // way a multiline entry does.
    if (!isValidMemoryEntryDate(params.date)) {
      throw new Error(INVALID_MEMORY_ENTRY_DATE_MESSAGE)
    }
    // A section name with a line break would write a corrupted multi-line
    // "## heading" that findSection can never match again — every subsequent
    // call would append yet another broken section instead of reaching the
    // duplicate guard, so reject it at the boundary like entry and date.
    if (MEMORY_ENTRY_LINE_BREAK_PATTERN.test(params.section)) {
      throw new Error(
        "section must be a single line: section names become H2 headings — remove line breaks",
      )
    }
    assertNoControlCharacters(params.entry, "entry")
    assertNoControlCharacters(params.section, "section")
    // Serialize the read-modify-write so concurrent appends to the same file
    // don't clobber each other's entries (lost update).
    return withFileLock(memoryFilePath(params.vaultPath, params.file), async () => {
      const date = params.date ?? DateTime.now().toISODate()
      const position = params.position ?? "top"
      const bullet = `- **${date}**: ${params.entry}`

      const existingContent = await readMemoryFileOrNull(
        { vaultPath: params.vaultPath, file: params.file },
        logger,
      )

      // File does not exist — create directory + file with section and entry
      if (existingContent === null) {
        const newSection = headingWithNewestFirstSuffix(params.section)
        const filePath = memoryFilePath(params.vaultPath, params.file)
        // The read reports a folder at the path as no file. The write below
        // renames over the path, which would replace a symlink that points
        // at a folder, so the write stops when the path leads to anything
        // but a file.
        const occupant = await statOrNull(filePath)

        if (occupant && !occupant.isFile()) {
          throw new Error(
            `cannot write memory file "${memoryDir}/${params.file}.md": that path is not a file`,
          )
        }

        try {
          await mkdir(dirname(filePath), { recursive: true })
        } catch (error) {
          // The folder is server configuration (MEMORY_DIR), so anything in
          // its way is the vault owner's to fix, not the caller's. mkdir
          // reports a file at the folder's own path as EEXIST, a file at a
          // folder above it as ENOTDIR, and a broken symlink at its path as
          // ENOENT:
          // - those failures are wrapped without their code, because the tool
          //   boundary's remedies for them tell the caller to choose another
          //   path or to retry; the memory tools' Errors entry names the
          //   owner's fix instead;
          // - other failures keep their code, so the tool boundary appends
          //   its remedy.
          const folderPathBlocked =
            isErrnoException(error, "EEXIST") ||
            isErrnoException(error, "ENOTDIR") ||
            isErrnoException(error, "ENOENT")

          if (!folderPathBlocked) throw error

          // MEMORY_DIR can be nested, and mkdir does not say which folder on
          // the way is a file, so the message names it for the owner
          const blocker = await findMemoryFolderBlocker(params.vaultPath)
          const blockerClause = blocker ? `: "${blocker}" is not a folder` : ""

          logger.warn("cannot create memory folder", {
            folder: memoryDir,
            blocker,
            error: describeError(error),
          })
          throw new Error(`cannot create memory folder "${memoryDir}"${blockerClause}`, {
            cause: error,
          })
        }

        const content = buildNewMemoryFile({
          fileName: params.file,
          section: newSection,
          bullet,
        })
        await atomicWriteFile({ filePath, content }, logger)
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

      const { textBeforeBody, body } = splitNoteKeepingBlock(existingContent)
      const contentLines = splitIntoLines(body)
      const sections = parseSections(contentLines)
      const match = findSection(sections, params.section, 2)

      // File exists but section does not — append new H2 + entry at end
      if (!match) {
        // A missing section is normally created — but a name that is merely
        // a mangled form of an existing heading (entity slip, typo, spacing)
        // would silently fragment the file into near-duplicate sections,
        // with the new entry unreachable via the real heading. Explicit
        // rejection over silent normalization: refuse and name both
        // headings so the caller can self-correct.
        const nearMiss = findNearMissSection(sections, params.section)

        if (nearMiss) {
          throw new Error(
            `section not created: "${params.section}" is nearly identical to existing section "${nearMiss.heading}". Existing sections: ${listSectionHeadings(sections)}`,
          )
        }
        const newSection = headingWithNewestFirstSuffix(params.section)
        const appendedLines = [...contentLines, `## ${newSection}`, bullet]
        const newContent = appendedLines.join("\n")
        const serialized = joinMemoryFile({
          body: newContent,
          textBeforeBody,
          filename: `${params.file}.md`,
        })
        const beforeBytes = Buffer.byteLength(existingContent, "utf8")
        const afterBytes = Buffer.byteLength(serialized, "utf8")
        guardAgainstShrink(beforeBytes, afterBytes, "creating memory section")
        await atomicWriteFile(
          {
            filePath: memoryFilePath(params.vaultPath, params.file),
            content: serialized,
          },
          logger,
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

      const bodyLines = contentLines.slice(match.bodyStartLine, match.bodyEndLine)

      const entryLineOffsets = scanGenuineEntryOffsets(bodyLines)

      // Duplicate check scoped to genuine entries (not fenced lines).
      // An exact duplicate means the entry already landed, typically from an
      // MCP client retrying after a gateway timeout. The same bullet under a
      // different heading is a distinct entry and does not suppress the append.
      const isDuplicate = entryLineOffsets.some((offset) => bodyLines[offset] === bullet)

      if (isDuplicate) {
        logger.info("memory entry unchanged", {
          file: params.file,
          section: params.section,
          date,
          outcome: "unchanged",
        })
        return "unchanged"
      }

      const firstBulletOffset = entryLineOffsets.at(0)

      // "top" inserts before the first existing bullet (newest-first ordering).
      // "bottom" inserts at the section end, below any ### subsection in it;
      // lastBulletOffset + 1 can land inside the last entry's continuation lines.
      // Sections with no genuine entries fall back to bodyEndLine for both
      // positions. Offset 0 is a bullet on the section's first line, so the
      // check compares with undefined.
      const topInsertIndex =
        firstBulletOffset === undefined
          ? match.bodyEndLine
          : match.bodyStartLine + firstBulletOffset
      const bottomInsertIndex = match.bodyEndLine
      const insertIndex = position === "top" ? topInsertIndex : bottomInsertIndex

      // Splice the new bullet into the content lines
      const updatedLines = [
        ...contentLines.slice(0, insertIndex),
        bullet,
        ...contentLines.slice(insertIndex),
      ]

      const newContent = updatedLines.join("\n")
      const serialized = joinMemoryFile({
        body: newContent,
        textBeforeBody,
        filename: `${params.file}.md`,
      })
      const beforeBytes = Buffer.byteLength(existingContent, "utf8")
      const afterBytes = Buffer.byteLength(serialized, "utf8")
      guardAgainstShrink(beforeBytes, afterBytes, "updating memory entry")
      await atomicWriteFile(
        {
          filePath: memoryFilePath(params.vaultPath, params.file),
          content: serialized,
        },
        logger,
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
  }

  const listMemoryFiles = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<MemoryFileOutline[]> => {
    const mdFiles = await listVisibleMemoryFilenames(params.vaultPath, logger)
    const outlines = await mapWithConcurrency({
      items: mdFiles,
      concurrency: memoryReadConcurrency,
      mapper: async (filename) => {
        const raw = await readListedMemoryFile({ vaultPath: params.vaultPath, filename }, logger)
        const parsed = parseMemoryFileForListing({ content: raw, filename }, logger)
        const name = basename(filename, ".md")
        const title = isString(parsed.data.title) ? parsed.data.title : name
        const lines = splitIntoLines(parsed.content)
        const leadingCallout = parseLeadingCallout(lines)
        const sections = parseSections(lines)

        const headings: MemoryHeading[] = sections.map((section) => {
          return section.level === 1
            ? { level: 1 as const, text: section.heading }
            : {
                level: 2 as const,
                text: section.heading,
                entry_count: section.entryCount,
              }
        })

        const bytes = Buffer.byteLength(raw, "utf8")
        return {
          file: name,
          title,
          bytes,
          entry_policy: entryPolicyFromFrontmatter(parsed.data["entry-policy"]),
          leading_callout: leadingCallout,
          headings,
        }
      },
    })

    logger.info("listed memory files", { count: outlines.length })
    return outlines
  }

  /** Lists memory file names (without .md), sorted. Cheap by design — a
   *  readdir, filter, and symlink check with no file-content reads or parsing
   *  — so it's safe to call on a hot path like prompt-arg autocomplete, which
   *  fires per keystroke. */
  const listMemoryFileNames = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<string[]> => {
    const mdFiles = await listVisibleMemoryFilenames(params.vaultPath, logger)
    const names = mdFiles.map((filename) => basename(filename, ".md"))
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
  ): Promise<void> => {
    // A date of any other shape can never match an entry, so it is refused
    // up front instead of ending in a guaranteed "no entry matching" miss.
    if (!MEMORY_ENTRY_DATE_SHAPE.test(params.date)) {
      throw new Error("date must be YYYY-MM-DD (e.g. 2026-07-02)")
    }
    // Serialize with concurrent updates/deletes to the same file so the
    // read-modify-write can't be interleaved and lose a write.
    return withFileLock(memoryFilePath(params.vaultPath, params.file), async () => {
      const raw = await readMemoryFile({ vaultPath: params.vaultPath, file: params.file }, logger)
      const { textBeforeBody, body } = splitNoteKeepingBlock(raw)
      const lines = splitIntoLines(body)
      const match = resolveSection({ lines, section: params.section, file: params.file })

      // Find the target bullet among genuine (non-fenced) entry lines.
      const targetBullet = `- **${params.date}**: ${params.entry}`
      const sectionBodyLines = lines.slice(match.bodyStartLine, match.bodyEndLine)
      const genuineEntryOffsets = scanGenuineEntryOffsets(sectionBodyLines)
      const matchingOffsets = genuineEntryOffsets.filter(
        (offset) => sectionBodyLines[offset] === targetBullet,
      )

      if (matchingOffsets.length === 0) {
        throw new Error(
          `no entry matching (${params.date}, "${params.entry}") under ## ${match.heading} in ${memoryDir}/${params.file}.md`,
        )
      }
      if (matchingOffsets.length > 1) {
        throw new Error(
          `ambiguous: ${matchingOffsets.length} entries match (${params.date}, "${params.entry}") under ## ${match.heading} in ${memoryDir}/${params.file}.md`,
        )
      }

      // Remove the matched entry's full span (bullet + continuation lines),
      // not just the bullet — leaving continuations would fold them into the
      // preceding entry's text.
      const matchOffset = matchingOffsets[0]

      // The length checks above guarantee exactly one element; TypeScript
      // cannot narrow an indexed access after a length check.
      if (matchOffset === undefined) {
        throw new Error("expected at least one matching offset")
      }

      // Find the end of this entry's span: the next entry, or the section's
      // end when this is the last entry. A deeper heading (### and below)
      // before that ends it too, as parseMemoryEntries ends an entry there, so
      // the subsection it opens is not deleted with the entry.
      const matchIndex = match.bodyStartLine + matchOffset
      const matchPosition = genuineEntryOffsets.indexOf(matchOffset)
      const nextEntryOffset = genuineEntryOffsets[matchPosition + 1]
      const nextEntryOrSectionEnd =
        nextEntryOffset !== undefined ? match.bodyStartLine + nextEntryOffset : match.bodyEndLine
      const nextSubheading = parseHeadings(lines).find(
        (heading) => heading.startLine > matchIndex && heading.startLine < nextEntryOrSectionEnd,
      )
      const rawSpanEnd = nextSubheading?.startLine ?? nextEntryOrSectionEnd

      // Trim trailing blank lines from the span — they separate sections
      // or entries visually and don't belong to the deleted entry.
      let trimmedSpanEnd = rawSpanEnd

      while (trimmedSpanEnd > matchIndex + 1 && lines[trimmedSpanEnd - 1]?.trim() === "") {
        trimmedSpanEnd--
      }
      const updatedLines = [...lines.slice(0, matchIndex), ...lines.slice(trimmedSpanEnd)]

      const newContent = updatedLines.join("\n")
      const serialized = joinMemoryFile({
        body: newContent,
        textBeforeBody,
        filename: `${params.file}.md`,
      })
      const beforeBytes = Buffer.byteLength(raw, "utf8")
      const afterBytes = Buffer.byteLength(serialized, "utf8")
      guardAgainstShrink(beforeBytes, afterBytes, "deleting memory entry")
      await atomicWriteFile(
        {
          filePath: memoryFilePath(params.vaultPath, params.file),
          content: serialized,
        },
        logger,
      )
      logger.info("deleted memory entry", {
        file: params.file,
        section: params.section,
        date: params.date,
        beforeBytes,
        afterBytes,
      })
    })
  }

  /** Idempotent — seeds the memory directory with template files on first boot. */
  const bootstrapMemoryDir = async (
    params: { vaultPath: string },
    logger: Logger,
  ): Promise<void> => {
    const dirPath = join(params.vaultPath, memoryDir)
    try {
      await access(dirPath, constants.F_OK)
      return
    } catch (err) {
      if (!isErrnoException(err, "ENOENT")) throw err
    }
    await mkdir(dirPath, { recursive: true })
    const created = DateTime.now().toISO()

    if (!created) {
      throw new Error("DateTime.now().toISO() returned null")
    }
    const templates = MEMORY_TEMPLATE_SPECS.map((spec) => {
      return renderMemoryTemplate(spec, created)
    })
    await Promise.all(
      templates.map((template) => {
        return atomicWriteFile(
          {
            filePath: join(dirPath, `${template.fileName}.md`),
            content: template.content,
          },
          logger,
        )
      }),
    )
    logger.info("bootstrapped memory directory", {
      memoryDir,
      fileCount: templates.length,
    })
  }

  return {
    getMemory,
    getMemoryEntries,
    updateMemory,
    listMemoryFiles,
    listMemoryFileNames,
    deleteMemory,
    bootstrapMemoryDir,
  }
}
