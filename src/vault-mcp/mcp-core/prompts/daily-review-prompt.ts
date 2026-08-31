/** daily-review prompt — review a day's daily note and reconcile activity.
 *
 *  Daily notes are the journaling surface of the daily rhythm and they feed
 *  the append-with-dates memory loop — so this prompt closes by inviting
 *  durable facts up into the memory layer. Task data (due/overdue, scheduled,
 *  in-note) is surfaced from the task index so the agent sees structured
 *  results instead of hand-parsing checkboxes. */

import { DateTime } from "luxon"
import { z } from "zod"
import {
  getDailyNote,
  readDailyNotesConfig,
} from "../../vault-operations/daily-notes.js"
import { describeError } from "../../../utils/describe-error.js"
import type { TaskEntry } from "../../search/search-index.js"
import { TOOL_NAMES } from "../tool-registry.js"
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
const DAILY_TASK_LIMIT = 20

type OutgoingLink = {
  path: string
  title: string | null
  exists: boolean
  daily_note_forward_ref?: boolean
}

/** Formats a single outgoing link as a bullet, flagging broken targets. */
const formatOutgoingLink = (link: OutgoingLink): string =>
  link.exists
    ? `- ${link.path}${link.title ? ` — ${link.title}` : ""}`
    : `- ${link.path} (**broken** — target does not exist)`

/** Assembles the outgoing links section with a broken-link summary. */
const formatOutgoingLinksSection = (
  noteExists: boolean,
  outgoingLinks: readonly OutgoingLink[],
  brokenLinks: readonly OutgoingLink[],
): string => {
  if (!noteExists)
    return "_Daily note does not exist — no link analysis available._"
  if (outgoingLinks.length === 0) return "No outgoing links in this daily note."

  const linkLines = outgoingLinks.map(formatOutgoingLink).join("\n")
  if (brokenLinks.length === 0) return linkLines

  const brokenCount = brokenLinks.length
  const brokenSummary = `${brokenCount} broken link${brokenCount === 1 ? "" : "s"} — the target note${brokenCount === 1 ? " does" : "s do"} not exist yet.`
  return `${linkLines}\n\n${brokenSummary}`
}

/** Assembles the backlinks section. */
const formatBacklinksSection = (
  noteExists: boolean,
  backlinks: ReadonlyArray<{ path: string; title: string }>,
): string => {
  if (!noteExists)
    return "_Daily note does not exist — no link analysis available._"
  if (backlinks.length === 0) return "No other notes link to this daily note."
  return backlinks.map(formatNoteLine).join("\n")
}

/** Formats a task entry as a prompt-friendly bullet with location and metadata. */
const formatTaskForPrompt = (task: TaskEntry, includePath: boolean): string => {
  const checkbox = `[${task.status_char}]`
  const locationParts = [
    includePath ? `\`${task.path}\`` : null,
    task.heading,
  ].filter(Boolean)
  const locationSuffix =
    locationParts.length > 0 ? ` — ${locationParts.join(" → ")}` : ""
  const metadataParts = [
    task.due ? `due: ${task.due}` : null,
    task.priority ? `priority: ${task.priority}` : null,
    task.scheduled ? `scheduled: ${task.scheduled}` : null,
  ].filter(Boolean)
  const metadataSuffix =
    metadataParts.length > 0 ? ` [${metadataParts.join(", ")}]` : ""
  return `- ${checkbox} ${task.description}${locationSuffix}${metadataSuffix}`
}

/** Assembles a task section with an overflow hint when results are capped.
 *  overflowToolHint is keyed on availability so the hint never names a tool
 *  the server doesn't serve. */
const formatTasksSection = ({
  tasks,
  total,
  emptyMessage,
  includePath,
  overflowToolHint,
}: {
  tasks: readonly TaskEntry[]
  total: number
  emptyMessage: string
  includePath: boolean
  overflowToolHint: string
}): string => {
  if (tasks.length === 0) return emptyMessage
  const lines = tasks
    .map((task) => formatTaskForPrompt(task, includePath))
    .join("\n")
  const overflowHint =
    total > tasks.length
      ? `\n\n_Showing ${tasks.length} of ${total}.${overflowToolHint}_`
      : ""
  return `${lines}${overflowHint}`
}

