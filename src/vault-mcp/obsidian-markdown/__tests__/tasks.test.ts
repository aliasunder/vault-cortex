import { describe, it, expect } from "vitest"
import { tasks, type ParsedTask, type MutationFormatConfig } from "../tasks.js"

/** Default emoji format config for mutation tests. */
const EMOJI_CONFIG: MutationFormatConfig = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
}

/** Dataview format config for format-specific tests. */
const DATAVIEW_CONFIG: MutationFormatConfig = {
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
    it("marks a todo task as done with a done date", () => {
      const result = tasks.updateTaskLineStatus(
        "- [ ] Fix the bug ➕ 2026-07-01",
        "done",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [x] Fix the bug ➕ 2026-07-01 ✅ 2026-07-12")
    })

    it("marks a todo task as cancelled with a cancelled date", () => {
      const result = tasks.updateTaskLineStatus(
        "- [ ] Dropped feature ➕ 2026-07-01",
        "cancelled",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [-] Dropped feature ➕ 2026-07-01 ❌ 2026-07-12")
    })

    it("marks an in-progress task as done", () => {
      const result = tasks.updateTaskLineStatus(
        "- [/] In-progress task ➕ 2026-07-01",
        "done",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [x] In-progress task ➕ 2026-07-01 ✅ 2026-07-12")
    })

    it("un-completes a done task by removing the done date", () => {
      const result = tasks.updateTaskLineStatus(
        "- [x] Was done ➕ 2026-07-01 ✅ 2026-07-10",
        "todo",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Was done ➕ 2026-07-01")
    })

    it("switches from done to cancelled: removes done date, adds cancelled date", () => {
      const result = tasks.updateTaskLineStatus(
        "- [x] Changed my mind ➕ 2026-07-01 ✅ 2026-07-10",
        "cancelled",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [-] Changed my mind ➕ 2026-07-01 ❌ 2026-07-12")
    })

    it("switches from cancelled to in_progress: removes cancelled date", () => {
      const result = tasks.updateTaskLineStatus(
        "- [-] Revived task ➕ 2026-07-01 ❌ 2026-07-10",
        "in_progress",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [/] Revived task ➕ 2026-07-01")
    })

    it("re-stamps an existing done date with today", () => {
      const result = tasks.updateTaskLineStatus(
        "- [x] Old completion ✅ 2026-06-01",
        "done",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [x] Old completion ✅ 2026-07-12")
    })

    it("inserts the done date before a block ID", () => {
      const result = tasks.updateTaskLineStatus(
        "- [ ] Task with ID ➕ 2026-07-01 ^my-task",
        "done",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe(
        "- [x] Task with ID ➕ 2026-07-01 ✅ 2026-07-12 ^my-task",
      )
    })

    it("preserves priority and created date when completing", () => {
      const result = tasks.updateTaskLineStatus(
        "- [ ] Prioritized ⏫ ➕ 2026-07-01 📅 2026-07-20",
        "done",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe(
        "- [x] Prioritized ⏫ ➕ 2026-07-01 📅 2026-07-20 ✅ 2026-07-12",
      )
    })

    it("handles a bare task with no metadata", () => {
      const result = tasks.updateTaskLineStatus(
        "- [ ] Simple task",
        "done",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [x] Simple task ✅ 2026-07-12")
    })

    it("strips a Dataview done date when un-completing", () => {
      const result = tasks.updateTaskLineStatus(
        "- [x] Task [completion:: 2026-07-10]",
        "todo",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task")
    })

    it("strips a Dataview cancelled date when reverting to todo", () => {
      const result = tasks.updateTaskLineStatus(
        "- [-] Task [cancelled:: 2026-07-10]",
        "todo",
        "2026-07-12",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task")
    })

    it("writes done date in Dataview format when configured", () => {
      const result = tasks.updateTaskLineStatus(
        "- [ ] Task [created:: 2026-07-01]",
        "done",
        "2026-07-12",
        DATAVIEW_CONFIG,
      )
      expect(result).toBe(
        "- [x] Task [created:: 2026-07-01] [completion:: 2026-07-12]",
      )
    })

    it("skips done date when setDoneDate is false", () => {
      const noDoneDateConfig: MutationFormatConfig = {
        taskFormat: "emoji",
        setDoneDate: false,
        setCancelledDate: true,
      }
      const result = tasks.updateTaskLineStatus(
        "- [ ] Task ➕ 2026-07-01",
        "done",
        "2026-07-12",
        noDoneDateConfig,
      )
      expect(result).toBe("- [x] Task ➕ 2026-07-01")
    })
  })

  describe("updateTaskLinePriority", () => {
    it("adds priority to a task with none, before the first date signifier", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Task ➕ 2026-07-01",
        "high",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task ⏫ ➕ 2026-07-01")
    })

    it("replaces an existing priority emoji", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Task ⏫ ➕ 2026-07-01",
        "lowest",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task ⏬ ➕ 2026-07-01")
    })

    it("removes priority when null is passed", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Task ⏫ ➕ 2026-07-01",
        null,
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task ➕ 2026-07-01")
    })

    it("returns the line unchanged when removing priority that does not exist", () => {
      const line = "- [ ] No priority task ➕ 2026-07-01"
      const result = tasks.updateTaskLinePriority(line, null, EMOJI_CONFIG)
      expect(result).toBe(line)
    })

    it("inserts priority before block ID when no date signifiers exist", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Just a task ^my-id",
        "medium",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Just a task 🔼 ^my-id")
    })

    it("appends priority at end when no date signifiers or block ID", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Bare task",
        "highest",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Bare task 🔺")
    })

    it("strips a Dataview priority field", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Task [priority:: high] [created:: 2026-07-01]",
        null,
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task [created:: 2026-07-01]")
    })

    it("replaces a Dataview priority with emoji when format is emoji", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Task [priority:: high] ➕ 2026-07-01",
        "low",
        EMOJI_CONFIG,
      )
      expect(result).toBe("- [ ] Task 🔽 ➕ 2026-07-01")
    })

    it("writes priority in Dataview format when configured", () => {
      const result = tasks.updateTaskLinePriority(
        "- [ ] Task ➕ 2026-07-01",
        "high",
        DATAVIEW_CONFIG,
      )
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
})
