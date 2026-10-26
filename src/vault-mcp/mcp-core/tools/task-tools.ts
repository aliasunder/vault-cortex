/** Task tool registrations — task listing (query), creation, and updating (mutation). */

import { z } from "zod"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import {
  dateFilterSchema,
  FILESYSTEM_ERROR_ENTRY,
  INDEX_ERROR_ENTRY,
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
      description: `List checkbox tasks across the whole vault with structured filters — the Tasks-plugin data model over MCP. Both task metadata formats are indexed: emoji signifiers (📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled, 🔺⏫🔼🔽⏬ priority, 🔁 recurrence, 🏁 onCompletion, 🆔/⛔ dependencies) and Dataview inline fields ([due:: 2026-07-04], [priority:: high], ...). Every result says where the task lives (path, line, heading; see Returns), so no follow-up reads are needed to locate it. Task lines inside fenced code blocks and %% %% comment blocks are not indexed. Checkboxes typed NON_TASK in the Tasks plugin's status settings are also excluded.

Example: vault_list_tasks({ due: { before: "2026-07-04" } }) — overdue triage; the default status (not_done) and sort (due ascending) make this the "what's overdue?" call
Example: vault_list_tasks({ path: "Code Projects/vault-cortex/TASKS.md", heading: ["Active", "Up Next", "Waiting On"], sort_by: "position" }) — actionable Kanban lanes in board order
Example: vault_list_tasks({ folder: "Code Projects/vault-cortex" }) — all open tasks across a project tree (TASKS.md + task-notes/ subdirectories)
Example: vault_list_tasks({ status: "done", done: { after: "2026-06-26" } }) — what got completed this week
Example: vault_list_tasks({ top_level_only: true, path: "TASKS.md" }) — board cards only, excluding checklist sub-items

When to use: Reading task status and order on one board (path + sort_by: "position"; add status: "all" to include done and cancelled cards). Also any vault-wide task triage question — "what's overdue?", "what's open per project?", "what did I finish this week?" — in one call instead of per-board reads.
${whenToolEnabledText("vault_read_note", "Prefer vault_read_note (heading mode) only when you need a lane's verbatim Markdown or a task's state right after a write. ")}Prefer vault_search for full-text queries over note content.

Behavior: A file change takes a few seconds to appear here, so a task written moments ago may still show its old state.

Parameters:
- status: "not_done" and "all" expand in arrays — ["not_done", "done"] matches todo + in_progress + done.
- due / scheduled / start / done / created / cancelled: a date filter only matches tasks that HAVE that date.
- folder: a whole folder, subfolders included ("Projects" covers "Projects/Archive" but not "ProjectsOld/"), ignoring ASCII letter case.
- sort_by: a task with none of a date sort's dates comes last; "priority" ascending puts highest first, and tasks with no priority sort between medium and low.

Errors:
- "invalid due.before date: …" (any date filter's bound) — the bound isn't in YYYY-MM-DD form; use that form
- "… is not a calendar date" — a date filter's bound has the YYYY-MM-DD form but names a day that doesn't exist, such as 2026-02-30; pass a real date
- "path must end in …" — add the ".md" extension
- "tag must not be empty …" — tag is "#" alone; pass the tag name
- No matches returns { total: 0, tasks: [] }, not an error
${INDEX_ERROR_ENTRY}

Returns: JSON { total, tasks }. Every task carries path, line, status, status_char (the checkbox character, such as "x" or "/"), description, folder (the task note's parent folder, e.g. "Code Projects/vault-cortex"), depth (0 for top-level, 1+ for sub-tasks), is_kanban_task (true when the task's note is a Kanban board, with kanban-plugin in its properties), depends_on, and tags (the arrays are [] when empty). Every other field appears only when the task has it: heading (nearest heading above the task), created/scheduled/start/due/done/cancelled dates, priority, recurrence, on_completion, task_id, block_id, parent_block_id (sub-tasks whose parent carries a ^block-id), done_lanes (Kanban boards only: the headings of the lanes the board marks **Complete**), and subtask_progress — { done, total } over the task's DIRECT checklist children, present only when the task has a checklist; done counts status "done" only (a cancelled child counts toward total, not done), and the counts ignore the query's filters — so a filtered or top_level_only read still shows each card's checklist progress.`,
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
          .describe('Tag on the task line, "#" optional; matches nested tags, any letter case'),
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
            'Sort direction. Default per field: "asc" for due/scheduled/priority/position, "desc" for start/created/done/note_mtime. Within the fallback chain of a date sort (see sort_by), each fallback uses its own default; an explicit value overrides all fields uniformly.',
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
          return JSON.stringify(result)
        },
      )
    },
  )

  // ── vault_create_task ──────────────────────────────────────────

  registerTool(
    TOOL_NAMES.VAULT_CREATE_TASK,
    {
      title: "Create Task",
      description: `Create a correctly-formatted task in one call — description, target heading, dates, priority, block_id, and optional checklist sub-items. The task is always created as todo (the Tasks plugin's todo symbol, [ ] by default), with its created date (➕) set to today${whenToolEnabledText("vault_update_task", "; set in_progress later with vault_update_task")}. Override format only at the user's request, since the Tasks plugin reads just one format.

Example: vault_create_task({ path: "TASKS.md", description: "Fix login bug", block_id: "fix-login", heading: "Active", priority: "high", due: "2026-09-15" }) — a card in a Kanban board's Active lane
Example: vault_create_task({ path: "TASKS.md", description: "Sub-bug", parent_block_id: "fix-login", due: "2026-09-01" }) — full sub-task under fix-login
Example: vault_create_task({ path: "Projects/plan.md", description: "Quick fix", block_id: "quick-fix", parent_line: 42 }) — sub-task in a regular note under a parent identified by line number
Example: vault_create_task({ path: "TASKS.md", description: "Write release notes", block_id: "release-notes", heading: "Active", position: 3 }) — insert as the 3rd card in the lane

When to use: Creating a new task card on a board or in a note. Guarantees correct field ordering${whenToolEnabledText("vault_list_tasks", ", so the card round-trips through vault_list_tasks with all fields intact")}.${whenToolEnabledText("vault_update_task", " For lightweight checklist items under an existing card (no metadata), use vault_update_task's add_subtasks param instead.")}

Parameters:
- heading is required on Kanban boards (notes with a kanban-plugin property) unless a parent is given.
- parent_block_id / parent_line: pass at most one. Either is mutually exclusive with heading — a sub-task lives wherever its parent lives.
- block_id / subtasks: block_id is required, except on a Kanban sub-task, where it is refused, as is a subtasks item ending in a ^block-id on a board. When the Kanban plugin saves the board, it copies an indented line's block ID onto its card, replacing the card's own ID.
- position: ignored without a heading, and under a parent, where the sub-task goes after the parent's last sub-item.
- priority: the Tasks plugin ranks "no signifier" (normal priority) between medium and low.
- recurrence: a rule ending "when done" bases the next occurrence on the completion day; a task with no dates recurs as a dateless copy.
- due / scheduled / start: omit a date rather than guessing.

Errors: (messages use camelCase names, e.g. blockId for block_id)
- "note not found" — path does not exist; check the path${whenToolEnabledText("vault_list_notes", " with vault_list_notes")}
- "path must end in …" — add the .md extension
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "heading required for Kanban boards" — pass heading with the target lane
- "heading "X" not found; available: ..." — the message lists the note's headings
- "cannot place at position P under "X" — the heading appears N times" — integer position on a note with duplicate heading names; use "top" or "bottom" (they place under the first match), or rename one section to make it unique
- "parent task not found" — parent_block_id or parent_line doesn't resolve to a task outside a fenced code block or %% %% comment; re-read the parent's block_id or line${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")}
- "parent task ambiguous" — more than one task line ends in that ^id (the message lists their line numbers); pass parent_line instead
- "checkbox "[c]" is a NON_TASK status" / "no checkbox symbol for status ..." — in the Tasks plugin's status settings, the parent's checkbox character (c) is typed NON_TASK so it is not a task, or todo has no symbol and the default [ ] character has another type; the user must change that character's type or add a todo symbol there, then restart the server
- "parentBlockId and parentLine are mutually exclusive" / "parent and heading are mutually exclusive" — drop one
- "blockId ... already exists in this note" / "blockId ... contains invalid characters" — pick a block_id no other line in the note ends in; the invalid-characters message names the allowed characters
- "blockId is required" — pass block_id
- "blockId is not allowed on a sub-task on a Kanban board" / "subtask ... ends in a block ID" — the message names what to drop
- "description is empty" / "subtasks cannot contain an empty item" / "description must be a single line" / "subtasks items must be a single line" — pass visible text on a single line
- "taskId ... contains invalid characters" / "dependsOn entry ... contains invalid characters" — the message names the allowed characters
- "unrecognized recurrence rule ..." — the message gives example rules
- "invalid date: …" — the message names the expected format
- "concurrent write in progress" — another write to this note is in flight; retry
${FILESYSTEM_ERROR_ENTRY}
${describePropertiesBlockErrorEntry()}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: When description or subtasks text ends in a signifier the plugin's parser recognizes as a field (an emoji field like "🔁 every week", or a Dataview [key:: value] field), with only other recognized fields after it, that text is read back as metadata, not text. Whether it is captured depends on the field's value grammar: 🔁 reads any trailing words as its recurrence rule, while 📅 followed by non-date words stays description text. The write still succeeds either way; reword the text to clear any advisories the result carries.

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
            "Checklist sub-items: text-only todo lines indented under the card, with no metadata (not even ➕). For a sub-task with dates or priority, make a separate call with parent_block_id.",
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
      description: `Update a task's status, priority, description, dates, recurrence, completion action, dependencies, block_id, checklist items, heading, or position within a lane, in any combination; every field passed is written in a single edit.

Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "done" }) — complete a task; on a Kanban board, auto-moves to the done lane
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", recurrence: "every week" }) — make a task recurring
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", heading: "Done" }) — move a task to a different heading (the checkbox is unchanged)
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", description: "Updated task name", due: "2026-10-01", scheduled: null }) — change the description, set one date, and clear another
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "in_progress", add_subtasks: ["Design", "Implement", "Test"] }) — start working and add checklist stages
Example: vault_update_task({ path: "TASKS.md", line: 42, assign_block_id: "my-task" }) — add a block_id to a task that lacks one
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", heading: "Active", position: 3 }) — move to the 3rd position in a lane

