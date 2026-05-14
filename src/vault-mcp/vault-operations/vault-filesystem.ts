import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises"
import { join, dirname, relative, resolve } from "node:path"
import type { Dirent } from "node:fs"
import matter from "gray-matter"
import picomatch from "picomatch"
import type { Logger } from "../../logger.js"

const PROTECTED_PATHS = ["About Me/", "Daily Notes/"] as const

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

/** Combines body + frontmatter into a gray-matter serialized string. Merges frontmatter if file already exists. */
const serializeNote = (
  existing: string | null,
  body: string,
  frontmatter?: Record<string, unknown>,
): string => {
  if (!existing) return matter.stringify(body, frontmatter ?? {})

  const parsed = matter(existing)
  const mergedData = frontmatter
    ? { ...parsed.data, ...frontmatter }
    : parsed.data
  return matter.stringify(body, mergedData)
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

/** Creates or updates a note. Merges frontmatter losslessly if the file exists. */
const writeNote = async (
  params: {
    vaultPath: string
    path: string
    body: string
    frontmatter?: Record<string, unknown>
  },
  logger: Logger,
): Promise<void> => {
  const fullPath = resolveSafePath(params.vaultPath, params.path)
  await mkdir(dirname(fullPath), { recursive: true })

  const existing = await readFileOrNull(fullPath)
  const serialized = serializeNote(existing, params.body, params.frontmatter)
  await writeFile(fullPath, serialized, "utf8")
  logger.info("wrote note", { path: params.path })
}

/** Deletes a note. Rejects paths under PROTECTED_PATHS. */
const deleteNote = async (
  params: { vaultPath: string; path: string },
  logger: Logger,
): Promise<void> => {
  if (PROTECTED_PATHS.some((p) => params.path.startsWith(p))) {
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

export const vaultFs = { readNote, writeNote, deleteNote, listNotes }
