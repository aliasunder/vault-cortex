/** Daily note tool registration. */

import { z } from "zod"
import { getDailyNote } from "../../vault-operations/daily-notes.js"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { FILESYSTEM_ERROR_ENTRY } from "./tool-helpers.js"

export const registerDailyNoteTools = ({
  registerTool,
  safeHandler,
  isToolEnabled,
  whenToolEnabledText,
  vaultPath,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  registerTool(
    TOOL_NAMES.VAULT_GET_DAILY_NOTE,
    {
      title: "Get Daily Note",
      description: `Read a daily note by date, using the vault's configured Daily Notes folder and filename date format. Each setting comes from the DAILY_NOTES_FOLDER / DAILY_NOTES_FORMAT env vars, falling back to the vault's .obsidian/daily-notes.json, then to "Daily Notes" and YYYY-MM-DD.

Example: vault_get_daily_note({ date: "2026-05-13" })
Example: vault_get_daily_note({}) — returns today's daily note

When to use: When you need today's or a specific date's daily note.${whenToolEnabledText("vault_patch_note", " To append content to a daily note section, use the returned path with vault_patch_note.")}${whenToolEnabledText("vault_recent_notes", " For recent vault activity, vault_recent_notes lists the most recently changed notes; it has no date filter.")}

Parameters:
- date: past and future dates are both valid.

Errors:
- "invalid date" — use YYYY-MM-DD format
- "… is not a calendar date" — the date has the YYYY-MM-DD form but names a day that doesn't exist, such as 2026-02-30; pass a real date
- "daily note format contains unsupported token(s): ..." — the configured format uses tokens the server cannot reproduce (ordinals like Do/Mo, dd, d, e, k/kk, w, Q, Z/ZZ, or the L-family localized formats); the message names the tokens and the fix
- "path traversal blocked" / "hidden path blocked" / "absolute path blocked" — the configured daily notes folder or format leads outside the vault or into a hidden folder; change it in Obsidian, or set DAILY_NOTES_FOLDER and DAILY_NOTES_FORMAT
${FILESYSTEM_ERROR_ENTRY}

Returns: JSON with path (string — resolved vault-relative path), content (string|null — the note's full text, properties block included, or null when the note doesn't exist), and exists (boolean).${isToolEnabled("vault_write_note") ? " When exists is false, create the note with vault_write_note using the returned path." : ""}`,
      inputSchema: {
        date: z
          .string()
          .min(1)
          .optional()
          .describe(
            'YYYY-MM-DD (e.g. "2026-05-13", "2025-12-31"). Defaults to today in the server\'s timezone.',
          ),
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
        () => {
          return getDailyNote(
            {
              vaultPath,
              date,
              settings: {
                source: "env",
                envSettings: {
                  folder: config.dailyNotesFolder,
                  format: config.dailyNotesFormat,
                },
              },
            },
            reqLogger,
          )
        },
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
