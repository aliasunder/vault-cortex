import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime } from "luxon"
import { taskMutations } from "../task-mutations.js"
import { logger } from "../../../logger.js"

// ── Helpers ─────────────────────────────────────────────────────

const createVault = async (): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "task-mutations-test-"))
  onTestFinished(async () => rm(vaultPath, { recursive: true }))
  return vaultPath
}

const writeTestNote = async (
  vaultPath: string,
  notePath: string,
  content: string,
): Promise<void> => {
  const dir = join(vaultPath, ...notePath.split("/").slice(0, -1))
  if (dir !== vaultPath) await mkdir(dir, { recursive: true })
  await writeFile(join(vaultPath, notePath), content, "utf8")
}

const readTestNote = async (
  vaultPath: string,
  notePath: string,
): Promise<string> => readFile(join(vaultPath, notePath), "utf8")

const today = (): string => {
  const date = DateTime.now().toISODate()
  if (date === null) throw new Error("failed to get today's date")
  return date
}

// ── Fixtures ────────────────────────────────────────────────────

const SIMPLE_NOTE = `---
title: Tasks
---

- [ ] Buy groceries ➕ 2026-07-01
- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog
- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10
`

const KANBAN_BOARD = `---
title: Board
kanban-plugin: board
---

## Active

- [/] In-progress task ➕ 2026-07-01 ^active-task
- [ ] Second task ➕ 2026-07-02

## Up Next

- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task

## Done

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`

const KANBAN_WITH_COMPLETE_MARKER = `---
kanban-plugin: board
---

## Active

- [ ] Task A ➕ 2026-07-01 ^task-a

## Archive

**Complete**
- [x] Old task ➕ 2026-06-01 ✅ 2026-06-10
`

const KANBAN_NO_DONE_LANE = `---
kanban-plugin: board
---

## Active

- [ ] Task A ➕ 2026-07-01 ^task-a

## Backlog

- [ ] Task B ➕ 2026-07-02
`

const KANBAN_MULTIPLE_DONE_LANES = `---
kanban-plugin: board
---

## Active

- [ ] Task A ➕ 2026-07-01 ^task-a

## Done

**Complete**
- [x] Done 1

## Archived

**Complete**
- [x] Done 2
`

const KANBAN_WITH_SUBITEMS = `---
kanban-plugin: board
---

## Active

- [ ] Parent task ➕ 2026-07-01 ^parent
  - Sub-item 1
  - Sub-item 2

## Done

- [x] Old done
`

/** A card inside a blockquote with a quoted checklist item — the parser
 *  strips `>` before measuring depth, so Stage 1 is the card's child. */
const QUOTED_BOARD = `---
kanban-plugin: board
---

## Active

> - [ ] Quoted parent ➕ 2026-07-01 ^quoted-parent
>   - [ ] Stage 1

## Done
`

/** A checklist item indented under a non-task bullet, with a task above the
 *  bullet: raw indent says sub-task, the parser says top-level — the plain
 *  bullet closes the earlier task's scope. */
const TASK_UNDER_PLAIN_BULLET = `## Active

- [ ] Earlier task ^earlier
- Agenda
  - [ ] Call dentist ^call-dentist

## Done
`

const PRIORITY_NOTE = `---
title: Priority
---

- [ ] No priority task ➕ 2026-07-01 ^no-pri
- [ ] Has priority ⏫ ➕ 2026-07-02 ^has-pri
- [ ] Plain task without dates ^plain-task
`

// ── Status changes ──────────────────────────────────────────────

