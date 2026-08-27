/** Task tool registrations — task listing (query), creation, and updating (mutation). */

import { z } from "zod"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler, dateFilterSchema } from "./tool-helpers.js"
import { taskMutations } from "../../vault-operations/task-updater.js"

export const registerTaskTools = ({
  registerTool,
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
      description: `List checkbox tasks across the whole vault with structured filters — the Tasks-plugin data model over MCP. Both task metadata formats are indexed: emoji signifiers (📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled, 🔺⏫🔼🔽⏬ priority, 🔁 recurrence, 🆔/⛔ dependencies) and Dataview inline fields ([due:: 2026-07-04], [priority:: high], ...). Every result carries its attribution — note path, folder, line number, and the nearest heading when the task sits under one (the lane on a Kanban board) — so no follow-up reads are needed to locate a task. Task lines inside fenced code blocks and %% %% comment blocks are not indexed.

Example: vault_list_tasks({ due: { before: "2026-07-04" } }) — overdue triage; the default status (not_done) and sort (due ascending) make this the "what's overdue?" call
Example: vault_list_tasks({ path: "Code Projects/vault-cortex/TASKS.md", heading: ["Active", "Up Next", "Waiting On"], sort_by: "position" }) — actionable Kanban lanes in board order; position is the natural sort for boards (file path then line number, preserving card arrangement)
Example: vault_list_tasks({ folder: "Code Projects/vault-cortex" }) — all open tasks across a project tree (TASKS.md + task-notes/ subdirectories); folder is a recursive prefix match
Example: vault_list_tasks({ status: "done", done: { after: "2026-06-26" } }) — what got completed this week
Example: vault_list_tasks({ top_level_only: true, path: "TASKS.md" }) — board cards only, excluding checklist sub-items

When to use: Any vault-wide task triage question — "what's overdue?", "what's open per project?", "what did I finish this week?" — in one call instead of per-board reads.
Prefer vault_read_note (heading mode) to read one specific board lane verbatim. Prefer vault_search for full-text queries over note content.

Parameters:
- status: a single value or an array of values, OR-combined (default "not_done"). Values: "not_done" (todo + in_progress, excludes done AND cancelled), "todo", "in_progress", "done", "cancelled", "all". Virtual values expand in arrays: ["not_done", "done"] matches todo + in_progress + done.
- due / scheduled / start / done / created / cancelled: date filters, each { before, on, after } in YYYY-MM-DD — before/after are exclusive, on is exact. A date filter only matches tasks that HAVE that date.
- priority: array of "highest" | "high" | "medium" | "low" | "lowest" | "none", OR-combined ("none" = tasks with no priority signifier).
- folder: recursive note-path prefix. tag: bare inline-task-tag name; a parent tag matches children. heading: exact heading text or array of headings, case-sensitive, OR-combined. path: one note, must end in ".md".
- top_level_only: boolean (default false). When true, only top-level tasks (depth 0) are returned — excludes indented sub-tasks and checklist items.
- sort_by: "due" (default) | "scheduled" | "start" | "created" | "done" | "priority" | "note_mtime" | "position". "position" sorts by file path then line number — the natural order for Kanban boards.
- limit: max results (default 50). The total field always reports the full match count.

Errors:
- A malformed or calendar-invalid date filter throws with remediation text ("Use YYYY-MM-DD")
- path without the ".md" extension is rejected
- No matches returns { total: 0, tasks: [] }, not an error

Returns: JSON { total, tasks }. Every task carries path, line, status, status_char, description, folder, depth (0 for top-level, 1+ for sub-tasks), is_kanban_task, depends_on, and tags (the arrays are [] when empty). Every other field appears only when the task has it: heading (nearest heading above the task), created/scheduled/start/due/done/cancelled dates, priority, recurrence, on_completion, task_id, block_id, parent_block_id (sub-tasks whose parent carries a ^block-id), done_lanes (Kanban boards only).`,
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
        top_level_only: z
          .boolean()
          .optional()
          .describe(
            "When true, only top-level tasks (depth 0) are returned — excludes indented sub-tasks and checklist items. Default false.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Max results (default 50); total always reports the full match count",
          ),
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
              topLevelOnly: top_level_only,
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
      description: `Create a correctly-formatted task in one call — description, target heading, dates, priority, block_id, and optional checklist sub-items. The task is always created as [ ] (todo) with ➕ today auto-stamped${whenToolEnabledText("vault_update_task", " — starting work is vault_update_task's job")}. Metadata is written in the format the vault's Tasks plugin is configured for (emoji unless the plugin config says Dataview).

Example: vault_create_task({ path: "TASKS.md", description: "Fix login bug", block_id: "fix-login", heading: "Active", priority: "high", due: "2026-09-15" })
Example: vault_create_task({ path: "TASKS.md", description: "Ship the feature", block_id: "ship-feature", heading: "Up Next", subtasks: ["Design", "Implement", "Test"] }) — card with checklist stages
Example: vault_create_task({ path: "TASKS.md", description: "Sub-bug", block_id: "sub-bug", parent_task: "fix-login", due: "2026-09-01" }) — full sub-task under a parent (identified by block_id)
Example: vault_create_task({ path: "TASKS.md", description: "Quick fix", block_id: "quick-fix", parent_task: 42 }) — sub-task under a parent identified by line number

When to use: Creating a new task card on a board or in a note. Guarantees correct field ordering (description → priority → ➕ created → 🛫 start → ⏳ scheduled → 📅 due → 🆔 task_id → ⛔ depends_on → ^block_id)${whenToolEnabledText("vault_list_tasks", " so the card round-trips through vault_list_tasks with all fields intact")}.${whenToolEnabledText("vault_update_task", " For lightweight checklist items under an existing card (no metadata), use vault_update_task's add_subtask param instead.")}

Parameters:
- path (required): vault-relative path to the note (must end in ".md"). The note must already exist.
- description (required): the task text (before metadata fields).
- block_id (required): the ^block-id for stable identification — letters, digits, and hyphens only. Must be unique within the note.
- heading: target heading. Required on Kanban boards (notes with kanban-plugin frontmatter); optional on regular notes (omit to append at end of body).
- parent_task: block_id (string) or line number (number) of an existing task to nest under as a sub-task. Mutually exclusive with heading — a sub-task lives wherever its parent lives.
- priority: "highest" | "high" | "medium" | "low" | "lowest". Omit for normal priority (the plugin ranks "no signifier" between medium and low).
- due / scheduled / start: YYYY-MM-DD dates (calendar-validated). Omit a date rather than guessing — an absent 📅 means "no deadline".
- task_id: Tasks plugin 🆔 identifier for dependency chains.
- depends_on: non-empty string array of Tasks plugin ⛔ dependency IDs (🆔 values of other tasks).
- subtasks: string array of checklist item descriptions — created as indented [ ] lines under the card (no metadata, no block_ids). For full sub-tasks with their own dates, priority, and block_id, make a separate vault_create_task call with parent_task.
- format: "emoji" or "dataview" — overrides the auto-detected Tasks plugin format (emoji when no plugin config is present).

Errors:
- "note not found" — path does not exist
- "heading required for Kanban boards" — kanban-plugin note without heading
- "heading "X" not found; available: ..." — no heading matches; the error lists the note's headings
- "parent task not found" — parent_task block_id or line doesn't resolve to a task
- "parent_task and heading are mutually exclusive" — both provided (either parent_task form)
- "block_id already exists" — collision with an existing block_id in the note
- "block_id contains invalid characters" — not matching [a-zA-Z0-9-]+
- "description is empty" / "depends_on cannot be empty" — whitespace-only description or an empty depends_on array
- "invalid date" — a date param fails calendar validation
- "concurrent write in progress" — another write to this note is in flight; retry

Returns: JSON { path, line, description, block_id, heading, changes } — line is the new card's 1-based position; heading is the nearest heading above the new task (omitted when the note has none); changes lists the fields written.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note (must end in ".md"). The note must already exist.',
          ),
        description: z
          .string()
          .min(1)
          .describe("The task text (before metadata fields)."),
        block_id: z
          .string()
          .min(1)
          .describe(
            "The ^block-id for stable identification — letters, digits, and hyphens only ([a-zA-Z0-9-]+). Must be unique within the note.",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target heading. Required on Kanban boards; optional on regular notes (omit to append at end of body).",
          ),
        parent_task: z
          .union([z.string().min(1), z.number().int().min(1)])
          .optional()
          .describe(
            "block_id (string) or line number (number) of an existing task to nest under. Mutually exclusive with heading.",
          ),
        priority: z
          .enum(["highest", "high", "medium", "low", "lowest"])
          .optional()
          .describe(
            "Priority signifier (🔺⏫🔼🔽⏬). Omit for normal priority — no signifier is written.",
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
          .describe(
            "Day the work is planned for (⏳), YYYY-MM-DD, calendar-validated.",
          ),
        start: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Earliest day work can begin (🛫), YYYY-MM-DD, calendar-validated.",
          ),
        task_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Tasks plugin 🆔 identifier other tasks can name in depends_on.",
          ),
        depends_on: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Tasks plugin ⛔ dependency IDs (🆔 values of other tasks). Non-empty; omit when there are no dependencies.",
          ),
        subtasks: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Checklist item descriptions — created as indented [ ] lines under the card (no metadata). For full sub-tasks with dates, priority, and block_id, make a separate call with parent_task.",
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
        parent_task,
        priority,
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
        parentTask: parent_task,
        priority,
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
        async () =>
          taskMutations.createTask(
            {
              vaultPath,
              path,
              description,
              blockId: block_id,
              heading,
              parentTask: parent_task,
              priority,
              due,
              scheduled,
              start,
              taskId: task_id,
              dependsOn: depends_on,
              subtasks,
              format,
            },
            reqLogger,
          ),
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
      description: `Update a task's status, priority, description, dates, dependencies, block_id, or heading placement in one call. Any combination of these can change together — every field passed is written in a single edit.

Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "done" }) — complete a task; on a Kanban board, auto-moves to the done lane
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", heading: "Done" }) — move a task to a different heading
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", description: "Updated task name", due: "2026-10-01" }) — change description and set due date
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", due: null }) — clear a date field
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", status: "in_progress", add_subtask: "Stage 1" }) — start working and add a checklist stage
Example: vault_update_task({ path: "TASKS.md", line: 42, assign_block_id: "my-task" }) — add a block_id to a task that lacks one
Example: vault_update_task({ path: "TASKS.md", block_id: "my-task", task_id: "abc123" }) — set a Tasks plugin 🆔 identifier

