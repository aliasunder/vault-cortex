/** Task tool registrations — task listing (query), creation, and updating (mutation). */

import { z } from "zod"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import {
  dateFilterSchema,
  describePropertiesBlockErrorEntry,
  OPENING_BLOCK_ERROR_ENTRY,
} from "./tool-helpers.js"
import { taskMutations } from "../../vault-operations/task-mutations.js"

export const registerTaskTools = ({
  registerTool,
  safeHandler,
  whenToolEnabledText,
  vaultPath,
  search,
  logger: sessionLogger,
}: ToolRegistrationContext): void => {
  // ── vault_list_tasks ────────────────────────────────────────────

  registerTool(
    TOOL_NAMES.VAULT_LIST_TASKS,
    {
      title: "List Tasks",
      description: `List checkbox tasks across the whole vault with structured filters — the Tasks-plugin data model over MCP. Both task metadata formats are indexed: emoji signifiers (📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled, 🔺⏫🔼🔽⏬ priority, 🔁 recurrence, 🏁 onCompletion, 🆔/⛔ dependencies) and Dataview inline fields ([due:: 2026-07-04], [priority:: high], ...). Every result carries its attribution — note path, folder, line number, and the nearest heading when the task sits under one (the lane on a Kanban board) — so no follow-up reads are needed to locate a task. Task lines inside fenced code blocks and %% %% comment blocks are not indexed. Checkboxes typed NON_TASK in the Tasks plugin's status registry are also excluded.

Example: vault_list_tasks({ due: { before: "2026-07-04" } }) — overdue triage; the default status (not_done) and sort (due ascending) make this the "what's overdue?" call
Example: vault_list_tasks({ path: "Code Projects/vault-cortex/TASKS.md", heading: ["Active", "Up Next", "Waiting On"], sort_by: "position" }) — actionable Kanban lanes in board order
Example: vault_list_tasks({ folder: "Code Projects/vault-cortex" }) — all open tasks across a project tree (TASKS.md + task-notes/ subdirectories)
Example: vault_list_tasks({ status: "done", done: { after: "2026-06-26" } }) — what got completed this week
Example: vault_list_tasks({ top_level_only: true, path: "TASKS.md" }) — board cards only, excluding checklist sub-items

When to use: Reading task status and order on one board (path + sort_by: "position"; add status: "all" to include done and cancelled cards). Also any vault-wide task triage question — "what's overdue?", "what's open per project?", "what did I finish this week?" — in one call instead of per-board reads.
${whenToolEnabledText("vault_read_note", "Prefer vault_read_note (heading mode) only when you need a lane's verbatim Markdown or a task's state right after a write. ")}Prefer vault_search for full-text queries over note content.

Behavior: Reads the search index, which picks up a file change within a few seconds, so a task written moments ago may still show its old state.

Parameters:
- status: virtual values expand in arrays — ["not_done", "done"] matches todo + in_progress + done.
- due / scheduled / start / done / created / cancelled: a date filter only matches tasks that HAVE that date.
- folder: a whole folder, subfolders included ("Projects" covers "Projects/Archive" but not "ProjectsOld/"), ignoring ASCII letter case.

Errors:
- A malformed or calendar-invalid date filter throws with remediation text ("Use YYYY-MM-DD")
- path without the ".md" extension is rejected
- No matches returns { total: 0, tasks: [] }, not an error

Returns: JSON { total, tasks }. Every task carries path, line, status, status_char, description, folder, depth (0 for top-level, 1+ for sub-tasks), is_kanban_task, depends_on, and tags (the arrays are [] when empty). Every other field appears only when the task has it: heading (nearest heading above the task), created/scheduled/start/due/done/cancelled dates, priority, recurrence, on_completion, task_id, block_id, parent_block_id (sub-tasks whose parent carries a ^block-id), done_lanes (Kanban boards only), and subtask_progress — { done, total } over the task's DIRECT checklist children, present only when the task has a checklist; done counts status "done" only (a cancelled child counts toward total, not done), and the counts ignore the query's filters — so a filtered or top_level_only read still shows each card's checklist progress.`,
      inputSchema: {
        status: z
          .union([
            z.enum(["not_done", "todo", "in_progress", "done", "cancelled", "all"]),
            z.array(z.enum(["not_done", "todo", "in_progress", "done", "cancelled", "all"])).min(1),
          ])
          .optional()
          .default("not_done")
          .describe(
            'Status filter, OR-combined (default "not_done" = todo + in_progress, excluding done and cancelled). "all" includes every status.',
          ),
        due: dateFilterSchema.describe("Due date (📅 / [due:: ]) bounds"),
        scheduled: dateFilterSchema.describe("Scheduled date (⏳ / [scheduled:: ]) bounds"),
        start: dateFilterSchema.describe("Start date (🛫 / [start:: ]) bounds"),
        done: dateFilterSchema.describe("Done date (✅ / [completion:: ]) bounds"),
        created: dateFilterSchema.describe("Created date (➕ / [created:: ]) bounds"),
        cancelled: dateFilterSchema.describe("Cancelled date (❌ / [cancelled:: ]) bounds"),
        priority: z
          .array(z.enum(["highest", "high", "medium", "low", "lowest", "none"]))
          .min(1)
          .optional()
          .describe(
            'Priority levels, OR-combined; "none" selects tasks with no priority signifier',
          ),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to a folder (e.g. "Code Projects/vault-cortex")'),
        tag: z
          .string()
          .min(1)
          .optional()
          .describe('Inline task tag, bare name without "#"; parent tags match children'),
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
          .describe('Restrict to one note (vault-relative path ending ".md", case-sensitive)'),
        top_level_only: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, only top-level tasks (depth 0) are returned — excludes indented sub-tasks and checklist items. Default false.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe("Max results (default 50); total always reports the full match count"),
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
          .default("due")
          .describe(
            'Sort key (default "due"). Date sorts cascade through related fields when the primary is absent (through the rest of due → scheduled → start → created, in that order; done does not cascade); each fallback uses its own natural direction. "position" sorts by file path then line number — the natural order for Kanban boards.',
          ),
        sort_direction: z
          .enum(["asc", "desc"])
          .optional()
          .describe(
            'Sort direction. Default per field: "asc" for due/scheduled/priority/position, "desc" for start/created/done/note_mtime. Within a date cascade, each fallback uses its own default; an explicit value overrides all fields uniformly.',
          ),
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
        top_level_only,
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
        topLevelOnly: top_level_only,
        limit,
        sortBy: sort_by,
        sortDirection: sort_direction,
      })
      return safeHandler(
        reqLogger,
        async () => {
          return search.listTasks(
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
              topLevelOnly: top_level_only,
              limit,
              sortBy: sort_by,
              sortDirection: sort_direction,
            },
            reqLogger,
          )
        },
        (result) => {
          reqLogger.info("tool_result", {
            resultCount: result.tasks.length,
            total: result.total,
          })
          return JSON.stringify({
            total: result.total,
            tasks: result.tasks,
          })
        },
      )
    },
  )

  // ── vault_create_task ──────────────────────────────────────────

  registerTool(
    TOOL_NAMES.VAULT_CREATE_TASK,
    {
      title: "Create Task",
      description: `Create a correctly-formatted task in one call — description, target heading, dates, priority, block_id, and optional checklist sub-items. The task is always created as todo (the Tasks plugin's todo symbol, [ ] by default), with its created date (➕) set to today${whenToolEnabledText("vault_update_task", "; set in_progress later with vault_update_task")}. Metadata uses the format the vault's Tasks plugin is configured for (emoji unless its config says Dataview); override it only at the user's request, since the plugin reads just one format.

Example: vault_create_task({ path: "TASKS.md", description: "Fix login bug", block_id: "fix-login", heading: "Active", priority: "high", due: "2026-09-15" }) — a card in a Kanban board's Active lane
Example: vault_create_task({ path: "TASKS.md", description: "Sub-bug", parent_block_id: "fix-login", due: "2026-09-01" }) — full sub-task under fix-login; no block_id on a Kanban sub-task
Example: vault_create_task({ path: "Projects/plan.md", description: "Quick fix", block_id: "quick-fix", parent_line: 42 }) — sub-task in a regular note under a parent identified by line number
Example: vault_create_task({ path: "TASKS.md", description: "Write release notes", block_id: "release-notes", heading: "Active", position: 3 }) — insert as the 3rd card in the lane

When to use: Creating a new task card on a board or in a note. Guarantees correct field ordering (description → priority → 🔁 recurrence → 🏁 on_completion → ➕ created → 🛫 start → ⏳ scheduled → 📅 due → 🆔 task_id → ⛔ depends_on → ^block_id)${whenToolEnabledText("vault_list_tasks", " so the card round-trips through vault_list_tasks with all fields intact")}.${whenToolEnabledText("vault_update_task", " For lightweight checklist items under an existing card (no metadata), use vault_update_task's add_subtasks param instead.")}

Parameters:
- heading is required on Kanban boards (notes with a kanban-plugin property) unless a parent is given.
- parent_block_id / parent_line: ${whenToolEnabledText("vault_update_task", "the same pair vault_update_task uses (block_id / line). ")}Pass at most one. Either is mutually exclusive with heading — a sub-task lives wherever its parent lives.
- block_id / subtasks: block_id is required, except on a Kanban sub-task, where it is refused, as is a subtasks item ending in a ^block-id on a board. When the Kanban plugin saves the board, it copies an indented line's block ID onto its card, replacing the card's own ID.
- position: ignored without a heading, and under a parent, where the sub-task goes after the parent's last sub-item.
- priority: the plugin ranks "no signifier" (normal priority) between medium and low.
- recurrence: a rule ending "when done" bases the next occurrence on the completion day; a task with no dates recurs as a dateless copy.
- due / scheduled / start: omit a date rather than guessing — an absent 📅 means "no deadline".

Errors: (messages use camelCase names, e.g. blockId for block_id)
- "note not found" — path does not exist; check the path${whenToolEnabledText("vault_list_notes", " with vault_list_notes")}
- "path must end in …" — add the .md extension
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "heading required for Kanban boards" — kanban-plugin note without heading; pass heading with the target lane
- "heading "X" not found; available: ..." — no heading matches; the error lists the note's headings
- "cannot place at position P under "X" — the heading appears N times" — integer position on a note with duplicate heading names; use "top" or "bottom" (they place under the first match), or rename one section to make it unique
- "parent task not found" — parent_block_id or parent_line doesn't resolve to a task (message names the blockId or line tried), or the line is inside a fenced code block or %% %% comment; re-read the parent's block_id or line${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")}
- "parent task ambiguous" — more than one task line ends in that ^id (the message lists their line numbers); pass parent_line instead
- "checkbox "[c]" is a NON_TASK status" — the parent's checkbox character (c) is typed NON_TASK in the Tasks plugin's status settings, so it is not a task; the user must change its type there, then restart the server
- "no checkbox symbol for status ..." — the Tasks plugin's status settings have no symbol for todo, and the default [ ] character has another type; the user must add a todo symbol there, then restart the server
- "parentBlockId and parentLine are mutually exclusive" — both parent_block_id and parent_line were passed; drop one
- "parent and heading are mutually exclusive" — a parent (parent_block_id or parent_line) and heading were both passed; drop one
- "blockId ... already exists in this note" — pick a block_id not yet used in the note
- "blockId ... contains invalid characters" — block_id must match [a-zA-Z0-9-]+
- "blockId is required" — pass block_id
- "blockId is not allowed on a sub-task on a Kanban board" / "subtask ... ends in a block ID" — drop the block_id, or the trailing ^id from the checklist item
- "description is empty" / "subtasks cannot contain an empty item" — whitespace-only description or checklist item; pass visible text
- "description must be a single line" / "subtasks items must be a single line" — a task is one file line; a line break in the text would split its metadata onto a line the parser never reads; remove the line breaks
- "taskId ... contains invalid characters" / "dependsOn entry ... contains invalid characters" — task_id and every depends_on entry must match [a-zA-Z0-9_-]+ (the Tasks plugin's id grammar)
- "unrecognized recurrence rule ..." — the rule text is not Tasks-plugin natural language; written as-is it would silently never recur; use a rule such as "every week" or "every 2 weeks when done"
- "invalid date" — a date param fails calendar validation; pass a real YYYY-MM-DD date
- "concurrent write in progress" — another write to this note is in flight; retry
${describePropertiesBlockErrorEntry()}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: The Tasks plugin reads metadata off the END of a task line. When description or subtasks text ends in a signifier the plugin's parser recognizes as a field (an emoji field like "🔁 every week", or a Dataview [key:: value] field), with only other recognized fields after it, that text is read back as metadata, not text. Whether it is captured depends on the field's value grammar: 🔁 reads any trailing words as its recurrence rule, while 📅 followed by non-date words stays description text. Captured text can also change the value read back for the field beside it, or add a field the call never set. The write still succeeds either way; when the stored line would read back differently than submitted, the result carries an advisories array naming each divergence; reword the text to avoid one.

Returns: JSON { path, line, description, block_id, heading, subtasks, changes, advisories } — line is the new task's 1-based line number in the file; description is the text as submitted; block_id is omitted when the task has none (line is then its handle); heading is the nearest heading above the new task (omitted when the note has none); subtasks lists each checklist item written as { line, description } (omitted when none) — checklist items are written without a block_id, so line is the handle for a follow-up update; changes lists every field written as "field: (none) → value", and checklist items as "subtasks: 0 → N"; advisories (omitted when the line round-trips clean) lists one sentence per place the stored line parses back differently than submitted — see Obsidian syntax above.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note (must end in ".md"). The note must already exist. Use the exact letter case.',
          ),
        description: z.string().min(1).describe("The task text (before metadata fields)."),
        block_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The ^block-id (without the ^) for stable identification — letters, digits, and hyphens only ([a-zA-Z0-9-]+), unique within the note.",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target heading's text, without the # marks, matched exactly. On a regular note, omit to append at end of body.",
          ),
        parent_block_id: z
          .string()
          .min(1)
          .optional()
          .describe("^block-id (without the ^) of an existing task to nest under as a sub-task."),
        parent_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based line number of an existing task to nest under as a sub-task. Fragile if the file changed since the line was read.",
          ),
        position: z
          .union([z.enum(["top", "bottom"]), z.number().int().min(1)])
          .optional()
          .describe(
            'Where within the heading section the task is placed: "top" first in the section, "bottom" at the end of the section, or a 1-based integer for an exact slot among the section\'s top-level tasks (a Kanban lane\'s cards; nested tasks are not counted). A position past the count lands directly below the last top-level task (unlike "bottom", which appends after any non-task text at the end of the section). Defaults to "bottom" ("top" on Kanban boards set to new-card-insertion-method: "prepend").',
          ),
        priority: z
          .enum(["highest", "high", "medium", "low", "lowest"])
          .optional()
          .describe(
            "Priority signifier: highest 🔺, high ⏫, medium 🔼, low 🔽, lowest ⏬. Omit for normal priority — no signifier is written.",
          ),
        recurrence: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Tasks plugin 🔁 rule in natural language (e.g. "every week", "every month on the 15th", "every 2 weeks when done"). Completing the task spawns its next occurrence.',
          ),
        on_completion: z
          .enum(["delete", "keep"])
          .optional()
          .describe(
            'Tasks plugin 🏁 onCompletion action. "delete" removes the task line and its children on completion; "keep" leaves it in place, as omitting the field does.',
          ),
        due: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Deadline (📅), YYYY-MM-DD, calendar-validated. Omit when there is no deadline.",
          ),
        scheduled: z
          .string()
          .min(1)
          .optional()
          .describe("Day the work is planned for (⏳), YYYY-MM-DD, calendar-validated."),
        start: z
          .string()
          .min(1)
          .optional()
          .describe("Earliest day work can begin (🛫), YYYY-MM-DD, calendar-validated."),
        task_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Tasks plugin 🆔 identifier other tasks can name in depends_on — letters, digits, hyphens, and underscores; separate from block_id.",
          ),
        depends_on: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Tasks plugin ⛔ dependency IDs (🆔 values of other tasks), not checked against existing tasks. Non-empty; omit when there are no dependencies.",
          ),
        subtasks: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Checklist items, not sub-tasks: plain indented todo lines under the card, with no metadata (not even ➕). For full sub-tasks with dates and priority, make a separate call with parent_block_id.",
          ),
        format: z
          .enum(["emoji", "dataview"])
          .optional()
          .describe(
            "Field format. Default: auto-detected from .obsidian/ config, falling back to emoji.",
          ),
      },
    },
    async (
      {
        path,
        description,
        block_id,
        heading,
        parent_block_id,
        parent_line,
        position,
        priority,
        recurrence,
        on_completion,
        due,
        scheduled,
        start,
        task_id,
        depends_on,
        subtasks,
        format,
      },
      extra,
    ) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_CREATE_TASK,
      })
      reqLogger.info("tool_call", {
        path,
        blockId: block_id,
        heading,
        parentBlockId: parent_block_id,
        parentLine: parent_line,
        position,
        priority,
        recurrence,
        onCompletion: on_completion,
        due,
        scheduled,
        start,
        taskId: task_id,
        dependsOn: depends_on,
        subtaskCount: subtasks?.length,
        format,
      })
      return safeHandler(
        reqLogger,
        async () => {
          return taskMutations.createTask(
            {
              vaultPath,
              path,
              statusRegistry: search.statusRegistry,
              description,
              blockId: block_id,
              heading,
              parentBlockId: parent_block_id,
              parentLine: parent_line,
              position,
              priority,
              recurrence,
              onCompletion: on_completion,
              due,
              scheduled,
              start,
              taskId: task_id,
              dependsOn: depends_on,
              subtasks,
              format,
            },
            reqLogger,
          )
        },
        (result) => {
          reqLogger.info("tool_result", {
            path: result.path,
            line: result.line,
            blockId: result.block_id,
            heading: result.heading,
            changes: result.changes,
          })
          return JSON.stringify(result)
        },
      )
    },
  )

  // ── vault_update_task ───────────────────────────────────────────

  registerTool(
    TOOL_NAMES.VAULT_UPDATE_TASK,
    {
      title: "Update Task",
      description: `Update a task's status, priority, description, dates, dependencies, block_id, checklist items, or heading placement in one call. Any combination of these can change together — every field passed is written in a single edit.

Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "done" }) — complete a task; on a Kanban board, auto-moves to the done lane; a recurring task (🔁) spawns its next occurrence
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", recurrence: "every week" }) — make a task recurring (null removes the rule)
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", heading: "Done" }) — move a task to a different heading (lands at the top of the lane by default; the checkbox is unchanged)
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", description: "Updated task name", due: "2026-10-01", scheduled: null }) — change the description, set one date, and clear another
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "in_progress", add_subtasks: ["Design", "Implement", "Test"] }) — start working and add checklist stages
Example: vault_update_task({ path: "TASKS.md", line: 42, assign_block_id: "my-task" }) — add a block_id to a task that lacks one
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", heading: "Active", position: 3 }) — move to the 3rd position in a lane