describe("task-mutations", () => {
  describe("status changes", () => {
    it("completes a simple non-Kanban task — checkbox and done date", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 5, status: "done" },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Buy groceries",
        changes: ["status: todo → done"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [x] Buy groceries ➕ 2026-07-01 ✅ ${today()}\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
    })

    it("sets a task to in_progress", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 5, status: "in_progress" },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Buy groceries",
        changes: ["status: todo → in_progress"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [/] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("un-completes a done task — removes done date", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 7, status: "todo" },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 7,
        description: "Done task",
        changes: ["status: done → todo"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [ ] Done task ➕ 2026-07-01\n",
      )
    })

    it("cancels a task — checkbox and cancelled date", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 5, status: "cancelled" },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Buy groceries",
        changes: ["status: todo → cancelled"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [-] Buy groceries ➕ 2026-07-01 ❌ ${today()}\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
    })

    it("identifies a task by block_id", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          status: "done",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["status: todo → done"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [x] Walk the dog ➕ 2026-07-02 ✅ ${today()} ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
    })

    it("identifies a task by line number", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 6, status: "in_progress" },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["status: todo → in_progress"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [/] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })
  })

  // ── Priority changes ────────────────────────────────────────────

  describe("priority changes", () => {
    it("adds priority to a task with none", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "no-pri",
          priority: "high",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "no-pri",
        path: "tasks.md",
        line: 5,
        description: "No priority task",
        changes: ["priority: (none) → high"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Priority\n---\n\n- [ ] No priority task ⏫ ➕ 2026-07-01 ^no-pri\n- [ ] Has priority ⏫ ➕ 2026-07-02 ^has-pri\n- [ ] Plain task without dates ^plain-task\n",
      )
    })

    it("changes an existing priority", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "has-pri",
          priority: "highest",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "has-pri",
        path: "tasks.md",
        line: 6,
        description: "Has priority",
        changes: ["priority: high → highest"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Priority\n---\n\n- [ ] No priority task ➕ 2026-07-01 ^no-pri\n- [ ] Has priority 🔺 ➕ 2026-07-02 ^has-pri\n- [ ] Plain task without dates ^plain-task\n",
      )
    })

    it("removes priority with null", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "has-pri",
          priority: null,
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "has-pri",
        path: "tasks.md",
        line: 6,
        description: "Has priority",
        changes: ["priority: high → (none)"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Priority\n---\n\n- [ ] No priority task ➕ 2026-07-01 ^no-pri\n- [ ] Has priority ➕ 2026-07-02 ^has-pri\n- [ ] Plain task without dates ^plain-task\n",
      )
    })

    it("inserts priority before block_id when no date signifiers", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "plain-task",
          priority: "low",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "plain-task",
        path: "tasks.md",
        line: 7,
        description: "Plain task without dates",
        changes: ["priority: (none) → low"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Priority\n---\n\n- [ ] No priority task ➕ 2026-07-01 ^no-pri\n- [ ] Has priority ⏫ ➕ 2026-07-02 ^has-pri\n- [ ] Plain task without dates 🔽 ^plain-task\n",
      )
    })
  })

  // ── Heading moves ─────────────────────────────────────────────

  describe("heading moves", () => {
    it("moves a task between Kanban headings", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "planned-task",
          heading: "Active",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "planned-task",
        heading: "Active",
        path: "board.md",
        line: 7,
        description: "Planned task",
        changes: ["heading: Up Next → Active"],
      })
      const content = await readTestNote(vault, "board.md")
      const activeSection = content.split("## Active")[1]?.split("## ")[0] ?? ""
      expect(activeSection).toBe(
        "\n- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task\n\n- [/] In-progress task ➕ 2026-07-01 ^active-task\n- [ ] Second task ➕ 2026-07-02\n\n",
      )
    })

    it("moves a task with sub-items", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_WITH_SUBITEMS)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "parent",
          heading: "Done",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "parent",
        heading: "Done",
        path: "board.md",
        line: 9,
        description: "Parent task",
        changes: ["heading: Active → Done"],
      })
      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1] ?? ""
      expect(doneSection).toBe(
        "\n- [ ] Parent task ➕ 2026-07-01 ^parent\n  - Sub-item 1\n  - Sub-item 2\n\n- [x] Old done\n",
      )
    })

    it("auto-completes to **Complete** marker lane", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_WITH_COMPLETE_MARKER)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "task-a",
          status: "done",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "task-a",
        heading: "Archive",
        path: "board.md",
        line: 11,
        description: "Task A",
        changes: ["status: todo → done", "heading: Active → Archive"],
      })
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(
        `---\nkanban-plugin: board\n---\n\n## Active\n\n\n## Archive\n\n**Complete**\n- [x] Task A ➕ 2026-07-01 ✅ ${today()} ^task-a\n- [x] Old task ➕ 2026-06-01 ✅ 2026-06-10\n`,
      )
    })

    it("auto-completes to 'Done' heading as fallback", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "active-task",
          status: "done",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "active-task",
        heading: "Done",
        path: "board.md",
        line: 15,
        description: "In-progress task",
        changes: ["status: in_progress → done", "heading: Active → Done"],
      })
      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1]?.split("%%")[0] ?? ""
      expect(doneSection).toBe(
        `\n- [x] In-progress task ➕ 2026-07-01 ✅ ${today()} ^active-task\n\n- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15\n\n`,
      )
      expect(result.changes).toEqual([
        "status: in_progress → done",
        "heading: Active → Done",
      ])
    })

    it("moves a task between headings in a non-Kanban note", async () => {
      const vault = await createVault()
      const noteWithHeadings = `---
title: Tasks
---

## TODO

- [ ] Task to move ➕ 2026-07-01 ^move-me

## Done

- [x] Already done ➕ 2026-06-01 ✅ 2026-06-15
`
      await writeTestNote(vault, "tasks.md", noteWithHeadings)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "move-me",
          heading: "Done",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "move-me",
        heading: "Done",
        path: "tasks.md",
        line: 9,
        description: "Task to move",
        changes: ["heading: TODO → Done"],
      })
      const content = await readTestNote(vault, "tasks.md")
      const doneSection = content.split("## Done")[1] ?? ""
      expect(doneSection).toContain("Task to move")
      const todoSection = content.split("## TODO")[1]?.split("## Done")[0] ?? ""
      expect(todoSection).not.toContain("Task to move")
    })
  })

  // ── Composed operations ─────────────────────────────────────────

  describe("composed operations", () => {
    it("completes and moves in one call", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "planned-task",
          status: "done",
          heading: "Done",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "planned-task",
        heading: "Done",
        path: "board.md",
        line: 15,
        description: "Planned task",
        changes: ["status: todo → done", "heading: Up Next → Done"],
      })
      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1]?.split("%%")[0] ?? ""
      expect(doneSection).toBe(
        `\n- [x] Planned task ⏫ ➕ 2026-07-03 ✅ ${today()} ^planned-task\n\n- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15\n\n`,
      )
    })

    it("changes status and priority in one call", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          status: "in_progress",
          priority: "highest",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["status: todo → in_progress", "priority: (none) → highest"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [/] Walk the dog 🔺 ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })
  })

  // ── Error cases ───────────────────────────────────────────────

  describe("error cases", () => {
    it("throws when note not found", async () => {
      const vault = await createVault()

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "missing.md",
            line: 1,
            status: "done",
          },
          logger,
        ),
      ).rejects.toThrow('note not found: "missing.md"')
    })

    it("throws when block_id not found", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "nonexistent",
            status: "done",
          },
          logger,
        ),
      ).rejects.toThrow('blockId "nonexistent" not found')
    })

    it("throws when line does not contain a task", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          { vaultPath: vault, path: "tasks.md", line: 1, status: "done" },
          logger,
        ),
      ).rejects.toThrow("no task at line 1")
    })

    it("throws when no mutations specified", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          { vaultPath: vault, path: "tasks.md", line: 5 },
          logger,
        ),
      ).rejects.toThrow("at least one mutation")
    })

    it("throws when target heading not found", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "active-task",
            heading: "Nonexistent",
          },
          logger,
        ),
      ).rejects.toThrow('heading "Nonexistent" not found')
    })

    it("throws when multiple done lanes and no explicit heading", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_MULTIPLE_DONE_LANES)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "task-a",
            status: "done",
          },
          logger,
        ),
      ).rejects.toThrow("multiple done lanes detected")
    })

    it("both identifiers provided is rejected", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            line: 5,
            blockId: "walk-dog",
            status: "done",
          },
          logger,
        ),
      ).rejects.toThrow("blockId and line are mutually exclusive")
    })

    it("no identifier provided is rejected", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          { vaultPath: vault, path: "tasks.md", status: "done" },
          logger,
        ),
      ).rejects.toThrow("exactly one of blockId or line is required")
    })

    it("throws when no done lane exists for auto-completion", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_NO_DONE_LANE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "task-a",
            status: "done",
          },
          logger,
        ),
      ).rejects.toThrow("no done lane detected")
    })
  })

  // ── No-op and override ──────────────────────────────────────────

  describe("edge cases", () => {
    it("no-op when task is already in the target heading", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)
      const contentBefore = await readTestNote(vault, "board.md")

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "active-task",
          heading: "Active",
        },
        logger,
      )

      const contentAfter = await readTestNote(vault, "board.md")
      expect(contentAfter).toBe(contentBefore)
      expect(result.changes).toEqual([])
    })

    it("format override writes done date in Dataview format", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          line: 5,
          status: "done",
          format: "dataview",
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Buy groceries",
        changes: ["status: todo → done"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [x] Buy groceries ➕ 2026-07-01 [completion:: ${today()}]\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
    })
  })

  describe("hidden paths", () => {
    it("rejects a task note inside a hidden folder and leaves it unchanged", async () => {
      const vault = await createVault()
      // The note exists on disk so a removed guard would let the update
      // succeed — the test then fails on the mutation, not a missing file.
      await writeTestNote(vault, ".trash/tasks.md", SIMPLE_NOTE)
      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: ".trash/tasks.md",
            line: 5,
            status: "done",
          },
          logger,
        ),
      ).rejects.toThrow(
        'hidden path blocked: ".trash/tasks.md" targets a hidden file or folder',
      )
      expect(await readTestNote(vault, ".trash/tasks.md")).toBe(SIMPLE_NOTE)
    })
  })

  // ── createTask ─────────────────────────────────────────────────

  describe("createTask", () => {
    it("creates a simple task appended to end of body", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          description: "New task",
          blockId: "new-task",
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 9,
        description: "New task",
        block_id: "new-task",
        changes: [`created: (none) → ${today()}`],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n\n- [ ] New task ➕ ${today()} ^new-task\n`,
      )
    })

    it("reports the last heading when appending to a note that has headings", async () => {
      const vault = await createVault()
      const noteWithHeadings = `---\ntitle: Notes\n---\n\n## Ideas\n\n- [ ] First idea\n\n## Later\n\n- [ ] Someday\n`
      await writeTestNote(vault, "notes.md", noteWithHeadings)

      const result = await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "notes.md",
          description: "Appended",
          blockId: "appended",
        },
        logger,
      )

      expect(result).toEqual({
        path: "notes.md",
        line: 13,
        description: "Appended",
        block_id: "appended",
        heading: "Later",
        changes: [`created: (none) → ${today()}`],
      })
    })

    it("creates a task under a specific heading on a Kanban board", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "board.md",
          description: "Board task",
          blockId: "board-task",
          heading: "Up Next",
        },
        logger,
      )

      expect(result).toEqual({
        path: "board.md",
        line: 14,
        description: "Board task",
        block_id: "board-task",
        heading: "Up Next",
        changes: [`created: (none) → ${today()}`],
      })
      const content = await readTestNote(vault, "board.md")
      // No setting → plugin default is append (bottom of lane)
      expect(content).toBe(`---
title: Board
kanban-plugin: board
---

## Active

- [/] In-progress task ➕ 2026-07-01 ^active-task
- [ ] Second task ➕ 2026-07-02

## Up Next

- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task
- [ ] Board task ➕ ${today()} ^board-task

## Done

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`)
    })

    it("creates a task with priority and dates", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          description: "Dated task",
          blockId: "dated",
          priority: "high",
          due: "2026-09-15",
          scheduled: "2026-09-10",
          start: "2026-09-01",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n\n- [ ] Dated task ⏫ ➕ ${today()} 🛫 2026-09-01 ⏳ 2026-09-10 📅 2026-09-15 ^dated\n`,
      )
    })

    it("creates a sub-task under a parent identified by block_id", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          description: "Child task",
          blockId: "child",
          parentBlockId: "walk-dog",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] Child task ➕ ${today()} ^child\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
    })

    it("creates a task with subtask checklist items", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          description: "Multi-stage task",
          blockId: "multi-stage",
          subtasks: ["Stage 1", "Stage 2", "Stage 3"],
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 9,
        description: "Multi-stage task",
        block_id: "multi-stage",
        subtasks: [
          { line: 10, description: "Stage 1" },
          { line: 11, description: "Stage 2" },
          { line: 12, description: "Stage 3" },
        ],
        changes: [`created: (none) → ${today()}`, "subtasks: 0 → 3"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n\n- [ ] Multi-stage task ➕ ${today()} ^multi-stage\n  - [ ] Stage 1\n  - [ ] Stage 2\n  - [ ] Stage 3\n`,
      )
    })

    it("errors on duplicate block_id", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Duplicate",
            blockId: "walk-dog",
          },
          logger,
        ),
      ).rejects.toThrow('blockId "walk-dog" already exists')
    })

    it("errors on invalid block_id characters", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Bad id",
            blockId: "bad id!",
          },
          logger,
        ),
      ).rejects.toThrow("contains invalid characters")
    })

    it("errors when heading is missing on a Kanban board", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "No heading",
            blockId: "no-heading",
          },
          logger,
        ),
      ).rejects.toThrow("heading required for Kanban boards")
    })

    it("errors on invalid date", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Bad date",
            blockId: "bad-date",
            due: "2026-02-30",
          },
          logger,
        ),
      ).rejects.toThrow('invalid date: due "2026-02-30"')
    })

    it("errors when parent not found", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Orphan",
            blockId: "orphan",
            parentBlockId: "nonexistent",
          },
          logger,
        ),
      ).rejects.toThrow("parent task not found")
    })

    it("creates a sub-task under a parent identified by line number", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          description: "Line child",
          blockId: "line-child",
          parentLine: 6,
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] Line child ➕ ${today()} ^line-child\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
    })

    it("rejects a whitespace-only depends_on entry on create", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Blocked task",
            blockId: "blocked",
            dependsOn: ["dep-a", " "],
          },
          logger,
        ),
      ).rejects.toThrow(
        'dependsOn entry " " contains invalid characters (allowed: letters, digits, hyphens, underscores)',
      )
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("rejects a task_id outside the plugin's id grammar on create", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Keyed task",
            blockId: "keyed",
            taskId: "has space",
          },
          logger,
        ),
      ).rejects.toThrow(
        'taskId "has space" contains invalid characters (allowed: letters, digits, hyphens, underscores)',
      )
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when parentBlockId and parentLine are both provided", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Two locators",
            blockId: "two-locators",
            parentBlockId: "walk-dog",
            parentLine: 6,
          },
          logger,
        ),
      ).rejects.toThrow("parentBlockId and parentLine are mutually exclusive")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when parent block_id and heading are both provided", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "Conflicting",
            blockId: "conflicting",
            parentBlockId: "active-task",
            heading: "Up Next",
          },
          logger,
        ),
      ).rejects.toThrow("parent and heading are mutually exclusive")
    })

    it("errors when parent line number and heading are both provided", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "Conflicting",
            blockId: "conflicting",
            parentLine: 7,
            heading: "Up Next",
          },
          logger,
        ),
      ).rejects.toThrow("parent and heading are mutually exclusive")
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(KANBAN_BOARD)
    })

    it("errors when a subtasks item is whitespace-only", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Ship",
            blockId: "ship",
            subtasks: ["Design", "   "],
          },
          logger,
        ),
      ).rejects.toThrow("subtasks cannot contain an empty item")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when the description contains a line break", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Line one\nLine two",
            blockId: "two-lines",
          },
          logger,
        ),
      ).rejects.toThrow("description must be a single line")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when a subtasks item contains a line break", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Ship",
            blockId: "ship",
            subtasks: ["Design", "Implement\r\nTest"],
          },
          logger,
        ),
      ).rejects.toThrow("subtasks items must be a single line")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when depends_on is an empty array", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "No deps",
            blockId: "no-deps",
            dependsOn: [],
          },
          logger,
        ),
      ).rejects.toThrow("dependsOn cannot be empty")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when parent line number does not point to a task", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Bad line parent",
            blockId: "bad-line",
            parentLine: 1,
          },
          logger,
        ),
      ).rejects.toThrow("parent task not found: line 1")
    })

    it("errors on empty description", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "   ",
            blockId: "empty-desc",
          },
          logger,
        ),
      ).rejects.toThrow("description is empty")
    })

    it("skips past **Complete** marker when inserting under a heading", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_WITH_COMPLETE_MARKER)

      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "board.md",
          description: "Archived card",
          blockId: "archived-card",
          heading: "Archive",
        },
        logger,
      )

      const content = await readTestNote(vault, "board.md")
      // New card should appear after **Complete**, not before it
      const archiveSection = content.split("## Archive")[1] ?? ""
      const completeIndex = archiveSection.indexOf("**Complete**")
      const newCardIndex = archiveSection.indexOf("Archived card")
      expect(completeIndex).toBeGreaterThan(-1)
      expect(newCardIndex).toBeGreaterThan(-1)
      expect(newCardIndex).toBeGreaterThan(completeIndex)
    })
  })

  // ── updateTask expansion ──────────────────────────────────────

  describe("updateTask expansion", () => {
    it("replaces a task description preserving metadata", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          description: "Walk the cat",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the cat",
        changes: ["description: Walk the dog → Walk the cat"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the cat ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("sets a due date on a task", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          due: "2026-09-15",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["due: (none) → 2026-09-15"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 📅 2026-09-15 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("clears a date field with null", async () => {
      const vault = await createVault()
      const noteWithDue = `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 📅 2026-09-01 ^my-task\n`
      await writeTestNote(vault, "tasks.md", noteWithDue)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          due: null,
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["due: 2026-09-01 → (none)"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ^my-task\n",
      )
    })

    it("sets created with a corrected date", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ^my-task\n`,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          created: "2026-06-15",
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["created: 2026-07-01 → 2026-06-15"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-06-15 ^my-task\n",
      )
    })

    it("clears created with null", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ^my-task\n`,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          created: null,
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["created: 2026-07-01 → (none)"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe("---\ntitle: Tasks\n---\n\n- [ ] Task ^my-task\n")
    })

    it("sets task_id after the dates", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ^my-task\n`,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          taskId: "abc123",
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["task_id: (none) → abc123"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 🆔 abc123 ^my-task\n",
      )
    })

    it("clears task_id with null", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 🆔 abc123 ⛔ dep-a,dep-b ^my-task\n`,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          taskId: null,
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["task_id: abc123 → (none)"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ⛔ dep-a,dep-b ^my-task\n",
      )
    })

    it("sets depends_on as a comma-joined id list", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ^my-task\n`,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          dependsOn: ["dep-a", "dep-b"],
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["depends_on: (none) → dep-a,dep-b"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 ⛔ dep-a,dep-b ^my-task\n",
      )
    })

    it("clears depends_on with null", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 🆔 abc123 ⛔ dep-a,dep-b ^my-task\n`,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          dependsOn: null,
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Task",
        block_id: "my-task",
        changes: ["depends_on: dep-a,dep-b → (none)"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 🆔 abc123 ^my-task\n",
      )
    })

    it("adds a subtask to a parent task", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          addSubtasks: ["Bring treats"],
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        subtasks: [{ line: 7, description: "Bring treats" }],
        changes: ["subtasks: 0 → 1"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] Bring treats\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("composes add_subtasks with status change", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          status: "in_progress",
          addSubtasks: ["First stage", "Second stage"],
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        subtasks: [
          { line: 7, description: "First stage" },
          { line: 8, description: "Second stage" },
        ],
        changes: ["status: todo → in_progress", "subtasks: 0 → 2"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [/] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] First stage\n  - [ ] Second stage\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("reports both sides of a description change with the line's tags, matching the result description", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        "---\ntitle: Tasks\n---\n\n- [ ] Fix bug 📅 2026-01-01 #urgent ^fix-bug\n",
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "fix-bug",
          description: "Fix crash",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "fix-bug",
        path: "tasks.md",
        line: 5,
        description: "Fix crash #urgent",
        changes: ["description: Fix bug #urgent → Fix crash #urgent"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Fix crash 📅 2026-01-01 #urgent ^fix-bug\n",
      )
    })

    it("rejects a whitespace-only depends_on entry on update", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            dependsOn: [" "],
          },
          logger,
        ),
      ).rejects.toThrow(
        'dependsOn entry " " contains invalid characters (allowed: letters, digits, hyphens, underscores)',
      )
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("moves a task with existing checklist items to a heading and appends add_subtasks under it in the same call", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "board.md",
        "---\nkanban-plugin: board\n---\n\n## Active\n\n- [ ] Parent task ➕ 2026-07-01 ^parent\n  - [x] First stage\n  - [ ] Second stage\n\n## Done\n\n- [x] Old done\n",
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "parent",
          heading: "Done",
          addSubtasks: ["Third stage"],
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "parent",
        path: "board.md",
        line: 9,
        description: "Parent task",
        heading: "Done",
        subtasks: [{ line: 12, description: "Third stage" }],
        changes: ["heading: Active → Done", "subtasks: 2 → 3"],
      })
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(
        "---\nkanban-plugin: board\n---\n\n## Active\n\n\n## Done\n- [ ] Parent task ➕ 2026-07-01 ^parent\n  - [x] First stage\n  - [ ] Second stage\n  - [ ] Third stage\n\n- [x] Old done\n",
      )
    })

    it("appends add_subtasks after existing checklist items and reports the count before → after", async () => {
      const vault = await createVault()
      await writeTestNote(
        vault,
        "tasks.md",
        "---\ntitle: Tasks\n---\n\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [x] Find the leash\n  - [ ] Bring treats\n- [ ] Buy groceries ➕ 2026-07-01\n",
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          addSubtasks: ["Lock the door"],
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 5,
        description: "Walk the dog",
        subtasks: [{ line: 8, description: "Lock the door" }],
        changes: ["subtasks: 2 → 3"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [x] Find the leash\n  - [ ] Bring treats\n  - [ ] Lock the door\n- [ ] Buy groceries ➕ 2026-07-01\n",
      )
    })

    it("assigns a block_id to a task without one", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          line: 5,
          assignBlockId: "buy-groceries",
        },
        logger,
      )

      expect(result).toEqual({
        path: "tasks.md",
        line: 5,
        description: "Buy groceries",
        block_id: "buy-groceries",
        changes: ["block_id: (none) → buy-groceries"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01 ^buy-groceries\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("omits heading from the result when the task sits above any heading", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          priority: "low",
        },
        logger,
      )

      expect(JSON.parse(JSON.stringify(result))).toEqual({
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        block_id: "walk-dog",
        changes: ["priority: (none) → low"],
      })
    })

    it("rejects an empty depends_on array (null is the clear idiom)", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            dependsOn: [],
          },
          logger,
        ),
      ).rejects.toThrow("dependsOn cannot be empty (use null to clear)")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("replaces an existing block_id", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          assignBlockId: "walk-cat",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-cat",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["block_id: walk-dog → walk-cat"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-cat\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("completes a sub-task in place without heading-moving", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_WITH_SUBITEMS)

      // Create a sub-task first so we have one to complete
      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "board.md",
          description: "Sub-stage",
          blockId: "sub-stage",
          parentBlockId: "parent",
        },
        logger,
      )

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "sub-stage",
          status: "done",
        },
        logger,
      )

      expect(result.changes).toEqual(["status: todo → done"])
      const content = await readTestNote(vault, "board.md")
      // Sub-task completed in place under Active, not moved to Done
      const activeSection = content.split("## Active")[1]?.split("## ")[0] ?? ""
      expect(activeSection).toContain(
        `[x] Sub-stage ➕ ${today()} ✅ ${today()} ^sub-stage`,
      )
      const doneSection = content.split("## Done")[1] ?? ""
      expect(doneSection).not.toContain("Sub-stage")
    })

    it("errors when explicit heading is set on a sub-task", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_WITH_SUBITEMS)

      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "board.md",
          description: "Sub for heading test",
          blockId: "sub-heading-test",
          parentBlockId: "parent",
        },
        logger,
      )

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "sub-heading-test",
            heading: "Done",
          },
          logger,
        ),
      ).rejects.toThrow("cannot move a sub-task to a heading")
    })

    it("errors on invalid date in update", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            due: "not-a-date",
          },
          logger,
        ),
      ).rejects.toThrow("invalid date")
    })

    it("errors on empty description in update", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            description: "   ",
          },
          logger,
        ),
      ).rejects.toThrow("description cannot be empty")
    })

    it("errors on a whitespace-only add_subtasks item", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            addSubtasks: ["Real stage", "   "],
          },
          logger,
        ),
      ).rejects.toThrow("addSubtasks cannot contain an empty item")
    })

    it("errors when the new description contains a line break", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            description: "Walk the dog\nthen feed it",
          },
          logger,
        ),
      ).rejects.toThrow("description must be a single line")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("errors when an add_subtasks item contains a line break", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            addSubtasks: ["Real stage", "Split\nstage"],
          },
          logger,
        ),
      ).rejects.toThrow("addSubtasks items must be a single line")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("moves a task nested under a plain bullet — top-level to the parser — to a heading", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "agenda.md", TASK_UNDER_PLAIN_BULLET)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "agenda.md",
          blockId: "call-dentist",
          heading: "Done",
        },
        logger,
      )

      expect(result.changes).toEqual(["heading: Active → Done"])
      const content = await readTestNote(vault, "agenda.md")
      expect(content).toBe(`## Active

- [ ] Earlier task ^earlier
- Agenda

## Done
  - [ ] Call dentist ^call-dentist
`)
    })

    it("moves a blockquoted card together with its quoted checklist", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", QUOTED_BOARD)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "quoted-parent",
          heading: "Done",
        },
        logger,
      )

      expect(result.changes).toEqual(["heading: Active → Done"])
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(`---
kanban-plugin: board
---

## Active


## Done
> - [ ] Quoted parent ➕ 2026-07-01 ^quoted-parent
>   - [ ] Stage 1
`)
    })

    it("writes an added checklist item inside the card's blockquote", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", QUOTED_BOARD)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "quoted-parent",
          addSubtasks: ["Stage 2"],
        },
        logger,
      )

      expect(result.changes).toEqual(["subtasks: 1 → 2"])
      expect(result.subtasks).toEqual([{ line: 9, description: "Stage 2" }])
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(`---
kanban-plugin: board
---

## Active

> - [ ] Quoted parent ➕ 2026-07-01 ^quoted-parent
>   - [ ] Stage 1
>   - [ ] Stage 2

## Done
`)
    })
  })

  // ── position param ──────────────────────────────────────────────

  describe("position param", () => {
    // ── createTask + position ───────────────────────────────────

    describe("createTask position", () => {
      it("non-Kanban + heading + no position → bottom (appends after existing tasks)", async () => {
        const vault = await createVault()
        const note = `---\ntitle: Notes\n---\n\n## Ideas\n\n- [ ] First ^first\n- [ ] Second ^second\n`
        await writeTestNote(vault, "notes.md", note)

        const result = await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "notes.md",
            description: "Third",
            blockId: "third",
            heading: "Ideas",
          },
          logger,
        )

        expect(result.heading).toBe("Ideas")
        const content = await readTestNote(vault, "notes.md")
        expect(content).toBe(
          `---\ntitle: Notes\n---\n\n## Ideas\n\n- [ ] First ^first\n- [ ] Second ^second\n- [ ] Third ➕ ${today()} ^third\n`,
        )
      })

      it("non-Kanban + heading + position=top → inserts before existing tasks", async () => {
        const vault = await createVault()
        const note = `---\ntitle: Notes\n---\n\n## Ideas\n\n- [ ] First ^first\n`
        await writeTestNote(vault, "notes.md", note)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "notes.md",
            description: "Prepended",
            blockId: "prepended",
            heading: "Ideas",
            position: "top",
          },
          logger,
        )

        const content = await readTestNote(vault, "notes.md")
        expect(content).toBe(
          `---\ntitle: Notes\n---\n\n## Ideas\n- [ ] Prepended ➕ ${today()} ^prepended\n\n- [ ] First ^first\n`,
        )
      })

      it("Kanban + heading + no position + no setting → bottom (plugin default is append)", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "board.md", KANBAN_BOARD)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "New card",
            blockId: "new-card",
            heading: "Up Next",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
