import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSearchIndex } from "../search-index.js"
import type { TaskEntry } from "../search-index.js"
import { logger } from "../../../logger.js"

const createTestIndex = () => createSearchIndex(":memory:")

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

const indexWithBoard = () => {
  const index = createTestIndex()
  index.upsertNote(
    {
      filePath: "Projects/board.md",
      rawContent: BOARD_NOTE,
      fileStat: testStat(1000),
    },
    logger,
  )
  return index
}

const indexWithBoardAndPlain = () => {
  const index = indexWithBoard()
  index.upsertNote(
    {
      filePath: "Inbox/notes.md",
      rawContent: PLAIN_NOTE,
      fileStat: testStat(2000),
    },
    logger,
  )
  return index
}

describe("task indexing lifecycle", () => {
  it("indexes tasks during upsertNote and returns them via listTasks", () => {
    const index = indexWithBoard()

    const result = index.listTasks({ status: "all" }, logger)
    expect(result.total).toBe(4)
    // Due-dated first (ASC), then scheduled, then created-only (DESC — newest first).
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Fix login bug",
      "Write tests",
      "Old idea",
      "Ship release",
    ])
  })

  it("returns full attribution on every entry — dates, priority, folder, heading, block ID", () => {
    const index = indexWithBoard()

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
      is_kanban_task: true,
    }
    expect(fixLoginTask).toEqual(expectedEntry)
  })

  it("round-trips non-empty tags and depends_on arrays through the index", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "note.md",
        rawContent:
          "- [ ] Tagged and blocked #home #home/kitchen ⛔ id-1, id-2 🆔 own-id",
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({}, logger)
    const expectedEntry: TaskEntry = {
      path: "note.md",
      line: 1,
      status: "todo",
      status_char: " ",
      description: "Tagged and blocked #home #home/kitchen",
      heading: null,
      folder: "",
      created: null,
      scheduled: null,
      start: null,
      due: null,
      done: null,
      cancelled: null,
      priority: null,
      recurrence: null,
      on_completion: null,
      task_id: "own-id",
      depends_on: ["id-1", "id-2"],
      tags: ["home", "home/kitchen"],
      block_id: null,
      is_kanban_task: false,
    }
    expect(result.tasks).toEqual([expectedEntry])
  })

  it("stores the full parent folder, not just the first path segment", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "Code Projects/vault-cortex/task-notes/note.md",
        rawContent: "- [ ] Deep task",
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.folder)).toEqual([
      "Code Projects/vault-cortex/task-notes",
    ])
  })

  it("stores an empty-string folder for root-level notes", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "inbox.md",
        rawContent: "- [ ] Root task",
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.folder)).toEqual([""])
  })

  it("marks tasks from kanban-plugin notes as is_kanban_task true", () => {
    const result = indexWithBoardAndPlain().listTasks({ status: "all" }, logger)
    const boardTasks = result.tasks.filter(
      (entry) => entry.path === "Projects/board.md",
    )

    expect(boardTasks).toHaveLength(4)
    expect(boardTasks.every((entry) => entry.is_kanban_task === true)).toBe(
      true,
    )
  })

  it("marks tasks from plain notes as is_kanban_task false", () => {
    const result = indexWithBoardAndPlain().listTasks({ status: "all" }, logger)
    const plainTasks = result.tasks.filter(
      (entry) => entry.path === "Inbox/notes.md",
    )

    expect(plainTasks).toHaveLength(2)
    expect(plainTasks.every((entry) => entry.is_kanban_task === false)).toBe(
      true,
    )
  })

  it("replaces a note's tasks on re-upsert instead of accumulating them", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "note.md",
        rawContent: "- [ ] Old task",
        fileStat: testStat(1000),
      },
      logger,
    )
    // Confirm the first version was actually indexed, so replacement can't
    // be satisfied by the first upsert never running.
    expect(
      index.listTasks({}, logger).tasks.map((entry) => entry.description),
    ).toEqual(["Old task"])

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
    expect(result.tasks.map((entry) => entry.description)).toEqual(["New task"])
  })

  it("removes a note's tasks on removeNote and keeps other notes' tasks", () => {
    const index = createTestIndex()
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
    expect(result.tasks.map((entry) => entry.path)).toEqual(["kept.md"])
  })

  it("indexes tasks from disk during rebuildFromVault and wipes stale rows", async () => {
    const index = createTestIndex()
    const vaultDir = await mkdtemp(join(tmpdir(), "task-rebuild-test-"))
    onTestFinished(() => rm(vaultDir, { recursive: true, force: true }))
    await mkdir(join(vaultDir, "Projects"), { recursive: true })
    await writeFile(join(vaultDir, "Projects/board.md"), BOARD_NOTE, "utf8")

    // A stale row from a note that no longer exists on disk must not
    // survive the rebuild. Confirm it was actually indexed first, so the
    // post-rebuild assertion can't pass by the row never existing.
    index.upsertNote(
      {
        filePath: "ghost.md",
        rawContent: "- [ ] Stale task",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(
      index.listTasks({}, logger).tasks.map((entry) => entry.path),
    ).toEqual(["ghost.md"])

    const { embedding } = await index.rebuildFromVault(
      { vaultPath: vaultDir },
      logger,
    )
    await embedding

    const result = index.listTasks({ status: "all" }, logger)
    expect(result.total).toBe(4)
    expect(result.tasks.map((entry) => entry.path)).toEqual([
      "Projects/board.md",
      "Projects/board.md",
      "Projects/board.md",
      "Projects/board.md",
    ])
  })
})

