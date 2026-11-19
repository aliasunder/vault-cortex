import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

const ROOT_UID = 0

/** True for the errors a folder gives when it does not let the CLI create a file in it. */
const isFolderPermissionError = (error: unknown): boolean => {
  return (
    error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")
  )
}

const runsAsRoot = (): boolean => process.getuid?.() === ROOT_UID

/**
 * Under sudo the CLI runs as root, and the new file would belong to root;
 * this hands it to the old .env's owner so they can still edit it. lstat
 * reads the .env path itself, never a file a link points to.
 */
const keepOwner = (params: { newFile: number; oldFilePath: string }): void => {
  if (!runsAsRoot()) return
  const oldFileStats = lstatSync(params.oldFilePath, { throwIfNoEntry: false })

  if (!oldFileStats) return
  fchownSync(params.newFile, oldFileStats.uid, oldFileStats.gid)
}

/**
 * Creates the temporary file owner-only and writes the text into it. Its
 * owner is set through the open file, so no path is looked up twice.
 */
const writeTempFile = (params: {
  tempPath: string
  envFilePath: string
  envContent: string
}): void => {
  // "wx" creates the file or fails, so it never writes into a file that exists.
  const tempFile = openSync(params.tempPath, "wx", ENV_FILE_MODE)

  try {
    writeFileSync(tempFile, params.envContent)
    keepOwner({ newFile: tempFile, oldFilePath: params.envFilePath })
  } finally {
    closeSync(tempFile)
  }
}

/**
 * Removes the temporary file when one was created. Without the check, a
 * folder the CLI cannot search would fail the removal too, and that error
 * would replace the one that explains what went wrong.
 */
const removeTempFile = (tempPath: string): void => {
  if (existsSync(tempPath)) rmSync(tempPath)
}

/**
 * True when .env may be rewritten in place after its folder refused a new
 * file: never under sudo, and only for a regular file, so the write is never
 * sent through a link.
 */
const canRewriteInPlace = (params: { error: unknown; envFilePath: string }): boolean => {
  if (!isFolderPermissionError(params.error) || runsAsRoot()) return false
  // existsSync is false for a path the CLI cannot reach, where lstat would throw.
  if (!existsSync(params.envFilePath)) return false
  return lstatSync(params.envFilePath).isFile()
}

/**
 * Writes .env as a new owner-only file renamed over the old one, never into
 * the old file:
 * - the new text is only ever in a file created owner-only;
 * - an interrupted write leaves the old file whole;
 * - a .env that is a link is replaced by a regular file, and the file it
 *   pointed to is left as it was;
 * - under sudo, the new file gets the old .env's owner.
 * When the folder does not let the CLI create a file, it narrows a regular
 * .env to owner-only and rewrites it in place instead, and an interrupted
 * write there can leave the file cut short.
 */
const writeOwnerOnly = (envFilePath: string, envContent: string): void => {
  const tempPath = `${envFilePath}.${randomUUID()}.tmp`

  try {
    writeTempFile({ tempPath, envFilePath, envContent })
  } catch (error) {
    // A write that fails partway (a full disk) leaves part of the text behind.
    removeTempFile(tempPath)
    if (!canRewriteInPlace({ error, envFilePath })) throw error

    // Narrowing the old file before writing keeps the new text out of a file others can read.
    chmodSync(envFilePath, ENV_FILE_MODE)
    writeFileSync(envFilePath, envContent)
    return
  }

  try {
    // rename replaces whatever is at the .env path, a link included, without following it.
    renameSync(tempPath, envFilePath)
  } catch (error) {
    removeTempFile(tempPath)
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
