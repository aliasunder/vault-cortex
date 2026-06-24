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
Example: vault_get_daily_note({}) — returns today's daily note

When to use: When you need today's or a specific date's daily note. Handles path resolution automatically using the vault's Obsidian config — you don't need to know the folder name or filename format. To append content to a daily note section, use the returned path with vault_patch_note. Use vault_recent_notes to review recent vault activity around a date (not date-filtered — returns globally recent notes).

Parameters:
- date is ISO YYYY-MM-DD (e.g. "2026-05-13"). Defaults to today in the server's local timezone. Past and future dates are both valid — the tool resolves the configured path for any date and reports exists: false if the note hasn't been created yet. The path is derived from the vault's Daily Notes plugin config (folder + date format), so callers never need to construct daily note paths manually.

Errors:
- "invalid date" — use YYYY-MM-DD format (e.g. "2026-05-13", not "May 13")

Returns: JSON with path (string — resolved vault-relative path), content (string|null — full note body, or null when the note doesn't exist), and exists (boolean). When exists is false, create the note with vault_write_note using the returned path.`,
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD (e.g. "2026-05-13", "2025-12-31"). Defaults to today in the server\'s timezone. Invalid formats like "May 13" return an error.',
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
        (result) => {
          reqLogger.info("tool_result", {
            exists: result.exists,
            path: result.path,
          })
          return JSON.stringify(result)
        },
      )
    },
  )
}
