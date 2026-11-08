import { describe, expect, it } from "vitest"
import { tasks } from "../tasks.js"
import type { TaskFormatConfig } from "../../vault-operations/task-format-config.js"

const config: TaskFormatConfig = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
  setCreatedDate: false,
  recurrenceOnNextLine: false,
  removeScheduledDateOnRecurrence: false,
  statusRegistry: new Map(),
}

describe("task prefix compatibility", () => {
  it.each([{ taskFormat: "emoji" as const }, { taskFormat: "dataview" as const }])(
    "keeps prefix spacing when the $taskFormat next occurrence removes every field",
    ({ taskFormat }) => {
      expect(
        tasks.buildNextOccurrenceLine({
          taskLine: "  - [ ] 🛫2026-01-02 ⛔a, b",
          nextDates: { startDate: null, scheduledDate: null, dueDate: null },
          today: "2026-11-08",
          config: { ...config, taskFormat },
        }),
      ).toBe("  - [ ] ")
    },
  )

  it("trims leading body tabs before inserting a date", () => {
    expect(
      tasks.updateTaskLineDate({
        taskLine: "- [ ] \t Work ⏫",
        field: "due",
        date: "2026-11-09",
        config,
      }),
    ).toBe("- [ ] Work ⏫ 📅 2026-11-09")
  })
})
