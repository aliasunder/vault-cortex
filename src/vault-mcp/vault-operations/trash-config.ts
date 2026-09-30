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

/** The setting's values, each with its label in Obsidian and what a note
 *  delete on this server does under it.
 *  - `"system"` is "Move to system trash", Obsidian's default and what an
 *    absent setting means. A container has no system trash, so the note moves
 *    to `.trash/`. When a retention window is set, the retention sweep
 *    (trash-sweeper.ts) removes that copy once it is older than
 *    TRASH_RETENTION_DAYS.
 *  - `"local"` is "Move to Obsidian trash (.trash folder)". The note moves to
 *    `.trash/` and stays there, because the sweep never removes it.
 *  - `"none"` is "Permanently delete". The note is removed outright. */
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

    // Read on every call, never cached. The setting decides whether a delete
    // is recoverable, so a switch from "Permanently delete" to a trash option
    // in Obsidian has to apply to the next delete, not after a restart.
    const fileContent = await readFile(configPath, "utf8")

    // JSON.parse returns `any`, so this annotation is unchecked. Non-object
    // JSON (an array, a string) has no `trashOption` and takes the default
    // below, while `null` throws on the property read and reaches the catch.
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawOption = parsed.trashOption

    if (isTrashOption(rawOption)) return rawOption

    // The file was read and holds no recognized choice, so the server uses
    // Obsidian's default. The catch below differs, because there a choice may
    // exist that the server could not read.
    return "system"
  } catch (error) {
    // app.json does not exist, so no choice was saved and Obsidian's default
    // applies.
    if (isErrnoException(error, "ENOENT")) {
      return "system"
    }

    // Any other failure (EACCES, EIO, malformed JSON) stops the delete. The
    // user's choice is unknown, and falling back to "system" would let the
    // retention sweep remove a note the user set ("local") to keep in
    // .trash/ forever.
    //
    // The warn is the only record of the raw cause (errno and absolute path,
    // or the JSON syntax error). The thrown message reaches the client, so it
    // names only the vault-relative file.
    logger.warn("cannot read trash config", { error: describeError(error) })
    throw new Error("cannot read trash config from .obsidian/app.json", {
      cause: error,
    })
  }
}