When to use: Any change to an existing task.${whenToolEnabledText("vault_list_tasks", " Use vault_list_tasks first to get identification fields (path + block_id or line).")}${whenToolEnabledText("vault_create_task", " For creating a new task, use vault_create_task instead.")}

Parameters:
- Exactly one of block_id or line is required to identify the task. A Kanban sub-task this server created has no block_id, so re-read its line${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")} just before an update by line: each save by the Kanban plugin rewrites the board${whenToolEnabledText("vault_list_tasks", ". The listing lags each save by a few seconds, so wait that long after a write before re-reading")}.
- At least one change is required. Clearing is always explicit null — omitting a field leaves it untouched.
- status side effects:
  Kanban: "done" moves the card and everything nested under it to the done lane (the lane holding a **Complete** line, else the heading "Done", exact case), leaving nested checkboxes as they are; a sub-task stays under its parent.
  Recurring (🔁), on "done" only: spawns the next occurrence, dates advanced per the rule, directly above the completed task, which keeps its nested lines. When the Tasks plugin's settings put the next recurrence on the line below, the spawn goes on the line directly below the task instead, so the task's nested lines then sit under the spawn. The spawn stays in the source lane with no block_id, 🆔, or ⛔ — follow up with assign_block_id on next_occurrence.line; an indented line of a Kanban board refuses a new id, so target that spawn by line instead. Completing by line is NOT idempotent for recurring tasks (the spawn occupies the old line); prefer block_id.
  Delete (🏁 delete / [onCompletion:: delete]), on "done": removes the task line and its children instead of moving to done. With 🔁 + 🏁, the next occurrence is still created, and the completed task is removed.
- recurrence: a rule ending "when done" bases the next occurrence on the completion day. When set together with status "done", the new rule governs the next occurrence. Setting recurrence to null while completing removes the rule and completes without spawning.
- on_completion: passed together with status, the submitted value governs the delete decision — "keep" while completing a "delete" task prevents the deletion.
- position: applies to a heading move or an auto-done-lane move; otherwise it reorders the task within its current lane. Omitted, an unmoved task stays put. Ignored when the task is deleted on completion.

Errors: (messages use camelCase names, e.g. assignBlockId for assign_block_id)
- "note not found" — path does not exist; check the path${whenToolEnabledText("vault_list_notes", " with vault_list_notes")}
- "path must end in …" — add the .md extension
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "exactly one of blockId or line is required" / "blockId and line are mutually exclusive" — the message states the rule
- "blockId ... not found" / "blockId ... is inside a fenced code block or comment" — no task line outside a fenced code block or %% %% comment ends with that ^id; check the id${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")}, or target by line
- "blockId ... matches N task lines" — more than one task line ends in the id (the message lists their line numbers); target the intended task by line. To repair on a regular note, give all but one line a new id with assign_block_id. On a Kanban board, where the plugin copied a sub-task's id onto its card, remove the id from the sub-task's line (assign_block_id: null, by line), then assign the card the id its existing links use, or a new one
- "no task at line N" / "line N is inside a fenced code block or comment" — the line holds no task checkbox, or sits inside a fenced code block or %% %% comment; re-read line numbers${whenToolEnabledText("vault_list_tasks", " with vault_list_tasks")}, or target by block_id
- "checkbox "[c]" is a NON_TASK status" / "no checkbox symbol for status ..." — in the Tasks plugin's status settings, the targeted task's checkbox character (c) is typed NON_TASK so it is not a task, or the status the message names has no symbol and its default character has another type; the user must change that character's type or add a symbol for that status there, then restart the server
- "at least one mutation" — the message lists the fields that count
- "cannot move a sub-task to a heading" / "cannot reposition a sub-task" — a heading or position on a task nested under another task (depth > 0${whenToolEnabledText("vault_list_tasks", " in vault_list_tasks")}); sub-tasks move with their parent, so move or reposition the parent instead
- "cannot reorder a task that sits above the first heading" — position without a heading on a task before the first section heading; the message names the fix
- "cannot reorder within "X" — the heading appears N times" / "cannot place at position P under "X" — the heading appears N times" — the heading name is duplicated in the note: the task's own heading for a reorder in place, the one in heading for a move; for a cross-lane move use "top" or "bottom" (they place under the first match), or rename one section to make it unique
- "heading "X" not found; available: ..." — the message lists the note's headings
- "multiple done lanes detected" / "no done lane detected" — status "done" on a Kanban board with more than one lane holding a **Complete** line, or with none and no "Done" heading; pass heading to pick the lane
- "blockId ... already exists" / "blockId ... contains invalid characters" — assign_block_id must be unique in the note and match [a-zA-Z0-9-]+
- "assignBlockId is not allowed" / "description ends in a block ID" / "subtask ... ends in a block ID" — a new ^id on an indented line of a Kanban board; leave the line without an id and target it by line, and drop any trailing ^id from the text
- "invalid date: …" — the message names the expected format
- "description cannot be empty" / "addSubtasks cannot contain an empty item" / "description must be a single line" / "addSubtasks items must be a single line" — pass visible text on a single line
- "taskId ... contains invalid characters" / "dependsOn entry ... contains invalid characters" — the message names the allowed characters
- "unrecognized recurrence rule ..." — the message gives example rules
- "concurrent write in progress" — another write to this note is in flight; retry
${FILESYSTEM_ERROR_ENTRY}
${describePropertiesBlockErrorEntry()}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: When description or add_subtasks text ends in a signifier the plugin's parser recognizes as a field (an emoji field like "🔁 every week", or a Dataview [key:: value] field), with only other recognized fields after it, that text is read back as metadata, not text. Whether it is captured depends on the field's value grammar: 🔁 reads any trailing words as its recurrence rule, while 📅 followed by non-date words stays description text. The write still succeeds either way; reword the text to clear any advisories the result carries. The ✅/❌ dates a status change adds or removes produce no advisories by themselves. A description signifier that changes how a stamped date parses back is still reported.

Returns: JSON { path, line, description, block_id, heading, subtasks, next_occurrence, changes, advisories, on_completion_applied }.
- line is the task's final 1-based line number in the file; after an on_completion delete, the line the task occupied before removal.
- description is the current text, and block_id and heading reflect the task after the update; block_id is omitted when the task has none, heading when the task sits above the first heading.
- subtasks lists each checklist item add_subtasks wrote as { line, description } (omitted when none were added); checklist items are written without a block_id, so line is the handle for a follow-up update.
- next_occurrence is present only when a completion spawned a recurring task's next occurrence: { line, description, due?, scheduled?, start? } with only the dates the occurrence has.
- changes lists every field applied as "field: before → after", with "(none)" for an absent value; a 🏁 delete is listed as "on_completion: task removed (🏁 delete)", naming any removed children. An add_subtasks change appears as "subtasks", its two sides checklist-item counts, and a spawn adds "next_occurrence: (none) → line N".
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
            'Target status. "done" adds the ✅ date and "cancelled" the ❌ date, when the Tasks plugin\'s settings stamp them; moving a task out of either status removes its date.',
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
            'Tasks plugin 🔁 rule in natural language (e.g. "every week", "every month on the 15th", "every 2 weeks when done") to set, or null to remove it.',
          ),
        on_completion: z
          .enum(["delete", "keep"])
          .nullable()
          .optional()
          .describe(
            'Tasks plugin 🏁 onCompletion action to set, or null to remove it. "keep" leaves the task in place on completion, as having no 🏁 field does.',
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
