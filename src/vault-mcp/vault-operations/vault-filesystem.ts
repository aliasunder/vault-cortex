import {
  writeFile,
  readdir,
  mkdir,
  unlink,
  rename,
  link,
  rm,
  rmdir,
  realpath,
  stat,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, dirname, relative, resolve, posix } from "node:path"
import picomatch from "picomatch"
import { describeError } from "../../utils/describe-error.js"
import { readFileOrNull, readdirOrNull } from "../../utils/fs.js"
import {
  parseNote,
  stringifyNote,
  mergeFrontmatter,
} from "../obsidian-markdown/frontmatter.js"
import { parseHeadings, findHeading } from "../obsidian-markdown/headings.js"
import { parseLeadingCallout } from "../obsidian-markdown/callouts.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import type { Logger } from "../../logger.js"

/** Canonicalizes a path for the protected-path prefix check: converts Windows
 *  backslashes to forward slashes, then collapses "./" and "../" so a separator
 *  or traversal variant can't evade the check. Absolute or vault-escaping paths
 *  are left for resolveSafePath. */
export const toVaultRelativePath = (input: string): string =>
  posix.normalize(input.replace(/\\/g, "/"))

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
 * Removes the note's now-empty parent folders, walking up from the note's
 * directory toward — but never including — the vault root. Only a directory
 * with zero entries is removed, so a folder still holding any file (including a
 * hidden one like .DS_Store) is left in place and stops the walk.
 *
 * Best-effort cleanup: the delete/move that triggered it has already succeeded,
 * so a failure to remove a folder (permissions, a race, a vanished dir) is
 * logged and ends the walk rather than thrown — it never fails the tool call.
 * Returns the number of folders removed.
 */
export const pruneEmptyParents = async (
  params: { vaultPath: string; path: string },
  logger: Logger,
): Promise<number> => {
  const vaultRoot = resolve(params.vaultPath)
  const start = dirname(resolveSafePath(params.vaultPath, params.path))

  const pruneFrom = async (dir: string, removed: number): Promise<number> => {
    // Stop at the vault root (never remove it) and defend against the
    // filesystem root where dirname stops shrinking.
    if (dir === vaultRoot || dir === dirname(dir)) return removed
    try {
      const entries = await readdir(dir)
      // A non-empty folder means no ancestor can be empty either — stop here.
      if (entries.length > 0) return removed
      await rmdir(dir)
    } catch (error) {
      logger.warn("could not remove empty folder", {
        folder: relative(vaultRoot, dir),
        error: describeError(error),
      })
      return removed
    }
    return pruneFrom(dirname(dir), removed + 1)
  }

  return pruneFrom(start, 0)
}

/**
 * Writes a file atomically: stage to a unique temp file, then rename over the
 * target. `rename` is atomic on the same filesystem, so the target is never
 * truncated — readers (notably the obsidian-sync container) see either the old
 * content or the new content, never a 0-byte or partial write. This is the
 * core defense against the partial-write clobber class of bug.
 *
 * Overwrites an existing target; use `atomicWriteFileExclusive` when the file
 * must not already exist.
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
 * Like {@link atomicWriteFile}, but **exclusive** (no-clobber): fails with
 * `EEXIST` if the target already exists instead of overwriting it. Stages the
 * content to a unique temp file, then hard-`link`s it onto the target — `link`
 * is atomic and fails when the destination exists, which closes the
 * check-then-write race for a destination that must be new (e.g.
 * `vault_move_note`'s new path). The content is fully staged before the link, so
 * the target appears atomically; the temp link is always removed, leaving only
 * the target on success. Mirrors POSIX `O_EXCL` / Node's `'wx'` flag semantics.
 *
 * When `hardLinksSupported` is `false` (a Windows-drive Docker bind mount, where
 * `link` isn't available), it instead reserves the target with an `O_EXCL`
 * create (the `'wx'` flag) — atomic and race-free, throwing `EEXIST` if the
 * target exists — then renames the staged temp over that empty placeholder so
 * the content still lands atomically. The placeholder is visible for only the
 * instant between the reservation and the rename. This preserves the same
 * no-clobber contract as the link path; `'wx'` create is far more portable
 * than `link`, so it works where hard links don't.
 */
