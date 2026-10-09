import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from "vitest"
import {
  mkdtemp,
  rm,
  writeFile,
  stat,
  mkdir,
  rename,
  unlink,
  symlink,
  utimes,
  readFile,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { watch, FSWatcher } from "chokidar"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { createSearchIndex } from "../search-index.js"
import { extractPdfText } from "../../obsidian-markdown/pdf.js"
import { readdirOrNull, statOrNull } from "../../../utils/fs.js"
import type { SearchIndex } from "../search-index.js"
import { startFileWatcher } from "../file-watcher.js"
import { logger } from "../../../logger.js"

// Auto-spy chokidar: spy: true keeps the real implementation, so the
// integration tests below watch real temp dirs, while the "watch options" suite
// overrides watch() per-test to inspect the options object passed to chokidar —
// without starting a real watcher — then restores the real one.
vi.mock("chokidar", { spy: true })
// Auto-spy the fs utils (real implementation kept): readdirOrNull is the
// rescan's synchronous first call, so the delay-default test can observe the
// timer firing without waiting on real filesystem I/O.
vi.mock("../../../utils/fs.js", { spy: true })
vi.mock("node:fs/promises", { spy: true })
vi.mock("../../obsidian-markdown/pdf.js", { spy: true })

let vault: string
let index: SearchIndex

/** Poll until a condition is met, with timeout. */
const waitFor = async (check: () => boolean, timeoutMs = 8000, intervalMs = 100): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

/** Retry policy for suites that watch real temp dirs.
 *
 *  Why: on macOS, fs.watch rides libuv's FSEventStream, whose kernel-side
 *  capture starts asynchronously — a write landing right after the watcher
 *  reports ready can produce no event at all, so waitFor times out
 *  (observed as bursty local-only failures; events arrive in <1s or never).
 *
 *  Why it's safe: Linux (CI and every production deployment) registers
 *  inotify watches synchronously and has no such gap, and a code
 *  regression fails every attempt — retries only absorb the macOS race. */
const REAL_WATCHER_RETRY = { retry: 2 }

const registerSharedVaultHooks = (): void => {
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "watcher-test-"))
    index = createSearchIndex(":memory:")
  })

  afterEach(async () => {
    await rm(vault, { recursive: true })
  })
}

describe("file-watcher", REAL_WATCHER_RETRY, () => {
  registerSharedVaultHooks()

  it("indexes a new .md file", { timeout: 15000 }, async () => {
    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "test.md"), "---\ntitle: Test\n---\n\nHello watcher\n", "utf8")

    await waitFor(() => index.fullTextSearch({ query: "watcher" }, logger).length > 0)
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
    await waitFor(() => index.fullTextSearch({ query: "original" }, logger).length > 0)

    await writeFile(join(vault, "modify.md"), "updated content\n", "utf8")
    await waitFor(() => index.fullTextSearch({ query: "updated" }, logger).length > 0)

    const results = index.fullTextSearch({ query: "updated" }, logger)
    expect(results).toHaveLength(1)
  })

  it("removes a deleted file from index", { timeout: 15000 }, async () => {
    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "delete-me.md"), "ephemeral\n", "utf8")
    await waitFor(() => index.fullTextSearch({ query: "ephemeral" }, logger).length > 0)

    await unlink(join(vault, "delete-me.md"))
    await waitFor(() => index.fullTextSearch({ query: "ephemeral" }, logger).length === 0)

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

    await waitFor(() => index.fullTextSearch({ query: "check" }, logger).length > 0)

    const jsonResults = index.fullTextSearch({ query: "value" }, logger)
    expect(jsonResults).toHaveLength(0)
  })

  it("skips a non-md file that vanishes before its stat", { timeout: 15000 }, async () => {
    const upsertNonMdFileSpy = vi.spyOn(index, "upsertNonMdFile")
    // Force the stat miss by path — a deterministic stand-in for the file
    // being deleted between the watcher event and the handler's stat.
    const actualFsUtils =
      await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")
    vi.mocked(statOrNull).mockImplementation(async (statPath) =>
      statPath.endsWith("vanished.png") ? null : actualFsUtils.statOrNull(statPath),
    )
    onTestFinished(() => {
      vi.mocked(statOrNull).mockRestore()
    })

    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "vanished.png"), "gone", "utf8")
    await writeFile(join(vault, "kept.png"), "here", "utf8")

    // Both non-md events have been processed once each file's stat ran.
    await waitFor(() =>
      ["vanished.png", "kept.png"].every((fileName) =>
        vi.mocked(statOrNull).mock.calls.some(([statPath]) => statPath.endsWith(fileName)),
      ),
    )

    // Only the surviving file is indexed — the vanished one's early return
    // must not upsert (without the guard, reading .size off null would throw
    // inside the watcher callback).
    await waitFor(() => upsertNonMdFileSpy.mock.calls.length > 0)
    expect(upsertNonMdFileSpy.mock.calls.map(([path]) => path)).toEqual(["kept.png"])
  })

  it("ignores hidden directories", { timeout: 15000 }, async () => {
    await mkdir(join(vault, ".obsidian"), { recursive: true })

    await startFileWatcher(vault, index, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, ".obsidian/workspace.md"), "hidden content\n", "utf8")
    await writeFile(join(vault, "visible.md"), "visible content\n", "utf8")

    await waitFor(() => index.fullTextSearch({ query: "visible" }, logger).length > 0)

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

  it("calls embedNote when indexing a .md file", { timeout: 15000 }, async () => {
    const embedNoteSpy = vi.spyOn(index, "embedNote")
    const capturedVersion = Promise.withResolvers<symbol>()
    const realUpsert = index.upsertNote
    vi.spyOn(index, "upsertNote").mockImplementation((params, requestLogger) => {
      const sourceVersion = realUpsert(params, requestLogger)
      capturedVersion.resolve(sourceVersion)
      return sourceVersion
    })
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
    const sourceVersion = await capturedVersion.promise
    expect(embedNoteSpy).toHaveBeenCalledExactlyOnceWith(
      {
        notePath: "embed-test.md",
        rawContent: "---\ntitle: Embed\n---\n\nEmbed this content\n",
        sourceVersion,
      },
      logger,
    )
  })

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

      await waitFor(() => index.fullTextSearch({ query: "raced" }, logger).length > 0)
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

    await waitFor(() => index.fullTextSearch({ query: "polled" }, logger).length > 0)
    const results = index.fullTextSearch({ query: "polled" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("polled.md")
  })
})

describe("file-watcher — file content indexing", REAL_WATCHER_RETRY, () => {
  registerSharedVaultHooks()

  it("indexes a text file into file content FTS", { timeout: 15000 }, async () => {
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })
    const upsertSpy = vi.spyOn(fileIndex, "upsertFileContent")

    await startFileWatcher(vault, fileIndex, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "notes.txt"), "deployment checklist for production release", "utf8")

    await waitFor(() => upsertSpy.mock.calls.length > 0)

    const { results } = await fileIndex.hybridSearch({ query: "deployment checklist" }, logger)
    const textResult = results.find((result) => result.path === "notes.txt")
    expect(textResult?.kind).toBe("file")
    expect(textResult?.extension).toBe(".txt")
  })

  it("removes text file content on delete", { timeout: 15000 }, async () => {
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })
    const upsertSpy = vi.spyOn(fileIndex, "upsertFileContent")
    const removeSpy = vi.spyOn(fileIndex, "removeFileContent")

    await startFileWatcher(vault, fileIndex, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "temp.csv"), "id,name\n1,ephemeral-data-row", "utf8")
    await waitFor(() => upsertSpy.mock.calls.length > 0)

    await unlink(join(vault, "temp.csv"))
    await waitFor(() => removeSpy.mock.calls.length > 0)

    const { results } = await fileIndex.hybridSearch({ query: "ephemeral-data-row" }, logger)
    expect(results).toHaveLength(0)
  })

  it("indexes a PDF file via extractPdfText", { timeout: 15000 }, async () => {
    const { buildMinimalPdf } = await import("../../obsidian-markdown/__tests__/pdf-fixture.js")
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })
    const upsertSpy = vi.spyOn(fileIndex, "upsertFileContent")

    await startFileWatcher(vault, fileIndex, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "doc.pdf"), buildMinimalPdf())
    await waitFor(() => upsertSpy.mock.calls.length > 0)

    const { results } = await fileIndex.hybridSearch({ query: "Hello PDF" }, logger)
    const pdfResult = results.find((result) => result.path === "doc.pdf")
    expect(pdfResult?.kind).toBe("file")
    expect(pdfResult?.extension).toBe(".pdf")
  })

  it("calls embedFileContent when indexing a non-md file", { timeout: 15000 }, async () => {
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })
    const embedFileSpy = vi.spyOn(fileIndex, "embedFileContent")
    const capturedVersion = Promise.withResolvers<symbol>()
    const realUpsert = fileIndex.upsertFileContent
    vi.spyOn(fileIndex, "upsertFileContent").mockImplementation((params, requestLogger) => {
      const sourceVersion = realUpsert(params, requestLogger)
      capturedVersion.resolve(sourceVersion)
      return sourceVersion
    })

    await startFileWatcher(vault, fileIndex, {
      stabilityThreshold: 200,
      pollInterval: 50,
    })

    await writeFile(join(vault, "data.csv"), "id,name,value\n1,deploy,active\n", "utf8")

    await waitFor(() => embedFileSpy.mock.calls.length > 0)
    const sourceVersion = await capturedVersion.promise
    expect(embedFileSpy).toHaveBeenCalledExactlyOnceWith(
      { filePath: "data.csv", sourceVersion },
      logger,
    )
  })
})

