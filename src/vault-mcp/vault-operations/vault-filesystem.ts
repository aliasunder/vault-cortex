import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  unlink,
  rename,
  link,
  rm,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, dirname, relative, resolve } from "node:path"
import type { Dirent } from "node:fs"
import picomatch from "picomatch"
import { parseNote, stringifyNote, mergeFrontmatter } from "./frontmatter.js"
import { parseHeadings, findHeading } from "./heading-parser.js"
import { parseLeadingCallout } from "./callout-parser.js"
import type { LeadingCallout } from "./callout-parser.js"
import type { Logger } from "../../logger.js"

/** Resolves a note path within the vault, throwing on traversal attempts. */
export const resolveSafePath = (
  vaultPath: string,
  notePath: string,
): string => {
  const normalizedVault = resolve(vaultPath)
  const resolved = resolve(normalizedVault, notePath)
  if (!resolved.startsWith(normalizedVault + "/")) {
    throw new Error(`path traversal blocked: "${notePath}" escapes vault root`)
  }
  return resolved
}

/**
 * Writes a file atomically: stage to a unique temp file, then rename over the
 * target. `rename` is atomic on the same filesystem, so the target is never
 * truncated — readers (notably the obsidian-sync container) see either the old
 * content or the new content, never a 0-byte or partial write. This is the
 * core defense against the partial-write clobber class of bug.
 */
export const atomicWriteFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, content, "utf8")
    await rename(tmpPath, filePath)
  } catch (err) {
    // Best-effort cleanup so a failed write never strands a temp file. Swallow
    // any cleanup error so the original write/rename failure is still thrown.
    try {
      await rm(tmpPath, { force: true })
    } catch {
      // ignore — preserving the root-cause error below matters more
    }
    throw err
  }
}

/**
 * Creates a file atomically and exclusively: stage to a unique temp file, then
 * hard-`link` it onto the target. Unlike atomicWriteFile (which renames *over*
 * the target), `link` fails with EEXIST when the target already exists, so this
 * never clobbers — closing the check-then-write race when the destination must
 * be new (e.g. vault_move_note's destination). The content is fully staged before
 * the link, so the target appears atomically. The temp link is always removed,
 * leaving only the target on success.
 */
export const atomicCreateFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, content, "utf8")
    // Atomic no-clobber create: throws EEXIST if filePath already exists.
    await link(tmpPath, filePath)
  } finally {
    // Always drop the temp link — redundant on success (filePath is the durable
    // name), and never stranded on failure. Swallow cleanup errors so the
    // original failure (e.g. EEXIST) is what propagates.
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}

/** Reads a file, returning null instead of throwing on ENOENT. */
const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/** Reads a directory recursively, returning null instead of throwing on ENOENT. */
const readdirOrNull = async (path: string): Promise<Dirent[] | null> => {
  try {
    return await readdir(path, { recursive: true, withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/** Combines body + frontmatter into a gray-matter serialized string. Merges with existing frontmatter if file already exists; keys set to null are removed. */
const serializeNote = (
  existing: string | null,
  body: string,
  frontmatter?: Record<string, unknown>,
): string => {
  if (!existing)
    return stringifyNote(body, mergeFrontmatter({}, frontmatter ?? {}))

  const parsed = parseNote(existing)
  const mergedData = frontmatter
    ? mergeFrontmatter(parsed.data, frontmatter)
    : parsed.data
  return stringifyNote(body, mergedData)
}

// ── Exported functions ──────────────────────────────────────────

/** Reads a .md note by relative path. Returns raw content including frontmatter. */
const readNote = async (
  params: { vaultPath: string; path: string },
  logger: Logger,
): Promise<string> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  logger.info("read note", { path: params.path })
  return content
}

/** One heading in a note's outline: its level, text, and the byte size of its
 *  section (heading line through the next same-or-higher heading). */
export type HeadingOutline = Readonly<{
  level: number
  text: string
  bytes: number
}>

/** A note's outline: its optional leading callout (a top-of-file `> [!type]`
 *  block — info, warning, etc.) plus the heading tree. `leading_callout` is
 *  omitted when the note has none. */
export type NoteOutline = Readonly<{
  leading_callout?: LeadingCallout
  headings: HeadingOutline[]
}>

/**
 * Returns a note's heading tree (no bodies) — H1–H6 with each section's byte
 * size, so an agent can pick which section to read without pulling the whole
 * file — plus any leading callout (a top-of-file `> [!type]` block — info,
 * warning, etc.), so notable context or state is visible without a full read.
 * Frontmatter is excluded (line
 * ranges are body-relative, matching vault_patch_note). A note with no headings
 * returns an empty headings array.
 */
const readNoteOutline = async (
  params: { vaultPath: string; path: string },
  logger: Logger,
): Promise<NoteOutline> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  const lines = parseNote(content).content.split("\n")
  const leadingCallout = parseLeadingCallout(lines)
  const headings = parseHeadings(lines)
  const outline = headings.map((heading) => {
    // Section span = heading line through bodyEndLine (the same span a section
    // read returns), so the size hint matches what reading it would cost.
    const sectionText = lines
      .slice(heading.startLine, heading.bodyEndLine)
      .join("\n")
    return {
      level: heading.level,
      text: heading.text,
      bytes: Buffer.byteLength(sectionText, "utf8"),
    }
  })
  const totalBytes = outline.reduce((sum, section) => sum + section.bytes, 0)
  logger.info("read note outline", {
    path: params.path,
    headingCount: outline.length,
    hasCallout: leadingCallout !== null,
    totalBytes,
  })
  // Omit `leading_callout` when absent, rather than emitting `leading_callout: null`.
  return leadingCallout
    ? { leading_callout: leadingCallout, headings: outline }
    : { headings: outline }
}

/**
 * Returns a single section of a note: the heading line plus its body, through
 * the next heading of the same-or-higher level (child headings included) —
 * the exact span vault_patch_note targets. Frontmatter is excluded.
 */
const readNoteSection = async (
  params: {
    vaultPath: string
    path: string
    heading: string
    headingLevel?: number
  },
  logger: Logger,
): Promise<string> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  const lines = parseNote(content).content.split("\n")
  const headings = parseHeadings(lines)
  const target = findHeading(headings, params.heading, params.headingLevel)
  logger.info("read note section", {
    path: params.path,
    heading: target.text,
  })
  return lines.slice(target.startLine, target.bodyEndLine).join("\n")
}

/** Parses a note's YAML frontmatter and returns the properties as an object. */
const readNoteProperties = async (
  params: { vaultPath: string; path: string },
  logger: Logger,
): Promise<Record<string, unknown>> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  logger.info("read note properties", { path: params.path })
  return parseNote(content).data
}