describe("listTasks status filter", () => {
  it("defaults to not_done: includes todo and in_progress, excludes done and cancelled", () => {
    const index = indexWithBoard()
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
      const index = indexWithBoard()
      const result = index.listTasks({ status }, logger)
      expect(result.tasks.map((entry) => entry.description)).toEqual([
        ...expected,
      ])
    },
  )

  it("returns every status with status: all", () => {
    const index = indexWithBoard()
    const result = index.listTasks({ status: "all" }, logger)
    // Created-only tasks sort DESC (newest first): Old idea (2026-06-02) before Ship release (2026-06-01).
    expect(result.tasks.map((entry) => entry.status)).toEqual([
      "todo",
      "in_progress",
      "cancelled",
      "done",
    ])
  })
})

describe("listTasks date filters", () => {
  const indexWithDates = () => {
    const index = createTestIndex()
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
    return index
  }

  it("due.before is exclusive and drops undated tasks", () => {
    const index = indexWithDates()
    const result = index.listTasks({ due: { before: "2026-07-20" } }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due early",
    ])
  })

  it("due.after is exclusive", () => {
    const index = indexWithDates()
    const result = index.listTasks({ due: { after: "2026-07-01" } }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual(["Due late"])
  })

  it("due.on matches exactly", () => {
    const index = indexWithDates()
    const result = index.listTasks({ due: { on: "2026-07-01" } }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due early",
    ])
  })

  it("combines before and after into a range", () => {
    const index = indexWithDates()
    const result = index.listTasks(
      { due: { after: "2026-06-30", before: "2026-07-19" } },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due early",
    ])
  })

  it("filters done range for completed-this-week reviews", () => {
    const index = indexWithDates()
    const result = index.listTasks(
      { status: "done", done: { after: "2026-06-30" } },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Done in july",
    ])
  })

  const dateColumnScenarios = [
    {
      column: "scheduled",
      filter: { scheduled: { on: "2026-07-02" } },
      expected: "Scheduled task",
    },
    {
      column: "start",
      filter: { start: { on: "2026-07-03" } },
      expected: "Started task",
    },
    {
      column: "created",
      filter: { created: { on: "2026-07-01" } },
      expected: "Created task",
    },
    {
      column: "cancelled",
      filter: { cancelled: { on: "2026-07-06" } },
      expected: "Cancelled task",
    },
  ] as const

  it.each(dateColumnScenarios)(
    "filters the $column date on its own column, not another date field",
    ({ filter, expected }) => {
      const index = createTestIndex()
      index.upsertNote(
        {
          filePath: "columns.md",
          rawContent: [
            "- [ ] Scheduled task ⏳ 2026-07-02",
            "- [ ] Started task 🛫 2026-07-03",
            "- [ ] Created task ➕ 2026-07-01",
            "- [-] Cancelled task ❌ 2026-07-06",
          ].join("\n"),
          fileStat: testStat(1000),
        },
        logger,
      )
      const result = index.listTasks({ status: "all", ...filter }, logger)
      expect(result.tasks.map((entry) => entry.description)).toEqual([expected])
    },
  )

  it("rejects a malformed date with remediation text", () => {
    const index = createTestIndex()
    expect(() =>
      index.listTasks({ due: { before: "July 3rd" } }, logger),
    ).toThrow(
      'invalid due.before date: "July 3rd". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })

  it("rejects a calendar-invalid date", () => {
    const index = createTestIndex()
    expect(() =>
      index.listTasks({ due: { on: "2026-02-31" } }, logger),
    ).toThrow(
      'invalid due.on date: "2026-02-31". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })
})

describe("listTasks priority filter", () => {
  const indexWithPriorities = () => {
    const index = createTestIndex()
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
    return index
  }

  it("filters a single priority level", () => {
    const index = indexWithPriorities()
    const result = index.listTasks({ priority: ["high"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "High task",
    ])
  })

  it("OR-combines multiple priority levels", () => {
    const index = indexWithPriorities()
    const result = index.listTasks({ priority: ["highest", "high"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Highest task",
      "High task",
    ])
  })

  it("selects unprioritized tasks with none", () => {
    const index = indexWithPriorities()
    const result = index.listTasks({ priority: ["none"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Normal task",
    ])
  })

  it("combines named levels with none", () => {
    const index = indexWithPriorities()
    const result = index.listTasks({ priority: ["lowest", "none"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Normal task",
      "Lowest task",
    ])
  })
})

describe("listTasks scope filters", () => {
  it("scopes to a folder, excluding tasks outside it", () => {
    const index = indexWithBoardAndPlain()
    const result = index.listTasks({ folder: "Projects" }, logger)
    expect(result.tasks.map((entry) => entry.path)).toEqual([
      "Projects/board.md",
      "Projects/board.md",
    ])
  })

  it("treats a trailing slash on folder as equivalent", () => {
    const index = indexWithBoardAndPlain()
    const withSlash = index.listTasks({ folder: "Projects/" }, logger)
    const withoutSlash = index.listTasks({ folder: "Projects" }, logger)
    expect(withSlash).toEqual(withoutSlash)
  })

  it("treats LIKE wildcards in the folder as literal characters", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "Pro_ects/tasks.md",
        rawContent: "- [ ] Inside underscore folder",
        fileStat: testStat(1000),
      },
      logger,
    )
    // Without escaping, LIKE 'Pro_ects/%' would also match this note — the
    // "_" wildcard matches the "j" in "Projects".
    index.upsertNote(
      {
        filePath: "Projects/tasks.md",
        rawContent: "- [ ] Inside plain folder",
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({ folder: "Pro_ects" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Inside underscore folder",
    ])
  })

  it("filters by inline tag, excluding untagged tasks", () => {
    const index = indexWithBoardAndPlain()
    const result = index.listTasks({ tag: "errand" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Standalone task #errand",
    ])
  })

  it("matches nested child tags when filtering by the parent tag", () => {
    const index = indexWithBoardAndPlain()
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

  it("treats LIKE wildcards in the tag as literal characters when matching children", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "escape.md",
        rawContent: [
          "- [ ] Under task #a_b/x",
          // Without escaping, LIKE 'a_b/%' would also match this tag — the
          // "_" wildcard matches the "x" in "axb".
          "- [ ] Wildcard task #axb/x",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = index.listTasks({ tag: "a_b" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Under task #a_b/x",
    ])
  })

  it("filters by heading (Kanban lane), excluding other lanes", () => {
    const index = indexWithBoardAndPlain()
    const result = index.listTasks({ status: "all", heading: "Done" }, logger)
    // Created-only tasks sort DESC (newest first): Old idea (2026-06-02) before Ship release (2026-06-01).
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Old idea",
      "Ship release",
    ])
  })

  it("scopes to a single note by path", () => {
    const index = indexWithBoardAndPlain()
    const result = index.listTasks({ path: "Inbox/notes.md" }, logger)
    expect(result.tasks.map((entry) => entry.path)).toEqual([
      "Inbox/notes.md",
      "Inbox/notes.md",
    ])
  })

  it("rejects a path without the .md extension", () => {
    const index = createTestIndex()
    expect(() => index.listTasks({ path: "Inbox/notes" }, logger)).toThrow(
      'path must end in ".md" (received "Inbox/notes")',
    )
  })

  it("AND-combines folder, heading, and priority filters correctly", () => {
    const index = indexWithBoardAndPlain()
    const result = index.listTasks(
      { folder: "Projects", heading: "Active", priority: ["high"] },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Fix login bug",
    ])
  })
})

describe("listTasks sorting and paging", () => {
  const indexWithSortData = () => {
    const index = createTestIndex()
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
    return index
  }

  it("defaults to due ascending with dateless tasks last", () => {
    const index = indexWithSortData()
    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due first",
      "Due middle",
      "Due last",
      "No due date",
    ])
  })

  it("reverses date order with sortDirection desc, keeping dateless last", () => {
    const index = indexWithSortData()
    const result = index.listTasks({ sortDirection: "desc" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due last",
      "Due middle",
      "Due first",
      "No due date",
    ])
  })

  it("sorts by priority in the plugin's order with none between medium and low", () => {
    const index = indexWithSortData()
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
    const index = indexWithSortData()
    const result = index.listTasks({ sortBy: "note_mtime" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due middle",
      "Due last",
      "Due first",
      "No due date",
    ])
  })

  it("cascades dateless due tasks by scheduled → start → created before file position", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "cascade.md",
        rawContent: [
          "- [ ] Has due 📅 2026-07-01",
          "- [ ] Has scheduled only ⏳ 2026-07-10",
          "- [ ] Has start only 🛫 2026-07-05",
          "- [ ] Has created only ➕ 2026-06-01",
          "- [ ] Fully dateless",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Has due",
      "Has scheduled only",
      "Has start only",
      "Has created only",
      "Fully dateless",
    ])
  })

  it("breaks ties among fully dateless tasks by note mtime descending", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "old.md",
        rawContent: "- [ ] Old note task",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "new.md",
        rawContent: "- [ ] New note task",
        fileStat: testStat(5000),
      },
      logger,
    )
    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "New note task",
      "Old note task",
    ])
  })

  it("defaults start sort to descending (most recently started first)", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "starts.md",
        rawContent: [
          "- [ ] Started early 🛫 2026-06-01",
          "- [ ] Started late 🛫 2026-07-01",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks({ sortBy: "start" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Started late",
      "Started early",
    ])
  })

  it("defaults created sort to descending (most recently created first)", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "created.md",
        rawContent: [
          "- [ ] Created early ➕ 2026-06-01",
          "- [ ] Created late ➕ 2026-07-01",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks({ sortBy: "created" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Created late",
      "Created early",
    ])
  })

  it("limits results to the top of the sort order while total reports the full match count", () => {
    const index = indexWithSortData()
    const result = index.listTasks({ limit: 2 }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due first",
      "Due middle",
    ])
    expect(result.total).toBe(4)
  })

  it("clamps a negative limit to zero rows instead of SQLite's unlimited", () => {
    const index = indexWithSortData()
    const result = index.listTasks({ limit: -1 }, logger)
    expect(result.tasks).toEqual([])
    expect(result.total).toBe(4)
  })

  it("floors a fractional limit instead of failing with SQLite's datatype mismatch", () => {
    const index = indexWithSortData()
    const result = index.listTasks({ limit: 2.7 }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Due first",
      "Due middle",
    ])
    expect(result.total).toBe(4)
  })

  it("cascade uses each fallback field's own default direction when sort_direction is omitted", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "cascade-dir.md",
        rawContent: [
          "- [ ] Old created only ➕ 2026-01-15",
          "- [ ] New created only ➕ 2026-07-06",
          "- [ ] Has due 📅 2026-08-01 ➕ 2026-06-01",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // Default sort_by: "due", no explicit direction.
    // Due-dated tasks sort first (ASC — due's default).
    // Created-only tasks sort second, but DESC (created's default) — newest first.
    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Has due",
      "New created only",
      "Old created only",
    ])
  })

  it("explicit sort_direction overrides cascade to a uniform direction", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "cascade-explicit.md",
        rawContent: [
          "- [ ] Old created only ➕ 2026-01-15",
          "- [ ] New created only ➕ 2026-07-06",
          "- [ ] Has due 📅 2026-08-01 ➕ 2026-06-01",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // Explicit ASC overrides all cascade steps — created-only tasks sort ASC (oldest first).
    const result = index.listTasks({ sortDirection: "asc" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Has due",
      "Old created only",
      "New created only",
    ])
  })

  it("cascade direction applies to start fallback (DESC default) within a due cascade", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "start-cascade.md",
        rawContent: [
          "- [ ] Old start 🛫 2026-06-01",
          "- [ ] New start 🛫 2026-07-05",
          "- [ ] Has due 📅 2026-07-10",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // Due-dated first (ASC), then start-only tasks sort DESC (start's default) — newest first.
    const result = index.listTasks({}, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Has due",
      "New start",
      "Old start",
    ])
  })

  it("start cascade uses per-field defaults (both start and created default DESC)", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "start-sort.md",
        rawContent: [
          "- [ ] Has start 🛫 2026-07-01",
          "- [ ] Old created only ➕ 2026-01-01",
          "- [ ] New created only ➕ 2026-07-06",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // sort_by: "start" cascades to [due, scheduled, created].
    // start defaults DESC — most recently started first.
    // created also defaults DESC — newest created first.
    const result = index.listTasks({ sortBy: "start" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Has start",
      "New created only",
      "Old created only",
    ])
  })

  it("sorts by position (file path then line number) within a single note", () => {
    const index = createTestIndex()
    // Created dates intentionally disagree with line order — Second card is
    // newest, so a created-DESC fallback would produce [Second, First, Third],
    // proving the sort is genuinely by line number.
    index.upsertNote(
      {
        filePath: "board.md",
        rawContent: [
          "## Active",
          "- [ ] First card ➕ 2026-07-01",
          "- [ ] Second card ➕ 2026-07-06",
          "## Done",
          "- [x] Third card ➕ 2026-06-01 ✅ 2026-06-28",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks(
      { path: "board.md", status: "all", sortBy: "position" },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "First card",
      "Second card",
      "Third card",
    ])
  })

  it("position sort groups by file path across multiple notes", () => {
    const index = createTestIndex()
    // b-note has a higher mtime so the default due-cascade tiebreaker (mtime
    // DESC) would put it first — position ASC puts a-note first instead,
    // proving the sort is genuinely by path.
    index.upsertNote(
      {
        filePath: "b-note.md",
        rawContent: "- [ ] B task",
        fileStat: testStat(5000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "a-note.md",
        rawContent: "- [ ] A task",
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks({ sortBy: "position" }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "A task",
      "B task",
    ])
  })

  it("position sort with explicit desc reverses file and line order", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "board.md",
        rawContent: ["- [ ] First line", "- [ ] Second line"].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.listTasks(
      { path: "board.md", sortBy: "position", sortDirection: "desc" },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Second line",
      "First line",
    ])
  })

  it("position sort with heading filter returns lane tasks in file order", () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "kanban.md",
        rawContent: [
          "---",
          "kanban-plugin: board",
          "---",
          "## Active",
          "- [ ] Third priority ➕ 2026-07-01",
          "- [ ] First priority ➕ 2026-07-06",
          "- [ ] Second priority ➕ 2026-07-03",
          "## Done",
          "- [x] Completed ➕ 2026-06-01 ✅ 2026-06-28",
        ].join("\n"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // Position sort preserves the file order — the user arranged these cards intentionally.
    const result = index.listTasks(
      { heading: "Active", sortBy: "position" },
      logger,
    )
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Third priority",
      "First priority",
      "Second priority",
    ])
  })
})

