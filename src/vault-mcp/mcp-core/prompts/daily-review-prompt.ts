/** daily-review prompt — review a day's daily note and reconcile activity.
 *
 *  Daily notes are the journaling surface of the daily rhythm and they feed
 *  the append-with-dates memory loop — so this prompt closes by inviting
 *  durable facts up into the memory layer. */

import { DateTime } from "luxon"
import { z } from "zod"
import { getDailyNote } from "../../vault-operations/daily-notes.js"
import { describeError } from "../../../utils/describe-error.js"
import {
  type PromptRegistrationContext,
  textResult,
  formatNoteLine,
  wrapWithDataMarkers,
  maxCharsArg,
} from "./prompt-helpers.js"

const PROMPT_NAMES = {
  DAILY_REVIEW: "daily-review",
} as const
export { PROMPT_NAMES as DAILY_REVIEW_PROMPT_NAMES }

/** Matches strict YYYY-MM-DD date strings (no time component, no partial dates). */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

const DAILY_RECENT_LIMIT = 10

export const registerDailyReviewPrompt = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: PromptRegistrationContext): void => {
  server.registerPrompt(
    PROMPT_NAMES.DAILY_REVIEW,
    {
      title: "Daily review & reconciliation",
      description: config.memoryEnabled
        ? `Review a day's daily note — its content, outgoing links (with broken-link detection), backlinks, and date-specific activity — reconcile what happened, extract tasks, and surface durable facts worth saving to ${config.memoryDir}/ memory.`
        : `Review a day's daily note — its content, outgoing links (with broken-link detection), backlinks, and date-specific activity — reconcile what happened and extract tasks.`,
      argsSchema: {
        date: z
          .string()
          .regex(ISO_DATE_REGEX, "use YYYY-MM-DD")
          .optional()
          .describe("Day to review in YYYY-MM-DD format (defaults to today)"),
        max_chars: maxCharsArg,
      },
    },
    async (args, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        prompt: PROMPT_NAMES.DAILY_REVIEW,
      })
      reqLogger.info("prompt_call", {
        date: args.date,
        maxChars: args.max_chars,
      })
      const maxChars = args.max_chars ? Number(args.max_chars) : undefined

      try {
        // Resolve the date once so getDailyNote and modifiedOnDate always
        // target the same calendar day, even around midnight.
        const dateArg = args.date ?? DateTime.now().toISODate()!
        const daily = await getDailyNote(
          { vaultPath, date: dateArg },
          reqLogger,
        )
        const modifiedOnDate = search.modifiedOnDate(
          { date: dateArg, limit: DAILY_RECENT_LIMIT },
          reqLogger,
        )
        const outgoingLinks = daily.exists
          ? search.getOutgoingLinks({ path: daily.path }, reqLogger)
          : []
        const backlinks = daily.exists
          ? search.getBacklinks({ path: daily.path }, reqLogger)
          : []

        const trimmedDaily = daily.content?.trim() ?? ""
        const truncated =
          maxChars !== undefined && trimmedDaily.length > maxChars
        const dailySection =
          daily.exists && trimmedDaily.length > 0
            ? wrapWithDataMarkers(
                trimmedDaily,
                { source: daily.path, type: "daily-note", date: dateArg },
                maxChars,
                "vault_get_daily_note",
              )
            : `_No daily note exists at \`${daily.path}\` yet._`

        const brokenLinks = outgoingLinks.filter(
          (link) => !link.exists && !link.daily_note_forward_ref,
        )
        const outgoingSection =
          daily.exists && outgoingLinks.length > 0
            ? [
                ...outgoingLinks.map((link) =>
                  link.exists
                    ? `- ${link.path}${link.title ? ` — ${link.title}` : ""}`
                    : `- ${link.path} (**broken** — target does not exist)`,
                ),
                ...(brokenLinks.length > 0
                  ? [
                      "",
                      `${brokenLinks.length} broken link${brokenLinks.length === 1 ? "" : "s"} — the target note${brokenLinks.length === 1 ? " does" : "s do"} not exist yet.`,
                    ]
                  : []),
              ].join("\n")
            : daily.exists
              ? "No outgoing links in this daily note."
              : "_Daily note does not exist — no link analysis available._"
        const backlinksSection =
          daily.exists && backlinks.length > 0
            ? backlinks.map(formatNoteLine).join("\n")
            : daily.exists
              ? "No other notes link to this daily note."
              : "_Daily note does not exist — no link analysis available._"
        const modifiedSection =
          modifiedOnDate.length > 0
            ? modifiedOnDate.map(formatNoteLine).join("\n")
            : `No notes were modified on ${dateArg}.`

        const reviewSteps = [
          "**Reconcile the day** — what got done, what's still open, what changed — cross-referencing the notes and links above.",
          "**Capture follow-ups** as concrete next actions; with my OK, append them to the daily note with vault_patch_note.",
          ...(config.memoryEnabled
            ? [
                `**Surface durable facts** — any preference, decision, or fact worth remembering long-term — and propose saving it to ${config.memoryDir}/ memory via vault_update_memory (append-with-dates, newest-first). Confirm before writing.`,
              ]
            : []),
          ...(daily.exists
            ? [
                "**Task extraction** — identify any incomplete tasks (`- [ ]`) in the daily note. Are any overdue or blocked?",
                "**Follow the links** — read linked notes (see outgoing links above) for full context on what was referenced today.",
                "**Pattern recognition** — look for recurring themes, repeated tasks, or persistent concerns across this note and recent activity.",
              ]
            : []),
        ]
        const reviewSection = reviewSteps
          .map((step, index) => `${index + 1}. ${step}`)
          .join("\n")

        const text = [
          "# Daily review",
          "",
          daily.exists
            ? `Daily note: \`${daily.path}\``
            : `No daily note found at \`${daily.path}\`. If you'd like one, create it at that path with vault_write_note.`,
          "",
          "## Daily note",
          "",
          dailySection,
          "",
          "## Outgoing links",
          "",
          outgoingSection,
          "",
          "## Backlinks",
          "",
          backlinksSection,
          "",
          `## Notes modified on ${dateArg}`,
          "",
          modifiedSection,
          "",
          "## How to review",
          "",
          reviewSection,
        ].join("\n")
        reqLogger.info("prompt_result", {
          outcome: daily.exists ? "ok" : "no_note",
          chars: text.length,
          truncated,
          outgoingLinks: outgoingLinks.length,
          brokenLinks: brokenLinks.length,
          backlinks: backlinks.length,
        })
        return textResult(text)
      } catch (err) {
        const message = describeError(err)
        reqLogger.error("prompt_error", { error: message })
        return textResult(
          `Could not load the daily note (${message}). Try vault_get_daily_note to fetch it directly.`,
        )
      }
    },
  )
}
