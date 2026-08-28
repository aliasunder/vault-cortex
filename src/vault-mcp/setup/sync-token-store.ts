/** Writes the Obsidian Sync auth token where the Sync client keeps its own
 *  copy — `<config home>/obsidian-headless/auth_token`, directory 0700, file
 *  0600 — so the init chain's `ob login` finds it on the next boot exactly as
 *  if the client had written it. */

import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Logger } from "../../logger.js"

const writeSyncToken = async (
  { tokenFilePath, token }: { tokenFilePath: string; token: string },
  logger: Logger,
): Promise<void> => {
  const tokenDir = dirname(tokenFilePath)
  await mkdir(tokenDir, { recursive: true, mode: 0o700 })
  // mkdir's mode applies only when it creates the directory; an existing one
  // keeps whatever mode it had, so set it explicitly.
  await chmod(tokenDir, 0o700)
  // Write-then-rename: the boot chain reads the file as "non-empty means a
  // token exists", so a crash mid-write must not leave a truncated token
  // behind for `ob login` to reject.
  const stagingPath = `${tokenFilePath}.tmp`
  await writeFile(stagingPath, token, { mode: 0o600 })
  // writeFile's mode applies only when it creates the file; a leftover
  // staging file keeps its old mode, so set it explicitly.
  await chmod(stagingPath, 0o600)
  await rename(stagingPath, tokenFilePath)
  logger.info("sync_token_written", { path: tokenFilePath })
}

export const syncTokenStore = { writeSyncToken }
