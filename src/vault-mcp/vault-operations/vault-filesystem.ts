import {
  writeFile,
  readdir,
  mkdir,
  open,
  unlink,
  rename,
  link,
  lstat,
  rm,
  rmdir,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, dirname, relative, resolve, parse, posix, isAbsolute, sep } from "node:path"
import picomatch from "picomatch"
import { describeError } from "../../utils/describe-error.js"
import { filterValidSymlinks } from "../../utils/filter-valid-symlinks.js"
import { fileExists, readFileOrNull, readdirOrNull, statOrNull } from "../../utils/fs.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { mapWithConcurrency } from "../../utils/map-with-concurrency.js"
import { mtimeToIso } from "../../utils/mtime-to-iso.js"
import { withExclusiveFileLock, withFileLock } from "../../utils/file-write-lock.js"
import { links } from "../obsidian-markdown/links.js"
import {
  OverwriteBlockedError,
  parseNote,
  parseNoteForRewrite,
  replacePropertiesBlock,
  stringifyNote,
  mergeFrontmatter,
  UnsupportedPropertiesBlockError,
} from "../obsidian-markdown/frontmatter.js"
import type { ParsedNote } from "../obsidian-markdown/frontmatter.js"
import {
  parseHeadings,
  findHeading,
  linesBeforeFirstHeading,
} from "../obsidian-markdown/headings.js"
import { parseLeadingCalloutSpan } from "../obsidian-markdown/callouts.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { splitIntoLines, trimBlankEdgeLines } from "../obsidian-markdown/lines.js"
import { assertNoControlCharacters } from "../../utils/assert-no-control-characters.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { caseFoldPath } from "../../utils/case-fold-path.js"
import type { TrashOption } from "./trash-config.js"
import { hasHiddenPathSegment } from "../../utils/has-hidden-path-segment.js"
import type { Logger } from "../../logger.js"

/** Normalizes a note path's spelling by converting Windows backslashes to
 *  forward slashes and collapsing "./" and "../" segments. Purely lexical —
 *  absolute and vault-escaping paths pass through unchanged, so safety checks
 *  belong to resolveSafePath and prefix guards to resolveVaultRelativePath. */
export const toVaultRelativePath = (input: string): string =>
  posix.normalize(input.replace(/\\/g, "/"))

/** Resolves a note path within the vault; throws on absolute paths,
 *  traversal, hidden paths (dot-prefixed segments — Obsidian ignores
 *  them), and the vault root itself (which names no entry). Hidden is
 *  checked on the resolved relative path (so "./" and "../" normalize)
 *  before any fs access (no existence leak). Internal ".obsidian/"
 *  config readers deliberately bypass this via direct readFile. */
export const resolveSafePath = (vaultPath: string, notePath: string): string => {
  // Vault paths are relative to the vault root — Obsidian has no other
  // form. An absolute input is rejected even when it lands inside the vault,
  // because accepting it would tie behavior to the deployment's mount point,
  // and a vault root whose name shadows a top-level folder (root "/vault",
  // folder "vault/") would let one leading slash silently select the wrong
  // file.
  if (posix.isAbsolute(notePath)) {
    throw new Error(`absolute path blocked: "${notePath}" must be vault-relative`)
  }

  const vaultRoot = resolve(vaultPath)
  const resolvedPath = resolve(vaultRoot, notePath)
  const pathFromVaultRoot = relative(vaultRoot, resolvedPath)
  const escapesVault =
    pathFromVaultRoot === ".." ||
    pathFromVaultRoot.startsWith(`..${sep}`) ||
    // On POSIX relative() always returns a relative path, but across drives
    // on Windows it can return an absolute one — this guard catches that.
    isAbsolute(pathFromVaultRoot)

  if (escapesVault) {
    throw new Error(`path traversal blocked: "${notePath}" escapes vault root`)
  }

  if (resolvedPath === vaultRoot) {
    throw new Error(`path traversal blocked: "${notePath}" resolves to the vault root`)
  }

  if (hasHiddenPathSegment(pathFromVaultRoot)) {
    throw new Error(`hidden path blocked: "${notePath}" targets a hidden file or folder`)
  }

  return resolvedPath
}

/** Canonical vault-relative form of a note path — prefix guards must run on
 *  this form so path aliases (separator variants, traversal segments) can't
 *  evade them. Throws resolveSafePath's absolute/traversal/hidden errors for
 *  unsafe input. */