title: Board
kanban-plugin: board
---

## Active

- [/] In-progress task ➕ 2026-07-01 ^active-task
- [ ] Second task ➕ 2026-07-02

## Up Next

- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task
- [ ] New card ➕ ${today()} ^new-card

## Done

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`)
      })

      it("Kanban + heading + no position + setting=append → bottom", async () => {
        const vault = await createVault()
        const board = `---
kanban-plugin: board
---

## Active

- [ ] Existing task ➕ 2026-07-01 ^existing

## Done

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append"}
\`\`\`
%%
`
        await writeTestNote(vault, "board.md", board)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "Appended card",
            blockId: "appended-card",
            heading: "Active",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
kanban-plugin: board
---

## Active

- [ ] Existing task ➕ 2026-07-01 ^existing
- [ ] Appended card ➕ ${today()} ^appended-card

## Done

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append"}
\`\`\`
%%
`)
      })

      it("Kanban + heading + no position + setting=prepend → top", async () => {
        const vault = await createVault()
        const board = `---
kanban-plugin: board
---

## Active

- [ ] Existing task ➕ 2026-07-01 ^existing

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"prepend"}
\`\`\`
%%
`
        await writeTestNote(vault, "board.md", board)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "Prepended card",
            blockId: "prepended-card",
            heading: "Active",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
kanban-plugin: board
---

## Active
- [ ] Prepended card ➕ ${today()} ^prepended-card

- [ ] Existing task ➕ 2026-07-01 ^existing

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"prepend"}
\`\`\`
%%
`)
      })

      it("Kanban + heading + explicit position=top overrides setting=append", async () => {
        const vault = await createVault()
        const board = `---
kanban-plugin: board
---

## Active

- [ ] Existing task ➕ 2026-07-01 ^existing

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append"}
\`\`\`
%%
`
        await writeTestNote(vault, "board.md", board)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "Top card",
            blockId: "top-card",
            heading: "Active",
            position: "top",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
kanban-plugin: board
---

## Active
- [ ] Top card ➕ ${today()} ^top-card

- [ ] Existing task ➕ 2026-07-01 ^existing

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append"}
\`\`\`
%%
`)
      })

      it("position is silently ignored when a parent locator is present", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

        const result = await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "Child task",
            blockId: "child",
            parentBlockId: "walk-dog",
            position: "top",
          },
          logger,
        )

        expect(result.changes).toEqual([`created: (none) → ${today()}`])
        const content = await readTestNote(vault, "tasks.md")
        expect(content).toBe(
          `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] Child task ➕ ${today()} ^child\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
        )
      })

      it("position is silently ignored when no heading on a non-Kanban note", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

        const result = await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            description: "End task",
            blockId: "end-task",
            position: "top",
          },
          logger,
        )

        expect(result.line).toBe(9)
        const content = await readTestNote(vault, "tasks.md")
        expect(content).toBe(
          `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n\n- [ ] End task ➕ ${today()} ^end-task\n`,
        )
      })

      it("bottom insertion into an empty section works", async () => {
        const vault = await createVault()
        const note = `---\ntitle: Board\nkanban-plugin: board\n---\n\n## Active\n\n## Done\n`
        await writeTestNote(vault, "board.md", note)

        const result = await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "First card",
            blockId: "first-card",
            heading: "Active",
            position: "bottom",
          },
          logger,
        )

        expect(result.heading).toBe("Active")
        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(
          `---\ntitle: Board\nkanban-plugin: board\n---\n\n## Active\n- [ ] First card ➕ ${today()} ^first-card\n\n## Done\n`,
        )
      })

      it("bottom insertion lands after last task in a Complete-marked lane", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "board.md", KANBAN_WITH_COMPLETE_MARKER)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "New done task",
            blockId: "new-done",
            heading: "Archive",
            position: "bottom",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
