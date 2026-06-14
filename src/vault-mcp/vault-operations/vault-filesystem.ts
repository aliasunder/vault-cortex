import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  unlink,
  rename,
  rm,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, dirname, relative, resolve } from "node:path"
import type { Dirent } from "node:fs"
import picomatch from "picomatch"
import { parseNote, stringifyNote, mergeFrontmatter } from "./frontmatter.js"
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
    // Best-effort cleanup so a failed write never strands a temp file.
    await rm(tmpPath, { force: true })
    throw err
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
  readNoteProperties,
  writeNote,
  updateProperties,
  deleteNote,
  listNotes,
}