/** Creates or updates a note. Merges frontmatter losslessly if the file exists. */
const writeNote = async (
  params: {
    vaultPath: string
    path: string
    body: string
    properties?: Record<string, unknown>
  },
  logger: Logger,
): Promise<void> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  await mkdir(dirname(fullPath), { recursive: true })

  const existing = await readFileOrNull(fullPath)
  const serialized = serializeNote(existing, params.body, params.properties)
  await atomicWriteFile(fullPath, serialized)
  logger.info("wrote note", {
    path: params.path,
    beforeBytes: existing ? Buffer.byteLength(existing, "utf8") : 0,
    afterBytes: Buffer.byteLength(serialized, "utf8"),
  })
}

/** Merges properties into an existing note's YAML frontmatter without touching the body. Keys set to null are removed. */
const updateProperties = async (
  params: {
    vaultPath: string
    path: string
    properties: Record<string, unknown>
  },
  logger: Logger,
): Promise<void> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const existing = await readFileOrNull(fullPath)
  if (existing === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  const parsed = parseNote(existing)
  const mergedProperties = mergeFrontmatter(parsed.data, params.properties)
  const serialized = stringifyNote(parsed.content, mergedProperties)
  await atomicWriteFile(fullPath, serialized)
  logger.info("updated properties", {
    path: params.path,
    beforeBytes: Buffer.byteLength(existing, "utf8"),
    afterBytes: Buffer.byteLength(serialized, "utf8"),
  })
}

/** Deletes a note. Rejects paths under the configured protected paths. */
const deleteNote = async (
  params: {
    vaultPath: string
    path: string
    protectedPaths: readonly string[]
  },
  logger: Logger,
): Promise<void> => {
  const protectedPrefixes = params.protectedPaths.map((folder) =>
    folder.endsWith("/") ? folder : `${folder}/`,
  )
  if (protectedPrefixes.some((prefix) => params.path.startsWith(prefix))) {
    throw new Error(
      `cannot delete protected path "${params.path}" (use vault_delete_memory for individual entries)`,
    )
  }

  const fullPath = resolveSafePath(params.vaultPath, params.path)
  await unlink(fullPath)
  logger.info("deleted note", { path: params.path })
}

/** Lists .md files under a folder (or vault root). Supports glob filtering. */
const listNotes = async (
  params: { vaultPath: string; folder?: string; glob?: string },
  logger: Logger,
): Promise<string[]> => {
  const searchRoot = params.folder
    ? resolveSafePath(params.vaultPath, params.folder)
    : resolve(params.vaultPath)
  const entries = await readdirOrNull(searchRoot)
  if (!entries) return []

  const normalizedVault = resolve(params.vaultPath)

  const paths = entries
    .reduce<string[]>((acc, entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".md")) return acc
      const rel = relative(normalizedVault, join(entry.parentPath, entry.name))
      if (rel.split("/").some((seg) => seg.startsWith("."))) return acc
      acc.push(rel)
      return acc
    }, [])
    .sort()

  const isMatch = params.glob ? picomatch(params.glob) : undefined
  const result = isMatch ? paths.filter((p) => isMatch(p)) : paths
  logger.info("listed notes", { folder: params.folder, count: result.length })
  return result
}

export const vaultFs = {
  readNote,
  readNoteOutline,
  readNoteSection,
  readNoteProperties,
  writeNote,
  updateProperties,
  deleteNote,
  listNotes,
}