describe("startFileWatcher — obsolete events and embedding queues", () => {
  const createControlledWatcher = async (embedder?: Parameters<typeof createSearchIndex>[1]) => {
    const testVault = await mkdtemp(join(tmpdir(), "watcher-events-"))
    onTestFinished(() => rm(testVault, { recursive: true }))
    const databasePath = join(testVault, "index.db")
    const search = createSearchIndex(databasePath, embedder, undefined, { fileToolsEnabled: true })
    const database = new Database(databasePath, { readonly: true })
    sqliteVec.load(database)
    onTestFinished(() => {
      database.close()
    })
    const watcher = new FSWatcher()
    const watchMock = vi.mocked(watch).mockReturnValue(watcher)
    onTestFinished(async () => {
      watchMock.mockRestore()
      await watcher.close()
    })
    const starting = startFileWatcher(testVault, search)
    watcher.emit("ready")
    await starting

    const fire = async (event: "add" | "change" | "unlink", fileName: string): Promise<void> => {
      const handler = watcher.listeners(event)[0]

      if (!handler) throw new Error(`${event} handler was not registered`)
      // EventEmitter types listeners as void, but the change handler returns
      // its actual promise, so awaiting it observes all indexing work.
      await handler(join(testVault, fileName))
    }
    return { testVault, search, database, fire }
  }

  it("re-indexes a changed note whose block is not valid YAML from its body, with no error", async () => {
    const { testVault, search, fire } = await createControlledWatcher()
    await writeFile(join(testVault, "note.md"), "---\ntags: [plan]\n---\nolder amber text\n")
    await fire("add", "note.md")
    expect(search.fullTextSearch({ query: "amber" }, logger).map((hit) => hit.path)).toEqual([
      "note.md",
    ])
    const errorSpy = vi.spyOn(logger, "error")
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    })

    await writeFile(
      join(testVault, "note.md"),
      "---\ntitle: Meeting: Q3 plan\n---\nnewer opal text\n",
    )
    await fire("change", "note.md")

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "indexed note without its properties block, which is not readable",
      {
        path: "note.md",
        error:
          "[Error]: properties block is not valid YAML at line 2, column 8: Nested mappings are not allowed in compact mappings",
      },
    )
    expect(search.fullTextSearch({ query: "amber" }, logger)).toEqual([])
    expect(search.fullTextSearch({ query: "opal" }, logger).map((hit) => hit.path)).toEqual([
      "note.md",
    ])
    expect(search.searchByTag({ tag: "plan" }, logger)).toEqual([])
  })

  it.each([{ event: "add" }, { event: "change" }] as const)(
    "contains a non-markdown stat failure during $event and recovers",
    async ({ event }) => {
      const { testVault, database, fire } = await createControlledWatcher()
      const filePath = join(testVault, "image.png")
      await writeFile(filePath, "image data")
      const actualFs =
        await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")
      const failedPaths = new Set([filePath])
      const statSpy = vi.mocked(statOrNull).mockImplementation(async (requestedPath) => {
        if (failedPaths.has(requestedPath)) throw new Error("controlled stat failure")
        return actualFs.statOrNull(requestedPath)
      })
      const errorSpy = vi.spyOn(logger, "error")
      onTestFinished(() => {
        statSpy.mockRestore()
        errorSpy.mockRestore()
      })

      await expect(fire(event, "image.png")).resolves.toBeUndefined()
      expect(statSpy).toHaveBeenCalledWith(filePath)
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to stat non-md file", {
        path: "image.png",
        error: "[Error]: controlled stat failure",
      })
      expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
      failedPaths.delete(filePath)
      await fire(event, "image.png")
      expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([
        { path: "image.png" },
      ])
      expect(errorSpy).toHaveBeenCalledTimes(1)
    },
  )

  it.each([{ event: "add" }, { event: "change" }] as const)(
    "contains an asset metadata upsert failure during $event and recovers",
    async ({ event }) => {
      const { testVault, search, database, fire } = await createControlledWatcher()
      const filePath = join(testVault, "content.txt")
      await writeFile(filePath, "currentopal")
      const realUpsert = search.upsertNonMdFile
      const failedPaths = new Set(["content.txt"])
      const upsertSpy = vi
        .spyOn(search, "upsertNonMdFile")
        .mockImplementation((requestedPath, bytes) => {
          if (failedPaths.has(requestedPath)) throw new Error("controlled asset upsert failure")
          realUpsert(requestedPath, bytes)
        })
      const contentUpsertSpy = vi.spyOn(search, "upsertFileContent")
      const errorSpy = vi.spyOn(logger, "error")
      onTestFinished(() => errorSpy.mockRestore())

      await expect(fire(event, "content.txt")).resolves.toBeUndefined()
      expect(upsertSpy).toHaveBeenCalledExactlyOnceWith(
        "content.txt",
        Buffer.byteLength("currentopal"),
      )
      expect(contentUpsertSpy).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to index non-md file metadata", {
        path: "content.txt",
        error: "[Error]: controlled asset upsert failure",
      })
      expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
      failedPaths.delete("content.txt")
      await fire(event, "content.txt")
      expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([
        { path: "content.txt" },
      ])
      expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([
        { path: "content.txt", content: "currentopal" },
      ])
      expect(errorSpy).toHaveBeenCalledTimes(1)
    },
  )

  it("removes independent file content after a metadata removal failure and retries metadata later", async () => {
    const { testVault, search, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, "content.txt")
    await writeFile(filePath, "currentopal")
    await fire("add", "content.txt")
    await unlink(filePath)
    const realRemove = search.removeNonMdFile
    const removeSpy = vi.spyOn(search, "removeNonMdFile").mockImplementation((requestedPath) => {
      if (requestedPath === "content.txt") throw new Error("controlled asset removal failure")
      realRemove(requestedPath)
    })
    const contentRemoveSpy = vi.spyOn(search, "removeFileContent")
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())

    await expect(fire("unlink", "content.txt")).resolves.toBeUndefined()
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith("content.txt")
    expect(contentRemoveSpy).toHaveBeenCalledExactlyOnceWith({ filePath: "content.txt" }, logger)
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to remove non-md file metadata", {
      path: "content.txt",
      error: "[Error]: controlled asset removal failure",
    })
    expect(await statOrNull(filePath)).toBeNull()
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([
      { path: "content.txt" },
    ])
    expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([])
    removeSpy.mockRestore()
    await fire("unlink", "content.txt")
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
    expect(database.prepare("SELECT path FROM file_content").all()).toEqual([])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("reports both independent unlink failures and recovers on a later event", async () => {
    const { testVault, search, database, fire } = await createControlledWatcher()
    await writeFile(join(testVault, "content.txt"), "currentopal")
    await fire("add", "content.txt")
    await unlink(join(testVault, "content.txt"))
    const metadataSpy = vi.spyOn(search, "removeNonMdFile").mockImplementationOnce(() => {
      throw new Error("metadata removal failed")
    })
    const contentSpy = vi.spyOn(search, "removeFileContent").mockImplementationOnce(() => {
      throw new Error("content removal failed")
    })
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())

    await fire("unlink", "content.txt")

    expect(metadataSpy).toHaveBeenCalledExactlyOnceWith("content.txt")
    expect(contentSpy).toHaveBeenCalledExactlyOnceWith({ filePath: "content.txt" }, logger)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledWith("failed to remove non-md file metadata", {
      path: "content.txt",
      error: "[Error]: metadata removal failed",
    })
    expect(errorSpy).toHaveBeenCalledWith("failed to remove file content", {
      path: "content.txt",
      error: "[Error]: content removal failed",
    })
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([
      { path: "content.txt" },
    ])
    expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([
      { path: "content.txt", content: "currentopal" },
    ])
    await fire("unlink", "content.txt")
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
    expect(database.prepare("SELECT path FROM file_content").all()).toEqual([])
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })

  it("cleans canvas links and vectors and rejects its held model after metadata removal fails", async () => {
    const vector = new Float32Array(384).fill(0.1)
    const modelEntered = Promise.withResolvers<undefined>()
    const releaseModel = Promise.withResolvers<Float32Array>()
    const modelFinished = Promise.withResolvers<undefined>()
    const embedder = {
      embedText: vi
        .fn()
        .mockResolvedValueOnce(vector)
        .mockImplementationOnce(() => {
          modelEntered.resolve(undefined)
          return releaseModel.promise
        }),
      embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => vector)),
    }
    const { testVault, search, database, fire } = await createControlledWatcher(embedder)
    const canvasContent = (text: string): string =>
      JSON.stringify({
        nodes: [
          { id: "text", type: "text", x: 0, y: 0, width: 100, height: 100, text },
          { id: "file", type: "file", x: 0, y: 200, width: 100, height: 100, file: "target.md" },
        ],
        edges: [],
      })
    search.upsertNote(
      { filePath: "target.md", rawContent: "targetamber", fileStat: { mtimeMs: 1000, size: 11 } },
      logger,
    )
    search.upsertNonMdFile("board.canvas", 100)
    const initialVersion = search.upsertFileContent(
      {
        filePath: "board.canvas",
        rawContent: canvasContent("oldquartz"),
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    await search.embedFileContent(
      { filePath: "board.canvas", sourceVersion: initialVersion },
      logger,
    )
    expect(database.prepare("SELECT COUNT(*) AS count FROM file_content_vectors").get()).toEqual({
      count: 1,
    })
    expect(search.getBacklinks({ path: "target.md" }, logger).map((link) => link.path)).toEqual([
      "board.canvas",
    ])
    const realEmbed = search.embedFileContent
    const pendingJobs: Promise<void>[] = []
    vi.spyOn(search, "embedFileContent").mockImplementation((params, requestLogger) => {
      const modelJob = realEmbed(params, requestLogger)
      pendingJobs.push(modelJob)
      // The detached job must settle before the fixture is removed.
      return modelJob.finally(() => modelFinished.resolve(undefined))
    })
    onTestFinished(async () => {
      releaseModel.resolve(vector)
      await Promise.allSettled(pendingJobs)
    })
    await writeFile(join(testVault, "board.canvas"), canvasContent("newopal"))
    await fire("change", "board.canvas")
    await modelEntered.promise
    await unlink(join(testVault, "board.canvas"))
    const metadataSpy = vi.spyOn(search, "removeNonMdFile").mockImplementationOnce(() => {
      throw new Error("metadata removal failed")
    })
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())

    await fire("unlink", "board.canvas")

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to remove non-md file metadata", {
      path: "board.canvas",
      error: "[Error]: metadata removal failed",
    })
    expect(
      database.prepare("SELECT path FROM non_md_files WHERE path = 'board.canvas'").all(),
    ).toEqual([{ path: "board.canvas" }])
    expect(database.prepare("SELECT path FROM file_content").all()).toEqual([])
    expect(database.prepare("SELECT file_path FROM file_content_chunks").all()).toEqual([])
    expect(database.prepare("SELECT COUNT(*) AS count FROM file_content_vectors").get()).toEqual({
      count: 0,
    })
    expect(search.getBacklinks({ path: "target.md" }, logger)).toEqual([])
    releaseModel.resolve(vector)
    await modelFinished.promise
    expect(database.prepare("SELECT file_path FROM file_content_chunks").all()).toEqual([])
    expect(database.prepare("SELECT COUNT(*) AS count FROM file_content_vectors").get()).toEqual({
      count: 0,
    })
    await fire("unlink", "board.canvas")
    expect(
      database.prepare("SELECT path FROM non_md_files WHERE path = 'board.canvas'").all(),
    ).toEqual([])
    expect(metadataSpy).toHaveBeenCalledTimes(2)
  })

  it.each([{ event: "add" }, { event: "change" }] as const)(
    "contains a non-markdown read failure during $event and recovers",
    async ({ event }) => {
      const { testVault, search, database, fire } = await createControlledWatcher()
      const filePath = join(testVault, "content.txt")
      await writeFile(filePath, "currentopal")
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      const readSpy = vi.mocked(readFile).mockImplementation(async (requestedPath, options) => {
        if (requestedPath === filePath) throw new Error("controlled content read failure")
        return actualFs.readFile(requestedPath, options)
      })
      const contentSpy = vi.spyOn(search, "upsertFileContent")
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => {
        readSpy.mockRestore()
        warnSpy.mockRestore()
      })

      await expect(fire(event, "content.txt")).resolves.toBeUndefined()
      expect(readSpy).toHaveBeenCalledWith(filePath, "utf8")
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith("file content indexing failed", {
        path: "content.txt",
        error: "[Error]: controlled content read failure",
      })
      expect(contentSpy).not.toHaveBeenCalled()
      expect(database.prepare("SELECT path, bytes FROM non_md_files").all()).toEqual([
        { path: "content.txt", bytes: Buffer.byteLength("currentopal") },
      ])
      expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([])
      readSpy.mockRestore()
      await fire(event, "content.txt")
      expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([
        { path: "content.txt", content: "currentopal" },
      ])
      expect(warnSpy).toHaveBeenCalledTimes(1)
    },
  )

  it.each([{ event: "add" }, { event: "change" }] as const)(
    "contains a PDF extraction failure during $event and recovers",
    async ({ event }) => {
      const { testVault, search, database, fire } = await createControlledWatcher()
      await writeFile(join(testVault, "doc.pdf"), "controlled PDF bytes")
      const extractSpy = vi
        .mocked(extractPdfText)
        .mockRejectedValueOnce(new Error("controlled PDF extraction failure"))
        .mockResolvedValueOnce({ text: "recoveredopal", totalPages: 1 })
      const contentSpy = vi.spyOn(search, "upsertFileContent")
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => {
        extractSpy.mockRestore()
        warnSpy.mockRestore()
      })

      await expect(fire(event, "doc.pdf")).resolves.toBeUndefined()
      expect(extractSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith("file content indexing failed", {
        path: "doc.pdf",
        error: "[Error]: controlled PDF extraction failure",
      })
      expect(contentSpy).not.toHaveBeenCalled()
      expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([{ path: "doc.pdf" }])
      expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([])
      await fire(event, "doc.pdf")
      expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([
        { path: "doc.pdf", content: "recoveredopal" },
      ])
      expect(extractSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    },
  )

  it("contains a file content removal failure during unlink and allows a later unlink", async () => {
    const { testVault, search, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, "content.txt")
    await writeFile(filePath, "currentopal")
    await fire("add", "content.txt")
    await unlink(filePath)
    const realRemove = search.removeFileContent
    const removeSpy = vi
      .spyOn(search, "removeFileContent")
      .mockImplementation((params, requestLogger) => {
        if (params.filePath === "content.txt") throw new Error("controlled content removal failure")
        realRemove(params, requestLogger)
      })
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())

    await expect(fire("unlink", "content.txt")).resolves.toBeUndefined()
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith({ filePath: "content.txt" }, logger)
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to remove file content", {
      path: "content.txt",
      error: "[Error]: controlled content removal failure",
    })
    expect(await statOrNull(filePath)).toBeNull()
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
    expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([
      { path: "content.txt", content: "currentopal" },
    ])
    removeSpy.mockRestore()
    await fire("unlink", "content.txt")
    expect(database.prepare("SELECT path FROM file_content").all()).toEqual([])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("contains a note removal failure during unlink and allows a later unlink", async () => {
    const { testVault, search, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, "note.md")
    await writeFile(filePath, "currentopal")
    await fire("add", "note.md")
    await unlink(filePath)
    const realRemove = search.removeNote
    const removeSpy = vi.spyOn(search, "removeNote").mockImplementation((requestedPath) => {
      if (requestedPath === "note.md") throw new Error("controlled note removal failure")
      realRemove(requestedPath)
    })
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())

    await expect(fire("unlink", "note.md")).resolves.toBeUndefined()
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith("note.md")
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to remove note from index", {
      path: "note.md",
      error: "[Error]: controlled note removal failure",
    })
    expect(await statOrNull(filePath)).toBeNull()
    expect(database.prepare("SELECT path, content FROM notes").all()).toEqual([
      { path: "note.md", content: "currentopal" },
    ])
    removeSpy.mockRestore()
    await fire("unlink", "note.md")
    expect(database.prepare("SELECT path FROM notes").all()).toEqual([])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it.each([{ operation: "read" }, { operation: "stat" }] as const)(
    "treats a note disappearing during its $operation as a benign source race",
    async ({ operation }) => {
      const { testVault, search, database, fire } = await createControlledWatcher()
      const filePath = join(testVault, "note.md")
      await writeFile(filePath, "committedamber")
      await fire("add", "note.md")
      const missingSource = Object.assign(new Error("controlled missing source"), {
        code: "ENOENT",
      })
      const sourceSpy = operation === "read" ? vi.mocked(readFile) : vi.mocked(stat)
      sourceSpy.mockRejectedValueOnce(missingSource)
      const upsertSpy = vi.spyOn(search, "upsertNote")
      const embedSpy = vi.spyOn(search, "embedNote")
      const debugSpy = vi.spyOn(logger, "debug")
      const errorSpy = vi.spyOn(logger, "error")
      onTestFinished(() => {
        sourceSpy.mockRestore()
        debugSpy.mockRestore()
        errorSpy.mockRestore()
      })

      await expect(fire("change", "note.md")).resolves.toBeUndefined()

      expect(debugSpy).toHaveBeenCalledExactlyOnceWith("change event skipped, file vanished", {
        path: "note.md",
      })
      expect(errorSpy).not.toHaveBeenCalled()
      expect(upsertSpy).not.toHaveBeenCalled()
      expect(embedSpy).not.toHaveBeenCalled()
      expect(database.prepare("SELECT path, content FROM notes").all()).toEqual([
        { path: "note.md", content: "committedamber" },
      ])
      await unlink(filePath)
      await fire("unlink", "note.md")
      expect(database.prepare("SELECT path, content FROM notes").all()).toEqual([])
      await writeFile(filePath, "recoveredopal")
      await fire("add", "note.md")
      expect(database.prepare("SELECT path, content FROM notes").all()).toEqual([
        { path: "note.md", content: "recoveredopal" },
      ])
      expect(upsertSpy).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { operation: "read", code: "EACCES" },
    { operation: "stat", code: "EIO" },
    { operation: "upsert", code: "ENOENT" },
    { operation: "embed", code: "ENOENT" },
  ] as const)("keeps $operation $code failures at error level", async ({ operation, code }) => {
    const { testVault, search, fire } = await createControlledWatcher()
    await writeFile(join(testVault, "note.md"), "currentamber")
    const failure = Object.assign(new Error("controlled operation failure"), { code })
    const errorSpy = vi.spyOn(logger, "error")
    const debugSpy = vi.spyOn(logger, "debug")
    const restoreOperations: Array<() => void> = []
    onTestFinished(() => {
      restoreOperations.forEach((restore) => restore())
      errorSpy.mockRestore()
      debugSpy.mockRestore()
    })
    if (operation === "read") {
      vi.mocked(readFile).mockRejectedValueOnce(failure)
      restoreOperations.push(() => vi.mocked(readFile).mockRestore())
    }
    if (operation === "stat") {
      vi.mocked(stat).mockRejectedValueOnce(failure)
      restoreOperations.push(() => vi.mocked(stat).mockRestore())
    }
    if (operation === "upsert") {
      const upsertSpy = vi.spyOn(search, "upsertNote").mockImplementationOnce(() => {
        throw failure
      })
      restoreOperations.push(() => upsertSpy.mockRestore())
    }
    if (operation === "embed") {
      const embedSpy = vi.spyOn(search, "embedNote").mockRejectedValueOnce(failure)
      restoreOperations.push(() => embedSpy.mockRestore())
    }

    await expect(fire("add", "note.md")).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("failed to process file change", {
      path: "note.md",
      error: "[Error]: controlled operation failure",
    })
    expect(debugSpy).not.toHaveBeenCalledWith("change event skipped, file vanished", {
      path: "note.md",
    })
  })

  const delayFirstRead = async (filePath: string) => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const delayedPaths = new Set<string>()
    vi.mocked(readFile).mockImplementation(async (requestedPath, options) => {
      const content = await actualFs.readFile(requestedPath, options)

      if (requestedPath === filePath && !delayedPaths.has(filePath)) {
        delayedPaths.add(filePath)
        entered.resolve(undefined)
        await release.promise
      }
      return content
    })
    onTestFinished(() => vi.mocked(readFile).mockRestore())
    return { entered: entered.promise, release: () => release.resolve(undefined) }
  }

  it.each([
    { fileName: "note.md", sourceTable: "notes" },
    { fileName: "content.txt", sourceTable: "file_content" },
  ])("rejects a delayed $fileName read after unlink", async ({ fileName, sourceTable }) => {
    const { testVault, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, fileName)
    await writeFile(filePath, "oldquartz")
    await fire("change", fileName)
    const delayedRead = await delayFirstRead(filePath)
    const lateChange = fire("change", fileName)
    await delayedRead.entered
    await unlink(filePath)
    await fire("unlink", fileName)

    expect(database.prepare(`SELECT path FROM ${sourceTable}`).all()).toEqual([])
    delayedRead.release()
    await lateChange
    expect(database.prepare(`SELECT path FROM ${sourceTable}`).all()).toEqual([])
    expect(database.prepare("SELECT path FROM notes").all()).toEqual([])
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
  })

  it.each([
    { fileName: "note.md", sourceTable: "notes" },
    { fileName: "content.txt", sourceTable: "file_content" },
  ])(
    "rejects an older $fileName read after the newer handler finishes",
    async ({ fileName, sourceTable }) => {
      const { testVault, database, fire } = await createControlledWatcher()
      const filePath = join(testVault, fileName)
      await writeFile(filePath, "oldquartz")
      const delayedRead = await delayFirstRead(filePath)
      const olderChange = fire("change", fileName)
      await delayedRead.entered
      await writeFile(filePath, "newopal")
      await fire("change", fileName)

      expect(database.prepare(`SELECT path, content FROM ${sourceTable}`).all()).toEqual([
        { path: fileName, content: "newopal" },
      ])
      delayedRead.release()
      await olderChange
      expect(database.prepare(`SELECT path, content FROM ${sourceTable}`).all()).toEqual([
        { path: fileName, content: "newopal" },
      ])
    },
  )

  it("keeps the newer event active when an older handler finishes first", async () => {
    const { testVault, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, "note.md")
    await writeFile(filePath, "oldquartz")
    const olderRead = await delayFirstRead(filePath)
    const olderChange = fire("change", "note.md")
    await olderRead.entered
    await writeFile(filePath, "newopal")
    const newerRead = await delayFirstRead(filePath)
    const newerChange = fire("change", "note.md")
    await newerRead.entered
    olderRead.release()
    await olderChange
    expect(database.prepare("SELECT path FROM notes").all()).toEqual([])
    newerRead.release()
    await newerChange
    expect(database.prepare("SELECT path, content FROM notes").all()).toEqual([
      { path: "note.md", content: "newopal" },
    ])
  })

  it("keeps the committed note when a newer read fails and an older read finishes late", async () => {
    const { testVault, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, "note.md")
    await writeFile(filePath, "committedamber")
    await fire("change", "note.md")
    await writeFile(filePath, "oldquartz")
    const delayedRead = await delayFirstRead(filePath)
    const olderChange = fire("change", "note.md")
    await delayedRead.entered
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(readFile).mockImplementation(async (requestedPath, options) => {
      if (requestedPath === filePath) throw new Error("controlled read failure")
      return actualFs.readFile(requestedPath, options)
    })
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())
    await fire("change", "note.md")
    delayedRead.release()
    await olderChange

    expect(errorSpy).toHaveBeenCalledWith("failed to process file change", {
      path: "note.md",
      error: "[Error]: controlled read failure",
    })
    expect(database.prepare("SELECT path, content FROM notes").all()).toEqual([
      { path: "note.md", content: "committedamber" },
    ])
  })

  it("rejects non-markdown metadata after unlink during stat", async () => {
    const { testVault, database, fire } = await createControlledWatcher()
    const filePath = join(testVault, "image.png")
    await writeFile(filePath, "image data")
    await fire("change", "image.png")
    const actualFs =
      await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")
    const statEntered = Promise.withResolvers<undefined>()
    const releaseStat = Promise.withResolvers<undefined>()
    vi.mocked(statOrNull).mockImplementation(async (requestedPath) => {
      const fileStat = await actualFs.statOrNull(requestedPath)

      if (requestedPath === filePath) {
        statEntered.resolve(undefined)
        await releaseStat.promise
      }
      return fileStat
    })
    onTestFinished(() => vi.mocked(statOrNull).mockRestore())
    const lateChange = fire("change", "image.png")
    await statEntered.promise
    await unlink(filePath)
    await fire("unlink", "image.png")
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
    releaseStat.resolve(undefined)
    await lateChange
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
  })

  it("rejects a PDF extraction that finishes after unlink", async () => {
    const { testVault, database, fire } = await createControlledWatcher()
    const { buildMinimalPdf } = await import("../../obsidian-markdown/__tests__/pdf-fixture.js")
    const filePath = join(testVault, "doc.pdf")
    await writeFile(filePath, buildMinimalPdf())
    const extractionEntered = Promise.withResolvers<undefined>()
    const releaseExtraction = Promise.withResolvers<undefined>()
    const actualPdf = await vi.importActual<typeof import("../../obsidian-markdown/pdf.js")>(
      "../../obsidian-markdown/pdf.js",
    )
    const extractionSpy = vi.mocked(extractPdfText).mockImplementation(async (pdfData) => {
      const extracted = await actualPdf.extractPdfText(pdfData)
      extractionEntered.resolve(undefined)
      await releaseExtraction.promise
      return extracted
    })
    onTestFinished(() => extractionSpy.mockRestore())
    const lateChange = fire("change", "doc.pdf")
    await extractionEntered.promise
    await unlink(filePath)
    await fire("unlink", "doc.pdf")
    expect(database.prepare("SELECT path FROM non_md_files").all()).toEqual([])
    releaseExtraction.resolve(undefined)
    await lateChange
    expect(database.prepare("SELECT path FROM file_content").all()).toEqual([])
    expect(extractionSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      fileName: "note.md",
      chunkTable: "note_chunks",
      vectorTable: "note_vectors",
      pathColumn: "note_path",
      prefix: "note",
    },
    {
      fileName: "content.txt",
      chunkTable: "file_content_chunks",
      vectorTable: "file_content_vectors",
      pathColumn: "file_path",
      prefix: "content",
    },
  ])(
    "skips obsolete queued $fileName jobs and retains the latest queue tail",
    async ({ fileName, chunkTable, vectorTable, pathColumn, prefix }) => {
      const firstEntered = Promise.withResolvers<undefined>()
      const releaseFirst = Promise.withResolvers<Float32Array>()
      const replacementEntered = Promise.withResolvers<undefined>()
      const releaseReplacement = Promise.withResolvers<Float32Array>()
      const finalEntered = Promise.withResolvers<undefined>()
      const releaseFinal = Promise.withResolvers<Float32Array>()
      const vector = new Float32Array(384).fill(0.1)
      const embedder = {
        embedText: vi.fn(async (text: string) => {
          if (text === `${prefix}\n\noldquartz`) {
            firstEntered.resolve(undefined)
            return releaseFirst.promise
          }
          if (text === `${prefix}\n\nnewopal`) {
            replacementEntered.resolve(undefined)
            return releaseReplacement.promise
          }
          if (text === `${prefix}\n\nfinalamber`) {
            finalEntered.resolve(undefined)
            return releaseFinal.promise
          }
          return vector
        }),
        embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => vector)),
      }
      const { testVault, database, search, fire } = await createControlledWatcher(embedder)
      const filePath = join(testVault, fileName)
      const sourceWritten = Promise.withResolvers<undefined>()
      const replacementSourceWritten = Promise.withResolvers<undefined>()
      const realUpsert = fileName.endsWith(".md") ? search.upsertNote : search.upsertFileContent
      const upsertName = fileName.endsWith(".md") ? "upsertNote" : "upsertFileContent"
      vi.spyOn(search, upsertName).mockImplementation(
        (
          params: Parameters<typeof realUpsert>[0],
          requestLogger: Parameters<typeof realUpsert>[1],
        ) => {
          const sourceVersion = realUpsert(params, requestLogger)

          if (params.rawContent === "queuedberyl") sourceWritten.resolve(undefined)
          if (params.rawContent === "newopal") replacementSourceWritten.resolve(undefined)
          return sourceVersion
        },
      )
      await writeFile(filePath, "oldquartz")
      const firstChange = fire("change", fileName)
      await firstEntered.promise
      await writeFile(filePath, "queuedberyl")
      const queuedChange = fire("change", fileName)
      await sourceWritten.promise
      await unlink(filePath)
      await fire("unlink", fileName)
      expect(
        database
          .prepare(`SELECT path FROM ${fileName.endsWith(".md") ? "notes" : "file_content"}`)
          .all(),
      ).toEqual([])
      await writeFile(filePath, "newopal")
      const replacementChange = fire("change", fileName)
      await replacementSourceWritten.promise
      releaseFirst.resolve(vector)
      await firstChange
      await queuedChange
      await replacementEntered.promise

      expect(embedder.embedText).toHaveBeenCalledTimes(2)
      expect(embedder.embedText).toHaveBeenNthCalledWith(1, `${prefix}\n\noldquartz`)
      expect(embedder.embedText).toHaveBeenNthCalledWith(2, `${prefix}\n\nnewopal`)
      expect(database.prepare(`SELECT chunk_text FROM ${chunkTable}`).all()).toEqual([])
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${vectorTable}`).get()).toEqual({
        count: 0,
      })

      const finalSourceWritten = Promise.withResolvers<undefined>()
      vi.spyOn(search, upsertName).mockImplementation(
        (
          params: Parameters<typeof realUpsert>[0],
          requestLogger: Parameters<typeof realUpsert>[1],
        ) => {
          const sourceVersion = realUpsert(params, requestLogger)
          finalSourceWritten.resolve(undefined)
          return sourceVersion
        },
      )
      const finalFileEmbedFinished = Promise.withResolvers<undefined>()
      const independentEmbedFinished = Promise.withResolvers<undefined>()
      const independentFileName = fileName.endsWith(".md") ? "sentry.md" : "sentry.txt"
      const realFileEmbed = search.embedFileContent
      vi.spyOn(search, "embedFileContent").mockImplementation(async (params, requestLogger) => {
        await realFileEmbed(params, requestLogger)
        if (params.filePath === fileName) finalFileEmbedFinished.resolve(undefined)
        if (params.filePath === independentFileName) independentEmbedFinished.resolve(undefined)
      })
      await writeFile(filePath, "finalamber")
      const finalChange = fire("change", fileName)
      await finalSourceWritten.promise
      // A different path completes while the replacement stays held, giving
      // any incorrectly unqueued final job time to reach its model call.
      await writeFile(join(testVault, independentFileName), "independentjade")
      await fire("change", independentFileName)
      if (!fileName.endsWith(".md")) await independentEmbedFinished.promise
      expect(embedder.embedText).toHaveBeenCalledTimes(3)
      releaseReplacement.resolve(vector)
      await replacementChange
      await finalEntered.promise
      expect(
        database
          .prepare(`SELECT chunk_text FROM ${chunkTable} WHERE ${pathColumn} = ?`)
          .all(fileName),
      ).toEqual([])
      releaseFinal.resolve(vector)
      await finalChange
      if (!fileName.endsWith(".md")) await finalFileEmbedFinished.promise
      const storedChunks = database
        .prepare(
          `SELECT ${pathColumn} AS path, chunk_text FROM ${chunkTable} WHERE ${pathColumn} = ?`,
        )
        .all(fileName)
      expect(storedChunks).toEqual([{ path: fileName, chunk_text: `${prefix}\n\nfinalamber` }])
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${vectorTable}`).get()).toEqual({
        count: 2,
      })
      expect(embedder.embedText).toHaveBeenCalledTimes(4)
    },
  )

  it("reports a detached file embedding failure and runs its queued replacement", async () => {
    const failingEntered = Promise.withResolvers<undefined>()
    const releaseFailure = Promise.withResolvers<Float32Array>()
    const recoveredEntered = Promise.withResolvers<undefined>()
    const releaseRecovered = Promise.withResolvers<Float32Array>()
    const recoveredFinished = Promise.withResolvers<undefined>()
    const failureLogged = Promise.withResolvers<undefined>()
    const vector = new Float32Array(384).fill(0.1)
    const embedder = {
      embedText: vi.fn(async (text: string) => {
        if (text === "content\n\noldquartz") {
          failingEntered.resolve(undefined)
          return releaseFailure.promise
        }
        if (text === "content\n\nnewopal") {
          recoveredEntered.resolve(undefined)
          return releaseRecovered.promise
        }
        return vector
      }),
      embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => vector)),
    }
    const { testVault, database, search, fire } = await createControlledWatcher(embedder)
    const realEmbed = search.embedFileContent
    vi.spyOn(search, "embedFileContent").mockImplementation(async (params, requestLogger) => {
      await realEmbed(params, requestLogger)
      recoveredFinished.resolve(undefined)
    })
    const errorSpy = vi.spyOn(logger, "error").mockImplementation((message) => {
      if (message === "file content embedding failed") failureLogged.resolve(undefined)
    })
    const debugSpy = vi.spyOn(logger, "debug")
    onTestFinished(() => {
      errorSpy.mockRestore()
      debugSpy.mockRestore()
    })
    const filePath = join(testVault, "content.txt")
    await writeFile(filePath, "oldquartz")
    await fire("change", "content.txt")
    await failingEntered.promise
    await writeFile(filePath, "newopal")
    await fire("change", "content.txt")
    expect(database.prepare("SELECT path, content FROM file_content").all()).toEqual([
      { path: "content.txt", content: "newopal" },
    ])

    releaseFailure.reject(new Error("controlled file model failure"))
    await failureLogged.promise
    await recoveredEntered.promise
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith("file content embedding failed", {
      path: "content.txt",
      error: "[Error]: controlled file model failure",
    })
    expect(debugSpy).toHaveBeenCalledWith("previous file embed failed, proceeding with current", {
      path: "content.txt",
      error: "[Error]: controlled file model failure",
    })
    expect(database.prepare("SELECT chunk_text FROM file_content_chunks").all()).toEqual([])
    releaseRecovered.resolve(vector)
    await recoveredFinished.promise
    expect(database.prepare("SELECT file_path, chunk_text FROM file_content_chunks").all()).toEqual(
      [{ file_path: "content.txt", chunk_text: "content\n\nnewopal" }],
    )
    expect(database.prepare("SELECT COUNT(*) AS count FROM file_content_vectors").get()).toEqual({
      count: 1,
    })
    expect(embedder.embedText).toHaveBeenCalledTimes(2)
  })

  it("recovers after a rejected job while another path embeds independently", async () => {
    const failingEntered = Promise.withResolvers<undefined>()
    const releaseFailure = Promise.withResolvers<Float32Array>()
    const recoveredEntered = Promise.withResolvers<undefined>()
    const releaseRecovered = Promise.withResolvers<Float32Array>()
    const vector = new Float32Array(384).fill(0.1)
    const embedder = {
      embedText: vi.fn(async (text: string) => {
        if (text === "note\n\noldquartz") {
          failingEntered.resolve(undefined)
          return releaseFailure.promise
        }
        if (text === "note\n\nnewopal") {
          recoveredEntered.resolve(undefined)
          return releaseRecovered.promise
        }
        return vector
      }),
      embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => vector)),
    }
    const { testVault, database, search, fire } = await createControlledWatcher(embedder)
    const sourceWritten = Promise.withResolvers<undefined>()
    const realUpsert = search.upsertNote
    vi.spyOn(search, "upsertNote").mockImplementation((params, requestLogger) => {
      const sourceVersion = realUpsert(params, requestLogger)

      if (params.rawContent === "newopal") sourceWritten.resolve(undefined)
      return sourceVersion
    })
    const errorSpy = vi.spyOn(logger, "error")
    const debugSpy = vi.spyOn(logger, "debug")
    onTestFinished(() => {
      errorSpy.mockRestore()
      debugSpy.mockRestore()
    })
    await writeFile(join(testVault, "note.md"), "oldquartz")
    const failingChange = fire("change", "note.md")
    await failingEntered.promise
    await writeFile(join(testVault, "note.md"), "newopal")
    const recoveredChange = fire("change", "note.md")
    await sourceWritten.promise
    await writeFile(join(testVault, "other.md"), "independentjade")
    await fire("change", "other.md")
    expect(database.prepare("SELECT note_path, chunk_text FROM note_chunks").all()).toEqual([
      { note_path: "other.md", chunk_text: "other\n\nindependentjade" },
    ])
    releaseFailure.reject(new Error("controlled model failure"))
    await failingChange
    await recoveredEntered.promise
    expect(errorSpy).toHaveBeenCalledWith("failed to process file change", {
      path: "note.md",
      error: "[Error]: controlled model failure",
    })
    expect(debugSpy).toHaveBeenCalledWith("previous embed failed, proceeding with current", {
      path: "note.md",
      error: "[Error]: controlled model failure",
    })
    releaseRecovered.resolve(vector)
    await recoveredChange
    expect(
      database.prepare("SELECT note_path, chunk_text FROM note_chunks ORDER BY note_path").all(),
    ).toEqual([
      { note_path: "note.md", chunk_text: "note\n\nnewopal" },
      { note_path: "other.md", chunk_text: "other\n\nindependentjade" },
    ])
    expect(embedder.embedText).toHaveBeenCalledTimes(3)
  })
})