export const resolveVaultRelativePath = (params: {
  vaultPath: string
  notePath: string
}): string => {
  const normalizedInput = toVaultRelativePath(params.notePath)
  // resolveSafePath is called for its safety guards; its absolute result is
  // an intermediate, converted straight back to vault-relative.
  const resolvedPath = resolveSafePath(params.vaultPath, normalizedInput)
  const relativePath = relative(resolve(params.vaultPath), resolvedPath)
  return toVaultRelativePath(relativePath)
}

/** True when the path sits under one of the protected folders (memory, daily
 *  notes). The comparison is case-folded so a case-aliased spelling can't slip
 *  past the guard on a case-insensitive filesystem (macOS/Windows bind
 *  mounts); the path must already be canonical (resolveVaultRelativePath). */
export const isProtectedPath = (params: {
  path: string
  protectedPaths: readonly string[]
}): boolean => {
  const foldedPath = caseFoldPath(params.path)
  return params.protectedPaths
    .map((folder) => (folder.endsWith("/") ? folder : `${folder}/`))
    .some((prefix) => foldedPath.startsWith(caseFoldPath(prefix)))
}

/**
 * Removes the note's now-empty parent folders, walking up from the note's
 * directory toward — but never including — the vault root. Only a directory
 * with zero entries is removed, so a folder still holding any file (including a
 * hidden one like .DS_Store) is left in place and stops the walk.
 *
 * The delete/move that triggered the prune has already succeeded, so a failure
 * to remove a folder (permissions, a race, a vanished dir) is logged and ends
 * the walk rather than thrown — it never fails the tool call.
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
 * Stages content to a unique temp file, then renames over the target.
 * `rename` is atomic on the same filesystem, so the target is never
 * truncated — readers (notably the obsidian-sync container) see either the old
 * content or the new content, never a 0-byte or partial write. This is the
 * core defense against the partial-write clobber class of bug.
 *
 * Overwrites an existing target; use `atomicWriteFileExclusive` when the file
 * must not already exist.
 */
