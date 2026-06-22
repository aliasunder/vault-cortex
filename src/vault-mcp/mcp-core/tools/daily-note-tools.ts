/** Daily note tool registration. */

import { z } from "zod"
import { getDailyNote } from "../../vault-operations/daily-notes.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler } from "./tool-helpers.js"

const TOOL_NAMES = {
  VAULT_GET_DAILY_NOTE: "vault_get_daily_note",
} as const

export { TOOL_NAMES as DAILY_NOTE_TOOL_NAMES }

export const registerDailyNoteTools = ({
  server,
  vaultPath,
  logger: sessionLogger,
}: ToolRegistrationContext): void => {
  server.registerTool(
    TOOL_NAMES.VAULT_GET_DAILY_NOTE,
    {
      title: "Get Daily Note",
      description: `Read a daily note by date, using the vault's configured Daily Notes folder and date format (from .obsidian/daily-notes.json). Defaults to today if no date is provided.

Example: vault_get_daily_note({ date: "2026-05-13" })

When to use: When you need today's or a specific date's daily note. Handles path resolution automatically using the vault's Obsidian config — you don't need to know the folder name or filename format. To append content to a daily note section, use the returned path with vault_patch_note.

Errors:
- "invalid date" — use YYYY-MM-DD format (e.g. "2026-05-13")

Returns: JSON with path (resolved vault-relative path), content (note body or null), and exists (boolean). When exists is false, use vault_write_note with the returned path to create the note.`,
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe(
            "Date in YYYY-MM-DD format (defaults to today in server timezone)",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ date }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_GET_DAILY_NOTE,
      })
      reqLogger.info("tool_call", { date })
      return safeHandler(
        reqLogger,
        () => getDailyNote({ vaultPath, date }, reqLogger),
        (result) => JSON.stringify(result),
      )
    },
  )
}
