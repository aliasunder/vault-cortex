import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export type VaultPathValidation =
  | { kind: "ok"; path: string }
  | { kind: "warn"; path: string; message: string }
  | { kind: "error"; message: string }

/**
 * Expands a leading `~` or `~/` to the user's home directory. Everything
 * else (including Windows backslash paths) is left untouched.
 */
export const expandTilde = (
  input: string,
  home: string = homedir(),
): string => {
  if (input === "~") return home
  if (input.startsWith("~/")) return join(home, input.slice(2))
  return input
}

/**
 * Validates a candidate Obsidian vault path. A missing or non-directory
 * path is an error; a directory without a `.obsidian/` folder is only a
 * warning — vault-cortex works on any folder of Markdown files.
 */
export const validateVaultPath = (input: string): VaultPathValidation => {
  const trimmed = input.trim()
  if (trimmed === "")
    return { kind: "error", message: "Vault path is required." }

  const absolutePath = resolve(expandTilde(trimmed))
  if (!existsSync(absolutePath)) {
    return { kind: "error", message: `Path does not exist: ${absolutePath}` }
  }
  if (!statSync(absolutePath).isDirectory()) {
    return {
      kind: "error",
      message: `Path is not a directory: ${absolutePath}`,
    }
  }
  if (!existsSync(join(absolutePath, ".obsidian"))) {
    return {
      kind: "warn",
      path: absolutePath,
      message: `${absolutePath} doesn't look like an Obsidian vault (no .obsidian folder).`,
    }
  }
  return { kind: "ok", path: absolutePath }
}
