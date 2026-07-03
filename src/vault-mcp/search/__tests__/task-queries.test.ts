import { describe, it, expect, beforeEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSearchIndex } from "../search-index.js"
import type { SearchIndex, TaskEntry } from "../search-index.js"
import { logger } from "../../../logger.js"

let index: SearchIndex

beforeEach(() => {
  index = createSearchIndex(":memory:")
})

const testStat = (
  mtimeMs: number,
  size = 100,
): { mtimeMs: number; size: number } => ({
  mtimeMs,
  size,
})

/** A Kanban-style board exercising statuses, dates, priority, tags, and
 *  block IDs across two lanes. */
const BOARD_NOTE = `---
kanban-plugin: board
---

## Active

- [ ] Fix login bug ⏫ ➕ 2026-06-20 📅 2026-07-01 ^fix-login
- [/] Write tests ➕ 2026-06-21 ⏳ 2026-07-05

## Done

- [x] Ship release ➕ 2026-06-01 ✅ 2026-06-28
- [-] Old idea ➕ 2026-06-02 ❌ 2026-06-25
`

const PLAIN_NOTE = `# Notes

- [ ] Standalone task #errand 📅 2026-07-10
- [ ] Undated low task 🔽
`

describe("task indexing lifecycle", () => {
  it("indexes tasks during upsertNote and returns them via listTasks", () => {
    index.upsertNote(
      {
        filePath: "Projects/board.md",
        rawContent: BOARD_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({ status: "all" }, logger)
    expect(result.total).toBe(4)
    expect(result.tasks).toHaveLength(4)
  })

  it("returns full attribution on every entry — dates, priority, folder, heading, block ID", () => {
    index.upsertNote(
      {
        filePath: "Projects/board.md",
        rawContent: BOARD_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({}, logger)
    const fixLoginTask = result.tasks.find(
      (entry) => entry.block_id === "fix-login",
    )
    const expectedEntry: TaskEntry = {
      path: "Projects/board.md",
      line: 7,
      status: "todo",
      status_char: " ",
      description: "Fix login bug",
      heading: "Active",
      folder: "Projects",
      created: "2026-06-20",
      scheduled: null,
      start: null,
      due: "2026-07-01",
      done: null,
      cancelled: null,
      priority: "high",
      recurrence: null,
      on_completion: null,
      task_id: null,
      depends_on: [],
      tags: [],
      block_id: "fix-login",
    }
    expect(fixLoginTask).toEqual(expectedEntry)
  })

  it("stores the full parent folder, not just the first path segment", () => {
    index.upsertNote(
      {
        filePath: "Code Projects/vault-cortex/task-notes/note.md",
        rawContent: "- [ ] Deep task",
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({}, logger)
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].folder).toBe("Code Projects/vault-cortex/task-notes")
  })

  it("replaces a note's tasks on re-upsert instead of accumulating them", () => {
    index.upsertNote(
      {
        filePath: "note.md",
        rawContent: "- [ ] Old task",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "note.md",
        rawContent: "- [ ] New task",
        fileStat: testStat(2000),
      },
      logger,
    )

    const result = index.listTasks({}, logger)
    expect(result.total).toBe(1)
    expect(result.tasks[0].description).toBe("New task")
  })

  it("removes a note's tasks on removeNote and keeps other notes' tasks", () => {
    index.upsertNote(
      {
        filePath: "removed.md",
        rawContent: "- [ ] Task in removed note",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "kept.md",
        rawContent: "- [ ] Task in kept note",
        fileStat: testStat(1000),
      },
      logger,
    )
    // Confirm the removed note's task was actually indexed first, so the
    // post-remove assertion can't pass by the note never being indexed.
    expect(index.listTasks({}, logger).total).toBe(2)

    index.removeNote("removed.md")

    const result = index.listTasks({}, logger)
    expect(result.total).toBe(1)
    expect(result.tasks[0].path).toBe("kept.md")
  })

  it("indexes tasks from disk during rebuildFromVault and wipes stale rows", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "task-rebuild-test-"))
    try {
      await mkdir(join(vaultDir, "Projects"), { recursive: true })
      await writeFile(join(vaultDir, "Projects/board.md"), BOARD_NOTE, "utf8")

      // A stale row from a note that no longer exists on disk must not
      // survive the rebuild.
      index.upsertNote(
        {
          filePath: "ghost.md",
          rawContent: "- [ ] Stale task",
          fileStat: testStat(1000),
        },
        logger,
      )

      const { embedding } = await index.rebuildFromVault(
        { vaultPath: vaultDir },
        logger,
      )
      await embedding

      const result = index.listTasks({ status: "all" }, logger)
      expect(result.total).toBe(4)
      expect(
        result.tasks.every((entry) => entry.path === "Projects/board.md"),
      ).toBe(true)
    } finally {
      await rm(vaultDir, { recursive: true })
    }
  })
})

describe("listTasks status filter", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/board.md",
        rawContent: BOARD_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )
  })

  it("defaults to not_done: includes todo and in_progress, excludes done and cancelled", () => {
    const result = index.listTasks({}, logger)
    const descriptions = result.tasks.map((entry) => entry.description)
    expect(descriptions).toEqual(["Fix login bug", "Write tests"])
  })

  const statusScenarios = [
    { status: "todo", expected: ["Fix login bug"] },
    { status: "in_progress", expected: ["Write tests"] },
    { status: "done", expected: ["Ship release"] },
    { status: "cancelled", expected: ["Old idea"] },
  ] as const

  it.each(statusScenarios)(
    "filters status $status exactly",
    ({ status, expected }) => {
      const result = index.listTasks({ status }, logger)
      expect(result.tasks.map((entry) => entry.description)).toEqual([
        ...expected,
      ])
    },
  )

  it("returns every status with status: all", () => {
    const result = index.listTasks({ status: "all" }, logger)
    expect(result.total).toBe(4)
  })
})

