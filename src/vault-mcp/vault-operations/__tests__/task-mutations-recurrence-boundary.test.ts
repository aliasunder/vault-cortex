import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { taskMutations } from "../task-mutations.js"
import { logger } from "../../../logger.js"
import { DEFAULT_STATUS_REGISTRY } from "../../obsidian-markdown/tasks.js"

describe("recurrence mutation metadata boundary", () => {
  it.each([
    { format: "emoji", malformed: "🔁", newField: "🔁 every week" },
    { format: "dataview", malformed: "[repeat::", newField: "[repeat:: every week]" },
  ] as const)(
    "keeps malformed $format recurrence outside the nonempty metadata tail",
    async ({ format, malformed, newField }) => {
      const vaultPath = await mkdtemp(join(tmpdir(), "probe-recurrence-boundary-"))
      onTestFinished(() => rm(vaultPath, { recursive: true, force: true }))
      const notePath = join(vaultPath, "Task.md")
      for (const size of [500, 1_000, 2_000]) {
        const description = `Work ${malformed}${" ".repeat(size)}?]`
        const original = `- [ ] ${description} 📅 2026-01-02\n`
        await writeFile(notePath, original)
        const setResult = await taskMutations.updateTask(
          {
            vaultPath,
            path: "Task.md",
            line: 1,
            recurrence: "every week",
            format,
            statusRegistry: DEFAULT_STATUS_REGISTRY,
          },
          logger,
        )

        expect(setResult.changes).toEqual(["recurrence: (none) → every week"])
        expect(await readFile(notePath, "utf8")).toBe(
          `- [ ] ${description} ${newField} 📅 2026-01-02\n`,
        )
        const followUpResult = await taskMutations.updateTask(
          {
            vaultPath,
            path: "Task.md",
            line: 1,
            recurrence: null,
            format,
            statusRegistry: DEFAULT_STATUS_REGISTRY,
          },
          logger,
        )

        expect(followUpResult.changes).toEqual(["recurrence: every week → (none)"])
        expect(await readFile(notePath, "utf8")).toBe(original)
        await writeFile(notePath, original)
        const clearResult = await taskMutations.updateTask(
          {
            vaultPath,
            path: "Task.md",
            line: 1,
            recurrence: null,
            format,
            statusRegistry: DEFAULT_STATUS_REGISTRY,
          },
          logger,
        )

        expect(clearResult.changes).toEqual(["recurrence: (none) → (none)"])
        expect(await readFile(notePath, "utf8")).toBe(original)
      }
    },
  )
})