export const atomicWriteFile = async (
  params: { filePath: string; content: string },
  logger: Logger,
): Promise<void> => {
  const tmpPath = `${params.filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, params.content, "utf8")
    await rename(tmpPath, params.filePath)
  } catch (err) {
    // Best-effort cleanup so a failed write never strands a temp file. A
    // failed cleanup is logged, not thrown, so the write failure propagates.
    try {
      await rm(tmpPath, { force: true })
    } catch (cleanupError) {
      logger.warn("failed to remove temp file", {
        path: tmpPath,
        error: describeError(cleanupError),
      })
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
  params: {
    filePath: string
    content: string
    hardLinksSupported?: boolean
  },
  logger: Logger,
): Promise<void> => {
  const tmpPath = `${params.filePath}.${randomUUID()}.tmp`
  const hardLinksSupported = params.hardLinksSupported ?? true
  try {
    await writeFile(tmpPath, params.content, "utf8")
    if (hardLinksSupported) {
      // Atomic no-clobber create — link throws EEXIST if filePath exists.
      await link(tmpPath, params.filePath)
      return
    }
    // No hard links on this filesystem. Reserve the target atomically
    // (O_EXCL) — it throws EEXIST if the target exists, with no separate
    // check, so there's no TOCTOU window in which a concurrent writer's file
    // could be clobbered.
    await writeFile(params.filePath, "", { flag: "wx" })
    try {
      // Swap the fully-staged content over the empty placeholder.
      await rename(tmpPath, params.filePath)
    } catch (renameError) {
      // The reservation took but the swap failed — drop the placeholder so a
      // failed write never strands a 0-byte note at the destination. A failed
      // cleanup is logged, not thrown, so the swap failure propagates.
      await rm(params.filePath, { force: true }).catch((cleanupError: unknown) => {
        logger.warn("failed to remove reservation placeholder", {
          path: params.filePath,
          error: describeError(cleanupError),
        })
      })
      throw renameError
    }
  } finally {
    // Always drop the temp file — renamed away on success, redundant otherwise.
    // A failed cleanup is logged, not thrown, so the original failure (e.g.
    // EEXIST) propagates.
    await rm(tmpPath, { force: true }).catch((cleanupError: unknown) => {
      logger.warn("failed to remove temp file", {
        path: tmpPath,
        error: describeError(cleanupError),
      })
    })
  }
}

/** Parses a note an overwrite will merge into. A refused properties block
 *  becomes an OverwriteBlockedError, whose repair skips putting prose back. */
const parseNoteForOverwrite = (existing: string): ParsedNote => {
  try {
    return parseNoteForRewrite(existing)
  } catch (error) {
    if (!(error instanceof UnsupportedPropertiesBlockError)) throw error
    throw new OverwriteBlockedError({ message: error.message, kind: error.kind, cause: error })
  }
}

/** Combines body + frontmatter into a note string. Merges with existing frontmatter if file already exists; keys set to null are removed. */
const serializeNote = (
  existing: string | null,
  body: string,
  frontmatter?: Record<string, unknown>,
): string => {
  // A new note has no properties to delete, so the merge only drops the keys
  // the caller set to null rather than writing them as empty properties
  if (!existing) return stringifyNote(body, mergeFrontmatter({}, frontmatter ?? {}))

  const parsed = parseNoteForOverwrite(existing)
  const mergedData = frontmatter ? mergeFrontmatter(parsed.data, frontmatter) : parsed.data
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

/** One heading and the exact UTF-8 byte length returned by a section read. */
type HeadingOutline = Readonly<{
  level: number
  text: string
  bytes: number
}>

/** The optional leading fields are omitted when absent and never overlap. */
type NoteOutline = Readonly<{
  bytes: number
  modified: string
  leading_callout?: LeadingCallout
  leading_content?: string
  headings: HeadingOutline[]
}>

/** Returns file metadata and the heading tree without section bodies, plus visible content above the first heading. */
const readNoteOutline = async (
  params: { vaultPath: string; path: string },
  logger: Logger,
): Promise<NoteOutline> => {
  assertPathHasExtension(params.path, ".md")
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const [content, fileStats] = await Promise.all([readFileOrNull(fullPath), statOrNull(fullPath)])

  if (content === null || fileStats === null) {
    throw new Error(`note not found: "${params.path}"`)
  }

  const lines = splitIntoLines(parseNote(content).content)
  const headings = parseHeadings(lines)
  const calloutSpan = parseLeadingCalloutSpan(lines)

  // linesBeforeFirstHeading returns a zero-based prefix, so its indices still
  // match the callout span. Filtering that prefix also keeps a callout after a
  // leading H1 outside the region without span subtraction or negative slices.
  const regionLines = linesBeforeFirstHeading(lines, headings)
  const regionOutsideCallout = regionLines.filter(
    (_line, index) =>
      calloutSpan === null || index < calloutSpan.startLine || index >= calloutSpan.endLine,
  )
  const leadingContent = trimBlankEdgeLines(regionOutsideCallout).join("\n")

  const outline = headings.map((heading) => {
    // The section span runs from the heading line through bodyEndLine (the
    // same span a section read returns), so the size hint matches what
    // reading it would cost.
    const sectionText = lines.slice(heading.startLine, heading.bodyEndLine).join("\n")
    return {
      level: heading.level,
      text: heading.text,
      bytes: Buffer.byteLength(sectionText, "utf8"),
    }
  })
  const totalSectionBytes = outline.reduce((sum, section) => sum + section.bytes, 0)
  logger.info("read note outline", {
    path: params.path,
    headingCount: outline.length,
    hasCallout: calloutSpan !== null,
    hasLeadingContent: leadingContent !== "",
    fileBytes: fileStats.size,
    totalSectionBytes,
  })
  // Omit either key when absent, rather than emitting an explicit null.
  return {
    bytes: fileStats.size,
    modified: mtimeToIso(fileStats.mtimeMs),
    ...(calloutSpan ? { leading_callout: calloutSpan.callout } : {}),
    ...(leadingContent ? { leading_content: leadingContent } : {}),
    headings: outline,
  }
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
    headingLevel?: number | undefined
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

/** A block holding a list or a single value returns `{}`; YAML the parser
 *  cannot read throws. */
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

/** Creates a note. Rejects if the file already exists unless overwrite is set. */
const writeNote = async (
  params: {
    vaultPath: string
    path: string
    body: string
    properties?: Record<string, unknown> | undefined
    overwrite?: boolean | undefined
  },
  logger: Logger,
): Promise<void> => {
  assertPathHasExtension(params.path, ".md")
  assertNoControlCharacters(params.body, "body")
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  return withExclusiveFileLock(fullPath, async () => {
    await mkdir(dirname(fullPath), { recursive: true })

    const existing = await readFileOrNull(fullPath)

    if (existing !== null && !params.overwrite) {
      throw new Error(`note already exists: "${params.path}"`)
    }
    // readFileOrNull reads a folder at the path as no file. The write below
    // renames over the path, which would replace a symlink that points at a
    // folder, so the write stops when the path leads to anything but a file.
    if (existing === null) {
      const occupant = await statOrNull(fullPath)

      if (occupant && !occupant.isFile()) {
        throw new Error(`cannot write note "${params.path}": that path is not a file`)
      }
    }
    const serialized = serializeNote(existing, params.body, params.properties)
    await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)
    logger.info("wrote note", {
      path: params.path,
      beforeBytes: existing ? Buffer.byteLength(existing, "utf8") : 0,
      afterBytes: Buffer.byteLength(serialized, "utf8"),
    })
  })
}

/** Merges properties into an existing note's YAML frontmatter. Keys set to
 *  null are removed. The body's text is kept, and the note ends with a
 *  newline as every rewrite does; replaceProperties adds none. */
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
  return withExclusiveFileLock(fullPath, async () => {
    const existing = await readFileOrNull(fullPath)

    if (existing === null) {
      throw new Error(`note not found: "${params.path}"`)
    }
    const parsed = parseNoteForRewrite(existing)
    const mergedProperties = mergeFrontmatter(parsed.data, params.properties)
    const serialized = stringifyNote(parsed.content, mergedProperties)
    await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)
    logger.info("updated properties", {
      path: params.path,
      beforeBytes: Buffer.byteLength(existing, "utf8"),
      afterBytes: Buffer.byteLength(serialized, "utf8"),
    })
  })
}

/** Replaces a note's whole properties block, keeping the body's bytes. The
 *  old block is never parsed, so this repairs a block that is not valid
 *  YAML, holds a list or a single value, or uses a YAML tag. A null value
 *  writes an empty property; `{}` removes the block. */
const replaceProperties = async (
  params: {
    vaultPath: string
    path: string
    properties: Record<string, unknown>
  },
  logger: Logger,
): Promise<void> => {
  assertPathHasExtension(params.path, ".md")
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  return withExclusiveFileLock(fullPath, async () => {
    const existing = await readFileOrNull(fullPath)

    if (existing === null) {
      throw new Error(`note not found: "${params.path}"`)
    }
    const serialized = replacePropertiesBlock(existing, params.properties)
    await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)
    logger.info("replaced properties", {
      path: params.path,
      beforeBytes: Buffer.byteLength(existing, "utf8"),
      afterBytes: Buffer.byteLength(serialized, "utf8"),
    })
  })
}

type DeleteNoteResult = {
  /** Number of now-empty parent folders removed. Always 0 unless
   *  pruneEmptyFolders was set. */
  prunedFolderCount: number
  /** Vault-relative path in `.trash/` when the note was moved to trash.
   *  Undefined when permanently deleted. */
  trashLocation?: string
}

/** Ties moveNoteToTrash's collision-exhaustion throw to deleteNote's rethrow
 *  guard — both use this lead-in, so a message edit can't silently break the
 *  guard's prefix match. */
const TRASH_COLLISION_ERROR_PREFIX = "cannot move to trash"

/** The serializing-lock key that every trash move and each retention-sweep
 *  row (trash-sweeper.ts) MUST share.
 *  - It is an in-memory key for file-write-lock's map, not a lock file on disk.
 *  - The sweep decides what to unlink from a row it re-reads under this lock,
 *    so a trash move interleaving with that decision could hand it a fresh
 *    file at a stale row's path.
 *  - Every other lock is on a note's own `.md` path, so none can share this
 *    folder key. */
export const trashDomainLockKey = (vaultPath: string): string => {
  return join(vaultPath, ".trash")
}

/** What the retention sweep checks in a trashed file before deleting it. */
export type TrashFileState = {
  /** Inode number, size, and modification time, stored in the file's
   *  trash_entries row and matched exactly.
   *  - Changing the format makes every recorded row a mismatch, so the sweep
   *    drops those rows and never deletes their files.
   *  - The inode alone is not enough, because ext4 reuses freed inode numbers.
   *  - The device number is left out because, inside a Docker Desktop bind
   *    mount, it is a number Docker Desktop's VM assigned when it mounted the
   *    share, which can change when Docker Desktop restarts, and rows outlive
   *    restarts. */
  identity: string
  /** The inode change time, which the sweep compares with the moment the row
   *  was recorded.
   *  - Every attribute write moves it, and so does a rename on most file
   *    systems (POSIX leaves that optional).
   *  - It is never stored, because inside a Docker Desktop bind mount the
   *    container keeps reporting the old change time after its own rename
   *    while the host's value moves, so a stored value stops matching after
   *    a restart. */
  changeTimeNs: bigint
}

/** Reads a trashed file's TrashFileState without following a symlink. The
 *  trash move and the sweep (trash-sweeper.ts) MUST both read it here, so the
 *  recorded identity and the one the sweep reads share one format. Throws
 *  when nothing is at the path. */
export const readTrashFileState = async (fullPath: string): Promise<TrashFileState> => {
  // A bigint keeps every digit, because a file ID seen through a Windows bind
  // mount can exceed 2^53, and a number would round two IDs to one value.
  const fileStats = await lstat(fullPath, { bigint: true })
  return {
    identity: `${fileStats.ino}:${fileStats.size}:${fileStats.mtimeNs}`,
    changeTimeNs: fileStats.ctimeNs,
  }
}

/** Retention-sweep bookkeeping hook for a trash move. It receives the
 *  vault-relative path the note landed at and the landed file's
 *  TrashFileState identity. */
type RecordTrashEntry = (entry: { trashPath: string; fileIdentity: string }) => void

/** Claims a trash destination with an exclusive create — the empty placeholder
 *  appears atomically, and only when nothing occupies the name. Returns false
 *  when the name is occupied by anything: a regular file, a directory, or a
 *  symlink (even dangling, which a stat-based existence check would report as
 *  free). */
const claimTrashTarget = async (targetPath: string): Promise<boolean> => {
  try {
    // "wx" opens with O_CREAT|O_EXCL — the create succeeds only when nothing
    // occupies the path and fails with EEXIST otherwise. The check and the
    // create are one atomic operation, so two claimants can't both win.
    await writeFile(targetPath, "", { flag: "wx" })
    return true
  } catch (error) {
    if (isErrnoException(error, "EEXIST")) return false
    throw error
  }
}

/** Moves a note into `.trash/` under the first name it can claim, and returns
 *  the vault-relative trash path.
 *  - Each candidate name, the original and then `note 1.md` … `note 100.md`,
 *    is claimed with an exclusive create before the move. The claim is the
 *    only existence check, so an existing trash copy is never overwritten,
 *    and a concurrent delete that loses a claim takes the next name.
 *  - With `recordTrashEntry`, the landed path and the landed file's identity
 *    are recorded for the retention sweep. Without it,
 *    `clearStaleTrashEntry` drops any earlier row at the landed path, so the
 *    sweep never deletes the new file. A caller that passes neither leaves
 *    such a row in place. */
const moveNoteToTrash = async (
  params: {
    vaultPath: string
    relativePath: string
    fullPath: string
    recordTrashEntry?: RecordTrashEntry | undefined
    clearStaleTrashEntry?: ((trashRelativePath: string) => void) | undefined
  },
  logger: Logger,
): Promise<string> => {
  // The claim loop stops after 100 numbered names, so a .trash/ crowded with
  // copies of one name fails the delete with an error the vault owner can act
  // on (clear old copies) instead of trying names without end.
  const TRASH_NAME_SUFFIX_LIMIT = 100
  const { dir, base, name, ext } = parse(params.relativePath)
  const trashFolder = join(".trash", dir)
  // Obsidian appends " 1", " 2", etc. for name collisions in .trash/.
  const suffixedFileNames = Array.from({ length: TRASH_NAME_SUFFIX_LIMIT }, (_, index) => {
    return `${name} ${index + 1}${ext}`
  })
  const candidateRelativePaths = [base, ...suffixedFileNames].map((fileName) => {
    return join(trashFolder, fileName)
  })

  // withFileLock queues behind the current holder instead of failing, so
  // concurrent moves and sweep rows take turns. Unlocked, a move could land a
  // fresh file at a stale row's path between the sweep's re-read of that row
  // and its unlink, and the sweep would delete the just-trashed copy.
  return withFileLock(trashDomainLockKey(params.vaultPath), async () => {
    // The folder is created under the lock because a sweep row removes the
    // .trash/ folders its unlink emptied. A folder created before the lock is
    // taken can be removed again before the claim, which would then fail.
    await mkdir(join(params.vaultPath, trashFolder), { recursive: true })

    for (const candidateRelativePath of candidateRelativePaths) {
      const candidateFullPath = join(params.vaultPath, candidateRelativePath)

      if (!(await claimTrashTarget(candidateFullPath))) continue

      try {
        await rename(params.fullPath, candidateFullPath)
      } catch (renameError) {
        // The claim took but the move failed — drop our placeholder so it
        // doesn't strand a 0-byte file occupying a suffix. A failed cleanup is
        // logged, not thrown, so the rename failure propagates as the cause.
        try {
          await rm(candidateFullPath, { force: true })
        } catch (cleanupError) {
          logger.warn("failed to remove claim placeholder", {
            path: candidateRelativePath,
            error: describeError(cleanupError),
          })
        }
        throw renameError
      }

      // The exclusive claim proved nothing occupied the landed path, so any
      // existing row for it belongs to an earlier occupant that has since
      // left .trash/:
      // - A recorded move replaces that row.
      // - An unrecorded move ("local", Obsidian's keep-forever trash) must
      //   clear it. A rename keeps a file's identity, so a note restored from
      //   .trash/ by hand and trashed again matches its old row. The sweep
      //   keeps it only when the rename moved its change time more than a
      //   minute past the old row's moment, which misses a quick restore and a
      //   file system that leaves the change time alone on rename (POSIX
      //   allows both behaviours).
      // - Both writes are fail-open because the note has already moved, so a
      //   failed identity read or row write is logged, not reported as a
      //   failed move.
      const tryClearStaleTrashEntry = (): void => {
        if (!params.clearStaleTrashEntry) return
        try {
          params.clearStaleTrashEntry(candidateRelativePath)
        } catch (clearError) {
          logger.warn("failed to clear stale trash entry", {
            path: candidateRelativePath,
            error: describeError(clearError),
          })
        }
      }

      if (params.recordTrashEntry) {
        try {
          // The sweep compares against whatever is at the landed path, so the
          // identity is read there, after the rename.
          const { identity } = await readTrashFileState(candidateFullPath)
          params.recordTrashEntry({ trashPath: candidateRelativePath, fileIdentity: identity })
        } catch (recordError) {
          logger.warn("failed to record trash entry", {
            path: candidateRelativePath,
            error: describeError(recordError),
          })
          // The failed record left any stale row in place — still defuse it.
          tryClearStaleTrashEntry()
        }
      } else {
        tryClearStaleTrashEntry()
      }
      return candidateRelativePath
    }

    throw new Error(
      `${TRASH_COLLISION_ERROR_PREFIX} "${params.relativePath}" — ${TRASH_NAME_SUFFIX_LIMIT} collisions in .trash/`,
    )
  })
}

/** Deletes or trashes a note depending on the vault's Deleted files setting.
 *  Rejects paths under the configured protected paths. When pruneEmptyFolders
 *  is set, removes any parent folders the operation empties. */
const deleteNote = async (
  params: {
    vaultPath: string
    path: string
    protectedPaths: readonly string[]
    pruneEmptyFolders: boolean
    trashOption: TrashOption
    /** Retention-sweep bookkeeping hook, forwarded to moveNoteToTrash. The
     *  caller decides which trash options are recorded; a move made without
     *  this hook is not recorded, and the sweep leaves its file in .trash/. */
    recordTrashEntry?: RecordTrashEntry | undefined
    /** Drops an earlier occupant's row at the landed trash path when the move
     *  is not recorded. Forwarded to moveNoteToTrash, which says why. */
    clearStaleTrashEntry?: ((trashRelativePath: string) => void) | undefined
  },
  logger: Logger,
): Promise<DeleteNoteResult> => {
  assertPathHasExtension(params.path, ".md")
  // Canonicalize before the protected-path check so an aliased spelling —
  // traversal ("X/../About Me/x.md") or separator variant — can't evade the
  // prefix test yet still resolve into a protected folder. Absolute input
  // throws here.
  const path = resolveVaultRelativePath({
    vaultPath: params.vaultPath,
    notePath: params.path,
  })

  if (isProtectedPath({ path, protectedPaths: params.protectedPaths })) {
    throw new Error(`cannot delete protected path "${path}"`)
  }

  const fullPath = resolveSafePath(params.vaultPath, path)
  // Locked so a concurrent read-modify-write (patch/replace) can't recreate
  // the note via its atomic-rename write after the unlink, and so a delete
  // throws while a note move holds this path — the lock fails fast, it never
  // waits.
  return withExclusiveFileLock(fullPath, async () => {
    // The existence check runs inside the lock, mirroring moveNote — a clean
    // vault-relative "note not found" instead of unlink's raw ENOENT (whose
    // message would leak the absolute container path to the client).
    if (!(await fileExists(fullPath))) {
      throw new Error(`note not found: "${path}"`)
    }

    // Assigned inside the try, read after it — pruning and the completion
    // log below need the value, so const can't span the catch boundary
    let trashLocation: string | undefined
    try {
      // "local" and "system" both land in .trash/ — a container has no host
      // trash, and Obsidian's own fallback for an unavailable system trash
      // is .trash/. Only "none" means permanent delete.
      if (params.trashOption !== "none") {
        // The trash path bypasses resolveSafePath because .trash/ is a hidden
        // path the guard rejects. Safe: `path` was already validated above.
        trashLocation = await moveNoteToTrash(
          {
            vaultPath: params.vaultPath,
            relativePath: path,
            fullPath,
            recordTrashEntry: params.recordTrashEntry,
            clearStaleTrashEntry: params.clearStaleTrashEntry,
          },
          logger,
        )
      } else {
        await unlink(fullPath)
      }
    } catch (error) {
      // Collision-exhaustion errors from moveNoteToTrash are already vault-relative
      const isTrashCollisionError =
        error instanceof Error && error.message.startsWith(TRASH_COLLISION_ERROR_PREFIX)

      if (isTrashCollisionError) {
        throw error
      }
      // Log the raw fs detail (errno, absolute path) for the operator;
      // surface only a vault-relative message to the client.
      const action = params.trashOption !== "none" ? "move to trash" : "delete"
      logger.warn(`failed to ${action}`, {
        path,
        error: describeError(error),
      })
      throw new Error(`cannot ${action} "${path}"`, { cause: error })
    }

    const prunedFolderCount = params.pruneEmptyFolders
      ? await pruneEmptyParents({ vaultPath: params.vaultPath, path }, logger)
      : 0

    // trashOption is logged because the result text and the tool_result log
    // say "trashed" for both "local" and "system".
    logger.info("deleted note", {
      path,
      trashOption: params.trashOption,
      ...(trashLocation ? { trashLocation } : {}),
      prunedFolderCount,
    })
    return {
      prunedFolderCount,
      ...(trashLocation ? { trashLocation } : {}),
    }
  })
}

/** Recursively walks the vault (or a folder within it) and returns the sorted
 *  vault-relative paths of every file of the requested kind — "note"
 *  (.md files) or "file" (everything else). The .md extension is the
 *  single definition of that boundary. Follows valid symlinks; hidden
 *  segments (any path part starting with ".") are skipped. */
const listVaultFilePaths = async (
  params: {
    vaultPath: string
    folder?: string | undefined
    fileKind: "note" | "file"
  },
  logger: Logger,
): Promise<string[]> => {
  const searchRoot = params.folder
    ? resolveSafePath(params.vaultPath, params.folder)
    : resolve(params.vaultPath)
  const allEntries = await readdirOrNull(searchRoot)

  if (!allEntries) return []

  const normalizedVault = resolve(params.vaultPath)

  // Symlinks may point outside the vault (e.g. ARCHITECTURE.md →
  // ~/Code/repo/ARCHITECTURE.md) — Obsidian supports this natively, so we
  // follow suit. Only broken symlinks and non-file targets are excluded.
  const entries = await filterValidSymlinks({
    entries: allEntries,
    normalizedRoot: normalizedVault,
    logger,
  })

  const kindMatchingEntries = entries.filter((entry) => {
    const isNoteFile = entry.name.endsWith(".md")
    const matchesKind = params.fileKind === "note" ? isNoteFile : !isNoteFile
    return (entry.isFile() || entry.isSymbolicLink()) && matchesKind
  })
  const relativePaths = kindMatchingEntries.map((entry) =>
    relative(normalizedVault, join(entry.parentPath, entry.name)),
  )
  const visiblePaths = relativePaths.filter((relativePath) => !hasHiddenPathSegment(relativePath))
  return visiblePaths.toSorted()
}

/** Lists .md files under a folder (or vault root). Supports glob filtering. */
const listNotes = async (
  params: {
    vaultPath: string
    folder?: string | undefined
    glob?: string | undefined
  },
  logger: Logger,
): Promise<string[]> => {
  const paths = await listVaultFilePaths(
    {
      vaultPath: params.vaultPath,
      folder: params.folder,
      fileKind: "note",
    },
    logger,
  )

  // With a folder, the glob matches each path relative to that folder. The
  // folder is re-derived from its resolved form so aliases ("Projects/",
  // "./Projects") reduce to the same vault-relative prefix as the listed paths.
  const globBase = params.folder
    ? relative(resolve(params.vaultPath), resolveSafePath(params.vaultPath, params.folder))
    : ""
  const isMatch = params.glob ? picomatch(params.glob) : undefined
  const result = isMatch
    ? paths.filter((notePath) => isMatch(posix.relative(globBase, notePath)))
    : paths
  logger.info("listed notes", { folder: params.folder, count: result.length })
  return result
}

/** Lists non-.md files (assets — images, canvases, PDFs, …) under a folder
 *  (or the vault root). Same walk and filters as listNotes; moveNote resolves
 *  asset links inside a moved note against the vault-wide result. */
const listAssets = async (
  params: { vaultPath: string; folder?: string | undefined },
  logger: Logger,
): Promise<string[]> => {
  const paths = await listVaultFilePaths(
    {
      vaultPath: params.vaultPath,
      folder: params.folder,
      fileKind: "file",
    },
    logger,
  )
  logger.info("listed assets", { folder: params.folder, count: paths.length })
  return paths
}

/** Reads a non-.md vault file (an asset) as raw bytes, with a size cap.
 *  Markdown notes are rejected — .md reads go through readNote, which treats
 *  files as notes, not bytes. The stat-before-read cap guards memory, and the
 *  read itself goes through a handle with a buffer bounded by that stat plus
 *  one sentinel byte — a file that grows between stat and read (a sync race)
 *  is rejected instead of ballooning memory or serving torn content. */
const readAsset = async (
  params: { vaultPath: string; path: string; maxBytes: number },
  logger: Logger,
): Promise<{ buffer: Buffer; bytes: number; extension: string }> => {
  if (params.path.endsWith(".md")) {
    throw new Error(`not a file: "${params.path}" is a markdown note`)
  }
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  const fileStats = await statOrNull(fullPath)

  if (!fileStats || !fileStats.isFile()) {
    throw new Error(`file not found: "${params.path}"`)
  }
  if (fileStats.size > params.maxBytes) {
    throw new Error(
      `file too large: "${params.path}" is ${fileStats.size} bytes ` +
        `(cap ${params.maxBytes} bytes — raise MAX_FILE_BYTES to read larger files)`,
    )
  }

  // IIFE scopes the ENOENT mapping to just the open call.
  const fileHandle = await (async () => {
    try {
      return await open(fullPath, "r")
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) {
        throw new Error(`file not found: "${params.path}"`, { cause: error })
      }
      throw error
    }
  })()
  try {
    // The buffer is one sentinel byte longer than the statted size — if the
    // file grew after the stat, the sentinel fills and the read is rejected
    // as unstable.
    const readBuffer = Buffer.alloc(Math.min(fileStats.size, params.maxBytes) + 1)
    // A single read() may return short on some platforms, so the loop
    // accumulates until EOF or the buffer is full.
    let totalBytesRead = 0
    while (totalBytesRead < readBuffer.length) {
      const { bytesRead } = await fileHandle.read(
        readBuffer,
        totalBytesRead,
        readBuffer.length - totalBytesRead,
        totalBytesRead,
      )

      if (bytesRead === 0) break
      totalBytesRead += bytesRead
    }
    if (totalBytesRead === readBuffer.length) {
      throw new Error(
        `file changed while reading: "${params.path}" grew past its ` +
          `measured size — retry the read`,
      )
    }
    const buffer = readBuffer.subarray(0, totalBytesRead)
    logger.info("read asset", { path: params.path, bytes: buffer.length })
    return {
      buffer,
      bytes: buffer.length,
      extension: links.getExtension(params.path).toLowerCase(),
    }
  } finally {
    await fileHandle.close()
  }
}

/** Stats a page of asset paths, returning each existing file's byte size.
 *  Assets that vanished between listing and stat (a sync race) are dropped
 *  rather than thrown — the listing is a snapshot, not a lock. */
const statAssets = async (
  params: { vaultPath: string; paths: readonly string[] },
  logger: Logger,
): Promise<{ path: string; bytes: number }[]> => {
  const stattedEntries = await mapWithConcurrency({
    items: params.paths,
    // Caps how many stat calls run at once, so a listing of thousands of
    // assets is statted in batches rather than all at the same moment
    concurrency: 16,
    mapper: async (assetPath) => {
      const fileStats = await statOrNull(resolveSafePath(params.vaultPath, assetPath))

      if (!fileStats) return null
      return { path: assetPath, bytes: fileStats.size }
    },
  })
  const existingEntries = stattedEntries.filter((entry) => entry !== null)
  logger.info("statted assets", { count: existingEntries.length })
  return existingEntries
}

export const vaultFs = {
  readNote,
  readNoteOutline,
  readNoteSection,
  readNoteProperties,
  writeNote,
  updateProperties,
  replaceProperties,
  deleteNote,
  listNotes,
  listAssets,
  readAsset,
  statAssets,
}