describe("listTasks date filters", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "dates.md",
        rawContent: [
          "- [ ] Due early 📅 2026-07-01",
          "- [ ] Due late 📅 2026-07-20",
          "- [ ] Undated",
          "- [x] Done in june ✅ 2026-06-28",
          "- [x] Done in july ✅ 2026-07-02",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
  })

  it("due.before is exclusive and drops undated tasks", () => {
    const result = index.listTasks({ due: { before: "2026-07-20" } }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due early",
    ])
  })

  it("due.after is exclusive", () => {
    const result = index.listTasks({ due: { after: "2026-07-01" } }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual(["Due late"])
  })

  it("due.on matches exactly", () => {
    const result = index.listTasks({ due: { on: "2026-07-01" } }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due early",
    ])
  })

  it("combines before and after into a range", () => {
    const result = index.listTasks(
      { due: { after: "2026-06-30", before: "2026-07-19" } },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due early",
    ])
  })

  it("filters done range for completed-this-week reviews", () => {
    const result = index.listTasks(
      { status: "done", done: { after: "2026-06-30" } },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Done in july",
    ])
  })

  it("rejects a malformed date with remediation text", () => {
    expect(() =>
      index.listTasks({ due: { before: "July 3rd" } }, logger),
    ).toThrow('invalid due.before date: "July 3rd". Use YYYY-MM-DD')
  })

  it("rejects a calendar-invalid date", () => {
    expect(() =>
      index.listTasks({ due: { on: "2026-02-31" } }, logger),
    ).toThrow('invalid due.on date: "2026-02-31". Use YYYY-MM-DD')
  })
})

