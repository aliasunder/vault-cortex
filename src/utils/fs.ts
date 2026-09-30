import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import type { Dirent, Stats } from "node:fs"
import { isErrnoException } from "./is-errno-exception.js"

/** True for the errors that mean nothing is reachable at a path: the entry is
 *  missing (ENOENT), or a component on the way to it is a file rather than a
 *  folder (ENOTDIR). Both read as "not there" to a caller that asked by path;
 *  the raw message names the absolute path, so it never leaves as an error. */
export const isMissingPathError = (error: unknown): boolean => {
  return isErrnoException(error, "ENOENT") || isErrnoException(error, "ENOTDIR")
}

/** Reads a UTF-8 file, returning null instead of throwing when no file exists
 *  at the path: nothing is there (ENOENT), a parent is a file (ENOTDIR), or the
 *  path is a folder (EISDIR). Any other error propagates. */
export const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isMissingPathError(error) || isErrnoException(error, "EISDIR")) return null
    throw error
  }
}

/** Stats a path, returning null instead of throwing when nothing exists there
 *  (ENOENT) or a parent is a file (ENOTDIR). Any other error propagates. */
export const statOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

/** Like statOrNull, but does not follow symlinks — checks whether the
 *  directory entry itself exists, not its target. */
export const lstatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

/** Recursively reads a directory's entries (with file types), returning null
 *  instead of throwing when no directory exists at the path: nothing is there
 *  (ENOENT), or the path or one of its parents is a file (ENOTDIR). Any other
 *  error propagates. */
export const readdirOrNull = async (path: string): Promise<Dirent[] | null> => {
  try {
    return await readdir(path, { recursive: true, withFileTypes: true })
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return null
    if (!isErrnoException(error, "ENOTDIR")) throw error

    // The walk also raises ENOTDIR when a folder inside it becomes a file
    // while it runs. Null would report that listing as empty, so it is
    // returned only when the listed path itself is not a folder.
    const pathStats = await statOrNull(path)
    const listedPathIsDirectory = pathStats?.isDirectory() ?? false

    if (listedPathIsDirectory) throw error
    return null
  }
}

/** Resolves a path's canonical form (symlinks followed), returning null
 *  instead of throwing when a component does not exist (ENOENT) or is a file
 *  (ENOTDIR). Any other error propagates. */
export const realpathOrNull = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

/** Resolves true when something exists at the path, false when nothing does
 *  (ENOENT) or a parent is a file (ENOTDIR). Any other error propagates. */
export const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}