When to use: Any change to an existing task — completing, starting, re-prioritizing, editing text, setting or clearing dates, adding checklist items, assigning block_ids, or moving between headings.${whenToolEnabledText("vault_list_tasks", " Use vault_list_tasks first to get identification fields (path + block_id or line).")}${whenToolEnabledText("vault_create_task", " For creating a new task, use vault_create_task instead.")}

Parameters:
- path (required): vault-relative path to the note (must end in ".md").
- Exactly one of block_id or line is required to identify the task.
- At least one change is required. Every field passed is applied in the same single write:
  - status: "todo" | "in_progress" | "done" | "cancelled". Manages checkbox and done/cancelled dates. On a Kanban board, "done" moves the card to the done lane together with its checklist sub-items (their checkboxes are left as they are); a sub-task marked done stays under its parent.
  - priority: "highest" | "high" | "medium" | "low" | "lowest" sets the signifier; null removes it.
  - description: replaces the task text. Metadata fields and block_id are preserved.
  - due / scheduled / start / created: YYYY-MM-DD sets the date; null clears it.
  - task_id: string sets the Tasks plugin 🆔; null clears it.
  - depends_on: non-empty string array sets the Tasks plugin ⛔; null clears it.
  - add_subtask: string — appends an indented [ ] checklist item under the task.${whenToolEnabledText("vault_create_task", " For full sub-tasks with their own metadata, use vault_create_task with parent_task.")}
  - assign_block_id: adds or replaces the ^block-id on the task line. Letters, digits, and hyphens only; must be unique within the note.
  - heading: target heading to move the task to. On Kanban boards this is a lane move; works on any note with headings. Not valid on sub-tasks.
  - Clearing is always explicit null — omitting a field leaves it untouched.