export const atomicWriteFileExclusive = async (
  filePath: string,
  content: string,
  options?: { hardLinksSupported?: boolean },
): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  const hardLinksSupported = options?.hardLinksSupported ?? true
  try {
    await writeFile(tmpPath, content, "utf8")
    if (hardLinksSupported) {
      // Atomic no-clobber create: throws EEXIST if filePath already exists.
      await link(tmpPath, filePath)
      return
    }
    // No hard links on this filesystem. Reserve the target atomically (O_EXCL):
    // throws EEXIST if it already exists, with no separate check — so there's no
    // TOCTOU window in which a concurrent writer's file could be clobbered.
    await writeFile(filePath, "", { flag: "wx" })
    try {
      // Swap the fully-staged content over the empty placeholder.
      await rename(tmpPath, filePath)
    } catch (renameError) {
      // The reservation took but the swap failed — drop the placeholder so a
      // failed write never strands a 0-byte note at the destination.
      await rm(filePath, { force: true }).catch(() => {})
      throw renameError
    }
  } finally {
    // Always drop the temp file — renamed away on success, redundant otherwise.
    // Swallow cleanup errors so the original failure (e.g. EEXIST) propagates.
    await rm(tmpPath, { force: true }).catch(() => {})
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
  assertPathHasExtension(params.path, ".md")
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
  assertPathHasExtension(params.path, ".md")
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  const lines = splitIntoLines(parseNote(content).content)
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
  assertPathHasExtension(params.path, ".md")
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${params.path}"`)
  }
  const lines = splitIntoLines(parseNote(content).content)
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
  assertPathHasExtension(params.path, ".md")
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
  assertPathHasExtension(params.path, ".md")
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
  assertPathHasExtension(params.path, ".md")
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

export type DeleteNoteResult = {
  /** Number of now-empty parent folders removed. Always 0 unless
   *  pruneEmptyFolders was set. */
  prunedEmptyFolders: number
}

/** Deletes a note. Rejects paths under the configured protected paths. When
 *  pruneEmptyFolders is set, removes any parent folders the deletion empties. */
const deleteNote = async (
  params: {
    vaultPath: string
    path: string
    protectedPaths: readonly string[]
    pruneEmptyFolders: boolean
  },
  logger: Logger,
): Promise<DeleteNoteResult> => {
  assertPathHasExtension(params.path, ".md")
  // Normalize before the protected-path check so a traversal path like
  // "X/../About Me/Principles.md" can't evade the prefix test yet still resolve
  // into a protected folder.
  const path = toVaultRelativePath(params.path)

  const protectedPrefixes = params.protectedPaths.map((folder) =>
    folder.endsWith("/") ? folder : `${folder}/`,
  )
  if (protectedPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(
      `cannot delete protected path "${path}" (use vault_delete_memory for individual entries)`,
    )
  }

  const fullPath = resolveSafePath(params.vaultPath, path)
  await unlink(fullPath)
  const prunedEmptyFolders = params.pruneEmptyFolders
    ? await pruneEmptyParents({ vaultPath: params.vaultPath, path }, logger)
    : 0
  logger.info("deleted note", {
    path,
    pruned_empty_folders: prunedEmptyFolders,
  })
  return { prunedEmptyFolders }
}

/** Lists .md files under a folder (or vault root). Supports glob filtering. */
const listNotes = async (
  params: { vaultPath: string; folder?: string; glob?: string },
  logger: Logger,
): Promise<string[]> => {
  const normalizedVault = resolve(params.vaultPath)
  const canonicalVault = await realpath(normalizedVault)

  // Canonicalize the search root so a symlinked folder inside the vault
  // can't redirect readdirOrNull to a directory outside the vault root.
  // Validate with canonical paths, but read with the original so
  // entry.parentPath stays consistent with normalizedVault for relative().
  const searchRoot = params.folder
    ? resolveSafePath(params.vaultPath, params.folder)
    : resolve(params.vaultPath)
  const canonicalSearchRoot = await realpath(searchRoot).catch(() => searchRoot)
  if (
    canonicalSearchRoot !== canonicalVault &&
    !canonicalSearchRoot.startsWith(canonicalVault + "/")
  ) {
    logger.warn("search root escapes vault root, skipping", {
      folder: params.folder,
    })
    return []
  }

  const allEntries = await readdirOrNull(searchRoot)
  if (!allEntries) return []

  // Validate symlink targets: exclude broken symlinks and those escaping the vault
  const entries = (
    await Promise.all(
      allEntries.map(async (entry) => {
        if (!entry.isSymbolicLink()) return entry
        const entryPath = join(entry.parentPath, entry.name)
        try {
          const targetPath = await realpath(entryPath)
          if (!targetPath.startsWith(canonicalVault + "/")) {
            logger.warn("symlink target escapes vault root, skipping", {
              path: relative(normalizedVault, entryPath),
            })
            return null
          }
          const targetStat = await stat(targetPath)
          if (!targetStat.isFile()) {
            logger.warn("symlink target is not a file, skipping", {
              path: relative(normalizedVault, entryPath),
            })
            return null
          }
          return entry
        } catch (error) {
          logger.warn("broken symlink, skipping", {
            path: relative(normalizedVault, entryPath),
            error: describeError(error),
          })
          return null
        }
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  const paths = entries
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith(".md"),
    )
    .map((entry) =>
      relative(normalizedVault, join(entry.parentPath, entry.name)),
    )
    .filter(
      (relativePath) =>
        !relativePath.split("/").some((segment) => segment.startsWith(".")),
    )
    .sort()

  const isMatch = params.glob ? picomatch(params.glob) : undefined
  const result = isMatch ? paths.filter((notePath) => isMatch(notePath)) : paths
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
