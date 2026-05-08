import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSearchIndex } from "../search-index.js"
import type { SearchIndex } from "../search-index.js"
import { startFileWatcher } from "../file-watcher.js"
import { logger } from "../../logger.js"

let vault: string
let index: SearchIndex

/** Poll until a condition is met, with timeout. */
const waitFor = async (
  check: () => boolean,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "watcher-test-"))
  index = createSearchIndex(":memory:")
})

afterEach(async () => {
  await rm(vault, { recursive: true })
})

describe("file-watcher", () => {
  it("indexes a new .md file", { timeout: 15000 }, async () => {
    startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    // Let chokidar finish its initial scan before writing
    await new Promise((r) => setTimeout(r, 500))

    await writeFile(
      join(vault, "test.md"),
      "---\ntitle: Test\n---\n\nHello watcher\n",
      "utf8",
    )

    await waitFor(
      () => index.fullTextSearch({ query: "watcher" }, logger).length > 0,
    )
    const results = index.fullTextSearch({ query: "watcher" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("test.md")
  })

  it("re-indexes a modified file", { timeout: 15000 }, async () => {
    await writeFile(join(vault, "modify.md"), "original content\n", "utf8")

    startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await waitFor(
      () => index.fullTextSearch({ query: "original" }, logger).length > 0,
    )

    await writeFile(join(vault, "modify.md"), "updated content\n", "utf8")
    await waitFor(
      () => index.fullTextSearch({ query: "updated" }, logger).length > 0,
    )

    const results = index.fullTextSearch({ query: "updated" }, logger)
    expect(results).toHaveLength(1)
  })

  it("removes a deleted file from index", { timeout: 15000 }, async () => {
    await writeFile(join(vault, "delete-me.md"), "ephemeral\n", "utf8")

    startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await waitFor(
      () => index.fullTextSearch({ query: "ephemeral" }, logger).length > 0,
    )

    await unlink(join(vault, "delete-me.md"))
    await waitFor(
      () => index.fullTextSearch({ query: "ephemeral" }, logger).length === 0,
    )

    const results = index.fullTextSearch({ query: "ephemeral" }, logger)
    expect(results).toHaveLength(0)
  })

  it("ignores non-.md files", { timeout: 15000 }, async () => {
    startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "data.json"), '{"key": "value"}', "utf8")
    await writeFile(join(vault, "check.md"), "check file\n", "utf8")

    await waitFor(
      () => index.fullTextSearch({ query: "check" }, logger).length > 0,
    )

    const jsonResults = index.fullTextSearch({ query: "value" }, logger)
    expect(jsonResults).toHaveLength(0)
  })

  it("ignores hidden directories", { timeout: 15000 }, async () => {
    await mkdir(join(vault, ".obsidian"), { recursive: true })

    startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(
      join(vault, ".obsidian/workspace.md"),
      "hidden content\n",
      "utf8",
    )
    await writeFile(join(vault, "visible.md"), "visible content\n", "utf8")

    await waitFor(
      () => index.fullTextSearch({ query: "visible" }, logger).length > 0,
    )

    const hiddenResults = index.fullTextSearch({ query: "hidden" }, logger)
    expect(hiddenResults).toHaveLength(0)
  })
})
