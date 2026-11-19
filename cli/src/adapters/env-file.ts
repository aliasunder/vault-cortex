import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type EnvWriteStatus = "created" | "unchanged" | "overwritten" | "kept"

/** .env holds the bearer token (and possibly a vault password), so only its owner may read it. */
const ENV_FILE_MODE = 0o600

/** Matches an env line whose value is wrapped in matching quotes. */
const QUOTED_ENV_VALUE = /^([A-Za-z_][A-Za-z0-9_]*=)(["'])(.*)\2(\s*)$/gm

/** The file's text, or undefined when it does not exist. */
const read = (envFilePath: string): string | undefined => {
  try {
    return readFileSync(envFilePath, "utf8")
  } catch (error) {
    // After a failed read, existsSync decides what the failure means:
    // - a path it cannot reach (missing, behind a folder without permission,
    //   a file where a folder should be, or deleted mid-command) is no .env;
    // - a file that exists but cannot be read still throws.
    if (!existsSync(envFilePath)) return undefined
    throw error
  }
}

/**
 * Writes .env as a new owner-only file renamed over the old one, never into
 * the old file:
 * - the new text is only ever in a file created owner-only;
 * - an interrupted write leaves the old file whole.
 * A .env that is a symbolic link is replaced by a regular file.
 */
const writeOwnerOnly = (envFilePath: string, envContent: string): void => {
  const tempPath = `${envFilePath}.${randomUUID()}.tmp`
  // "wx" creates the temporary file or fails, so it never writes into a file that exists.
  writeFileSync(tempPath, envContent, { mode: ENV_FILE_MODE, flag: "wx" })

  try {
    renameSync(tempPath, envFilePath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

/** Replaces an existing .env's text, leaving it readable by its owner only. */
const replace = (envFilePath: string, envContent: string): void => {
  writeOwnerOnly(envFilePath, envContent)
}

/**
 * Strips surrounding quotes from env values in the file. `docker run
 * --env-file` passes quotes literally (`VAULT_NAME="My Vault"` becomes
 * the value `"My Vault"` with embedded quotes), while Compose strips
 * them. Removing quotes makes the file work correctly for both paths.
 * Returns true when the file was modified.
 */
const stripQuotedValues = (envFilePath: string): boolean => {
  const content = read(envFilePath)

  if (!content) return false
  const sanitized = content.replace(QUOTED_ENV_VALUE, "$1$3$4")

  if (sanitized === content) return false
  writeOwnerOnly(envFilePath, sanitized)
  return true
}

/**
 * Writes .env into targetDir (created if missing), readable by its owner
 * only. An existing .env is never overwritten silently: identical content is
 * skipped, and differing content defers to the resolveConflict callback
 * (interactive prompt, or a constant `false` in non-interactive mode).
 */
const write = async (
  params: { targetDir: string; envContent: string },
  resolveConflict: () => Promise<boolean>,
): Promise<EnvWriteStatus> => {
  const { targetDir, envContent } = params
  mkdirSync(targetDir, { recursive: true })
  const envFilePath = join(targetDir, ".env")
  const existingContent = read(envFilePath)

  if (existingContent === undefined) {
    writeOwnerOnly(envFilePath, envContent)
    return "created"
  }
  if (existingContent === envContent) return "unchanged"
  const overwrite = await resolveConflict()

  if (!overwrite) return "kept"
  writeOwnerOnly(envFilePath, envContent)
  return "overwritten"
}

/** Reads and writes a deployment's .env file; parseEnvValues in env-values.ts parses what read returns. */
export const envFile = {
  read,
  replace,
  stripQuotedValues,
  write,
}
