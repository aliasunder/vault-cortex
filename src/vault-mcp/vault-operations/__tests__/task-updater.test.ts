import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime } from "luxon"
import { taskUpdater } from "../task-updater.js"
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

      const result = await taskUpdater.updateTask(
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

      const result = await taskUpdater.updateTask(
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

      const result = await taskUpdater.updateTask(
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

      const result = await taskUpdater.updateTask(
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

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "walk-dog",
          status: "done",
        },
        logger,
      )

      expect(result).toEqual({
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

      const result = await taskUpdater.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 6, status: "in_progress" },
        logger,
      )

      expect(result).toEqual({
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

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "no-pri",
          priority: "high",
        },
        logger,
      )

      expect(result).toEqual({
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

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "has-pri",
          priority: "highest",
        },
        logger,
      )

      expect(result).toEqual({
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

    it("removes priority with 'none'", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "has-pri",
          priority: "none",
        },
        logger,
      )

      expect(result).toEqual({
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

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "plain-task",
          priority: "low",
        },
        logger,
      )

      expect(result).toEqual({
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

  // ── Lane moves ────────────────────────────────────────────────

  describe("lane moves", () => {
    it("moves a task between Kanban headings", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "planned-task",
          lane: "Active",
        },
        logger,
      )

      expect(result).toEqual({
        path: "board.md",
        line: 7,
        description: "Planned task",
        changes: ["lane: Up Next → Active"],
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

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "parent",
          lane: "Done",
        },
        logger,
      )

      expect(result).toEqual({
        path: "board.md",
        line: 9,
        description: "Parent task",
        changes: ["lane: Active → Done"],
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

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "task-a",
          status: "done",
        },
        logger,
      )

      expect(result).toEqual({
        path: "board.md",
        line: 9,
        description: "Task A",
        changes: ["status: todo → done", "lane: Active → Archive"],
      })
      const content = await readTestNote(vault, "board.md")
      expect(content).toBe(
        `---\nkanban-plugin: board\n---\n\n## Active\n\n\n## Archive\n- [x] Task A ➕ 2026-07-01 ✅ ${today()} ^task-a\n\n**Complete**\n- [x] Old task ➕ 2026-06-01 ✅ 2026-06-10\n`,
      )
    })

    it("auto-completes to 'Done' heading as fallback", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "active-task",
          status: "done",
        },
        logger,
      )

      expect(result).toEqual({
        path: "board.md",
        line: 15,
        description: "In-progress task",
        changes: ["status: in_progress → done", "lane: Active → Done"],
      })
      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1]?.split("%%")[0] ?? ""
      expect(doneSection).toBe(
        `\n- [x] In-progress task ➕ 2026-07-01 ✅ ${today()} ^active-task\n\n- [x] Completed ➕ 2026-06-01 ✅ 2026-06-15\n\n`,
      )
      expect(result.changes).toEqual([
        "status: in_progress → done",
        "lane: Active → Done",
      ])
    })

    it("rejects lane move on non-Kanban note", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskUpdater.updateTask(
          {
            vaultPath: vault,
            path: "tasks.md",
            line: 5,
            lane: "Done",
          },
          logger,
        ),
      ).rejects.toThrow("lane requires a Kanban board")
    })
  })

  // ── Composed operations ─────────────────────────────────────────

  describe("composed operations", () => {
    it("completes and moves in one call", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "planned-task",
          status: "done",
          lane: "Done",
        },
        logger,
      )

      expect(result).toEqual({
        path: "board.md",
        line: 15,
        description: "Planned task",
        changes: ["status: todo → done", "lane: Up Next → Done"],
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

      const result = await taskUpdater.updateTask(
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
        taskUpdater.updateTask(
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
        taskUpdater.updateTask(
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
        taskUpdater.updateTask(
          { vaultPath: vault, path: "tasks.md", line: 1, status: "done" },
          logger,
        ),
      ).rejects.toThrow("no task at line 1")
    })

    it("throws when no mutations specified", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskUpdater.updateTask(
          { vaultPath: vault, path: "tasks.md", line: 5 },
          logger,
        ),
      ).rejects.toThrow(
        "at least one mutation (status, priority, or lane) is required",
      )
    })

    it("throws when target heading not found", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)

      await expect(
        taskUpdater.updateTask(
          {
            vaultPath: vault,
            path: "board.md",
            blockId: "active-task",
            lane: "Nonexistent",
          },
          logger,
        ),
      ).rejects.toThrow('heading "Nonexistent" not found')
    })

    it("throws when multiple done lanes and no explicit lane", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_MULTIPLE_DONE_LANES)

      await expect(
        taskUpdater.updateTask(
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
        taskUpdater.updateTask(
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
        taskUpdater.updateTask(
          { vaultPath: vault, path: "tasks.md", status: "done" },
          logger,
        ),
      ).rejects.toThrow("exactly one of blockId or line is required")
    })

    it("throws when no done lane exists for auto-completion", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_NO_DONE_LANE)

      await expect(
        taskUpdater.updateTask(
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
    it("no-op when task is already in the target lane", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_BOARD)
      const contentBefore = await readTestNote(vault, "board.md")

      const result = await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "active-task",
          lane: "Active",
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

      const result = await taskUpdater.updateTask(
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
})
