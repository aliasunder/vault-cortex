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

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain(
        `- [x] Buy groceries ➕ 2026-07-01 ✅ ${today()}`,
      )
      expect(result.changes).toContain(`status: todo → done`)
    })

    it("sets a task to in_progress", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskUpdater.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 5, status: "in_progress" },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [/] Buy groceries ➕ 2026-07-01")
    })

    it("un-completes a done task — removes done date", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskUpdater.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 7, status: "todo" },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [ ] Done task ➕ 2026-07-01")
      expect(content).not.toContain("✅")
    })

    it("cancels a task — checkbox and cancelled date", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await taskUpdater.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 5, status: "cancelled" },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain(
        `- [-] Buy groceries ➕ 2026-07-01 ❌ ${today()}`,
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

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain(
        `- [x] Walk the dog ➕ 2026-07-02 ✅ ${today()} ^walk-dog`,
      )
      expect(result.description).toBe("Walk the dog")
    })

    it("identifies a task by line number", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      const result = await taskUpdater.updateTask(
        { vaultPath: vault, path: "tasks.md", line: 6, status: "in_progress" },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [/] Walk the dog")
      expect(result.changes).toContain("status: todo → in_progress")
    })
  })

  // ── Priority changes ────────────────────────────────────────────

  describe("priority changes", () => {
    it("adds priority to a task with none", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "no-pri",
          priority: "high",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain(
        "- [ ] No priority task ⏫ ➕ 2026-07-01 ^no-pri",
      )
    })

    it("changes an existing priority", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "has-pri",
          priority: "highest",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [ ] Has priority 🔺 ➕ 2026-07-02 ^has-pri")
      expect(content).not.toContain("⏫")
    })

    it("removes priority with 'none'", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "has-pri",
          priority: "none",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [ ] Has priority ➕ 2026-07-02 ^has-pri")
      expect(content).not.toContain("⏫")
    })

    it("inserts priority before block_id when no date signifiers", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", PRIORITY_NOTE)

      await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "tasks.md",
          blockId: "plain-task",
          priority: "low",
        },
        logger,
      )

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [ ] Plain task without dates 🔽 ^plain-task")
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

      const content = await readTestNote(vault, "board.md")
      const activeSection = content.split("## Active")[1]?.split("## ")[0] ?? ""
      const upNextSection =
        content.split("## Up Next")[1]?.split("## ")[0] ?? ""
      expect(activeSection).toContain("Planned task")
      expect(upNextSection).not.toContain("Planned task")
      expect(result.changes).toContain("lane: Up Next → Active")
    })

    it("moves a task with sub-items", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "board.md", KANBAN_WITH_SUBITEMS)

      await taskUpdater.updateTask(
        {
          vaultPath: vault,
          path: "board.md",
          blockId: "parent",
          lane: "Done",
        },
        logger,
      )

      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1]?.split("## ")[0] ?? ""
      const activeSection = content.split("## Active")[1]?.split("## ")[0] ?? ""
      expect(doneSection).toContain("Parent task")
      expect(doneSection).toContain("Sub-item 1")
      expect(doneSection).toContain("Sub-item 2")
      expect(activeSection).not.toContain("Parent task")
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

      const content = await readTestNote(vault, "board.md")
      const archiveSection =
        content.split("## Archive")[1]?.split("## ")[0] ?? ""
      expect(archiveSection).toContain("Task A")
      expect(archiveSection).toMatch(/\[x\]/)
      expect(archiveSection).toMatch(/✅ \d{4}-\d{2}-\d{2}/)
      expect(result.changes).toEqual(
        expect.arrayContaining([
          expect.stringContaining("status:"),
          expect.stringContaining("lane: Active → Archive"),
        ]),
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

      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1]?.split("## ")[0] ?? ""
      expect(doneSection).toContain("In-progress task")
      expect(doneSection).toMatch(/\[x\]/)
      expect(doneSection).toMatch(/✅ \d{4}-\d{2}-\d{2}/)
      expect(result.changes).toEqual(
        expect.arrayContaining([
          expect.stringContaining("status:"),
          expect.stringContaining("lane: Active → Done"),
        ]),
      )
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

      const content = await readTestNote(vault, "board.md")
      const doneSection = content.split("## Done")[1]?.split("## ")[0] ?? ""
      expect(doneSection).toContain(`[x] Planned task`)
      expect(doneSection).toContain(`✅ ${today()}`)
      expect(result.changes).toHaveLength(2)
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

      const content = await readTestNote(vault, "tasks.md")
      expect(content).toContain("- [/] Walk the dog 🔺 ➕ 2026-07-02 ^walk-dog")
      expect(result.changes).toHaveLength(2)
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
      ).rejects.toThrow("at least one mutation")
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
      ).rejects.toThrow("mutually exclusive")
    })

    it("no identifier provided is rejected", async () => {
      const vault = await createVault()
      await writeTestNote(vault, "tasks.md", SIMPLE_NOTE)

      await expect(
        taskUpdater.updateTask(
          { vaultPath: vault, path: "tasks.md", status: "done" },
          logger,
        ),
      ).rejects.toThrow("exactly one of block_id or line is required")
    })
  })
})
