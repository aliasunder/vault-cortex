import { describe, it, expect, vi } from "vitest"
import type { FileWatcherOptions } from "../file-watcher.js"

// Mock chokidar so we can inspect the exact options startFileWatcher builds,
// instead of spinning up a real watcher. The integration tests in
// file-watcher.test.ts cover real indexing; this file isolates option wiring.
// vi.hoisted lets the factory reference the spy despite vi.mock being hoisted
// above the imports.
const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }))
vi.mock("chokidar", () => ({ watch: watchMock }))

const { startFileWatcher } = await import("../file-watcher.js")
const { createSearchIndex } = await import("../search-index.js")

/** A minimal chokidar watcher stand-in: chainable `.on()`, and fires "ready" so
 *  startFileWatcher's promise resolves. It emits no fs events. */
const createFakeWatcher = (): { on: (event: string) => unknown } => {
  const watcher = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "ready") queueMicrotask(() => handler())
      return watcher
    },
  }
  return watcher
}

/** Runs startFileWatcher and returns the options object it passed to watch(). */
const watchOptionsFor = async (
  options?: FileWatcherOptions,
): Promise<Record<string, unknown>> => {
  watchMock.mockReset()
  watchMock.mockImplementation(() => createFakeWatcher())
  const search = createSearchIndex(":memory:")
  await startFileWatcher("/vault", search, options)
  expect(watchMock).toHaveBeenCalledTimes(1)
  return watchMock.mock.calls[0][1] as Record<string, unknown>
}

describe("startFileWatcher — chokidar watch options", () => {
  it("defaults to native events (usePolling false) with no interval when unset", async () => {
    const options = await watchOptionsFor()
    expect(options.usePolling).toBe(false)
    expect("interval" in options).toBe(false)
  })

  it("omits interval when usePolling is false", async () => {
    const options = await watchOptionsFor({ usePolling: false })
    expect(options.usePolling).toBe(false)
    expect("interval" in options).toBe(false)
  })

  it("passes interval (300ms) only when usePolling is true", async () => {
    const options = await watchOptionsFor({ usePolling: true })
    expect(options.usePolling).toBe(true)
    expect(options.interval).toBe(300)
  })
})
