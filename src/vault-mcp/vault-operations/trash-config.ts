/** Trash config — reads Obsidian's "Deleted files" setting.
 *
 *  Obsidian stores the setting as `trashOption` in `.obsidian/app.json`.
 *  When the file is absent (`.obsidian/` not synced to the server) or the
 *  key is missing (user never changed the default), defaults to `"system"`.
 *  The default matches Obsidian's own default: "Move to system trash." */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"

// ── Types ───────────────────────────────────────────────────────

export type TrashOption = "system" | "local" | "none"

const isTrashOption = (value: unknown): value is TrashOption => {
  return value === "system" || value === "local" || value === "none"
}

// ── Config reader ───────────────────────────────────────────────

// Caches only SUCCESSFUL reads — uncached fallbacks are retried, so a
// config arriving after boot (e.g. from Obsidian Sync) is picked up
// without a restart.
let cachedOption: TrashOption | null = null

/** Reads the `trashOption` setting from `.obsidian/app.json`. Falls back
 *  to `"system"` when the file is missing (uncached — retried on next call),
 *  the key is absent, or the value is unrecognized. */
export const readTrashConfig = async (
  vaultPath: string,
): Promise<TrashOption> => {
  if (cachedOption) return cachedOption

  try {
    const configPath = join(vaultPath, ".obsidian", "app.json")
    const fileContent = await readFile(configPath, "utf8")
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawOption = parsed.trashOption
    const trashOption: TrashOption = isTrashOption(rawOption)
      ? rawOption
      : "system"

    cachedOption = trashOption
    return trashOption
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      logger.debug("failed to read trash config, using default", {
        error: describeError(error),
      })
    }
    return "system"
  }
}

/** Resets the cached config — only for testing. */
export const resetTrashConfigCache = (): void => {
  cachedOption = null
}
