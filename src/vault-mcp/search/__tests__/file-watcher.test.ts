import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  onTestFinished,
} from "vitest"
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  unlink,
  symlink,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { watch } from "chokidar"
import { createSearchIndex } from "../search-index.js"
import type { SearchIndex } from "../search-index.js"
import { startFileWatcher } from "../file-watcher.js"
import { logger } from "../../../logger.js"

// Auto-spy chokidar: spy: true keeps the real implementation, so the
// integration tests below watch real temp dirs, while the "watch options" suite
// overrides watch() per-test to inspect the options object passed to chokidar —
// without starting a real watcher — then restores the real one.
vi.mock("chokidar", { spy: true })

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
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
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
    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

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
    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "modify.md"), "original content\n", "utf8")
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
    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "delete-me.md"), "ephemeral\n", "utf8")
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
    await startFileWatcher(vault, index, {
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

    await startFileWatcher(vault, index, {
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

  it("indexes a symlinked .md file", { timeout: 15000 }, async () => {
    await writeFile(join(vault, "real.md"), "symlink watcher target\n", "utf8")

    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await symlink("real.md", join(vault, "linked.md"))

    await waitFor(() =>
      index
        .fullTextSearch({ query: "symlink watcher" }, logger)
        .some((result) => result.path === "linked.md"),
    )
    const paths = index
      .fullTextSearch({ query: "symlink watcher" }, logger)
      .map((result) => result.path)
    expect(paths).toContain("linked.md")
  })

  // Polling is the Windows-mode path (inotify doesn't cross the Docker Desktop ↔
  // WSL2 bridge). It works on any filesystem, so this verifies the usePolling
  // option is wired through and indexing still happens under polling.
  it("indexes a new .md file when polling", { timeout: 15000 }, async () => {
    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
      usePolling: true,
    })

    await writeFile(join(vault, "polled.md"), "polled content\n", "utf8")

    await waitFor(
      () => index.fullTextSearch({ query: "polled" }, logger).length > 0,
    )
    const results = index.fullTextSearch({ query: "polled" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("polled.md")
  })
})

describe("startFileWatcher — chokidar watch options", () => {
  type FakeWatcher = {
    on: (event: string, handler: (...args: unknown[]) => void) => FakeWatcher
  }

  /** Chainable watcher stub that fires "ready" so startFileWatcher resolves. */
  const createFakeWatcher = (): FakeWatcher => {
    const watcher: FakeWatcher = {
      on(event, handler) {
        if (event === "ready") queueMicrotask(() => handler())
        return watcher
      },
    }
    return watcher
  }

  /** Starts the watcher with the given FileWatcherOptions (chokidar.watch stubbed
   *  for this one test) and returns the options object chokidar.watch was called
   *  with. mockRestore (via onTestFinished) hands the real, spied watch back to
   *  the integration tests. */
  const chokidarOptionsFrom = async (
    watcherOptions?: Parameters<typeof startFileWatcher>[2],
  ): Promise<Record<string, unknown>> => {
    const watchMock = vi.mocked(watch)
    watchMock.mockReset()
    watchMock.mockImplementation(
      () => createFakeWatcher() as unknown as ReturnType<typeof watch>,
    )
    onTestFinished(() => watchMock.mockRestore())
    await startFileWatcher("/vault", index, watcherOptions)
    expect(watchMock).toHaveBeenCalledTimes(1)
    return watchMock.mock.calls[0][1] as Record<string, unknown>
  }

  it("defaults to native events (usePolling false) with no interval when unset", async () => {
    const chokidarOptions = await chokidarOptionsFrom()
    expect(chokidarOptions.usePolling).toBe(false)
    expect("interval" in chokidarOptions).toBe(false)
  })

  it("omits interval when usePolling is false", async () => {
    const chokidarOptions = await chokidarOptionsFrom({ usePolling: false })
    expect(chokidarOptions.usePolling).toBe(false)
    expect("interval" in chokidarOptions).toBe(false)
  })

  it("passes interval (300ms) only when usePolling is true", async () => {
    const chokidarOptions = await chokidarOptionsFrom({ usePolling: true })
    expect(chokidarOptions.usePolling).toBe(true)
    expect(chokidarOptions.interval).toBe(300)
  })
})