describe("listTasks priority filter", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "priorities.md",
        rawContent: [
          "- [ ] Highest task 🔺",
          "- [ ] High task ⏫",
          "- [ ] Medium task 🔼",
          "- [ ] Normal task",
          "- [ ] Low task 🔽",
          "- [ ] Lowest task ⏬",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
  })

  it("filters a single priority level", () => {
    const result = index.listTasks({ priority: ["high"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "High task",
    ])
  })

  it("OR-combines multiple priority levels", () => {
    const result = index.listTasks({ priority: ["highest", "high"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Highest task",
      "High task",
    ])
  })

  it("selects unprioritized tasks with none", () => {
    const result = index.listTasks({ priority: ["none"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Normal task",
    ])
  })

  it("combines named levels with none", () => {
    const result = index.listTasks({ priority: ["lowest", "none"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Normal task",
      "Lowest task",
    ])
  })
})

describe("listTasks scope filters", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/board.md",
        rawContent: BOARD_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Inbox/notes.md",
        rawContent: PLAIN_NOTE,
        fileStat: testStat(2000),
      },
      logger,
    )
  })

  it("scopes to a folder, excluding tasks outside it", () => {
    const result = index.listTasks({ folder: "Projects" }, logger)
    expect(result.tasks.map((entry) => entry.path)).toEqual([
      "Projects/board.md",
      "Projects/board.md",
    ])
  })

  it("treats a trailing slash on folder as equivalent", () => {
    const withSlash = index.listTasks({ folder: "Projects/" }, logger)
    const withoutSlash = index.listTasks({ folder: "Projects" }, logger)
    expect(withSlash).toEqual(withoutSlash)
  })

  it("filters by inline tag, excluding untagged tasks", () => {
    const result = index.listTasks({ tag: "errand" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Standalone task #errand",
    ])
  })

  it("matches nested child tags when filtering by the parent tag", () => {
    index.upsertNote(
      {
        filePath: "nested.md",
        rawContent: "- [ ] Nested tag task #errand/groceries",
        fileStat: testStat(3000),
      },
      logger,
    )
    const result = index.listTasks({ tag: "errand" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Standalone task #errand",
      "Nested tag task #errand/groceries",
    ])
  })

  it("filters by heading (Kanban lane), excluding other lanes", () => {
    const result = index.listTasks({ status: "all", heading: "Done" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Ship release",
      "Old idea",
    ])
  })

  it("scopes to a single note by path", () => {
    const result = index.listTasks({ path: "Inbox/notes.md" }, logger)
    expect(result.tasks.map((entry) => entry.path)).toEqual([
      "Inbox/notes.md",
      "Inbox/notes.md",
    ])
  })

  it("rejects a path without the .md extension", () => {
    expect(() => index.listTasks({ path: "Inbox/notes" }, logger)).toThrow()
  })
})

describe("listTasks sorting and paging", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: [
          "- [ ] Due last 📅 2026-07-30",
          "- [ ] Due first 📅 2026-07-01",
          "- [ ] No due date",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "- [ ] Due middle 📅 2026-07-15",
        fileStat: testStat(5000),
      },
      logger,
    )
  })

  it("defaults to due ascending with dateless tasks last", () => {
    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due first",
      "Due middle",
      "Due last",
      "No due date",
    ])
  })

  it("reverses date order with sortDirection desc, keeping dateless last", () => {
    const result = index.listTasks({ sortDirection: "desc" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due last",
      "Due middle",
      "Due first",
      "No due date",
    ])
  })

  it("sorts by priority in the plugin's order with none between medium and low", () => {
    index.upsertNote(
      {
        filePath: "priorities.md",
        rawContent: [
          "- [ ] P-low 🔽",
          "- [ ] P-none",
          "- [ ] P-highest 🔺",
          "- [ ] P-medium 🔼",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks(
      { path: "priorities.md", sortBy: "priority" },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "P-highest",
      "P-medium",
      "P-none",
      "P-low",
    ])
  })

  it("sorts by note_mtime newest-first by default", () => {
    const result = index.listTasks({ sortBy: "note_mtime" }, logger)
    expect(result.tasks[0].path).toBe("b.md")
  })

  it("limits results while total reports the full match count", () => {
    const result = index.listTasks({ limit: 2 }, logger)
    expect(result.tasks).toHaveLength(2)
    expect(result.total).toBe(4)
  })
})