describe("listTasks array params", () => {
  /** A Kanban board with four lanes for testing multi-heading filters. */
  const MULTI_LANE_BOARD = `---
kanban-plugin: board
---

## Active

- [/] Implement feature ➕ 2026-07-01

## Up Next

- [ ] Write docs ➕ 2026-07-02

## Waiting On

- [ ] Blocked on review ➕ 2026-07-03

## Someday

- [ ] Nice to have ➕ 2026-07-04
`

  const indexWithMultiLaneBoard = () => {
    const index = createTestIndex()
    index.upsertNote(
      {
        filePath: "Projects/board.md",
        rawContent: MULTI_LANE_BOARD,
        fileStat: testStat(1000),
      },
      logger,
    )
    return index
  }

  // ── heading array ──

  it("accepts a single-element heading array, equivalent to a scalar", () => {
    const index = indexWithMultiLaneBoard()
    const arrayResult = index.listTasks(
      { status: "all", heading: ["Active"] },
      logger,
    )
    const scalarResult = index.listTasks(
      { status: "all", heading: "Active" },
      logger,
    )
    expect(arrayResult).toEqual(scalarResult)
    expect(arrayResult.tasks).toHaveLength(1)
    expect(arrayResult.tasks[0]?.description).toBe("Implement feature")
  })

  it("returns tasks from multiple headings, excluding unselected lanes", () => {
    const index = indexWithMultiLaneBoard()
    const result = index.listTasks(
      { status: "all", heading: ["Active", "Up Next", "Waiting On"] },
      logger,
    )
    // Default sort is due ASC; all dateless, so cascade falls through to
    // created DESC (newest first): 07-03 → 07-02 → 07-01.
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Blocked on review",
      "Write docs",
      "Implement feature",
    ])
    expect(result.total).toBe(3)
  })

  it("excludes tasks under headings not in the array", () => {
    const index = indexWithMultiLaneBoard()
    const result = index.listTasks(
      { status: "all", heading: ["Active", "Up Next"] },
      logger,
    )
    // Exact match proves inclusion of Active + Up Next AND exclusion of
    // Someday + Waiting On — a vacuous empty result cannot satisfy this.
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Write docs",
      "Implement feature",
    ])
  })

  // ── status array ──

  it("accepts an array of real statuses, OR-combined", () => {
    const index = indexWithBoard()
    const result = index.listTasks({ status: ["done", "cancelled"] }, logger)
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Old idea",
      "Ship release",
    ])
  })

  it("treats a single-element status array as equivalent to the scalar", () => {
    const index = indexWithBoard()
    const arrayResult = index.listTasks({ status: ["todo"] }, logger)
    const scalarResult = index.listTasks({ status: "todo" }, logger)
    expect(arrayResult).toEqual(scalarResult)
  })

  it("expands not_done in an array to todo + in_progress", () => {
    const index = indexWithBoard()
    const result = index.listTasks({ status: ["not_done", "done"] }, logger)
    // Exact ordered match: due ASC puts Fix login bug first (due 2026-07-01),
    // then dateless tasks cascade through related dates.
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Fix login bug",
      "Write tests",
      "Ship release",
    ])
  })

  it("deduplicates when not_done overlaps with an explicit status", () => {
    const index = indexWithBoard()
    const result = index.listTasks({ status: ["not_done", "todo"] }, logger)
    // not_done expands to todo + in_progress; the explicit "todo" is a duplicate
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Fix login bug",
      "Write tests",
    ])
  })

  it("treats all in an array as a no-filter, returning every status", () => {
    const index = indexWithBoard()
    const arrayResult = index.listTasks({ status: ["all"] }, logger)
    const scalarResult = index.listTasks({ status: "all" }, logger)
    expect(arrayResult).toEqual(scalarResult)
    expect(arrayResult.tasks).toHaveLength(4)
  })

  it("matches explicit real statuses equivalent to not_done", () => {
    const index = indexWithBoard()
    const arrayResult = index.listTasks(
      { status: ["todo", "in_progress"] },
      logger,
    )
    const defaultResult = index.listTasks({}, logger)
    expect(arrayResult).toEqual(defaultResult)
  })

  // ── combined array filters ──

  it("AND-combines heading array with status array", () => {
    const index = indexWithMultiLaneBoard()
    const result = index.listTasks(
      { heading: ["Active", "Someday"], status: ["todo"] },
      logger,
    )
    // Only "Nice to have" is todo under Active or Someday;
    // "Implement feature" is in_progress so excluded by status filter
    expect(result.tasks.map((entry) => entry.description)).toEqual([
      "Nice to have",
    ])
  })
})
