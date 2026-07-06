import { readFile, readdir, stat } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { isErrnoException } from "./is-errno-exception.js"

/** Reads a UTF-8 file, returning null instead of throwing when it does not exist
 *  (ENOENT). Any other error propagates. */
export const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return null
    throw error
  }
}

/** Recursively reads a directory's entries (with file types), returning null
 *  instead of throwing when the directory does not exist (ENOENT). Any other
 *  error propagates. */
export const readdirOrNull = async (path: string): Promise<Dirent[] | null> => {
  try {
    return await readdir(path, { recursive: true, withFileTypes: true })
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return null
    throw error
  }
}

/** Resolves true when something exists at the path, false on ENOENT. Any other
 *  error propagates. */
export const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return false
    throw error
  }
}
