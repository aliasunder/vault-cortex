/** Writes the Obsidian Sync auth token where the Sync client keeps its own
 *  copy — `<config home>/obsidian-headless/auth_token`, directory 0700, file
 *  0600 — so the init chain's `ob login` finds it on the next boot exactly as
 *  if the client had written it. */

import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Logger } from "../../logger.js"

/** Owner-only modes, the same ones the Sync client sets on its own store:
 *  the directory is enterable and listable by UID 1000 alone, the token file
 *  readable by UID 1000 alone. */
const OWNER_ONLY_DIRECTORY_MODE = 0o700
const OWNER_ONLY_FILE_MODE = 0o600

const writeSyncToken = async (
  { tokenFilePath, token }: { tokenFilePath: string; token: string },
  logger: Logger,
): Promise<void> => {
  const tokenDir = dirname(tokenFilePath)
  await mkdir(tokenDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
  // mkdir's mode applies only when it creates the directory; an existing one
  // keeps whatever mode it had, so set it explicitly.
  await chmod(tokenDir, OWNER_ONLY_DIRECTORY_MODE)
  // Write-then-rename: the boot chain reads the file as "non-empty means a
  // token exists", so a crash mid-write must not leave a truncated token
  // behind for `ob login` to reject.
  const stagingPath = `${tokenFilePath}.tmp`
  await writeFile(stagingPath, token, { mode: OWNER_ONLY_FILE_MODE })
  // writeFile's mode applies only when it creates the file; a leftover
  // staging file keeps its old mode, so set it explicitly.
  await chmod(stagingPath, OWNER_ONLY_FILE_MODE)
  await rename(stagingPath, tokenFilePath)
  logger.info("sync_token_written", { path: tokenFilePath })
}

export const syncTokenStore = { writeSyncToken }
