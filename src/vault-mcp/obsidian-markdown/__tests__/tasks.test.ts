import { describe, it, expect } from "vitest"
import { tasks, type ParsedTask } from "../tasks.js"

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
        field: { doneDate: "2026-07-05" },
      },
      {
        name: "cancelled ❌",
        line: "- [-] T ❌ 2026-07-06",
        field: { cancelledDate: "2026-07-06" },
      },
    ]

    it.each(dateScenarios)("parses $name", ({ line, field }) => {
      const extracted = tasks.extractTasks(line)
      expect(extracted).toHaveLength(1)
      expect(extracted[0]).toMatchObject({ description: "T", ...field })
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
        field: { doneDate: "2026-07-05" },
      },
      {
        name: "cancelled",
        line: "- [-] T [cancelled:: 2026-07-06]",
        field: { cancelledDate: "2026-07-06" },
      },
      {
        name: "priority word",
        line: "- [ ] T [priority:: high]",
        field: { priority: "high" },
      },
      {
        name: "repeat (not recurrence::)",
        line: "- [ ] T [repeat:: every week]",
        field: { recurrence: "every week" },
      },
      {
        name: "onCompletion",
        line: "- [x] T [onCompletion:: delete]",
        field: { onCompletion: "delete" },
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
      expect(extracted).toHaveLength(1)
      expect(extracted[0]).toMatchObject({ description: "T", ...field })
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
