import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime } from "luxon"
import { taskMutations } from "../task-updater.js"
import { logger } from "../../../logger.js"

// ── Helpers ─────────────────────────────────────────────────────

const createVault = async (): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "task-updater-test-"))
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

const PRIORITY_NOTE = `---
title: Priority
---

- [ ] No priority task ➕ 2026-07-01 ^no-pri
- [ ] Has priority ⏫ ➕ 2026-07-02 ^has-pri
- [ ] Plain task without dates ^plain-task
`

// ── Status changes ──────────────────────────────────────────────

describe("task-updater", () => {
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
        changes: ["priority: high"],
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
        changes: ["priority: highest"],
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
        changes: ["priority: removed"],
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
        changes: ["priority: low"],
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
        changes: ["status: todo → in_progress", "priority: highest"],
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
      ).rejects.toThrow('block_id "nonexistent" not found')
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
      ).rejects.toThrow("block_id and line are mutually exclusive")
    })

    it("no identifier provided is rejected", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          { vaultPath: vault, path: "tasks.md", status: "done" },
          logger,
        ),
      ).rejects.toThrow("exactly one of block_id or line is required")
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

      expect(result).toMatchObject({
        path: "tasks.md",
        description: "New task",
        block_id: "new-task",
      })
      expect(result.heading).toBeUndefined()
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n\n- [ ] New task ➕ ${today()} ^new-task\n`,
      )
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

      expect(result).toMatchObject({
        path: "board.md",
        description: "Board task",
        block_id: "board-task",
        heading: "Up Next",
      })
      const content = await readTestNote(vault, "board.md")
      // Task inserted at the top of Up Next, before the existing card
      const upNextSection =
        content.split("## Up Next")[1]?.split("## ")[0] ?? ""
      expect(upNextSection).toBe(
        `\n- [ ] Board task ➕ ${today()} ^board-task\n\n- [ ] Planned task ⏫ ➕ 2026-07-03 ^planned-task\n\n`,
      )
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
          parentTask: "walk-dog",
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

      await taskMutations.createTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          description: "Multi-stage task",
          blockId: "multi-stage",
          subtasks: ["Stage 1", "Stage 2", "Stage 3"],
        },
        logger,
      )

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
      ).rejects.toThrow('block_id "walk-dog" already exists')
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
            parentTask: "nonexistent",
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
          parentTask: 6,
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        `---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] Line child ➕ ${today()} ^line-child\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n`,
      )
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
            parentTask: "active-task",
            heading: "Up Next",
          },
          logger,
        ),
      ).rejects.toThrow("parent_task and heading are mutually exclusive")
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
            parentTask: 7,
            heading: "Up Next",
          },
          logger,
        ),
      ).rejects.toThrow("parent_task and heading are mutually exclusive")
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(KANBAN_BOARD)
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
      ).rejects.toThrow("depends_on cannot be empty")
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
            parentTask: 1,
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

      await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          due: "2026-09-15",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 📅 2026-09-15 ^walk-dog\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("clears a date field with null", async () => {
      const vault = await createVault()
      const noteWithDue = `---\ntitle: Tasks\n---\n\n- [ ] Task ➕ 2026-07-01 📅 2026-09-01 ^my-task\n`
      await writeTestNote(vault, "tasks.md", noteWithDue)

      await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "my-task",
          due: null,
        },
        logger,
      )

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

      expect(result.changes).toEqual(["created: 2026-06-15"])
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

      expect(result.changes).toEqual(["created: removed"])
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

      expect(result.changes).toEqual(["task_id: abc123"])
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

      expect(result.changes).toEqual(["task_id: removed"])
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

      expect(result.changes).toEqual(["depends_on: dep-a,dep-b"])
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

      expect(result.changes).toEqual(["depends_on: removed"])
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
          addSubtask: "Bring treats",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["subtask added: Bring treats"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [ ] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] Bring treats\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
      )
    })

    it("composes add_subtask with status change", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          status: "in_progress",
          addSubtask: "First stage",
        },
        logger,
      )

      expect(result).toEqual({
        block_id: "walk-dog",
        path: "tasks.md",
        line: 6,
        description: "Walk the dog",
        changes: ["status: todo → in_progress", "subtask added: First stage"],
      })
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(
        "---\ntitle: Tasks\n---\n\n- [ ] Buy groceries ➕ 2026-07-01\n- [/] Walk the dog ➕ 2026-07-02 ^walk-dog\n  - [ ] First stage\n- [x] Done task ➕ 2026-07-01 ✅ 2026-07-10\n",
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
        changes: ["block_id assigned: buy-groceries"],
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
        changes: ["priority: low"],
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
      ).rejects.toThrow("depends_on cannot be empty (use null to clear)")
      const content = await readTestNote(vault, "tasks.md")
      expect(content).toBe(SIMPLE_NOTE)
    })

    it("replaces an existing block_id", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskMutations.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          assignBlockId: "walk-cat",
        },
        logger,
      )

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
          parentTask: "parent",
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
          parentTask: "parent",
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

    it("errors on whitespace-only add_subtask", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskMutations.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            blockId: "walk-dog",
            addSubtask: "   ",
          },
          logger,
        ),
      ).rejects.toThrow("add_subtask cannot be empty")
    })
  })
})
