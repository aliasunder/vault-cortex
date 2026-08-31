import { describe, it, expect } from "vitest"
import { tasks, type ParsedTask, type TaskFormatConfig } from "../tasks.js"

/** Default emoji format config for mutation tests. */
const EMOJI_CONFIG: TaskFormatConfig = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
}

/** Dataview format config for format-specific tests. */
const DATAVIEW_CONFIG: TaskFormatConfig = {
  taskFormat: "dataview",
  setDoneDate: true,
  setCancelledDate: true,
}

/** Builds a full ParsedTask from overrides so assertions compare whole
 *  objects — any unexpected field change fails the test. */
const task = (overrides: Partial<ParsedTask>): ParsedTask => ({
  line: 1,
  statusChar: " ",
  status: "todo",
  description: "",
  createdDate: null,
  scheduledDate: null,
  startDate: null,
  dueDate: null,
  doneDate: null,
  cancelledDate: null,
  priority: null,
  recurrence: null,
  onCompletion: null,
  taskId: null,
  dependsOn: [],
  tags: [],
  blockId: null,
  heading: null,
  depth: 0,
  parentLine: null,
  ...overrides,
})

describe("tasks.extractTasks", () => {
  describe("task-line detection", () => {
    const detectedScenarios = [
      { name: "dash list marker", line: "- [ ] Buy milk" },
      { name: "asterisk list marker", line: "* [ ] Buy milk" },
      { name: "plus list marker", line: "+ [ ] Buy milk" },
      { name: "numbered marker with dot", line: "1. [ ] Buy milk" },
      { name: "numbered marker with paren", line: "42) [ ] Buy milk" },
      { name: "indented sub-task (spaces)", line: "    - [ ] Buy milk" },
      { name: "indented sub-task (tab)", line: "\t- [ ] Buy milk" },
      { name: "blockquote prefix", line: "> - [ ] Buy milk" },
      { name: "nested callout prefix", line: "> > - [ ] Buy milk" },
    ]

    it.each(detectedScenarios)("detects a task line with $name", ({ line }) => {
      const extracted = tasks.extractTasks(line)
      expect(extracted).toEqual([task({ description: "Buy milk" })])
    })

    const ignoredScenarios = [
      { name: "a plain list item without a checkbox", line: "- Buy milk" },
      { name: "no space between marker and checkbox", line: "-[ ] Buy milk" },
      { name: "empty brackets (no status character)", line: "- [] Buy milk" },
      { name: "two characters inside the brackets", line: "- [xx] Buy milk" },
      { name: "plain prose", line: "Buy milk [ ] someday" },
      { name: "a heading", line: "## Buy milk" },
    ]

    it.each(ignoredScenarios)("ignores $name", ({ line }) => {
      const extracted = tasks.extractTasks(line)
      expect(extracted).toEqual([])
    })

    it("allows an empty description", () => {
      const extracted = tasks.extractTasks("- [ ] ")
      expect(extracted).toEqual([task({ description: "" })])
    })
  })

  describe("status mapping", () => {
    const statusScenarios = [
      { char: " ", status: "todo" },
      { char: "x", status: "done" },
      { char: "X", status: "done" },
      { char: "/", status: "in_progress" },
      { char: "-", status: "cancelled" },
      // Unknown symbols are TODO — the plugin's unknown-symbol behavior.
      { char: ">", status: "todo" },
      { char: "?", status: "todo" },
      { char: "!", status: "todo" },
    ] as const

    it.each(statusScenarios)(
      "maps status char “$char” to $status",
      ({ char, status }) => {
        const extracted = tasks.extractTasks(`- [${char}] Task`)
        expect(extracted).toEqual([
          task({ statusChar: char, status, description: "Task" }),
        ])
      },
    )
  })

  describe("emoji date fields", () => {
    const dateScenarios = [
      {
        name: "created ➕",
        line: "- [ ] T ➕ 2026-07-01",
        field: { createdDate: "2026-07-01" },
      },
      {
        name: "scheduled ⏳",
        line: "- [ ] T ⏳ 2026-07-02",
        field: { scheduledDate: "2026-07-02" },
      },
      {
        name: "scheduled ⌛ variant",
        line: "- [ ] T ⌛ 2026-07-02",
        field: { scheduledDate: "2026-07-02" },
      },
      {
        name: "start 🛫",
        line: "- [ ] T 🛫 2026-07-03",
        field: { startDate: "2026-07-03" },
      },
      {
        name: "due 📅",
        line: "- [ ] T 📅 2026-07-04",
        field: { dueDate: "2026-07-04" },
      },
      {
        name: "due 📆 variant",
        line: "- [ ] T 📆 2026-07-04",
        field: { dueDate: "2026-07-04" },
      },
      {
        name: "due 🗓 variant",
        line: "- [ ] T 🗓 2026-07-04",
        field: { dueDate: "2026-07-04" },
      },
      {
        name: "done ✅",
        line: "- [x] T ✅ 2026-07-05",
        field: {
          statusChar: "x",
          status: "done" as const,
          doneDate: "2026-07-05",
        },
      },
      {
        name: "cancelled ❌",
        line: "- [-] T ❌ 2026-07-06",
        field: {
          statusChar: "-",
          status: "cancelled" as const,
          cancelledDate: "2026-07-06",
        },
      },
    ]

    it.each(dateScenarios)("parses $name", ({ line, field }) => {
      const extracted = tasks.extractTasks(line)
      expect(extracted).toEqual([task({ description: "T", ...field })])
    })

    it("tolerates a variant selector (U+FE0F) after the emoji", () => {
      const extracted = tasks.extractTasks("- [ ] T 🗓️ 2026-07-04")
      expect(extracted).toEqual([
        task({ description: "T", dueDate: "2026-07-04" }),
      ])
    })

    it("parses all six dates on one line regardless of order", () => {
      const extracted = tasks.extractTasks(
        "- [x] T 📅 2026-07-04 ➕ 2026-07-01 ✅ 2026-07-05 🛫 2026-07-03 ❌ 2026-07-06 ⏳ 2026-07-02",
      )
      expect(extracted).toEqual([
        task({
          statusChar: "x",
          status: "done",
          description: "T",
          createdDate: "2026-07-01",
          scheduledDate: "2026-07-02",
          startDate: "2026-07-03",
          dueDate: "2026-07-04",
          doneDate: "2026-07-05",
          cancelledDate: "2026-07-06",
        }),
      ])
    })

    it("does not parse a non-ISO date", () => {
      const extracted = tasks.extractTasks("- [ ] T 📅 01/02/2026")
      expect(extracted).toEqual([task({ description: "T 📅 01/02/2026" })])
    })

    it("strips a calendar-invalid emoji date but parses it as null", () => {
      const extracted = tasks.extractTasks("- [ ] T 📅 2026-99-99")
      expect(extracted).toEqual([task({ description: "T" })])
    })

    it("strips a calendar-invalid dataview date but parses it as null", () => {
      const extracted = tasks.extractTasks("- [ ] T [due:: 2026-02-30]")
      expect(extracted).toEqual([task({ description: "T" })])
    })

    it("keeps a leap-day date that is calendar-valid", () => {
      const extracted = tasks.extractTasks("- [ ] T 📅 2028-02-29")
      expect(extracted).toEqual([
        task({ description: "T", dueDate: "2028-02-29" }),
      ])
    })
  })

  describe("dataview inline fields", () => {
    const dataviewScenarios = [
      {
        name: "created",
        line: "- [ ] T [created:: 2026-07-01]",
        field: { createdDate: "2026-07-01" },
      },
      {
        name: "scheduled",
        line: "- [ ] T [scheduled:: 2026-07-02]",
        field: { scheduledDate: "2026-07-02" },
      },
      {
        name: "start",
        line: "- [ ] T [start:: 2026-07-03]",
        field: { startDate: "2026-07-03" },
      },
      {
        name: "due",
        line: "- [ ] T [due:: 2026-07-04]",
        field: { dueDate: "2026-07-04" },
      },
      {
        name: "completion (not done::)",
        line: "- [x] T [completion:: 2026-07-05]",
        field: {
          statusChar: "x",
          status: "done" as const,
          doneDate: "2026-07-05",
        },
      },
      {
        name: "cancelled",
        line: "- [-] T [cancelled:: 2026-07-06]",
        field: {
          statusChar: "-",
          status: "cancelled" as const,
          cancelledDate: "2026-07-06",
        },
      },
      {
        name: "priority word",
        line: "- [ ] T [priority:: high]",
        field: { priority: "high" as const },
      },
      {
        name: "repeat (not recurrence::)",
        line: "- [ ] T [repeat:: every week]",
        field: { recurrence: "every week" },
      },
      {
        name: "onCompletion",
        line: "- [x] T [onCompletion:: delete]",
        field: {
          statusChar: "x",
          status: "done" as const,
          onCompletion: "delete",
        },
      },
      {
        name: "id",
        line: "- [ ] T [id:: abc-123]",
        field: { taskId: "abc-123" },
      },
      {
        name: "dependsOn",
        line: "- [ ] T [dependsOn:: a1, b2]",
        field: { dependsOn: ["a1", "b2"] },
      },
    ]

    it.each(dataviewScenarios)("parses [$name:: ...]", ({ line, field }) => {
      const extracted = tasks.extractTasks(line)
      expect(extracted).toEqual([task({ description: "T", ...field })])
    })

    it("parses the parenthesized field form (due:: ...)", () => {
      const extracted = tasks.extractTasks("- [ ] T (due:: 2026-07-04)")
      expect(extracted).toEqual([
        task({ description: "T", dueDate: "2026-07-04" }),
      ])
    })

    it("tolerates a trailing comma after a bracketed field", () => {
      const extracted = tasks.extractTasks(
        "- [ ] T [due:: 2026-07-04] [priority:: high],",
      )
      expect(extracted).toEqual([
        task({ description: "T", dueDate: "2026-07-04", priority: "high" }),
      ])
    })

    it("does not parse a capitalized priority word (the plugin is lowercase-only)", () => {
      const extracted = tasks.extractTasks("- [ ] T [priority:: High]")
      expect(extracted).toEqual([task({ description: "T [priority:: High]" })])
    })

    it("does not parse mismatched brackets", () => {
      const extracted = tasks.extractTasks("- [ ] T [due:: 2026-07-04)")
      expect(extracted).toEqual([task({ description: "T [due:: 2026-07-04)" })])
    })

    it("mixes emoji and dataview fields on the same line", () => {
      const extracted = tasks.extractTasks(
        "- [ ] T [due:: 2026-07-04] ➕ 2026-07-01",
      )
      expect(extracted).toEqual([
        task({
          description: "T",
          dueDate: "2026-07-04",
          createdDate: "2026-07-01",
        }),
      ])
    })
  })

  describe("priority", () => {
    const priorityScenarios = [
      { emoji: "🔺", priority: "highest" },
      { emoji: "⏫", priority: "high" },
      { emoji: "🔼", priority: "medium" },
      { emoji: "🔽", priority: "low" },
      { emoji: "⏬", priority: "lowest" },
    ] as const

    it.each(priorityScenarios)(
      "maps $emoji to $priority",
      ({ emoji, priority }) => {
        const extracted = tasks.extractTasks(`- [ ] T ${emoji}`)
        expect(extracted).toEqual([task({ description: "T", priority })])
      },
    )

    it("leaves priority null when no signifier is present", () => {
      const extracted = tasks.extractTasks("- [ ] T")
      expect(extracted).toEqual([task({ description: "T" })])
    })

    it("parses priority placed before dates (canonical write order)", () => {
      const extracted = tasks.extractTasks(
        "- [ ] T ⏫ ➕ 2026-07-01 📅 2026-07-10",
      )
      expect(extracted).toEqual([
        task({
          description: "T",
          priority: "high",
          createdDate: "2026-07-01",
          dueDate: "2026-07-10",
        }),
      ])
    })
  })

  describe("recurrence, onCompletion, dependencies", () => {
    it("stores the recurrence rule text verbatim, including a 'when done' suffix", () => {
      const extracted = tasks.extractTasks(
        "- [ ] Weekly review 🔁 every week on Friday when done 📅 2026-07-10",
      )
      expect(extracted).toEqual([
        task({
          description: "Weekly review",
          recurrence: "every week on Friday when done",
          dueDate: "2026-07-10",
        }),
      ])
    })

    it("parses 🏁 onCompletion so it does not block fields to its left", () => {
      const extracted = tasks.extractTasks("- [x] T ✅ 2026-07-05 🏁 delete")
      expect(extracted).toEqual([
        task({
          statusChar: "x",
          status: "done",
          description: "T",
          doneDate: "2026-07-05",
          onCompletion: "delete",
        }),
      ])
    })

    it("parses 🆔 id and ⛔ dependsOn with spaces around commas", () => {
      const extracted = tasks.extractTasks(
        "- [ ] Build API ⛔ db-setup , cache-setup 🆔 api-build",
      )
      expect(extracted).toEqual([
        task({
          description: "Build API",
          taskId: "api-build",
          dependsOn: ["db-setup", "cache-setup"],
        }),
      ])
    })
  })

  describe("block IDs", () => {
    it("captures a block ID and strips it from the description", () => {
      const extracted = tasks.extractTasks("- [ ] Fix login ^fix-login")
      expect(extracted).toEqual([
        task({ description: "Fix login", blockId: "fix-login" }),
      ])
    })

    it("parses a block ID placed after emoji metadata (canonical card format)", () => {
      const extracted = tasks.extractTasks(
        "- [x] Ship release ⏫ ➕ 2026-05-04 ✅ 2026-05-08 ^ship-release",
      )
      expect(extracted).toEqual([
        task({
          statusChar: "x",
          status: "done",
          description: "Ship release",
          priority: "high",
          createdDate: "2026-05-04",
          doneDate: "2026-05-08",
          blockId: "ship-release",
        }),
      ])
    })
  })

  describe("inline tags", () => {
    it("keeps tags interleaved with signifiers in the description and extracts them bare", () => {
      const extracted = tasks.extractTasks(
        "- [ ] Do something #tag1 📅 2026-07-04 #tag2",
      )
      expect(extracted).toEqual([
        task({
          description: "Do something #tag1 #tag2",
          dueDate: "2026-07-04",
          tags: ["tag1", "tag2"],
        }),
      ])
    })

    it("extracts nested tags with their slash segments", () => {
      const extracted = tasks.extractTasks("- [ ] T #project/vault-cortex")
      expect(extracted).toEqual([
        task({
          description: "T #project/vault-cortex",
          tags: ["project/vault-cortex"],
        }),
      ])
    })

    it("deduplicates repeated tags", () => {
      const extracted = tasks.extractTasks("- [ ] T #a mid #a")
      expect(extracted).toEqual([
        task({ description: "T #a mid #a", tags: ["a"] }),
      ])
    })
  })

  describe("backward-scan stop rule", () => {
    it("ignores metadata when unrecognized text follows it", () => {
      const extracted = tasks.extractTasks(
        "- [ ] Fix bug 📅 2026-02-01 some note",
      )
      expect(extracted).toEqual([
        task({ description: "Fix bug 📅 2026-02-01 some note" }),
      ])
    })

    it("leaves a mid-description dataview-looking field in the description", () => {
      const extracted = tasks.extractTasks(
        "- [ ] Try [due:: 2026-07-04] tomorrow",
      )
      expect(extracted).toEqual([
        task({ description: "Try [due:: 2026-07-04] tomorrow" }),
      ])
    })
  })

  describe("code fences and frontmatter", () => {
    it("excludes task lines inside a fenced code block", () => {
      const content = [
        "- [ ] Real task",
        "```",
        "- [ ] Not a task, just example code",
        "```",
        "- [ ] Another real task",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 1, description: "Real task" }),
        task({ line: 5, description: "Another real task" }),
      ])
    })

    it("excludes task lines inside a tilde fence", () => {
      const content = ["~~~", "- [ ] Hidden", "~~~"].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([])
    })

    it("skips frontmatter and reports file-relative 1-based line numbers", () => {
      const content = [
        "---",
        "title: Board",
        "tags: [kanban]",
        "---",
        "",
        "- [ ] First task",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([task({ line: 6, description: "First task" })])
    })

    it("does not extract checkbox-shaped lines inside frontmatter", () => {
      const content = [
        "---",
        "note: '- [ ] not a task'",
        "---",
        "- [ ] Real task",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([task({ line: 4, description: "Real task" })])
    })

    it("treats an unclosed leading --- as body, not frontmatter", () => {
      const content = ["---", "- [ ] Task under a horizontal rule"].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 2, description: "Task under a horizontal rule" }),
      ])
    })

    it("excludes task lines inside a fenced code block within a callout", () => {
      const content = [
        "> [!info] Example",
        "> ```",
        "> - [ ] not really a task",
        "> ```",
        "> - [ ] Real callout task",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 5, description: "Real callout task" }),
      ])
    })

    it("still extracts real tasks inside callouts without fences", () => {
      const content = [
        "> [!todo] Board",
        "> - [ ] Buy milk",
        "> - [x] Walk dog",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 2, description: "Buy milk" }),
        task({
          line: 3,
          statusChar: "x",
          status: "done",
          description: "Walk dog",
        }),
      ])
    })

    it("extracts tasks after a blockquote-scoped fence implicitly closes", () => {
      const content = [
        "> ```",
        "> - [ ] hidden in fence",
        "- [ ] visible after blockquote ends",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 3, description: "visible after blockquote ends" }),
      ])
    })

    it("excludes task lines inside a tilde fenced code block within a callout", () => {
      const content = [
        "> [!info] Example",
        "> ~~~",
        "> - [ ] not really a task",
        "> ~~~",
        "> - [ ] Real tilde callout task",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 5, description: "Real tilde callout task" }),
      ])
    })

    it("excludes task lines inside a depth-2 fence that implicitly closes", () => {
      const content = [
        "> [!info] Example",
        "> > ```",
        "> > - [ ] nested task hidden in fence",
        "> Back to depth 1, fence implicitly closed",
        "> - [ ] Task after nested fence",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 5, description: "Task after nested fence" }),
      ])
    })
  })

  describe("comment blocks", () => {
    it("excludes task lines inside a %% %% comment block", () => {
      const content = [
        "- [ ] Visible task",
        "%%",
        "- [ ] Hidden task",
        "%%",
        "- [ ] Another visible task",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 1, description: "Visible task" }),
        task({ line: 5, description: "Another visible task" }),
      ])
    })

    it("excludes a single-line inline comment containing a task", () => {
      const content = [
        "- [ ] Visible task",
        "%% - [ ] Hidden inline task %%",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 1, description: "Visible task" }),
      ])
    })

    it("skips all tasks after an unclosed comment running to EOF", () => {
      const content = [
        "- [ ] Visible task",
        "%%",
        "- [ ] Hidden by unclosed comment",
        "- [ ] Also hidden",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 1, description: "Visible task" }),
      ])
    })

    it("does not open a fence inside a comment block", () => {
      const content = [
        "%%",
        "```",
        "- [ ] Hidden inside comment, fence is just text",
        "```",
        "%%",
        "- [ ] Visible after comment closes",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 6, description: "Visible after comment closes" }),
      ])
    })

    it("does not toggle comment state inside a fenced code block", () => {
      const content = [
        "```",
        "%%",
        "- [ ] Inside fence, %% is just text",
        "%%",
        "```",
        "- [ ] Visible after fence closes",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 6, description: "Visible after fence closes" }),
      ])
    })

    it("does not toggle on mid-line %% in card text", () => {
      const content = ["- [ ] Card with 100%% off", "- [ ] Another card"].join(
        "\n",
      )
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 1, description: "Card with 100%% off" }),
        task({ line: 2, description: "Another card" }),
      ])
    })

    it("attributes tasks after a comment block to the heading before it", () => {
      const content = [
        "## Active",
        "- [ ] Active task",
        "%%",
        "## Hidden Heading",
        "- [ ] Hidden task",
        "%%",
        "- [ ] Still under Active",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 2, description: "Active task", heading: "Active" }),
        task({ line: 7, description: "Still under Active", heading: "Active" }),
      ])
    })
  })

  describe("heading attribution", () => {
    it("attributes each task to the nearest heading above it", () => {
      const content = [
        "- [ ] Orphan task",
        "",
        "## Active",
        "",
        "- [ ] Card in Active",
        "",
        "## Done",
        "",
        "- [x] Card in Done ✅ 2026-07-01",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 1, description: "Orphan task" }),
        task({ line: 5, description: "Card in Active", heading: "Active" }),
        task({
          line: 9,
          statusChar: "x",
          status: "done",
          description: "Card in Done",
          doneDate: "2026-07-01",
          heading: "Done",
        }),
      ])
    })

    it("uses the nearest heading regardless of level", () => {
      const content = ["## Lane", "### Sub-section", "- [ ] Task"].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({ line: 3, description: "Task", heading: "Sub-section" }),
      ])
    })

    it("accounts for frontmatter when matching headings to tasks", () => {
      const content = [
        "---",
        "kanban-plugin: board",
        "---",
        "",
        "## Up Next",
        "",
        "- [ ] Card ➕ 2026-07-01 ^card-id",
      ].join("\n")
      const extracted = tasks.extractTasks(content)
      expect(extracted).toEqual([
        task({
          line: 7,
          description: "Card",
          createdDate: "2026-07-01",
          blockId: "card-id",
          heading: "Up Next",
        }),
      ])
    })
  })
})

