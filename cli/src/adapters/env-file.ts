import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fchownSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

const runsAsRoot = (): boolean => process.getuid?.() === ROOT_UID

/** Matches a user or group id as sudo writes it into SUDO_UID and SUDO_GID. */
const NUMERIC_ID = /^\d+$/

/** The user who ran sudo, or undefined when the CLI is not running under sudo. */
const findSudoUser = (): { uid: number; gid: number } | undefined => {
  if (!runsAsRoot()) return undefined
  const { SUDO_UID: sudoUid = "", SUDO_GID: sudoGid = "" } = process.env
  const sudoIdsValid = NUMERIC_ID.test(sudoUid) && NUMERIC_ID.test(sudoGid)

  if (!sudoIdsValid) return undefined
  return { uid: Number(sudoUid), gid: Number(sudoGid) }
}

/**
 * Under sudo the CLI runs as root, and the new file would belong to root;
 * this gives it to the user who ran sudo, so they can still edit it without
 * sudo. The owner comes from sudo, never from whatever sits at the .env path.
 */
const giveToSudoUser = (newFile: number): void => {
  const sudoUser = findSudoUser()

  if (!sudoUser) return
  fchownSync(newFile, sudoUser.uid, sudoUser.gid)
}

/** Matches a line of `ls -le` output that lists an ACL entry, such as " 0: group:everyone allow read". */
const ACL_ENTRY_LINE = /^ \d+: /m

/**
 * On macOS a new file takes "allow" ACL entries from its folder, and those
 * grant access that the 0600 mode does not show. This removes them from the
 * still-empty temporary file. Linux masks such entries with the mode given at
 * creation, so it needs no step.
 */
const removeInheritedAcl = (filePath: string): void => {
  if (process.platform !== "darwin") return
  const listing = execFileSync("/bin/ls", ["-le", filePath], { encoding: "utf8" })

  // chmod -N runs only on a file that has entries, so a drive without ACLs never sees it.
  if (!ACL_ENTRY_LINE.test(listing)) return
  execFileSync("/bin/chmod", ["-N", filePath])
}

/**
 * Creates the temporary file owner-only and writes the text into it. Its
 * owner is set through the open file, so no path is looked up twice.
 */
const writeTempFile = (params: { tempPath: string; envContent: string }): void => {
  // "wx" creates the file or fails, so it never writes into a file that exists.
  const tempFile = openSync(params.tempPath, "wx", ENV_FILE_MODE)

  try {
    removeInheritedAcl(params.tempPath)
    writeFileSync(tempFile, params.envContent)
    giveToSudoUser(tempFile)
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
 * Writes .env as a new owner-only file renamed over the old one, never into
 * the old file:
 * - the new text is only ever in a file created owner-only, and on macOS
 *   without the ACL entries its folder passes down;
 * - an interrupted write leaves the old file whole;
 * - a .env that is a link is replaced by a regular file, and the file it
 *   pointed to is left as it was;
 * - under sudo, the new file belongs to the user who ran sudo.
 */
const writeOwnerOnly = (envFilePath: string, envContent: string): void => {
  const tempPath = `${envFilePath}.${randomUUID()}.tmp`

  try {
    writeTempFile({ tempPath, envContent })
  } catch (error) {
    // A write that fails partway (a full disk) leaves part of the text behind.
    removeTempFile(tempPath)
    throw error
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

type FolderOwnership = { ownerUid: number; mode: number }

/** Who owns a folder and its permission bits, or undefined when it does not exist. */
const folderOwnership = (folderPath: string): FolderOwnership | undefined => {
  // existsSync is false for a path the CLI cannot reach, where statSync would throw.
  if (!existsSync(folderPath)) return undefined
  const { uid, mode } = statSync(folderPath)
  return { ownerUid: uid, mode }
}

/**
 * The user ids an install folder may belong to: root, and the user the CLI
 * acts for (under sudo, the user who ran sudo). Undefined on Windows, where
 * files have no Unix owner.
 */
const trustedOwnerIds = (): ReadonlyArray<number> | undefined => {
  const processUid = process.getuid?.()

  if (processUid === undefined) return undefined
  return [ROOT_UID, findSudoUser()?.uid ?? processUid]
}

/**
 * Reads and writes a deployment's .env file, and reports who owns the
 * folder holding it; parseEnvValues in env-values.ts parses what read returns.
 */
export const envFile = {
  folderOwnership,
  read,
  replace,
  stripQuotedValues,
  trustedOwnerIds,
  write,
}