export const registerDailyReviewPrompt = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
  isToolEnabled,
  whenToolEnabledText,
  formatEnabledToolList,
}: PromptRegistrationContext): void => {
  server.registerPrompt(
    PROMPT_NAMES.DAILY_REVIEW,
    {
      title: "Daily review & reconciliation",
      description: config.memoryEnabled
        ? `Reconcile a day — daily note, vault-wide task status (due/overdue, scheduled), modified notes, and links — surface what happened, what's open, and durable facts worth saving to ${config.memoryDir}/ memory.`
        : `Reconcile a day — daily note, vault-wide task status (due/overdue, scheduled), modified notes, and links — surface what happened, what's open, and what needs follow-up.`,
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
        // Resolve the date once so all queries target the same calendar day,
        // even around midnight.
        const resolvedDate = args.date ?? DateTime.now().toISODate()
        if (!resolvedDate) {
          return textResult(
            "Could not determine today's date. Pass an explicit date in YYYY-MM-DD format.",
          )
        }
        const dateArg = resolvedDate

        // Tomorrow is the exclusive upper bound: due < tomorrow captures
        // both due-today and overdue tasks in a single query.
        const tomorrow = DateTime.fromISO(dateArg).plus({ days: 1 }).toISODate()
        if (!tomorrow) {
          return textResult(
            "Could not compute the next day. Pass an explicit date in YYYY-MM-DD format.",
          )
        }

        const dailyNote = await getDailyNote(
          {
            vaultPath,
            date: dateArg,
            envSettings: {
              folder: config.dailyNotesFolder,
              format: config.dailyNotesFormat,
            },
          },
          reqLogger,
        )
        const modifiedOnDate = search.modifiedOnDate(
          { date: dateArg, limit: DAILY_RECENT_LIMIT },
          reqLogger,
        )
        const dailyNotesConfig = await readDailyNotesConfig(vaultPath, {
          folder: config.dailyNotesFolder,
          format: config.dailyNotesFormat,
        })
        const outgoingLinks = dailyNote.exists
          ? search.getOutgoingLinks(
              {
                path: dailyNote.path,
                dailyNotesFolder: dailyNotesConfig.folder,
              },
              reqLogger,
            )
          : []
        const backlinks = dailyNote.exists
          ? search.getBacklinks({ path: dailyNote.path }, reqLogger)
          : []

        // Task queries — vault-wide due/scheduled + daily-note-scoped
        const dueOrOverdue = search.listTasks(
          {
            due: { before: tomorrow },
            status: "not_done",
            sortBy: "due",
            limit: DAILY_TASK_LIMIT,
          },
          reqLogger,
        )
        const scheduledToday = search.listTasks(
          {
            scheduled: { on: dateArg },
            status: "not_done",
            sortBy: "scheduled",
            limit: DAILY_TASK_LIMIT,
          },
          reqLogger,
        )
        // note_mtime is constant within a single note, so the tiebreaker
        // (t.line ASC) governs — tasks render in document order.
        const dailyNoteTasks = dailyNote.exists
          ? search.listTasks(
              {
                path: dailyNote.path,
                status: "all",
                sortBy: "note_mtime",
                limit: DAILY_TASK_LIMIT,
              },
              reqLogger,
            )
          : { total: 0, tasks: [] }

        const trimmedDaily = dailyNote.content?.trim() ?? ""
        const truncated =
          maxChars !== undefined && trimmedDaily.length > maxChars
        const cappedDailyContent = wrapWithDataMarkers({
          content: trimmedDaily,
          markerAttributes: {
            source: dailyNote.path,
            type: "daily-note",
            date: dateArg,
          },
          maxChars,
          truncationToolName: isToolEnabled("vault_get_daily_note")
            ? "vault_get_daily_note"
            : undefined,
        })
        const dailySection =
          dailyNote.exists && trimmedDaily.length > 0
            ? cappedDailyContent
            : `_No daily note exists at \`${dailyNote.path}\` yet._`

        const brokenLinks = outgoingLinks.filter(
          (link) => !link.exists && !link.daily_note_forward_ref,
        )
        const outgoingSection = formatOutgoingLinksSection(
          dailyNote.exists,
          outgoingLinks,
          brokenLinks,
        )
        const backlinksSection = formatBacklinksSection(
          dailyNote.exists,
          backlinks,
        )
        const modifiedSection =
          modifiedOnDate.length > 0
            ? modifiedOnDate.map(formatNoteLine).join("\n")
            : `No notes were modified on ${dateArg}.`

        const taskOverflowHint = whenToolEnabledText(
          "vault_list_tasks",
          " Use vault_list_tasks for the full list.",
        )
        const dueSection = formatTasksSection({
          tasks: dueOrOverdue.tasks,
          total: dueOrOverdue.total,
          emptyMessage: `No tasks are due on ${dateArg} or overdue.`,
          includePath: true,
          overflowToolHint: taskOverflowHint,
        })
        const scheduledSection = formatTasksSection({
          tasks: scheduledToday.tasks,
          total: scheduledToday.total,
          emptyMessage: `No tasks scheduled for ${dateArg}.`,
          includePath: true,
          overflowToolHint: taskOverflowHint,
        })
        const dailyTasksSection = dailyNote.exists
          ? formatTasksSection({
              tasks: dailyNoteTasks.tasks,
              total: dailyNoteTasks.total,
              emptyMessage: "No checkbox tasks in this daily note.",
              includePath: false,
              overflowToolHint: taskOverflowHint,
            })
          : null

        const hasTaskData =
          dueOrOverdue.tasks.length > 0 ||
          scheduledToday.tasks.length > 0 ||
          dailyNoteTasks.tasks.length > 0
        // Write directives name only served tools; without them, the step
        // falls back to conversational output.
        const memoryStepText = isToolEnabled("vault_update_memory")
          ? `**Surface durable facts** — any preference, decision, or fact worth remembering long-term — and propose saving it to ${config.memoryDir}/ memory via vault_update_memory (append-with-dates, newest-first). Confirm before writing.`
          : "**Surface durable facts** — any preference, decision, or fact worth remembering long-term — and tell me so I can record them."
        const memoryStep = config.memoryEnabled ? memoryStepText : ""
        // vault_update_task is the atomic path for status, priority, and lane
        // moves, but it takes no date fields — rescheduling is still a note
        // edit. Each sentence stands alone so any subset reads correctly.
        const rescheduleTools = formatEnabledToolList([
          TOOL_NAMES.VAULT_PATCH_NOTE,
          TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
        ])
        const taskUpdateDirective = [
          whenToolEnabledText(
            TOOL_NAMES.VAULT_UPDATE_TASK,
            "Update status or priority with vault_update_task.",
          ),
          rescheduleTools.length > 0
            ? `Reschedule by editing the date with ${rescheduleTools}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
        const taskReviewWithData =
          taskUpdateDirective.length > 0
            ? `**Review tasks** — check the task summaries above. Are any blocked or need rescheduling? ${taskUpdateDirective}`
            : "**Review tasks** — check the task summaries above. Are any blocked or need rescheduling? Flag what needs updating so I can change it in Obsidian."
        const noDataFallback = dailyNote.exists
          ? "**Scan for tasks** — no structured tasks surfaced for this date. Look for informal action items or commitments in the daily note."
          : ""
        const taskReviewStep = hasTaskData ? taskReviewWithData : noDataFallback
        const noteContextSteps = dailyNote.exists
          ? [
              "**Follow the links** — read linked notes (see outgoing links above) for full context on what was referenced today.",
              "**Pattern recognition** — look for recurring themes, repeated tasks, or persistent concerns across this note and recent activity.",
            ]
          : []
        const reviewSection = [
          "**Reconcile the day** — what got done, what's still open, what changed — cross-referencing the notes and links above.",
          isToolEnabled("vault_patch_note")
            ? "**Capture follow-ups** as concrete next actions; with my OK, append them to the daily note with vault_patch_note."
            : "**Capture follow-ups** as concrete next actions and list them for me to record.",
          memoryStep,
          taskReviewStep,
          ...noteContextSteps,
        ]
          .filter(Boolean)
          .map((step, index) => `${index + 1}. ${step}`)
          .join("\n")

        const noNoteMessage = isToolEnabled("vault_write_note")
          ? `No daily note found at \`${dailyNote.path}\`. If you'd like one, create it at that path with vault_write_note.`
          : `No daily note found at \`${dailyNote.path}\`.`
        const dailyReview = [
          "# Daily review",
          "",
          dailyNote.exists
            ? `Daily note: \`${dailyNote.path}\``
            : noNoteMessage,
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
          `## Tasks due on ${dateArg} or overdue`,
          "",
          dueSection,
          "",
          `## Tasks scheduled for ${dateArg}`,
          "",
          scheduledSection,
          ...(dailyTasksSection !== null
            ? ["", "## Tasks in the daily note", "", dailyTasksSection]
            : []),
          "",
          "## How to review",
          "",
          reviewSection,
        ].join("\n")
        reqLogger.info("prompt_result", {
          outcome: dailyNote.exists ? "ok" : "no_note",
          chars: dailyReview.length,
          truncated,
          outgoingLinks: outgoingLinks.length,
          brokenLinks: brokenLinks.length,
          backlinks: backlinks.length,
          tasksDueOrOverdue: dueOrOverdue.total,
          tasksScheduled: scheduledToday.total,
          tasksDailyNote: dailyNoteTasks.total,
        })
        return textResult(dailyReview)
      } catch (err) {
        const message = describeError(err)
        reqLogger.error("prompt_error", { error: message })
        const dailyFallbackHint = whenToolEnabledText(
          "vault_get_daily_note",
          " Try vault_get_daily_note to fetch the note directly.",
        )
        return textResult(
          `Could not assemble the daily review (${message}).${dailyFallbackHint}`,
        )
      }
    },
  )
}
