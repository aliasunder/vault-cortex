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
  rename,
  unlink,
  symlink,
  utimes,
} from "node:fs/promises"
import { join, resolve } from "node:path"
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
    expect(results[0]?.path).toBe("test.md")
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

  it(
    "calls embedNote when indexing a .md file",
    { timeout: 15000 },
    async () => {
      const embedNoteSpy = vi.spyOn(index, "embedNote")
      await startFileWatcher(vault, index, {
        stabilityThreshold: 200,
        pollInterval: 50,
      })

      await writeFile(
        join(vault, "embed-test.md"),
        "---\ntitle: Embed\n---\n\nEmbed this content\n",
        "utf8",
      )

      await waitFor(() => embedNoteSpy.mock.calls.length > 0)
      expect(embedNoteSpy).toHaveBeenCalledWith(
        {
          notePath: "embed-test.md",
          rawContent: "---\ntitle: Embed\n---\n\nEmbed this content\n",
        },
        expect.anything(), // logger — runtime child logger, not deterministic
      )
    },
  )

  it(
    "indexes a note atomically written into a brand-new directory",
    { timeout: 15000 },
    async () => {
      await startFileWatcher(vault, index, {
        stabilityThreshold: 200,
        pollInterval: 50,
        newDirectoryRescanDelay: 500,
      })

      // vault_write_note's sequence — mkdir -p, stage a temp file, rename over
      // the target — is the pattern that races chokidar's new-directory scan.
      const newDirectory = join(vault, "brand-new/nested")
      await mkdir(newDirectory, { recursive: true })
      const notePath = join(newDirectory, "note.md")
      await writeFile(`${notePath}.tmp`, "raced into a new folder\n", "utf8")
      await rename(`${notePath}.tmp`, notePath)

      await waitFor(
        () => index.fullTextSearch({ query: "raced" }, logger).length > 0,
      )
      const results = index.fullTextSearch({ query: "raced" }, logger)
      expect(results).toHaveLength(1)
      expect(results[0]?.path).toBe("brand-new/nested/note.md")
    },
  )

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
    expect(results[0]?.path).toBe("polled.md")
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
    return watchMock.mock.calls[0]?.[1] as Record<string, unknown>
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