describe("startFileWatcher — chokidar watch options", () => {
  registerSharedVaultHooks()

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
    watchMock.mockImplementation(() => createFakeWatcher() as unknown as ReturnType<typeof watch>)
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

  it("defaults awaitWriteFinish to 2000ms stability and 100ms poll interval", async () => {
    const chokidarOptions = await chokidarOptionsFrom()
    expect(chokidarOptions.awaitWriteFinish).toEqual({
      stabilityThreshold: 2000,
      pollInterval: 100,
    })
  })
})

// The chokidar race the rescan closes (a file landing between the
// new-directory scan and its watch registration) can't be forced from the
// outside, so these tests drive the reconciliation directly: a fake watcher
// captures the addDir handler, reports test-controlled tracking via
// getWatched(), and records add() calls — against a real temp vault and index.
describe("startFileWatcher — new-directory rescan", REAL_WATCHER_RETRY, () => {
  registerSharedVaultHooks()

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
    watchMock.mockImplementation(() => fakeWatcher as unknown as ReturnType<typeof watch>)
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

  it("indexes a file on disk that chokidar does not track", { timeout: 15000 }, async () => {
    const newDirectory = join(vault, "new-folder")
    await mkdir(newDirectory)
    const missedPath = join(newDirectory, "missed.md")
    await writeFile(missedPath, "missed by the scan\n", "utf8")
    await backdateMtime(missedPath)

    const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
    fireAddDir(newDirectory)

    await waitFor(() => index.fullTextSearch({ query: "missed" }, logger).length > 0)
    const results = index.fullTextSearch({ query: "missed" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("new-folder/missed.md")
    // The file must also be registered with chokidar — indexed but
    // untracked, its later deletion would emit no unlink (ghost entry).
    expect(addedPaths).toEqual([missedPath])
  })

  it("does not re-index a file chokidar already tracks", { timeout: 15000 }, async () => {
    const newDirectory = join(vault, "new-folder")
    await mkdir(newDirectory)
    const trackedPath = join(newDirectory, "tracked.md")
    const missedPath = join(newDirectory, "missed.md")
    await writeFile(trackedPath, "already tracked note\n", "utf8")
    await writeFile(missedPath, "missed sibling note\n", "utf8")
    await backdateMtime(trackedPath)
    await backdateMtime(missedPath)

    const upsertNoteSpy = vi.spyOn(index, "upsertNote")
    const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar(
      { [resolve(newDirectory)]: ["tracked.md"] },
      RESCAN_TEST_OPTIONS,
    )
    fireAddDir(newDirectory)

    // The untracked sibling getting indexed proves the rescan ran — the
    // tracked file being skipped can't be a silent no-op.
    await waitFor(() => index.fullTextSearch({ query: "sibling" }, logger).length > 0)
    expect(upsertNoteSpy).toHaveBeenCalledTimes(1)
    expect(upsertNoteSpy.mock.calls[0]?.[0]?.filePath).toBe("new-folder/missed.md")
    // Only the missed file is registered — the tracked one is not re-added.
    expect(addedPaths).toEqual([missedPath])
  })

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

      const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar(
        {},
        { ...RESCAN_TEST_OPTIONS, stabilityThreshold: 60_000 },
      )
      fireAddDir(newDirectory)

      // The settled sibling proves the rescan ran; the fresh file is skipped
      // at rescan time (its 60s retry timer never fires within this test).
      await waitFor(() => index.fullTextSearch({ query: "settled" }, logger).length > 0)
      const freshResults = index.fullTextSearch({ query: "fresh" }, logger)
      expect(freshResults).toHaveLength(0)
      // Skipping must not register the fresh file yet — only the settled file
      // is handed to watcher.add() during the rescan pass.
      expect(addedPaths).toEqual([settledPath])
    },
  )

  it("registers a missed subdirectory and indexes its contents", { timeout: 15000 }, async () => {
    const newDirectory = join(vault, "new-folder")
    const missedSubdirectory = join(newDirectory, "missed-subdir")
    await mkdir(missedSubdirectory, { recursive: true })
    const nestedPath = join(missedSubdirectory, "nested.md")
    await writeFile(nestedPath, "nested in a missed subdir\n", "utf8")
    await backdateMtime(nestedPath)

    const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
    fireAddDir(newDirectory)

    await waitFor(() => index.fullTextSearch({ query: "nested" }, logger).length > 0)
    const results = index.fullTextSearch({ query: "nested" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("new-folder/missed-subdir/nested.md")
    // The subdirectory and the missed file are both handed back to chokidar
    // so they gain watches and future events (unlink included) fire.
    expect(addedPaths).toEqual([missedSubdirectory, nestedPath])
  })

  it("ignores dot-directories during the rescan", { timeout: 15000 }, async () => {
    const newDirectory = join(vault, "new-folder")
    const hiddenDirectory = join(newDirectory, ".trash")
    await mkdir(hiddenDirectory, { recursive: true })
    const hiddenPath = join(hiddenDirectory, "hidden.md")
    const visiblePath = join(newDirectory, "visible.md")
    await writeFile(hiddenPath, "hidden rescan note\n", "utf8")
    await writeFile(visiblePath, "visible rescan note\n", "utf8")
    await backdateMtime(hiddenPath)
    await backdateMtime(visiblePath)

    const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
    fireAddDir(newDirectory)

    await waitFor(() => index.fullTextSearch({ query: "visible" }, logger).length > 0)
    const hiddenResults = index.fullTextSearch({ query: "hidden" }, logger)
    expect(hiddenResults).toHaveLength(0)
    // The dot-directory must not be registered with chokidar — only the
    // visible missed file is.
    expect(addedPaths).toEqual([visiblePath])
  })

  it("indexes settled files inside a missed symlinked directory", { timeout: 15000 }, async () => {
    // The recursive readdir doesn't traverse symlinks, so a symlinked
    // directory's contents need their own reconciliation pass.
    const targetDirectory = join(vault, "target-dir")
    await mkdir(targetDirectory)
    const insidePath = join(targetDirectory, "inside.md")
    await writeFile(insidePath, "inside a symlinked folder\n", "utf8")
    await backdateMtime(insidePath)
    const newDirectory = join(vault, "new-folder")
    await mkdir(newDirectory)
    const linkedDirectory = join(newDirectory, "linked-dir")
    await symlink(targetDirectory, linkedDirectory)

    const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
    fireAddDir(newDirectory)

    await waitFor(() => index.fullTextSearch({ query: "symlinked" }, logger).length > 0)
    const results = index.fullTextSearch({ query: "symlinked" }, logger)
    expect(results).toHaveLength(1)
    // Indexed under the link path, matching chokidar's followSymlinks view.
    expect(results[0]?.path).toBe("new-folder/linked-dir/inside.md")
    // The inner file registers during the recursion, then the link itself.
    expect(addedPaths).toEqual([join(linkedDirectory, "inside.md"), linkedDirectory])
  })

  it(
    "retries and indexes a still-being-written file inside a missed symlinked directory",
    { timeout: 15000 },
    async () => {
      // A file mid-write inside a directory chokidar never watched gets no
      // replay event once watcher.add() registers the directory silently —
      // the rescan must retry after the write settles instead of skipping
      // it forever.
      const targetDirectory = join(vault, "target-dir")
      await mkdir(targetDirectory)
      const insidePath = join(targetDirectory, "inside.md")
      await writeFile(insidePath, "inside a symlinked folder\n", "utf8")
      const newDirectory = join(vault, "new-folder")
      await mkdir(newDirectory)
      const linkedDirectory = join(newDirectory, "linked-dir")
      await symlink(targetDirectory, linkedDirectory)

      const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar(
        {},
        // 1s stability window: the fresh mtime is inside it when the rescan
        // fires (~50ms), forcing the retry path; the retry lands ~1s later.
        { ...RESCAN_TEST_OPTIONS, stabilityThreshold: 1000 },
      )
      // Re-touch right before the addDir so a slow test runner can't let the
      // file settle before the rescan fires — the retry must be the only path.
      const now = new Date()
      await utimes(insidePath, now, now)
      fireAddDir(newDirectory)

      await waitFor(() => index.fullTextSearch({ query: "symlinked" }, logger).length > 0)
      const results = index.fullTextSearch({ query: "symlinked" }, logger)
      expect(results).toHaveLength(1)
      expect(results[0]?.path).toBe("new-folder/linked-dir/inside.md")
      // Registration order proves the retry ran: the symlinked directory
      // registered during the rescan; the file only after its retry settled.
      expect(addedPaths).toEqual([linkedDirectory, join(linkedDirectory, "inside.md")])
    },
  )

  it(
    "indexes a cycling symlinked directory's sibling exactly once",
    { timeout: 15000 },
    async () => {
      // A symlink pointing back at its own ancestor must not recurse — without
      // the realpath cycle guard the rescan would descend loop/loop/loop/…,
      // indexing ghost duplicates under each cycle path until ELOOP.
      const newDirectory = join(vault, "new-folder")
      await mkdir(newDirectory)
      const settledPath = join(newDirectory, "settled.md")
      await writeFile(settledPath, "settled beside a cycle\n", "utf8")
      await backdateMtime(settledPath)
      const loopLink = join(newDirectory, "loop")
      await symlink(newDirectory, loopLink)

      const upsertNoteSpy = vi.spyOn(index, "upsertNote")
      const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
      fireAddDir(newDirectory)

      await waitFor(() => upsertNoteSpy.mock.calls.length > 0)
      // Give a (broken) unbounded recursion time to produce extra upserts
      // before asserting the exact count.
      await new Promise((finished) => setTimeout(finished, 300))
      expect(upsertNoteSpy).toHaveBeenCalledTimes(1)
      expect(upsertNoteSpy.mock.calls[0]?.[0]?.filePath).toBe("new-folder/settled.md")
      // readdir order isn't guaranteed, so compare sorted ("loop" < "settled.md").
      expect([...addedPaths].sort()).toEqual([loopLink, settledPath])
    },
  )

  it("skips a broken symlink and still indexes its sibling", { timeout: 15000 }, async () => {
    const newDirectory = join(vault, "new-folder")
    await mkdir(newDirectory)
    const settledPath = join(newDirectory, "settled.md")
    await writeFile(settledPath, "settled beside a broken link\n", "utf8")
    await backdateMtime(settledPath)
    // A dangling .md symlink: readdir lists it, stat() throws ENOENT — the
    // rescan must swallow that and keep processing the rest of the listing.
    const danglingLink = join(newDirectory, "dangling.md")
    await symlink(join(newDirectory, "no-such-target.md"), danglingLink)

    const upsertNoteSpy = vi.spyOn(index, "upsertNote")
    // logger is module-shared — restore so the spy doesn't leak across tests.
    const debugSpy = vi.spyOn(logger, "debug")
    onTestFinished(() => debugSpy.mockRestore())
    const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
    fireAddDir(newDirectory)

    await waitFor(() => index.fullTextSearch({ query: "settled" }, logger).length > 0)
    // The skip log proves the broken link was actually encountered and
    // swallowed — not merely absent from the listing.
    expect(debugSpy).toHaveBeenCalledWith("rescan skipped unreadable entry", {
      path: "new-folder/dangling.md",
      error: expect.stringContaining("ENOENT"),
    })
    expect(upsertNoteSpy).toHaveBeenCalledTimes(1)
    expect(upsertNoteSpy.mock.calls[0]?.[0]?.filePath).toBe("new-folder/settled.md")
    expect(addedPaths).toEqual([settledPath])
  })

  it("defaults the rescan delay to twice the stability threshold", { timeout: 15000 }, async () => {
    const newDirectory = join(vault, "new-folder")
    await mkdir(newDirectory)
    const missedPath = join(newDirectory, "missed.md")
    await writeFile(missedPath, "missed by the scan\n", "utf8")
    await backdateMtime(missedPath)

    // Fake only setTimeout: queueMicrotask (the fake watcher's "ready") and
    // Date (waitFor's deadline, the mtime guard) must stay real.
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })

    // readdirOrNull is the rescan's synchronous first call — it registers
    // the moment the timer fires, unlike upsertNote, which sits behind real
    // filesystem I/O that fake-timer advancement doesn't wait for.
    const readdirSpy = vi.mocked(readdirOrNull)
    readdirSpy.mockClear()
    const { fireAddDir } = await startWatcherWithFakeChokidar(
      {},
      // No newDirectoryRescanDelay — expected default: 2 × 200ms = 400ms.
      { stabilityThreshold: 200, pollInterval: 50 },
    )
    fireAddDir(newDirectory)

    // One tick short of 2 × stabilityThreshold the rescan must not have
    // fired. The post-400ms half below proves the machinery is live, so
    // this half can't pass vacuously.
    await vi.advanceTimersByTimeAsync(399)
    expect(readdirSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(readdirSpy).toHaveBeenCalledWith(newDirectory)

    // The timer has fired; hand the event loop back to real timers so the
    // rescan's real-fs work (and waitFor's polling) can proceed, proving
    // the delayed rescan carries through to indexing.
    vi.useRealTimers()
    await waitFor(() => index.fullTextSearch({ query: "missed" }, logger).length > 0)
  })

  it(
    "skips the rescan when the directory was deleted before it fires",
    { timeout: 15000 },
    async () => {
      const upsertNoteSpy = vi.spyOn(index, "upsertNote")
      // logger is module-shared — restore so spies don't leak across tests.
      const debugSpy = vi.spyOn(logger, "debug")
      const errorSpy = vi.spyOn(logger, "error")
      onTestFinished(() => {
        debugSpy.mockRestore()
        errorSpy.mockRestore()
      })
      const { fireAddDir } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
      fireAddDir(join(vault, "never-created"))

      // The vanished-dir debug log is the side effect unique to the graceful
      // early-return — "no upserts" alone would also pass if the timer never
      // fired, or if the rescan crashed into the error handler instead.
      await waitFor(() =>
        debugSpy.mock.calls.some(([message]) => message === "rescan skipped, directory vanished"),
      )
      expect(debugSpy).toHaveBeenCalledWith("rescan skipped, directory vanished", {
        path: "never-created",
      })
      expect(upsertNoteSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalledWith("failed to rescan new directory", expect.anything())
    },
  )

  it(
    "logs the vanish at debug when the directory disappears after its listing",
    { timeout: 15000 },
    async () => {
      // Forces the narrower race: the listing succeeds (mocked) but the
      // directory is gone by the realpath call. That's the same benign
      // vanish as an ENOENT listing — it must not surface as an error.
      const readdirSpy = vi.mocked(readdirOrNull)
      readdirSpy.mockResolvedValueOnce([])
      // logger is module-shared — restore so spies don't leak across tests.
      const debugSpy = vi.spyOn(logger, "debug")
      const errorSpy = vi.spyOn(logger, "error")
      onTestFinished(() => {
        debugSpy.mockRestore()
        errorSpy.mockRestore()
      })
      const { fireAddDir } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
      fireAddDir(join(vault, "vanished-mid-rescan"))

      // The mocked listing skips the null branch, so this debug log can only
      // come from the realpath vanish handling.
      await waitFor(() =>
        debugSpy.mock.calls.some(([message]) => message === "rescan skipped, directory vanished"),
      )
      expect(debugSpy).toHaveBeenCalledWith("rescan skipped, directory vanished", {
        path: "vanished-mid-rescan",
      })
      expect(errorSpy).not.toHaveBeenCalledWith("failed to rescan new directory", expect.anything())
    },
  )

  it(
    "indexes a file whose mtime is in the future instead of skipping it forever",
    { timeout: 15000 },
    async () => {
      // Clock skew across a Docker bind mount can stamp files with future
      // mtimes. A negative file age must count as settled — treating it as
      // "still being written" would skip the note on every pass.
      const newDirectory = join(vault, "new-folder")
      await mkdir(newDirectory)
      const skewedPath = join(newDirectory, "skewed.md")
      await writeFile(skewedPath, "future mtime clock skew\n", "utf8")
      const futureDate = new Date(Date.now() + 3_600_000)
      await utimes(skewedPath, futureDate, futureDate)

      const { fireAddDir, addedPaths } = await startWatcherWithFakeChokidar({}, RESCAN_TEST_OPTIONS)
      fireAddDir(newDirectory)

      await waitFor(() => index.fullTextSearch({ query: "skew" }, logger).length > 0)
      const results = index.fullTextSearch({ query: "skew" }, logger)
      expect(results).toHaveLength(1)
      expect(results[0]?.path).toBe("new-folder/skewed.md")
      expect(addedPaths).toEqual([skewedPath])
    },
  )
})