kanban-plugin: board
---

## Active

- [ ] Task A ➕ 2026-07-01 ^task-a

## Archive

**Complete**
- [x] Old task ➕ 2026-06-01 ✅ 2026-06-10
- [ ] New done task ➕ ${today()} ^new-done
`)
      })

      it("bottom insertion into the last lane of a board with kanban:settings stays before the settings block", async () => {
        const vault = await createVault()
        const board = `---
kanban-plugin: board
---

## Done

- [x] Old task ➕ 2026-06-01 ✅ 2026-06-10

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append"}
\`\`\`
%%
`
        await writeTestNote(vault, "board.md", board)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "board.md",
            description: "New card",
            blockId: "new-card",
            heading: "Done",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
kanban-plugin: board
---

## Done

- [x] Old task ➕ 2026-06-01 ✅ 2026-06-10
- [ ] New card ➕ ${today()} ^new-card

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","new-card-insertion-method":"append"}
\`\`\`
%%
`)
      })

      it("bottom insertion into a section ending with prose appends after the prose", async () => {
        const vault = await createVault()
        const note = `---\ntitle: Notes\n---\n\n## Tasks\n\n- [ ] First ^first\n\nSome notes about the tasks.\n\n## Other\n`
        await writeTestNote(vault, "notes.md", note)

        await taskMutations.createTask(
          {
            vaultPath: vault,
            path: "notes.md",
            description: "After prose",
            blockId: "after-prose",
            heading: "Tasks",
          },
          logger,
        )

        const content = await readTestNote(vault, "notes.md")
        expect(content).toBe(
          `---\ntitle: Notes\n---\n\n## Tasks\n\n- [ ] First ^first\n\nSome notes about the tasks.\n- [ ] After prose ➕ ${today()} ^after-prose\n\n## Other\n`,
        )
      })
    })

    // ── updateTask + position ───────────────────────────────────

    describe("updateTask position", () => {
      it("heading move + no position → top (default preserved)", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "board.md", KANBAN_BOARD)

        await taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "planned-task",
            heading: "Active",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
title: Board
kanban-plugin: board
---

## Active
- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task

- [/] In-progress task ➕ 2026-07-01 ^active-task
- [ ] Second task ➕ 2026-07-02

## Up Next


## Done

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`)
      })

      it("heading move + position=bottom → appends after existing tasks", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "board.md", KANBAN_BOARD)

        await taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "planned-task",
            heading: "Active",
            position: "bottom",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
title: Board
kanban-plugin: board
---

## Active

- [/] In-progress task ➕ 2026-07-01 ^active-task
- [ ] Second task ➕ 2026-07-02
- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task

## Up Next


## Done

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`)
      })

      it("status=done auto-move + no position → top of done lane", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "board.md", KANBAN_BOARD)

        await taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "active-task",
            status: "done",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
title: Board
kanban-plugin: board
---

## Active

- [ ] Second task ➕ 2026-07-02

## Up Next

- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task

## Done
- [x] In-progress task ➕ 2026-07-01 ✅ ${today()} ^active-task

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`)
      })

      it("status=done auto-move + position=bottom → bottom of done lane", async () => {
        const vault = await createVault()
        await writeTestNote(vault, "board.md", KANBAN_BOARD)

        await taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "active-task",
            status: "done",
            position: "bottom",
          },
          logger,
        )

        const content = await readTestNote(vault, "board.md")
        expect(content).toBe(`---
title: Board
kanban-plugin: board
---

## Active

- [ ] Second task ➕ 2026-07-02

## Up Next

- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task

## Done

- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15
- [x] In-progress task ➕ 2026-07-01 ✅ ${today()} ^active-task

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`)
      })
    })
  })
})
