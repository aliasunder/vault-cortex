/** Trash config — reads Obsidian's "Deleted files" setting.
 *
 *  Obsidian stores the setting as `trashOption` in `.obsidian/app.json`.
 *  When the file is absent or the key is missing, defaults to `"system"`
 *  (Obsidian's own default: "Move to system trash"). On `:remote` deploys
 *  with Obsidian Sync, the handler skips this reader entirely — `.trash/`
 *  is never synced, so recovery is through Sync's version history, not a
 *  local trash folder. */

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

/** Reads the `trashOption` setting from `.obsidian/app.json` on every call.
 *  The setting decides whether a delete is recoverable, so a user who
 *  switches Obsidian from "Permanently delete" to a trash option must be
 *  followed at once, never after a restart; deletes are rare enough that
 *  the read costs nothing worth caching. Falls back to `"system"` when the
 *  file is missing, the key is absent, or the value is unrecognized. Throws
 *  on non-ENOENT read failures so a broken config never silently causes
 *  permanent delete. */
export const readTrashConfig = async (vaultPath: string): Promise<TrashOption> => {
  try {
    const configPath = join(vaultPath, ".obsidian", "app.json")
    const fileContent = await readFile(configPath, "utf8")
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawOption = parsed.trashOption

    if (isTrashOption(rawOption)) return rawOption

    return "system"
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return "system"
    }
    // Non-ENOENT failures (EACCES, EIO) must not silently fall back to
    // permanent delete — the user may have configured .trash/ retention.
    logger.warn("cannot read trash config", { error: describeError(error) })
    throw new Error("cannot read trash config from .obsidian/app.json", {
      cause: error,
    })
  }
}
