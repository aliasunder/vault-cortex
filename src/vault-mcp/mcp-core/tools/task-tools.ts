/** Task tool registrations — task listing (query) and task updating (mutation). */

import { z } from "zod"
import type { TaskEntry } from "../../search/search-index.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler, dateFilterSchema } from "./tool-helpers.js"
import { taskUpdater } from "../../vault-operations/task-updater.js"

const TOOL_NAMES = {
  VAULT_LIST_TASKS: "vault_list_tasks",
  VAULT_UPDATE_TASK: "vault_update_task",
} as const

export { TOOL_NAMES as TASK_TOOL_NAMES }

/** Drops null fields, false booleans, and empty arrays from a task entry
 *  so responses stay lean — most tasks carry only a few of the optional
 *  metadata fields. */
const formatTaskEntry = (entry: TaskEntry): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) =>
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0),
    ),
  )

export const registerTaskTools = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
}: ToolRegistrationContext): void => {
  // ── vault_list_tasks ────────────────────────────────────────────

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_TASKS,
    {
      title: "List Tasks",
      description: `List checkbox tasks across the whole vault with structured filters — the Tasks-plugin data model over MCP. Both task metadata formats are indexed: emoji signifiers (📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled, 🔺⏫🔼🔽⏬ priority, 🔁 recurrence, 🆔/⛔ dependencies) and Dataview inline fields ([due:: 2026-07-04], [priority:: high], ...). Every result carries its full attribution — note path, folder, nearest heading (the lane on a Kanban board), and line number — so no follow-up reads are needed to locate a task. Task lines inside fenced code blocks and %% %% comment blocks are not indexed.

Example: vault_list_tasks({ due: { before: "2026-07-04" } }) — overdue triage; the default status (not_done) and sort (due ascending) make this the "what's overdue?" call
Example: vault_list_tasks({ path: "Code Projects/vault-cortex/TASKS.md", heading: ["Active", "Up Next", "Waiting On"], sort_by: "position" }) — actionable Kanban lanes in board order; position is the natural sort for boards (file path then line number, preserving card arrangement)
Example: vault_list_tasks({ folder: "Code Projects/vault-cortex" }) — all open tasks across a project tree (TASKS.md + task-notes/ subdirectories); folder is a recursive prefix match
Example: vault_list_tasks({ status: "done", done: { after: "2026-06-26" } }) — what got completed this week
Example: vault_list_tasks({ status: ["todo", "in_progress"] }) — explicit equivalent of "not_done"
Example: vault_list_tasks({ priority: ["highest", "high"], sort_by: "priority" }) — most urgent open work first

When to use: Any vault-wide task triage question — "what's overdue?", "what's open per project?", "what did I finish this week?" — in one call instead of per-board reads.
Prefer vault_read_note (heading mode) to read one specific board lane verbatim. Prefer vault_search for full-text queries over note content.

Parameters:
- status: a single value or an array of values, OR-combined (default "not_done"). Values: "not_done" (todo + in_progress, excludes done AND cancelled), "todo", "in_progress", "done", "cancelled", "all". Virtual values expand in arrays: ["not_done", "done"] matches todo + in_progress + done. Checkbox chars map to statuses the way the Tasks plugin maps them: " " todo, "/" in_progress, "x"/"X" done, "-" cancelled, any other char todo.
- due / scheduled / start / done / created / cancelled: date filters, each { before, on, after } in YYYY-MM-DD — before/after are exclusive, on is exact. A date filter only matches tasks that HAVE that date.
- priority: array of "highest" | "high" | "medium" | "low" | "lowest" | "none", OR-combined ("none" = tasks with no priority signifier).
- folder: recursive note-path prefix — includes all notes under the folder and its subdirectories (e.g. "Code Projects/vault-cortex" matches TASKS.md and task-notes/*.md). Use path for a single board file. tag: bare inline-task-tag name; a parent tag matches children ("errand" matches "errand/groceries"). heading: exact heading text or array of headings, case-sensitive, OR-combined (e.g. ["Active", "Up Next"] returns tasks under either heading — useful for querying multiple Kanban lanes at once). path: one note, must end in ".md".
- sort_by: "due" (default) | "scheduled" | "start" | "created" | "done" | "priority" | "note_mtime" | "position". Date sorts put dateless tasks last in both directions and cascade through related dates when the primary is absent — due falls through to scheduled → start → created; scheduled, start, and created cascade similarly through the remaining date fields. Each cascade step uses its own natural direction (due/scheduled ascending, start/created descending), so a task with no due date but a created date sorts newest-first rather than inheriting due's ascending order. An explicit sort_direction overrides all cascade steps uniformly. "done" does not cascade — it sorts by done date alone, with a modified-time tiebreaker for undated tasks. Fully dateless tasks tie-break by note modified time (most recent first), then file position. Priority sorts highest→lowest with unprioritized between medium and low. "position" sorts by file path then line number — the natural order for Kanban boards where card position IS priority.
- limit: max results (default 50). The total field always reports the full match count, so "50 of 338" is distinguishable from "all 50".

Errors:
- A malformed or calendar-invalid date filter throws with remediation text ("Use YYYY-MM-DD")
- path without the ".md" extension is rejected
- No matches returns { total: 0, tasks: [] }, not an error — don't use as an existence check

Returns: JSON { total, tasks }. Each task carries: path, line (1-based file line number), status, status_char (raw checkbox character, for custom-status vaults), description (inline #tags kept in the text), folder (the note's full parent folder), heading (nearest heading above the task — on a Kanban board this is the lane name, null-omitted above the first heading), lane (the Kanban lane name — only present when is_kanban_task is true, same value as heading but semantically explicit), done_lanes (headings marked with the Kanban plugin's **Complete** marker — only present for Kanban boards; use to determine the done lane for vault_update_task), plus whichever metadata the task has: created/scheduled/start/due/done/cancelled dates, priority, recurrence (rule text — parsed, never executed), on_completion, task_id, depends_on, tags (bare inline tag names), block_id, is_kanban_task (true when the task's parent note has kanban-plugin frontmatter — present only when true, omitted for regular tasks; when true, heading carries the Kanban lane name and completing the task requires a lane move via vault_update_task, not just a checkbox toggle). Null fields, false booleans, and empty arrays are omitted to keep responses lean.`,
      inputSchema: {
        status: z
          .union([
            z.enum([
              "not_done",
              "todo",
              "in_progress",
              "done",
              "cancelled",
              "all",
            ]),
            z
              .array(
                z.enum([
                  "not_done",
                  "todo",
                  "in_progress",
                  "done",
                  "cancelled",
                  "all",
                ]),
              )
              .min(1),
          ])
          .optional()
          .describe(
            'Status filter, OR-combined (default "not_done" = todo + in_progress, excluding done and cancelled). Virtual values expand in arrays: "not_done" adds todo + in_progress, "all" includes every status.',
          ),
        due: dateFilterSchema.describe("Due date (📅 / [due:: ]) bounds"),
        scheduled: dateFilterSchema.describe(
          "Scheduled date (⏳ / [scheduled:: ]) bounds",
        ),
        start: dateFilterSchema.describe("Start date (🛫 / [start:: ]) bounds"),
        done: dateFilterSchema.describe(
          "Done date (✅ / [completion:: ]) bounds",
        ),
        created: dateFilterSchema.describe(
          "Created date (➕ / [created:: ]) bounds",
        ),
        cancelled: dateFilterSchema.describe(
          "Cancelled date (❌ / [cancelled:: ]) bounds",
        ),
        priority: z
          .array(z.enum(["highest", "high", "medium", "low", "lowest", "none"]))
          .optional()
          .describe(
            'Priority levels, OR-combined; "none" selects tasks with no priority signifier',
          ),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Restrict to a note-path prefix (e.g. "Code Projects/vault-cortex")',
          ),
        tag: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Inline task tag, bare name without "#"; parent tags match children',
          ),
        heading: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe(
            'Exact heading text or array of headings, OR-combined, case-sensitive (e.g. "Active" or ["Active", "Up Next"])',
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to one note (vault-relative path ending ".md")'),
        limit: z.number().optional().describe("Max results (default 50)"),
        sort_by: z
          .enum([
            "due",
            "scheduled",
            "start",
            "created",
            "done",
            "priority",
            "note_mtime",
            "position",
          ])
          .optional()
          .describe(
            'Sort key (default "due"). Date sorts cascade through related fields when the primary is absent; each fallback uses its own natural direction. "position" sorts by file path then line number — the natural order for Kanban boards.',
          ),
        sort_direction: z
          .enum(["asc", "desc"])
          .optional()
          .describe(
            'Sort direction. Default per field: "asc" for due/scheduled/priority/position, "desc" for start/created/done/note_mtime. Within a date cascade, each fallback uses its own default; an explicit value overrides all fields uniformly.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      {
        status,
        due,
        scheduled,
        start,
        done,
        created,
        cancelled,
        priority,
        folder,
        tag,
        heading,
        path,
        limit,
        sort_by,
        sort_direction,
      },
      extra,
    ) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_LIST_TASKS,
      })
      reqLogger.info("tool_call", {
        status,
        due,
        scheduled,
        start,
        done,
        created,
        cancelled,
        priority,
        folder,
        tag,
        heading,
        path,
        limit,
        sortBy: sort_by,
        sortDirection: sort_direction,
      })
      return safeHandler(
        reqLogger,
        async () =>
          search.listTasks(
            {
              status,
              due,
              scheduled,
              start,
              done,
              created,
              cancelled,
              priority,
              folder,
              tag,
              heading,
              path,
              limit,
              sortBy: sort_by,
              sortDirection: sort_direction,
            },
            reqLogger,
          ),
        (result) => {
          reqLogger.info("tool_result", {
            resultCount: result.tasks.length,
            total: result.total,
          })
          return JSON.stringify({
            total: result.total,
            tasks: result.tasks.map(formatTaskEntry),
          })
        },
      )
    },
  )

  // ── vault_update_task ───────────────────────────────────────────

  server.registerTool(
    TOOL_NAMES.VAULT_UPDATE_TASK,
    {
      title: "Update Task",
      description: `Update a task's status, priority, or Kanban lane in a single atomic call. Multiple mutations compose — status + priority + lane move all apply in one write cycle.

Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "done" }) — complete a task; on a Kanban board, auto-moves to the done lane
Example: vault_update_task({ path: "TASKS.md", line: 42, priority: "high" }) — set priority
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "in_progress", lane: "Active" }) — start working and move to Active
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", lane: "Up Next" }) — lane move without status change
Example: vault_update_task({ path: "TASKS.md", line: 15, priority: "none" }) — remove priority

When to use: Any task state change — completing, starting, re-prioritizing, or moving between Kanban lanes. Use vault_list_tasks first to get identification fields (path + block_id or line). For Kanban boards with multiple done lanes, check done_lanes from vault_list_tasks to know which to pass.

Parameters:
- Exactly one of block_id or line is required to identify the task.
- At least one of status, priority, or lane is required (the mutation).
- status changes the checkbox and manages dates: "done" appends ✅ date, "cancelled" appends ❌ date, "todo"/"in_progress" removes completion dates. On a Kanban board, "done" without an explicit lane auto-detects the done lane (via **Complete** marker, falling back to "Done" heading).
- lane is only valid on notes with kanban-plugin frontmatter (is_kanban_task in vault_list_tasks).
- format overrides the auto-detected Tasks plugin write format ("emoji" or "dataview"). When omitted, reads the Tasks plugin config from .obsidian/; defaults to emoji if .obsidian/ is not synced to the server. Both formats are always recognized for reading — only the write format is configurable.

Errors:
- "note not found" — path does not exist
- "no task at line N" — line doesn't contain a task checkbox
- "block_id not found" — no task line ends with ^block_id
- "at least one mutation required" — none of status, priority, or lane provided
- "lane requires a Kanban board" — lane on a note without kanban-plugin frontmatter
- "heading not found" — target lane doesn't exist; lists available headings
- "multiple done lanes detected" — pass lane explicitly (check done_lanes)
- "no done lane detected" — no **Complete** marker and no "Done" heading

Returns: JSON { path, line, description, changes } — line is the final 1-based position (may shift after a lane move), description is a short excerpt, changes lists what was applied.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note containing the task (must end in ".md")',
          ),
        block_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Stable task identifier — the ^block-id at the end of the task line, without the ^. Preferred over line.",
          ),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based line number from vault_list_tasks. Fragile if the file changed since the query.",
          ),
        status: z
          .enum(["todo", "in_progress", "done", "cancelled"])
          .optional()
          .describe(
            'Target status. "done" appends ✅ date and auto-moves to done lane on Kanban boards. "cancelled" appends ❌ date.',
          ),
        priority: z
          .enum(["highest", "high", "medium", "low", "lowest", "none"])
          .optional()
          .describe('Target priority. "none" removes the priority emoji.'),
        lane: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target Kanban lane heading for a lane move. Only valid on Kanban boards.",
          ),
        format: z
          .enum(["emoji", "dataview"])
          .optional()
          .describe(
            "Field format for new metadata (done dates, priority). Overrides the auto-detected Tasks plugin config. Default: auto-detected from .obsidian/ config, falling back to emoji.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, block_id, line, status, priority, lane, format }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_UPDATE_TASK,
      })
      reqLogger.info("tool_call", {
        path,
        blockId: block_id,
        line,
        status,
        priority,
        lane,
        format,
      })
      return safeHandler(
        reqLogger,
        async () =>
          taskUpdater.updateTask(
            {
              vaultPath,
              path,
              blockId: block_id,
              line,
              status,
              priority,
              lane,
              format,
            },
            reqLogger,
          ),
        (result) => {
          reqLogger.info("tool_result", {
            path: result.path,
            line: result.line,
            changes: result.changes,
          })
          return JSON.stringify(result)
        },
      )
    },
  )
}