- format: "emoji" or "dataview" — overrides the auto-detected Tasks plugin format.

Errors:
- "note not found" — path does not exist
- "exactly one of block_id or line is required" / "block_id and line are mutually exclusive" — identifier validation
- "block_id not found" — no task line ends with ^block_id
- "no task at line N" — line doesn't contain a task checkbox
- "at least one mutation" — no change params provided
- "cannot move a sub-task to a heading" — explicit heading on an indented task
- "heading "X" not found; available: ..." — target heading doesn't exist; the error lists the note's headings
- "block_id already exists" / "block_id contains invalid characters" — assign_block_id validation
- "invalid date" — a date param fails calendar validation
- "description cannot be empty" / "add_subtask cannot be empty" / "depends_on cannot be empty" — whitespace-only text or an empty array (use null to clear depends_on)
- "concurrent write in progress" — another write to this note is in flight; retry

Returns: JSON { path, line, description, block_id, heading, changes } — line is the final 1-based position; description is the current text; block_id and heading reflect the task after the update (block_id is omitted when the task has none, heading when the task sits above the first heading); changes lists what was applied.`,
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
            'Target status. "done" appends the ✅ date and, on a Kanban board, moves the card and its checklist sub-items to the done lane (sub-item checkboxes are left as they are). "cancelled" appends the ❌ date.',
          ),
        priority: z
          .enum(["highest", "high", "medium", "low", "lowest"])
          .nullable()
          .optional()
          .describe("Priority signifier to set, or null to remove it."),
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
            "Created date (YYYY-MM-DD) to set or clear. Typically auto-stamped; use for corrections.",
          ),
        task_id: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Tasks plugin 🆔 identifier to set, or null to clear."),
        depends_on: z
          .array(z.string().min(1))
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Tasks plugin ⛔ dependency IDs to set (non-empty), or null to clear.",
          ),
        add_subtask: z
          .string()
          .min(1)
          .optional()
          .describe(
            `Checklist item to append as an indented [ ] line under the task. Can be combined with any other change.${whenToolEnabledText("vault_create_task", " For full sub-tasks with metadata, use vault_create_task with parent_task.")}`,
          ),
        assign_block_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Add or replace the ^block-id on the task line. Letters, digits, and hyphens only; must be unique within the note.",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target heading to move the task to. On Kanban boards this is a lane move; works on any note with headings. Not valid on sub-tasks.",
          ),
        format: z
          .enum(["emoji", "dataview"])
          .optional()
          .describe(
            "Field format for new metadata. Default: auto-detected from .obsidian/ config, falling back to emoji.",
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
        description,
        due,
        scheduled,
        start,
        created,
        task_id,
        depends_on,
        add_subtask,
        assign_block_id,
        heading,
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
        due,
        scheduled,
        start,
        created,
        taskId: task_id,
        dependsOn: depends_on,
        hasSubtask: Boolean(add_subtask),
        assignBlockId: assign_block_id,
        heading,
        format,
      })
      return safeHandler(
        reqLogger,
        async () =>
          taskMutations.updateTask(
            {
              vaultPath,
              path,
              blockId: block_id,
              line,
              status,
              priority,
              description,
              due,
              scheduled,
              start,
              created,
              taskId: task_id,
              dependsOn: depends_on,
              addSubtask: add_subtask,
              assignBlockId: assign_block_id,
              heading,
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
