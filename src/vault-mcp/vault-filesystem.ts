import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises"
import { join, dirname, relative, resolve } from "node:path"
import type { Dirent } from "node:fs"
import matter from "gray-matter"
import picomatch from "picomatch"
import { logger as rootLogger } from "../logger.js"

const logger = rootLogger.child({ module: "vault-filesystem" })

const PROTECTED_PATHS = ["About Me/", "Daily Notes/"] as const

/** Resolves a note path within the vault, throwing on traversal attempts. */
const resolveSafePath = (vaultPath: string, notePath: string): string => {
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

/** Reads a .md note by relative path. Returns raw content including frontmatter. */
const readNote = async (
  vaultPath: string,
  notePath: string,
): Promise<string> => {
  const fullPath = resolveSafePath(vaultPath, notePath)
  const content = await readFileOrNull(fullPath)
  if (content === null) {
    throw new Error(`note not found: "${notePath}"`)
  }
  return content
}

/** Creates or updates a note. Merges frontmatter losslessly if the file exists. */
const writeNote = async (
  vaultPath: string,
  notePath: string,
  body: string,
  frontmatter?: Record<string, unknown>,
): Promise<void> => {
  const fullPath = resolveSafePath(vaultPath, notePath)
  await mkdir(dirname(fullPath), { recursive: true })

  const existing = await readFileOrNull(fullPath)
  const serialized = serializeNote(existing, body, frontmatter)
  await writeFile(fullPath, serialized, "utf8")
  logger.debug("wrote note", { path: notePath })
}

/** Deletes a note. Rejects paths under PROTECTED_PATHS. */
const deleteNote = async (
  vaultPath: string,
  notePath: string,
): Promise<void> => {
  if (PROTECTED_PATHS.some((p) => notePath.startsWith(p))) {
    throw new Error(
      `cannot delete protected path "${notePath}" (use vault_delete_memory for individual entries)`,
    )
  }

  const fullPath = resolveSafePath(vaultPath, notePath)
  await unlink(fullPath)
  logger.debug("deleted note", { path: notePath })
}

/** Lists .md files under a folder (or vault root). Supports glob filtering. */
const listNotes = async (
  vaultPath: string,
  folder?: string,
  glob?: string,
): Promise<string[]> => {
  const searchRoot = folder
    ? resolveSafePath(vaultPath, folder)
    : resolve(vaultPath)
  const entries = await readdirOrNull(searchRoot)
  if (!entries) return []

  const normalizedVault = resolve(vaultPath)

  const paths = entries
    .reduce<string[]>((acc, entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".md")) return acc
      const rel = relative(normalizedVault, join(entry.parentPath, entry.name))
      if (rel.split("/").some((seg) => seg.startsWith("."))) return acc
      acc.push(rel)
      return acc
    }, [])
    .sort()

  if (!glob) return paths
  const isMatch = picomatch(glob)
  return paths.filter((p) => isMatch(p))
}

export const vaultFs = { readNote, writeNote, deleteNote, listNotes }