When to use: Any change to an existing task — completing, starting, re-prioritizing, editing text, setting or clearing dates, adding checklist items, assigning block_ids, moving between headings, or reordering within a lane.${whenToolEnabledText("vault_list_tasks", " Use vault_list_tasks first to get identification fields (path + block_id or line).")}${whenToolEnabledText("vault_create_task", " For creating a new task, use vault_create_task instead.")}

Parameters:
- Exactly one of block_id or line is required to identify the task. A sub-task on a Kanban board has no block_id, so re-read its line${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")} just before an update by line: each save by the Kanban plugin rewrites the board${whenToolEnabledText("vault_list_tasks", ", and the listing can take a few seconds to catch up with a save")}.
- At least one change is required. Clearing is always explicit null — omitting a field leaves it untouched.
- status side effects:
  Kanban: "done" moves the card and everything nested under it to the done lane (nested checkboxes left as they are); a sub-task stays under its parent.
  Recurring (🔁), on "done" only: spawns the next occurrence above the completed one, dates advanced per the rule; when the Tasks plugin puts the next recurrence on the line below, the spawn goes there and the completed task's nested lines stay with it. The spawn stays in the source lane with no block_id, 🆔, or ⛔ — follow up with assign_block_id on next_occurrence.line, except on an indented line of a Kanban board. Completing by line is NOT idempotent for recurring tasks (the spawn occupies the old line); prefer block_id.
  Delete (🏁 delete / [onCompletion:: delete]), on "done": removes the task line and its children instead of moving to done. With 🔁 + 🏁, the spawn is created first, then the completed task is removed. Result carries on_completion_applied: "delete".
- recurrence: a rule ending "when done" bases the next occurrence on the completion day. When set together with status "done", the new rule governs the spawn. Setting recurrence to null while completing removes the rule and completes without spawning.
- on_completion: passed together with status, the submitted value governs the delete decision — "keep" while completing a "delete" task prevents the deletion.
- position: applies to a heading move or an auto-done-lane move; otherwise it reorders the task within its current lane. Omitting position performs no reorder. Ignored when the task is deleted on completion. Not valid on sub-tasks.

Errors: (messages use camelCase names, e.g. assignBlockId for assign_block_id)
- "note not found" — path does not exist; check the path${whenToolEnabledText("vault_list_notes", " with vault_list_notes")}
- "path must end in …" — add the .md extension
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "exactly one of blockId or line is required" / "blockId and line are mutually exclusive" — pass exactly one of block_id or line
- "blockId ... not found" — no task line in the note ends with ^block_id; check the id${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")}, or target by line
- "blockId ... is inside a fenced code block or comment" — the only lines ending in that ^id sit inside a fenced code block or %% %% comment, which hold no tasks; check the id, or target by line
- "blockId ... matches N task lines" — more than one task line ends in the id (the message lists their line numbers); target the intended task by line. To repair on a regular note, give all but one line a new id with assign_block_id. On a Kanban board, where the plugin copied an indented line's id onto its card, remove that line's id (assign_block_id: null, by line), then give the card back its original id by line (links to the card still name it) or a new one
- "no task at line N" — line doesn't contain a task checkbox; re-read line numbers${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")}, or target by block_id
- "line N is inside a fenced code block or comment" — the line is inside a fenced code block or %% %% comment; target a line outside the fence
- "checkbox "[c]" is a NON_TASK status" — the task's checkbox character (c) is typed NON_TASK in the Tasks plugin's status settings, so it is not a task; the user must change its type there, then restart the server
- "no checkbox symbol for status ..." — the Tasks plugin's status settings have no symbol for the status the message names, and its default character has another type; the user must add one there, then restart the server
- "at least one mutation" — no change params provided; pass at least one field to change
- "cannot move a sub-task to a heading" — explicit heading on a task nested under another task (depth > 0${whenToolEnabledText("vault_list_tasks", " in vault_list_tasks")}); move its parent instead
- "cannot reposition a sub-task" — explicit position on a sub-task (sub-tasks move with their parent); reposition the parent instead
- "cannot reorder a task that sits above the first heading" — position without a heading on a task before the first section heading; pass heading to move it into a section
- "cannot reorder within "X" — the heading appears N times" — same-lane reorder on a card whose heading name is duplicated in the note; rename one section to make it unique
- "cannot place at position P under "X" — the heading appears N times" — cross-lane move with an integer position to a heading name that appears more than once; use "top" or "bottom" (they place under the first match), or rename one section to make it unique
- "heading "X" not found; available: ..." — target heading doesn't exist; the error lists the note's headings
- "multiple done lanes detected" — status "done" on a Kanban board with more than one lane marked complete (a **Complete** line under its heading); pass heading to pick the lane
- "no done lane detected" — status "done" on a Kanban board with no **Complete** line and no "Done" heading; pass heading explicitly
- "blockId ... already exists" / "blockId ... contains invalid characters" — assign_block_id must be unique in the note and match [a-zA-Z0-9-]+
- "assignBlockId is not allowed" / "description ends in a block ID" / "subtask ... ends in a block ID" — a new ^id on an indented line of a Kanban board; leave the line without an id and target it by line, and drop any trailing ^id from the text
- "invalid date" — a date param fails calendar validation; pass a real YYYY-MM-DD date
- "description cannot be empty" / "addSubtasks cannot contain an empty item" — whitespace-only description or checklist item; pass visible text
- "description must be a single line" / "addSubtasks items must be a single line" — a task is one file line; a line break in the text would split its metadata onto a line the parser never reads; remove the line breaks
- "taskId ... contains invalid characters" / "dependsOn entry ... contains invalid characters" — task_id and every depends_on entry must match [a-zA-Z0-9_-]+ (the Tasks plugin's id grammar)
- "unrecognized recurrence rule ..." — the rule text is not Tasks-plugin natural language; written as-is it would silently never recur; use a rule such as "every week" or "every 2 weeks when done"
- "concurrent write in progress" — another write to this note is in flight; retry
${describePropertiesBlockErrorEntry()}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: The Tasks plugin reads metadata off the END of a task line. When description or add_subtasks text ends in a signifier the plugin's parser recognizes as a field (an emoji field like "🔁 every week", or a Dataview [key:: value] field), with only other recognized fields after it, that text is read back as metadata, not text. Whether it is captured depends on the field's value grammar: 🔁 reads any trailing words as its recurrence rule, while 📅 followed by non-date words stays description text. Captured text can also change the value read back for the field beside it, or add a field the call never set. The write still succeeds either way; when the stored line would read back differently than this call set, the result carries an advisories array naming each divergence; reword the text to avoid one. The ✅/❌ dates a status change adds or removes produce no advisories by themselves. A description signifier that changes how a stamped date parses back is still reported.

Returns: JSON { path, line, description, block_id, heading, subtasks, next_occurrence, changes, advisories, on_completion_applied }.
- line is the task's final 1-based line number in the file; after an on_completion delete, the line the task occupied before removal.
- description is the current text. block_id and heading reflect the task after the update; block_id is omitted when the task has none, heading when the task sits above the first heading.
- subtasks lists each checklist item add_subtasks wrote as { line, description } (omitted when none were added); checklist items are written without a block_id, so line is the handle for a follow-up update.
- next_occurrence is present only when a completion spawned a recurring task's next occurrence: { line, description, due?, scheduled?, start? } with only the dates the occurrence has. It carries no block_id, so line is its handle.
- changes lists every field applied as "field: before → after", with "(none)" for an absent value. add_subtasks appears as "subtasks", its two sides checklist-item counts, and a spawn adds "next_occurrence: (none) → line N".
- advisories (omitted when there are none) lists one sentence for each: a stored line that parses back differently than submitted (see Obsidian syntax above), a duplicate tag removed from the line, or a completed recurring task whose rule yields no next occurrence (unreadable rule text, or a finite rule with no occurrences left).
- on_completion_applied is "delete", present only when the effective on_completion was delete (already on the task or set in the same call) and the task was transitioned to done.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note containing the task (must end in ".md"). Use the exact letter case.',
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
            'Target status. "done" adds the ✅ date and "cancelled" the ❌ date, when the Tasks plugin\'s settings stamp them; leaving either status removes its date.',
          ),
        priority: z
          .enum(["highest", "high", "medium", "low", "lowest"])
          .nullable()
          .optional()
          .describe("Priority signifier to set, or null to remove it."),
        recurrence: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            'Tasks plugin 🔁 rule in natural language (e.g. "every week", "every month on the 15th", "every 2 weeks when done") to set, or null to remove it. Completing the task spawns its next occurrence.',
          ),
        on_completion: z
          .enum(["delete", "keep"])
          .nullable()
          .optional()
          .describe(
            'Tasks plugin 🏁 onCompletion action to set, or null to remove it. "delete" removes the task line on completion; "keep" leaves it in place (which is also the behavior when no 🏁 field exists on the task). Omitting this parameter leaves the field unchanged.',
          ),
        description: z
          .string()
          .min(1)
          .optional()
          .describe(
            "New task description text. Replaces the existing description; metadata fields and block_id are preserved.",
          ),
        due: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Due date (YYYY-MM-DD) to set, or null to clear."),
        scheduled: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Scheduled date (YYYY-MM-DD) to set, or null to clear."),
        start: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Start date (YYYY-MM-DD) to set, or null to clear."),
        created: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            `Created date (YYYY-MM-DD) to set or clear, for corrections.${whenToolEnabledText("vault_create_task", " vault_create_task stamps it on every new task.")}`,
          ),
        task_id: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Tasks plugin 🆔 identifier to set, or null to clear — letters, digits, hyphens, and underscores; separate from block_id.",
          ),
        depends_on: z
          .array(z.string().min(1))
          .min(1)
          .nullable()
          .optional()
          .describe("Tasks plugin ⛔ dependency IDs to set (non-empty), or null to clear."),
        add_subtasks: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            `Checklist items to append, one indented todo line each, under the task's existing items — never replaces them. Can be combined with any other change; not appended, and not reported, when the same call removes the task (on_completion delete).${whenToolEnabledText("vault_create_task", " For full sub-tasks with metadata, use vault_create_task with parent_block_id.")}`,
          ),
        assign_block_id: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Add or replace the ^block-id on the task line, or null to remove it. Letters, digits, and hyphens only; must be unique within the note.",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target heading to move the task to. On Kanban boards this is a lane move; works on any note with headings. Not valid on sub-tasks.",
          ),
        position: z
          .union([z.enum(["top", "bottom"]), z.number().int().min(1)])
          .optional()
          .describe(
            'Where within the target heading the task lands. "top" or "bottom" for the extremes; an integer (1-based) for an exact position among the lane\'s top-level cards (sub-tasks move with their parent and are not counted). Position 1 is the first card. A position past the card count lands directly below the last card (unlike "bottom", which appends after any non-task text at the end of the section). Defaults to "top" on heading and done-lane moves.',
          ),
        format: z
          .enum(["emoji", "dataview"])
          .optional()
          .describe(
            "Field format for metadata this call writes; fields it leaves alone keep theirs, so a line can mix formats. Default: auto-detected from .obsidian/ config, falling back to emoji.",
          ),
      },
    },
    async (
      {
        path,
        block_id,
        line,
        status,
        priority,
        recurrence,
        on_completion,
        description,
        due,
        scheduled,
        start,
        created,
        task_id,
        depends_on,
        add_subtasks,
        assign_block_id,
        heading,
        position,
        format,
      },
      extra,
    ) => {
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
        recurrence,
        onCompletion: on_completion,
        due,
        scheduled,
        start,
        created,
        taskId: task_id,
        dependsOn: depends_on,
        subtaskCount: add_subtasks?.length,
        assignBlockId: assign_block_id,
        heading,
        position,
        format,
      })
      return safeHandler(
        reqLogger,
        async () => {
          return taskMutations.updateTask(
            {
              vaultPath,
              path,
              statusRegistry: search.statusRegistry,
              blockId: block_id,
              line,
              status,
              priority,
              recurrence,
              onCompletion: on_completion,
              description,
              due,
              scheduled,
              start,
              created,
              taskId: task_id,
              dependsOn: depends_on,
              addSubtasks: add_subtasks,
              assignBlockId: assign_block_id,
              heading,
              position,
              format,
            },
            reqLogger,
          )
        },
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
