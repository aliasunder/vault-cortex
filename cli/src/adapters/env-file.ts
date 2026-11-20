import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fchownSync,
  lchownSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, relative, sep } from "node:path"

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

/** Matches a line of `ls -led` output that lists an ACL entry, such as " 0: group:everyone allow read". */
const ACL_ENTRY_LINE = /^ \d+: /m

/** Matches a line of `ls -led` output that lists an ACL entry granting access. */
const ACL_ALLOW_LINE = /^ \d+: .* allow /m

/** The `ls -led` listing of a path, which on macOS includes its ACL entries. */
const listWithAcl = (filePath: string): string => {
  return execFileSync("/bin/ls", ["-led", filePath], { encoding: "utf8" })
}

/**
 * Creates the temporary file owner-only and writes the text into it. Its
 * owner is set through the open file, so no path is looked up twice.
 */
const writeTempFile = (params: { tempPath: string; envContent: string }): void => {
  // "wx" creates the file or fails, so it never writes into a file that exists.
  const tempFile = openSync(params.tempPath, "wx", ENV_FILE_MODE)

  try {
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
 * - the new text is only ever in a file created owner-only;
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
 * Folders init creates are owner-only whatever the umask, so a new install
 * folder passes the install-folder check.
 */
const INSTALL_FOLDER_MODE = 0o700

/**
 * Creates targetDir and any missing folders above it. Under sudo each new
 * folder goes to the user who ran sudo, and on macOS each loses the ACL
 * entries its parent passed down, while it is still empty.
 */
const createInstallFolder = (targetDir: string): void => {
  const firstCreatedFolder = mkdirSync(targetDir, { recursive: true, mode: INSTALL_FOLDER_MODE })

  if (!firstCreatedFolder) return
  const nestedNames = relative(firstCreatedFolder, targetDir).split(sep).filter(Boolean)
  const createdFolders = [
    firstCreatedFolder,
    ...nestedNames.map((_, index) => join(firstCreatedFolder, ...nestedNames.slice(0, index + 1))),
  ]
  const sudoUser = findSudoUser()

  // lchown and chmod -h act on the path itself: if something swapped a link in
  // for a new folder, root changes the link, not the file it points to.
  for (const createdFolder of createdFolders) {
    if (sudoUser) lchownSync(createdFolder, sudoUser.uid, sudoUser.gid)
    // chmod -N runs only on a folder that has entries, so a drive without ACLs never sees it.
    if (process.platform === "darwin" && ACL_ENTRY_LINE.test(listWithAcl(createdFolder))) {
      execFileSync("/bin/chmod", ["-h", "-N", createdFolder])
    }
  }
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
  createInstallFolder(targetDir)
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

type FolderOwnership = {
  ownerUid: number
  mode: number
  /**
   * True when an ACL entry on the folder or its .env lets someone in (macOS).
   * Files made in the folder take its entries on, and a .env written there
   * earlier keeps the entries it took then.
   */
  aclAllowsAccess: boolean
}

/**
 * True when the ACL of what the path leads to lists an entry that lets
 * someone in. A link is resolved first, so the listing covers the file or
 * folder the CLI reads, as statSync does for the owner; macOS `ls -L` shows a
 * link target's mode but not its ACL.
 */
const aclAllowsAccessTo = (filePath: string): boolean => {
  return ACL_ALLOW_LINE.test(listWithAcl(realpathSync(filePath)))
}

/** Who owns a folder and who else it lets in, or undefined when it does not exist. */
const folderOwnership = (folderPath: string): FolderOwnership | undefined => {
  // existsSync is false for a path the CLI cannot reach, where statSync would throw.
  if (!existsSync(folderPath)) return undefined
  const { uid, mode } = statSync(folderPath)
  const envFilePath = join(folderPath, ".env")
  const aclAllowsAccess =
    process.platform === "darwin" &&
    (aclAllowsAccessTo(folderPath) || (existsSync(envFilePath) && aclAllowsAccessTo(envFilePath)))
  return { ownerUid: uid, mode, aclAllowsAccess }
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
 * folder holding it and who else it lets in; parseEnvValues in env-values.ts parses what read returns.
 */
export const envFile = {
  folderOwnership,
  read,
  replace,
  stripQuotedValues,
  trustedOwnerIds,
  write,
}