// The chokidar race the rescan closes (a file landing between the
// new-directory scan and its watch registration) can't be forced from the
// outside, so these tests drive the reconciliation directly: a fake watcher
// captures the addDir handler, reports test-controlled tracking via
// getWatched(), and records add() calls — against a real temp vault and index.
describe("startFileWatcher — new-directory rescan", () => {
  const RESCAN_TEST_OPTIONS = {
    stabilityThreshold: 200,
    pollInterval: 50,
    newDirectoryRescanDelay: 50,
  }

  type RescanFakeWatcher = {
    fireAddDir: (dirPath: string) => void
    addedPaths: string[]
  }

  /** Stubs chokidar.watch with a fake exposing what the rescan consumes, then
   *  starts the file watcher against it. mockRestore (via onTestFinished)
   *  hands the real, spied watch back to the integration tests. */
  const startWatcherWithFakeChokidar = async (
    watchedChildren: Record<string, string[]>,
    watcherOptions: Parameters<typeof startFileWatcher>[2],
  ): Promise<RescanFakeWatcher> => {
    const handlers = new Map<string, (path: string) => void>()
    const addedPaths: string[] = []
    const fakeWatcher = {
      on(event: string, handler: (path: string) => void) {
        if (event === "ready") queueMicrotask(() => handler(""))
        handlers.set(event, handler)
        return fakeWatcher
      },
      getWatched: () => watchedChildren,
      add: (path: string) => {
        addedPaths.push(path)
      },
    }
    const watchMock = vi.mocked(watch)
    watchMock.mockReset()
    watchMock.mockImplementation(
      () => fakeWatcher as unknown as ReturnType<typeof watch>,
    )
    onTestFinished(() => watchMock.mockRestore())
    await startFileWatcher(vault, index, watcherOptions)

    const fireAddDir = (dirPath: string): void => {
      const addDirHandler = handlers.get("addDir")
      if (addDirHandler === undefined) {
        throw new Error("addDir handler was not registered")
      }
      addDirHandler(dirPath)
    }
    return { fireAddDir, addedPaths }
  }

  /** Backdates a file's mtime (10 minutes) so the rescan's "still being
   *  written" guard sees it as settled. */
  const backdateMtime = async (filePath: string): Promise<void> => {
    const backdated = new Date(Date.now() - 600_000)
    await utimes(filePath, backdated, backdated)
  }

  it(
    "indexes a file on disk that chokidar does not track",
    { timeout: 15000 },
    async () => {
      const newDirectory = join(vault, "new-folder")
      await mkdir(newDirectory)
      const missedPath = join(newDirectory, "missed.md")
      await writeFile(missedPath, "missed by the scan\n", "utf8")
      await backdateMtime(missedPath)

      const { fireAddDir } = await startWatcherWithFakeChokidar(
        {},
        RESCAN_TEST_OPTIONS,
      )
      fireAddDir(newDirectory)

      await waitFor(
        () => index.fullTextSearch({ query: "missed" }, logger).length > 0,
      )
      const results = index.fullTextSearch({ query: "missed" }, logger)
      expect(results).toHaveLength(1)
      expect(results[0]?.path).toBe("new-folder/missed.md")
    },
  )

  it(
    "does not re-index a file chokidar already tracks",
    { timeout: 15000 },
    async () => {
      const newDirectory = join(vault, "new-folder")
      await mkdir(newDirectory)
      const trackedPath = join(newDirectory, "tracked.md")
      const missedPath = join(newDirectory, "missed.md")
      await writeFile(trackedPath, "already tracked note\n", "utf8")
      await writeFile(missedPath, "missed sibling note\n", "utf8")
      await backdateMtime(trackedPath)
      await backdateMtime(missedPath)

      const upsertNoteSpy = vi.spyOn(index, "upsertNote")
      const { fireAddDir } = await startWatcherWithFakeChokidar(
        { [resolve(newDirectory)]: ["tracked.md"] },
        RESCAN_TEST_OPTIONS,
      )
      fireAddDir(newDirectory)

      // The untracked sibling getting indexed proves the rescan ran — the
      // tracked file being skipped can't be a silent no-op.
      await waitFor(
        () => index.fullTextSearch({ query: "sibling" }, logger).length > 0,
      )
      expect(upsertNoteSpy).toHaveBeenCalledTimes(1)
      expect(upsertNoteSpy.mock.calls[0]?.[0]?.filePath).toBe(
        "new-folder/missed.md",
      )
    },
  )

  it(
    "skips an untracked file modified within the stability window",
    { timeout: 15000 },
    async () => {
      const newDirectory = join(vault, "new-folder")
      await mkdir(newDirectory)
      const settledPath = join(newDirectory, "settled.md")
      const freshPath = join(newDirectory, "fresh.md")
      await writeFile(settledPath, "settled note\n", "utf8")
      await writeFile(freshPath, "fresh note\n", "utf8")
      // settled.md is backdated; fresh.md keeps its just-written mtime, which
      // a 60s stability threshold treats as still being written.
      await backdateMtime(settledPath)

      const { fireAddDir } = await startWatcherWithFakeChokidar(
        {},
        { ...RESCAN_TEST_OPTIONS, stabilityThreshold: 60_000 },
      )
      fireAddDir(newDirectory)

      // The settled sibling proves the rescan ran; the fresh file is left for
      // the (by now registered) directory watch to index once it settles.
      await waitFor(
        () => index.fullTextSearch({ query: "settled" }, logger).length > 0,
      )
      const freshResults = index.fullTextSearch({ query: "fresh" }, logger)
      expect(freshResults).toHaveLength(0)
    },
  )

  it(
    "registers a missed subdirectory and indexes its contents",
    { timeout: 15000 },
    async () => {
      const newDirectory = join(vault, "new-folder")
      const missedSubdirectory = join(newDirectory, "missed-subdir")
      await mkdir(missedSubdirectory, { recursive: true })
      const nestedPath = join(missedSubdirectory, "nested.md")
      await writeFile(nestedPath, "nested in a missed subdir\n", "utf8")
      await backdateMtime(nestedPath)

      const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar(
        {},
        RESCAN_TEST_OPTIONS,
      )
      fireAddDir(newDirectory)

      await waitFor(
        () => index.fullTextSearch({ query: "nested" }, logger).length > 0,
      )
      const results = index.fullTextSearch({ query: "nested" }, logger)
      expect(results).toHaveLength(1)
      expect(results[0]?.path).toBe("new-folder/missed-subdir/nested.md")
      // The subdirectory must be handed back to chokidar so it gains watches.
      expect(addedPaths).toEqual([missedSubdirectory])
    },
  )

  it(
    "ignores dot-directories during the rescan",
    { timeout: 15000 },
    async () => {
      const newDirectory = join(vault, "new-folder")
      const hiddenDirectory = join(newDirectory, ".trash")
      await mkdir(hiddenDirectory, { recursive: true })
      const hiddenPath = join(hiddenDirectory, "hidden.md")
      const visiblePath = join(newDirectory, "visible.md")
      await writeFile(hiddenPath, "hidden rescan note\n", "utf8")
      await writeFile(visiblePath, "visible rescan note\n", "utf8")
      await backdateMtime(hiddenPath)
      await backdateMtime(visiblePath)

      const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar(
        {},
        RESCAN_TEST_OPTIONS,
      )
      fireAddDir(newDirectory)

      await waitFor(
        () => index.fullTextSearch({ query: "visible" }, logger).length > 0,
      )
      const hiddenResults = index.fullTextSearch({ query: "hidden" }, logger)
      expect(hiddenResults).toHaveLength(0)
      // The dot-directory must not be registered with chokidar either.
      expect(addedPaths).toEqual([])
    },
  )

  it(
    "handles a directory deleted before the rescan fires",
    { timeout: 15000 },
    async () => {
      const upsertNoteSpy = vi.spyOn(index, "upsertNote")
      const { fireAddDir } = await startWatcherWithFakeChokidar(
        {},
        RESCAN_TEST_OPTIONS,
      )
      fireAddDir(join(vault, "never-created"))

      // Give the scheduled rescan time to run; it must bail without indexing
      // anything (an unhandled rejection would fail the test run).
      await new Promise((finished) => setTimeout(finished, 300))
      expect(upsertNoteSpy).not.toHaveBeenCalled()
    },
  )
})