// ── Task-line mutation tests ────────────────────────────────────

import { parseHeadings } from "../headings.js"

describe("task line mutations", () => {
  describe("charForStatus", () => {
    it("maps todo to space", () => {
      expect(tasks.charForStatus("todo")).toBe(" ")
    })

    it("maps in_progress to slash", () => {
      expect(tasks.charForStatus("in_progress")).toBe("/")
    })

    it("maps done to x", () => {
      expect(tasks.charForStatus("done")).toBe("x")
    })

    it("maps cancelled to dash", () => {
      expect(tasks.charForStatus("cancelled")).toBe("-")
    })
  })

  describe("emojiForPriority", () => {
    it("maps highest to 🔺", () => {
      expect(tasks.emojiForPriority("highest")).toBe("🔺")
    })

    it("maps high to ⏫", () => {
      expect(tasks.emojiForPriority("high")).toBe("⏫")
    })

    it("maps medium to 🔼", () => {
      expect(tasks.emojiForPriority("medium")).toBe("🔼")
    })

    it("maps low to 🔽", () => {
      expect(tasks.emojiForPriority("low")).toBe("🔽")
    })

    it("maps lowest to ⏬", () => {
      expect(tasks.emojiForPriority("lowest")).toBe("⏬")
    })
  })

  describe("isTaskLine", () => {
    it("returns true for a standard task line", () => {
      expect(tasks.isTaskLine("- [ ] Do something")).toBe(true)
    })

    it("returns true for a done task", () => {
      expect(tasks.isTaskLine("- [x] Done thing ✅ 2026-07-12")).toBe(true)
    })

    it("returns false for a plain list item", () => {
      expect(tasks.isTaskLine("- Not a task")).toBe(false)
    })

    it("returns false for a heading", () => {
      expect(tasks.isTaskLine("## Active")).toBe(false)
    })

    it("returns false for an empty string", () => {
      expect(tasks.isTaskLine("")).toBe(false)
    })
  })

  describe("updateTaskLineStatus", () => {
    it("un-completing strips only the real done date, never a date-like phrase in the description", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine:
          "- [x] Shipped ✅ 2026-07-01 in the notes ➕ 2026-07-01 ✅ 2026-07-12",
        newStatus: "todo",
        today: "2026-07-13",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] Shipped ✅ 2026-07-01 in the notes ➕ 2026-07-01",
      )
    })

    it("marks a todo task as done with a done date", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Fix the bug ➕ 2026-07-01",
        newStatus: "done",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [x] Fix the bug ➕ 2026-07-01 ✅ 2026-07-12")
    })

    it("marks a todo task as cancelled with a cancelled date", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Dropped feature ➕ 2026-07-01",
        newStatus: "cancelled",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [-] Dropped feature ➕ 2026-07-01 ❌ 2026-07-12")
    })

    it("marks an in-progress task as done", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [/] In-progress task ➕ 2026-07-01",
        newStatus: "done",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [x] In-progress task ➕ 2026-07-01 ✅ 2026-07-12")
    })

    it("un-completes a done task by removing the done date", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [x] Was done ➕ 2026-07-01 ✅ 2026-07-10",
        newStatus: "todo",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Was done ➕ 2026-07-01")
    })

    it("switches from done to cancelled: removes done date, adds cancelled date", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [x] Changed my mind ➕ 2026-07-01 ✅ 2026-07-10",
        newStatus: "cancelled",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [-] Changed my mind ➕ 2026-07-01 ❌ 2026-07-12")
    })

    it("switches from cancelled to in_progress: removes cancelled date", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [-] Revived task ➕ 2026-07-01 ❌ 2026-07-10",
        newStatus: "in_progress",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [/] Revived task ➕ 2026-07-01")
    })

    it("re-stamps an existing done date with today", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [x] Old completion ✅ 2026-06-01",
        newStatus: "done",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [x] Old completion ✅ 2026-07-12")
    })

    it("inserts the done date before a block ID", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Task with ID ➕ 2026-07-01 ^my-task",
        newStatus: "done",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [x] Task with ID ➕ 2026-07-01 ✅ 2026-07-12 ^my-task",
      )
    })

    it("preserves priority and created date when completing", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Prioritized ⏫ ➕ 2026-07-01 📅 2026-07-20",
        newStatus: "done",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [x] Prioritized ⏫ ➕ 2026-07-01 📅 2026-07-20 ✅ 2026-07-12",
      )
    })

    it("handles a bare task with no metadata", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Simple task",
        newStatus: "done",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [x] Simple task ✅ 2026-07-12")
    })

    it("strips a Dataview done date when un-completing", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [x] Task [completion:: 2026-07-10]",
        newStatus: "todo",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task")
    })

    it("strips a Dataview cancelled date when reverting to todo", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [-] Task [cancelled:: 2026-07-10]",
        newStatus: "todo",
        today: "2026-07-12",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task")
    })

    it("writes done date in Dataview format when configured", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Task [created:: 2026-07-01]",
        newStatus: "done",
        today: "2026-07-12",
        config: DATAVIEW_CONFIG,
      })
      expect(result).toBe(
        "- [x] Task [created:: 2026-07-01] [completion:: 2026-07-12]",
      )
    })

    it("skips done date when setDoneDate is false", () => {
      const noDoneDateConfig: TaskFormatConfig = {
        taskFormat: "emoji",
        setDoneDate: false,
        setCancelledDate: true,
      }
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Task ➕ 2026-07-01",
        newStatus: "done",
        today: "2026-07-12",
        config: noDoneDateConfig,
      })
      expect(result).toBe("- [x] Task ➕ 2026-07-01")
    })

    it("skips cancelled date when setCancelledDate is false", () => {
      const noCancelledDateConfig: TaskFormatConfig = {
        taskFormat: "emoji",
        setDoneDate: true,
        setCancelledDate: false,
      }
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Task ➕ 2026-07-01",
        newStatus: "cancelled",
        today: "2026-07-12",
        config: noCancelledDateConfig,
      })
      expect(result).toBe("- [-] Task ➕ 2026-07-01")
    })

    it("writes cancelled date in Dataview format when configured", () => {
      const result = tasks.updateTaskLineStatus({
        taskLine: "- [ ] Task [created:: 2026-07-01]",
        newStatus: "cancelled",
        today: "2026-07-12",
        config: DATAVIEW_CONFIG,
      })
      expect(result).toBe(
        "- [-] Task [created:: 2026-07-01] [cancelled:: 2026-07-12]",
      )
    })
  })

  describe("updateTaskLinePriority", () => {
    it("adds priority to a task with none, before the first date signifier", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Task ➕ 2026-07-01",
        newPriority: "high",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task ⏫ ➕ 2026-07-01")
    })

    it("replaces an existing priority emoji", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Task ⏫ ➕ 2026-07-01",
        newPriority: "lowest",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task ⏬ ➕ 2026-07-01")
    })

    it("removes priority when null is passed", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Task ⏫ ➕ 2026-07-01",
        newPriority: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task ➕ 2026-07-01")
    })

    it("returns the line unchanged when removing priority that does not exist", () => {
      const line = "- [ ] No priority task ➕ 2026-07-01"
      const result = tasks.updateTaskLinePriority({
        taskLine: line,
        newPriority: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(line)
    })

    it("inserts priority before block ID when no date signifiers exist", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Just a task ^my-id",
        newPriority: "medium",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Just a task 🔼 ^my-id")
    })

    it("appends priority at end when no date signifiers or block ID", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Bare task",
        newPriority: "highest",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Bare task 🔺")
    })

    it("inserts priority after a description that uses a priority emoji as prose", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Prefer 🔼 arrows in docs 📅 2026-09-15",
        newPriority: "high",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Prefer 🔼 arrows in docs ⏫ 📅 2026-09-15")
    })

    it("removes only the metadata priority, leaving a prose emoji intact", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Prefer 🔼 arrows in docs ⏫ 📅 2026-09-15",
        newPriority: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Prefer 🔼 arrows in docs 📅 2026-09-15")
    })

    it("strips a Dataview priority field", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Task [priority:: high] [created:: 2026-07-01]",
        newPriority: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task [created:: 2026-07-01]")
    })

    it("replaces a Dataview priority with emoji when format is emoji", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Task [priority:: high] ➕ 2026-07-01",
        newPriority: "low",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] Task 🔽 ➕ 2026-07-01")
    })

    it("writes priority in Dataview format when configured", () => {
      const result = tasks.updateTaskLinePriority({
        taskLine: "- [ ] Task ➕ 2026-07-01",
        newPriority: "high",
        config: DATAVIEW_CONFIG,
      })
      expect(result).toBe("- [ ] Task [priority:: high] ➕ 2026-07-01")
    })
  })

  describe("findTaskByBlockId", () => {
    it("finds a task line by its block ID suffix", () => {
      const lines = [
        "## Active",
        "",
        "- [ ] First task ➕ 2026-07-01 ^first-task",
        "- [ ] Second task ➕ 2026-07-02 ^second-task",
      ]
      const result = tasks.findTaskByBlockId(lines, "second-task")
      expect(result).toBe(3)
    })

    it("returns null when no task line matches the block ID", () => {
      const lines = ["## Active", "- [ ] Task ➕ 2026-07-01 ^existing-id"]
      const result = tasks.findTaskByBlockId(lines, "nonexistent-id")
      expect(result).toBeNull()
    })

    it("does not match a heading with a block ID", () => {
      const lines = ["## Heading ^heading-id", "- [ ] Real task ^task-id"]
      const result = tasks.findTaskByBlockId(lines, "heading-id")
      expect(result).toBeNull()
    })

    it("returns the first matching task when multiple lines end with the same block ID", () => {
      const lines = ["- [ ] First ^dup-id", "- [ ] Second ^dup-id"]
      const result = tasks.findTaskByBlockId(lines, "dup-id")
      expect(result).toBe(0)
    })
  })

  describe("extractDoneLanes", () => {
    it("detects a lane with a **Complete** marker", () => {
      const bodyLines = [
        "## Active",
        "",
        "- [ ] Task A",
        "",
        "## Done",
        "",
        "**Complete**",
        "- [x] Task B ✅ 2026-07-01",
      ]
      const headings = parseHeadings(bodyLines)
      const result = tasks.extractDoneLanes(bodyLines, headings)
      expect(result).toEqual(["Done"])
    })

    it("returns an empty array when no markers exist", () => {
      const bodyLines = [
        "## Active",
        "",
        "- [ ] Task A",
        "",
        "## Done",
        "",
        "- [x] Task B ✅ 2026-07-01",
      ]
      const headings = parseHeadings(bodyLines)
      const result = tasks.extractDoneLanes(bodyLines, headings)
      expect(result).toEqual([])
    })

    it("detects multiple marked lanes", () => {
      const bodyLines = [
        "## Done",
        "**Complete**",
        "- [x] Task A",
        "",
        "## Cancelled",
        "**Complete**",
        "- [-] Task B",
      ]
      const headings = parseHeadings(bodyLines)
      const result = tasks.extractDoneLanes(bodyLines, headings)
      expect(result).toEqual(["Done", "Cancelled"])
    })

    it("skips blank lines between heading and marker", () => {
      const bodyLines = ["## Done", "", "", "**Complete**", "- [x] Task"]
      const headings = parseHeadings(bodyLines)
      const result = tasks.extractDoneLanes(bodyLines, headings)
      expect(result).toEqual(["Done"])
    })

    it("does not detect a marker that is not the first content after the heading", () => {
      const bodyLines = ["## Done", "- [x] Task comes first", "**Complete**"]
      const headings = parseHeadings(bodyLines)
      const result = tasks.extractDoneLanes(bodyLines, headings)
      expect(result).toEqual([])
    })

    it("does not detect a marker on an empty lane (heading with no body)", () => {
      const bodyLines = ["## Active", "", "## Done"]
      const headings = parseHeadings(bodyLines)
      const result = tasks.extractDoneLanes(bodyLines, headings)
      expect(result).toEqual([])
    })
  })

  // ── getTaskIndent ──────────────────────────────────────────────

  describe("getTaskIndent", () => {
    it("returns 0 for a top-level task", () => {
      expect(tasks.getTaskIndent("- [ ] Top level")).toBe(0)
    })

    it("returns 2 for a 2-space indented sub-task", () => {
      expect(tasks.getTaskIndent("  - [ ] Sub-task")).toBe(2)
    })

    it("returns 4 for a 4-space indented sub-task", () => {
      expect(tasks.getTaskIndent("    - [ ] Deep sub-task")).toBe(4)
    })

    it("returns tab width for tab-indented sub-task", () => {
      expect(tasks.getTaskIndent("\t- [ ] Tab sub-task")).toBe(1)
    })

    it("strips blockquote markers before measuring", () => {
      expect(tasks.getTaskIndent("> - [ ] Blockquoted top")).toBe(0)
    })

    it("strips nested blockquote markers", () => {
      expect(tasks.getTaskIndent("> > - [ ] Nested blockquote")).toBe(0)
    })

    it("measures indent after blockquote markers", () => {
      expect(tasks.getTaskIndent(">   - [ ] Indented in blockquote")).toBe(2)
    })
  })

  // ── replaceTaskLineDescription ────────────────────────────────

  describe("replaceTaskLineDescription", () => {
    it("replaces description before metadata signifiers", () => {
      const line = "- [ ] Old description ⏫ ➕ 2026-08-01 ^my-task"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "New description",
      })
      expect(result).toBe("- [ ] New description ⏫ ➕ 2026-08-01 ^my-task")
    })

    it("replaces description when only a block_id follows", () => {
      const line = "- [ ] Old text ^my-task"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "Updated text",
      })
      expect(result).toBe("- [ ] Updated text ^my-task")
    })

    it("replaces description on a bare task (no metadata, no block_id)", () => {
      const line = "- [ ] Just a task"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "New name",
      })
      expect(result).toBe("- [ ] New name")
    })

    it("preserves indentation on sub-tasks", () => {
      const line = "  - [ ] Sub-task description ➕ 2026-08-01"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "Updated sub",
      })
      expect(result).toBe("  - [ ] Updated sub ➕ 2026-08-01")
    })

    it("preserves checkbox status", () => {
      const line = "- [x] Done task ✅ 2026-08-01 ^done"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "Still done",
      })
      expect(result).toBe("- [x] Still done ✅ 2026-08-01 ^done")
    })

    it("treats a signifier emoji inside the description as prose", () => {
      const line = "- [ ] Prefer 🔼 arrows in docs 📅 2026-09-15 ^x"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "Prefers arrows",
      })
      expect(result).toBe("- [ ] Prefers arrows 📅 2026-09-15 ^x")
    })

    it("keeps tags interleaved with metadata in the tail", () => {
      const line = "- [ ] Fix bug 📅 2026-01-01 #urgent"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "Fix crash",
      })
      expect(result).toBe("- [ ] Fix crash 📅 2026-01-01 #urgent")
    })

    it("replaces the whole body when a signifier emoji is followed by prose only", () => {
      const line = "- [ ] Prefer 🔼 arrows"
      const result = tasks.replaceTaskLineDescription({
        taskLine: line,
        newDescription: "Prefers arrows",
      })
      expect(result).toBe("- [ ] Prefers arrows")
    })
  })

  // ── describeTaskLine ──────────────────────────────────────────

  describe("describeTaskLine", () => {
    it("returns the parser's description with a mid-line emoji intact", () => {
      expect(
        tasks.describeTaskLine(
          "- [ ] Prefer 🔼 arrows in docs 📅 2026-09-15 ^x",
        ),
      ).toBe("Prefer 🔼 arrows in docs")
    })

    it("re-appends tags interleaved with metadata", () => {
      expect(
        tasks.describeTaskLine("- [ ] Fix bug 📅 2026-01-01 #urgent"),
      ).toBe("Fix bug #urgent")
    })

    it("strips a bare block link with no metadata", () => {
      expect(tasks.describeTaskLine("- [ ] Walk the dog ^walk-dog")).toBe(
        "Walk the dog",
      )
    })
  })

  // ── assignBlockId ─────────────────────────────────────────────

  describe("assignBlockId", () => {
    it("adds a block_id to a task without one", () => {
      const line = "- [ ] My task ➕ 2026-08-01"
      expect(tasks.assignBlockId({ taskLine: line, blockId: "my-task" })).toBe(
        "- [ ] My task ➕ 2026-08-01 ^my-task",
      )
    })

    it("replaces an existing block_id", () => {
      const line = "- [ ] My task ➕ 2026-08-01 ^old-id"
      expect(tasks.assignBlockId({ taskLine: line, blockId: "new-id" })).toBe(
        "- [ ] My task ➕ 2026-08-01 ^new-id",
      )
    })
  })

  // ── formatDateField ───────────────────────────────────────────

  describe("formatDateField", () => {
    it("formats created date in emoji format", () => {
      expect(
        tasks.formatDateField({
          field: "created",
          date: "2026-08-25",
          format: "emoji",
        }),
      ).toBe("➕ 2026-08-25")
    })

    it("formats due date in dataview format", () => {
      expect(
        tasks.formatDateField({
          field: "due",
          date: "2026-09-01",
          format: "dataview",
        }),
      ).toBe("[due:: 2026-09-01]")
    })

    it("formats done date in emoji format", () => {
      expect(
        tasks.formatDateField({
          field: "done",
          date: "2026-08-25",
          format: "emoji",
        }),
      ).toBe("✅ 2026-08-25")
    })

    it("formats scheduled in dataview format", () => {
      expect(
        tasks.formatDateField({
          field: "scheduled",
          date: "2026-09-15",
          format: "dataview",
        }),
      ).toBe("[scheduled:: 2026-09-15]")
    })

    it("formats start in emoji format", () => {
      expect(
        tasks.formatDateField({
          field: "start",
          date: "2026-10-01",
          format: "emoji",
        }),
      ).toBe("🛫 2026-10-01")
    })

    it("formats cancelled in dataview format", () => {
      expect(
        tasks.formatDateField({
          field: "cancelled",
          date: "2026-08-25",
          format: "dataview",
        }),
      ).toBe("[cancelled:: 2026-08-25]")
    })
  })

  // ── updateTaskLineDate ────────────────────────────────────────

  describe("updateTaskLineDate", () => {
    it("leaves a date-like phrase in the description alone when setting a due date", () => {
      const line = "- [ ] Trip on 📅 2026-09-15, then relax ➕ 2026-08-01 ^trip"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "due",
        date: "2026-09-20",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] Trip on 📅 2026-09-15, then relax ➕ 2026-08-01 📅 2026-09-20 ^trip",
      )
    })

    it("clears only the real due date, never a date-like phrase in the description", () => {
      const line =
        "- [ ] Trip on 📅 2026-09-15, file taxes ➕ 2026-08-01 📅 2026-09-20 ^trip"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "due",
        date: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] Trip on 📅 2026-09-15, file taxes ➕ 2026-08-01 ^trip",
      )
    })

    it("sets a due date on a task without one (emoji)", () => {
      const line = "- [ ] My task ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "due",
        date: "2026-09-15",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 📅 2026-09-15 ^my-task")
    })

    it("replaces an existing due date", () => {
      const line = "- [ ] My task ➕ 2026-08-01 📅 2026-09-01 ^my-task"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "due",
        date: "2026-10-01",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 📅 2026-10-01 ^my-task")
    })

    it("clears a due date", () => {
      const line = "- [ ] My task ➕ 2026-08-01 📅 2026-09-01 ^my-task"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "due",
        date: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 ^my-task")
    })

    it("sets a scheduled date in dataview format", () => {
      const line = "- [ ] My task [created:: 2026-08-01] ^my-task"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "scheduled",
        date: "2026-09-10",
        config: {
          taskFormat: "dataview",
          setDoneDate: true,
          setCancelledDate: true,
        },
      })
      expect(result).toBe(
        "- [ ] My task [created:: 2026-08-01] [scheduled:: 2026-09-10] ^my-task",
      )
    })

    it("inserts a start date before scheduled when both exist", () => {
      const line = "- [ ] My task ➕ 2026-08-01 ⏳ 2026-09-10 ^my-task"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "start",
        date: "2026-08-15",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] My task ➕ 2026-08-01 🛫 2026-08-15 ⏳ 2026-09-10 ^my-task",
      )
    })

    it("clears a created date", () => {
      const line = "- [ ] My task ➕ 2026-08-01 📅 2026-09-01 ^my-task"
      const result = tasks.updateTaskLineDate({
        taskLine: line,
        field: "created",
        date: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task 📅 2026-09-01 ^my-task")
    })
  })

  // ── updateTaskLineTaskId ──────────────────────────────────────

  describe("updateTaskLineTaskId", () => {
    it("sets a task ID (emoji format)", () => {
      const line = "- [ ] My task ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineTaskId({
        taskLine: line,
        taskId: "abc123",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 🆔 abc123 ^my-task")
    })

    it("clears a task ID", () => {
      const line = "- [ ] My task 🆔 abc123 ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineTaskId({
        taskLine: line,
        taskId: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 ^my-task")
    })

    it("inserts a new task ID ahead of an existing depends_on field", () => {
      const line = "- [ ] My task ➕ 2026-08-01 ⛔ dep-a ^my-task"
      const result = tasks.updateTaskLineTaskId({
        taskLine: line,
        taskId: "abc123",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] My task ➕ 2026-08-01 🆔 abc123 ⛔ dep-a ^my-task",
      )
    })

    it("leaves an id-like phrase in the description alone", () => {
      const line =
        "- [ ] Ticket 🆔 old-ref in the description ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineTaskId({
        taskLine: line,
        taskId: "abc123",
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] Ticket 🆔 old-ref in the description ➕ 2026-08-01 🆔 abc123 ^my-task",
      )
    })

    it("sets a task ID (dataview format)", () => {
      const line = "- [ ] My task [created:: 2026-08-01] ^my-task"
      const result = tasks.updateTaskLineTaskId({
        taskLine: line,
        taskId: "xyz789",
        config: {
          taskFormat: "dataview",
          setDoneDate: true,
          setCancelledDate: true,
        },
      })
      expect(result).toBe(
        "- [ ] My task [created:: 2026-08-01] [id:: xyz789] ^my-task",
      )
    })
  })

  // ── updateTaskLineDependsOn ───────────────────────────────────

  describe("updateTaskLineDependsOn", () => {
    it("sets depends-on (emoji format)", () => {
      const line = "- [ ] My task ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineDependsOn({
        taskLine: line,
        dependsOn: ["abc123", "def456"],
        config: EMOJI_CONFIG,
      })
      expect(result).toBe(
        "- [ ] My task ➕ 2026-08-01 ⛔ abc123,def456 ^my-task",
      )
    })

    it("clears depends-on", () => {
      const line = "- [ ] My task ⛔ abc123 ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineDependsOn({
        taskLine: line,
        dependsOn: null,
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 ^my-task")
    })

    it("clears depends-on with empty array", () => {
      const line = "- [ ] My task ⛔ abc123 ➕ 2026-08-01 ^my-task"
      const result = tasks.updateTaskLineDependsOn({
        taskLine: line,
        dependsOn: [],
        config: EMOJI_CONFIG,
      })
      expect(result).toBe("- [ ] My task ➕ 2026-08-01 ^my-task")
    })
  })

  // ── buildTaskLine + extractTasks round-trip ───────────────────

  describe("buildTaskLine", () => {
    it("builds a minimal task line", () => {
      const line = tasks.buildTaskLine(
        {
          description: "Buy groceries",
          blockId: "buy-groceries",
          created: "2026-08-25",
        },
        EMOJI_CONFIG,
      )
      expect(line).toBe("- [ ] Buy groceries ➕ 2026-08-25 ^buy-groceries")
    })

    it("builds a task with all fields (emoji)", () => {
      const line = tasks.buildTaskLine(
        {
          description: "Ship the feature",
          blockId: "ship-feature",
          priority: "high",
          created: "2026-08-25",
          start: "2026-09-01",
          scheduled: "2026-09-10",
          due: "2026-09-15",
          taskId: "abc123",
          dependsOn: ["dep1", "dep2"],
        },
        EMOJI_CONFIG,
      )
      expect(line).toBe(
        "- [ ] Ship the feature ⏫ ➕ 2026-08-25 🛫 2026-09-01 ⏳ 2026-09-10 📅 2026-09-15 🆔 abc123 ⛔ dep1,dep2 ^ship-feature",
      )
    })

    it("builds a task in dataview format", () => {
      const line = tasks.buildTaskLine(
        {
          description: "Dataview task",
          blockId: "dv-task",
          created: "2026-08-25",
          due: "2026-09-01",
        },
        { taskFormat: "dataview", setDoneDate: true, setCancelledDate: true },
      )
      expect(line).toBe(
        "- [ ] Dataview task [created:: 2026-08-25] [due:: 2026-09-01] ^dv-task",
      )
    })

    it("builds an indented sub-task", () => {
      const line = tasks.buildTaskLine(
        {
          description: "Sub-task",
          blockId: "sub",
          created: "2026-08-25",
          indent: "  ",
        },
        EMOJI_CONFIG,
      )
      expect(line).toBe("  - [ ] Sub-task ➕ 2026-08-25 ^sub")
    })

    it("round-trips through extractTasks with all fields intact", () => {
      const params = {
        description: "Round-trip test",
        blockId: "round-trip",
        priority: "highest" as const,
        created: "2026-08-25",
        start: "2026-09-01",
        scheduled: "2026-09-10",
        due: "2026-09-15",
        taskId: "rt-001",
        dependsOn: ["dep-a"],
      }
      const builtLine = tasks.buildTaskLine(params, EMOJI_CONFIG)
      const noteContent = `---\ntitle: Test\n---\n\n${builtLine}\n`
      const parsed = tasks.extractTasks(noteContent)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Round-trip test",
          blockId: "round-trip",
          priority: "highest",
          createdDate: "2026-08-25",
          startDate: "2026-09-01",
          scheduledDate: "2026-09-10",
          dueDate: "2026-09-15",
          taskId: "rt-001",
          dependsOn: ["dep-a"],
        }),
      ])
    })

    it("round-trips dataview format", () => {
      const dvConfig = {
        taskFormat: "dataview" as const,
        setDoneDate: true,
        setCancelledDate: true,
      }
      const builtLine = tasks.buildTaskLine(
        {
          description: "DV round-trip",
          blockId: "dv-rt",
          created: "2026-08-25",
          due: "2026-09-01",
          priority: "medium",
        },
        dvConfig,
      )
      const parsed = tasks.extractTasks(
        `---\ntitle: Test\n---\n\n${builtLine}\n`,
      )
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "DV round-trip",
          dueDate: "2026-09-01",
          createdDate: "2026-08-25",
          priority: "medium",
          blockId: "dv-rt",
        }),
      ])
    })
  })

  // ── Depth and parent tracking in extractTasks ─────────────────

  describe("depth and parent tracking", () => {
    it("assigns depth 0 and null parent to top-level tasks", () => {
      const content =
        "---\ntitle: Test\n---\n\n- [ ] Task A ^a\n- [ ] Task B ^b\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Task A",
          blockId: "a",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 6,
          description: "Task B",
          blockId: "b",
          depth: 0,
          parentLine: null,
        }),
      ])
    })

    it("does not attach a task nested under a plain bullet to an earlier task", () => {
      const content =
        [
          "- [ ] Earlier task ^earlier",
          "- Agenda",
          "  - [ ] Call dentist ^call-dentist",
          "  - [ ] Book flights ^book-flights",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 1,
          description: "Earlier task",
          blockId: "earlier",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 3,
          description: "Call dentist",
          blockId: "call-dentist",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 4,
          description: "Book flights",
          blockId: "book-flights",
          depth: 0,
          parentLine: null,
        }),
      ])
    })

    it("keeps a task's sub-tasks when a deeper plain bullet sits between them", () => {
      const content =
        [
          "- [ ] Parent ^parent",
          "    - note under the parent",
          "  - [ ] Child ^child",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 1,
          description: "Parent",
          blockId: "parent",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 3,
          description: "Child",
          blockId: "child",
          depth: 1,
          parentLine: 1,
        }),
      ])
    })

    it("assigns depth 1 and parent to indented sub-tasks", () => {
      const content =
        [
          "---",
          "title: Test",
          "---",
          "",
          "- [ ] Parent ^parent",
          "  - [ ] Child ^child",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Parent",
          blockId: "parent",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 6,
          description: "Child",
          blockId: "child",
          depth: 1,
          parentLine: 5,
        }),
      ])
    })

    it("tracks depth 2 for deeply nested tasks", () => {
      const content =
        [
          "---",
          "title: Test",
          "---",
          "",
          "- [ ] Root ^root",
          "  - [ ] Level 1 ^l1",
          "    - [ ] Level 2 ^l2",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Root",
          blockId: "root",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 6,
          description: "Level 1",
          blockId: "l1",
          depth: 1,
          parentLine: 5,
        }),
        task({
          line: 7,
          description: "Level 2",
          blockId: "l2",
          depth: 2,
          parentLine: 6,
        }),
      ])
    })

    it("correctly pops the stack for sibling tasks after children", () => {
      const content =
        [
          "---",
          "title: Test",
          "---",
          "",
          "- [ ] Parent A ^pa",
          "  - [ ] Child of A ^ca",
          "- [ ] Parent B ^pb",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Parent A",
          blockId: "pa",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 6,
          description: "Child of A",
          blockId: "ca",
          depth: 1,
          parentLine: 5,
        }),
        task({
          line: 7,
          description: "Parent B",
          blockId: "pb",
          depth: 0,
          parentLine: null,
        }),
      ])
    })

    it("resets the indent stack at heading boundaries", () => {
      const content =
        [
          "---",
          "title: Test",
          "---",
          "",
          "## Active",
          "- [ ] Task A ^a",
          "  - [ ] Sub A ^sa",
          "## Up Next",
          "- [ ] Task B ^b",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 6,
          description: "Task A",
          blockId: "a",
          heading: "Active",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 7,
          description: "Sub A",
          blockId: "sa",
          heading: "Active",
          depth: 1,
          parentLine: 6,
        }),
        task({
          line: 9,
          description: "Task B",
          blockId: "b",
          heading: "Up Next",
          depth: 0,
          parentLine: null,
        }),
      ])
    })

    it("handles non-task lines between parent and child", () => {
      const content =
        [
          "---",
          "title: Test",
          "---",
          "",
          "- [ ] Parent ^parent",
          "  - Not a task line",
          "  - [ ] Child ^child",
        ].join("\n") + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Parent",
          blockId: "parent",
          depth: 0,
          parentLine: null,
        }),
        task({
          line: 7,
          description: "Child",
          blockId: "child",
          depth: 1,
          parentLine: 5,
        }),
      ])
    })

    it("handles blockquote-prefixed tasks at depth 0", () => {
      const content =
        ["---", "title: Test", "---", "", "> - [ ] Blockquoted task ^bq"].join(
          "\n",
        ) + "\n"
      const parsed = tasks.extractTasks(content)
      expect(parsed).toEqual([
        task({
          line: 5,
          description: "Blockquoted task",
          blockId: "bq",
          depth: 0,
          parentLine: null,
        }),
      ])
    })
  })

  // ── parseKanbanCardInsertionMethod ─────────────────────────────

  describe("parseKanbanCardInsertionMethod", () => {
    it("returns undefined when no kanban:settings block exists", () => {
      const bodyLines = ["## Active", "", "- [ ] Task"]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBeUndefined()
    })

    it("returns undefined when the key is absent from the settings JSON", () => {
      const bodyLines = [
        "## Active",
        "",
        "%% kanban:settings",
        "```",
        '{"kanban-plugin":"board"}',
        "```",
        "%%",
      ]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBeUndefined()
    })

    it('returns "prepend" when the setting is "prepend"', () => {
      const bodyLines = [
        "## Active",
        "",
        "%% kanban:settings",
        "```",
        '{"kanban-plugin":"board","new-card-insertion-method":"prepend"}',
        "```",
        "%%",
      ]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBe("prepend")
    })

    it('returns "append" when the setting is "append"', () => {
      const bodyLines = [
        "## Active",
        "",
        "%% kanban:settings",
        "```",
        '{"kanban-plugin":"board","new-card-insertion-method":"append"}',
        "```",
        "%%",
      ]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBe("append")
    })

    it("handles the ```json language tag on the code fence", () => {
      const bodyLines = [
        "%% kanban:settings",
        "```json",
        '{"new-card-insertion-method":"append"}',
        "```",
        "%%",
      ]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBe("append")
    })

    it("returns undefined for malformed JSON", () => {
      const bodyLines = [
        "%% kanban:settings",
        "```",
        "{not valid json",
        "```",
        "%%",
      ]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBeUndefined()
    })

    it("returns undefined for an unrecognized insertion method value", () => {
      const bodyLines = [
        "%% kanban:settings",
        "```",
        '{"new-card-insertion-method":"custom-value"}',
        "```",
        "%%",
      ]
      expect(tasks.parseKanbanCardInsertionMethod(bodyLines)).toBeUndefined()
    })
  })
})
