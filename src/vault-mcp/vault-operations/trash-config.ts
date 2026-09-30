/** Trash config — reads Obsidian's "Deleted files" setting, which Obsidian
 *  stores as `trashOption` in `.obsidian/app.json`. `TrashOption` below lists
 *  the values.
 *
 *  A server running Obsidian Sync never calls this reader. The delete tool's
 *  handler deletes permanently there, because `.trash/` is never synced and
 *  recovery is through Sync's version history. */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"

// ── Types ───────────────────────────────────────────────────────

/** Obsidian's "Deleted files" choices and what a delete does on this server:
 *  - `"system"` ("Move to system trash", the default): moves to `.trash/` and
 *    is swept after TRASH_RETENTION_DAYS, since a container has no system trash.
 *  - `"local"` ("Move to Obsidian trash"): moves to `.trash/` and stays.
 *  - `"none"` ("Permanently delete"): removed outright. */
export type TrashOption = "system" | "local" | "none"

const isTrashOption = (value: unknown): value is TrashOption => {
  return value === "system" || value === "local" || value === "none"
}

// ── Config reader ───────────────────────────────────────────────

/** Reads the `trashOption` setting from `.obsidian/app.json`.
 *  - Returns `"system"` when the file is missing, the key is absent, or the
 *    value is unrecognized.
 *  - Throws when the file exists but cannot be read or parsed. */
export const readTrashConfig = async (vaultPath: string, logger: Logger): Promise<TrashOption> => {
  try {
    const configPath = join(vaultPath, ".obsidian", "app.json")

    // Read on every call, so a switch away from "Permanently delete" applies
    // to the next delete rather than after a restart.
    const fileContent = await readFile(configPath, "utf8")
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawOption = parsed.trashOption

    if (isTrashOption(rawOption)) return rawOption

    // A missing or unknown value means no saved choice, so Obsidian's default applies.
    return "system"
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return "system"
    }

    // Any other failure hides the user's choice, and a "system" fallback could
    // let the sweep remove a note the user set to keep ("local"). The warn
    // carries the raw cause; only the thrown message reaches the client.
    logger.warn("cannot read trash config", { error: describeError(error) })
    throw new Error("cannot read trash config from .obsidian/app.json", {
      cause: error,
    })
  }
}
