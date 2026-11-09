import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  bootstrapMemoryIfEnabled,
  createShutdownHandler,
  resolveDataPaths,
  startServer,
} from "../server.js"
import { createBodyTagParser } from "../search/body-tag-parser.js"
import { createPdfExtractor } from "../vault-operations/pdf-extractor.js"
import { watchVaultAndBuildIndex } from "../search/file-watcher.js"
import { loadConfig } from "../config.js"
import { logger } from "../../logger.js"

vi.mock("../search/body-tag-parser.js", { spy: true })
vi.mock("../vault-operations/pdf-extractor.js", { spy: true })
vi.mock("../search/file-watcher.js", { spy: true })

describe("startServer", () => {
  it("rethrows the startup error after logging every failed cleanup with its cause", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "server-startup-cleanup-"))
    onTestFinished(async () => {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      await rm(vaultPath, { recursive: true, force: true })
    })
    vi.stubEnv("VAULT_PATH", vaultPath)
    vi.stubEnv("MCP_AUTH_TOKEN", "test-startup-token")
    vi.stubEnv("PUBLIC_URL", "http://localhost:8000")
    vi.stubEnv("INDEX_DB_PATH", join(vaultPath, "search.db"))
    vi.stubEnv("EMBEDDING_ENABLED", "false")
    vi.stubEnv("MEMORY_ENABLED", "false")
    const startupError = new Error("controlled startup failure")
    const pdfClose = vi.fn(async () => {
      throw new Error("PDF close failed", { cause: new Error("PDF termination failed") })
    })
    const parserClose = vi.fn(async () => {
      throw new Error("parser close failed", { cause: new Error("worker termination failed") })
    })
    vi.mocked(createPdfExtractor).mockReturnValue({
      close: pdfClose,
      extractForIndex: vi.fn(),
      readText: vi.fn(),
    })
    vi.mocked(createBodyTagParser).mockReturnValue({ close: parserClose, parse: vi.fn() })
    vi.mocked(watchVaultAndBuildIndex).mockRejectedValue(startupError)
    vi.spyOn(process, "once").mockReturnValue(process)
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})

    await expect(startServer()).rejects.toBe(startupError)

    expect(watchVaultAndBuildIndex).toHaveBeenCalledTimes(1)
    expect(pdfClose).toHaveBeenCalledExactlyOnceWith()
    expect(parserClose).toHaveBeenCalledExactlyOnceWith()
    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenNthCalledWith(1, "startup cleanup failed", {
      error: "[Error]: PDF close failed",
      cause: "[Error]: PDF termination failed",
    })
    expect(errorSpy).toHaveBeenNthCalledWith(2, "startup cleanup failed", {
      error: "[Error]: parser close failed",
      cause: "[Error]: worker termination failed",
    })
  })
})

describe("createShutdownHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(logger, "info").mockImplementation(() => {})
    vi.spyOn(logger, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const createClosingParser = () => ({ close: vi.fn(async () => undefined) })

  it("closes extraction and the server, and exits 0 once both finish", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    // close() that immediately invokes its callback = drain completes at once.
    const close = vi.fn((callback: () => void) => callback())
    const bodyTagParser = createClosingParser()
    const extractionClosed = Promise.withResolvers<undefined>()
    onTestFinished(() => extractionClosed.resolve(undefined))
    const pdfExtractor = { close: vi.fn(() => extractionClosed.promise) }

    try {
      createShutdownHandler({ httpServer: { close }, bodyTagParser, pdfExtractor })()
      expect(pdfExtractor.close).toHaveBeenCalledExactlyOnceWith()
      expect(pdfExtractor.close).toHaveBeenCalledBefore(close)
      expect(bodyTagParser.close).toHaveBeenCalledOnce()
      expect(bodyTagParser.close).toHaveBeenCalledBefore(close)
      expect(close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(0)
      expect(exitSpy).not.toHaveBeenCalled()
      extractionClosed.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(0)
    } finally {
      // Settle the mocked shutdown before the shared mock teardown can restore process.exit.
      extractionClosed.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("forces exit 1 if the drain does not finish within the timeout", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    // close() that never invokes its callback = drain hangs.
    const close = vi.fn()

    // Not the 10-second default, so the test fails if forceExitMs is ignored
    createShutdownHandler({
      httpServer: { close },
      bodyTagParser: createClosingParser(),
      pdfExtractor: createClosingParser(),
      forceExitMs: 5_000,
    })()

    vi.advanceTimersByTime(4_999)
    expect(exitSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
  })

  it("forces exit 1 after 10 seconds when no timeout is given", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    const close = vi.fn()

    createShutdownHandler({
      httpServer: { close },
      bodyTagParser: createClosingParser(),
      pdfExtractor: createClosingParser(),
    })()

    vi.advanceTimersByTime(9_999)
    expect(exitSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
  })

  it("waits for extraction and HTTP drain before exiting after a parser cleanup failure", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    const extractionClosed = Promise.withResolvers<undefined>()
    const drained = Promise.withResolvers<undefined>()
    const close = vi.fn(async (callback: () => void) => {
      await drained.promise
      callback()
    })
    const bodyTagParser = {
      close: vi.fn(async () => Promise.reject(new Error("terminate failed"))),
    }

    try {
      createShutdownHandler({
        httpServer: { close },
        bodyTagParser,
        pdfExtractor: { close: vi.fn(() => extractionClosed.promise) },
      })()
      await vi.advanceTimersByTimeAsync(0)
      expect(exitSpy).not.toHaveBeenCalled()
      extractionClosed.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(exitSpy).not.toHaveBeenCalled()
      drained.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(logger.warn).toHaveBeenCalledExactlyOnceWith("shutdown cleanup failed", {
        error: "[Error]: terminate failed",
      })
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      extractionClosed.resolve(undefined)
      drained.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it("logs every failed cleanup when extraction and the parser both fail to close", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())

    createShutdownHandler({
      httpServer: { close: vi.fn((callback: () => void) => callback()) },
      bodyTagParser: { close: vi.fn(async () => Promise.reject(new Error("terminate failed"))) },
      pdfExtractor: { close: vi.fn(async () => Promise.reject(new Error("kill failed"))) },
    })()
    await vi.advanceTimersByTimeAsync(0)

    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenNthCalledWith(1, "shutdown cleanup failed", {
      error: "[Error]: kill failed",
    })
    expect(logger.warn).toHaveBeenNthCalledWith(2, "shutdown cleanup failed", {
      error: "[Error]: terminate failed",
    })
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
  })
})

describe("bootstrapMemoryIfEnabled", () => {
  const createTempVault = async (): Promise<string> => {
    const vault = await mkdtemp(join(tmpdir(), "server-bootstrap-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    return vault
  }

  it("creates the memory folder with template files on a writable server", async () => {
    const vault = await createTempVault()

    await bootstrapMemoryIfEnabled(loadConfig({}), vault)

    const memoryFiles = await readdir(join(vault, "About Me"))
    expect(memoryFiles.sort()).toEqual([
      "Agents.md",
      "Me.md",
      "Opinions.md",
      "Principles.md",
      "Routines.md",
    ])
  })

  it("creates nothing in read-only mode — the vault stays untouched", async () => {
    const vault = await createTempVault()

    await bootstrapMemoryIfEnabled(loadConfig({ READONLY_MODE: "true" }), vault)

    // The writable-server test above proves the same call would otherwise
    // create the folder, so an empty vault here can't be a silent no-op.
    expect(await readdir(vault)).toEqual([])
  })

  it("creates nothing when the memory layer is disabled", async () => {
    const vault = await createTempVault()

    await bootstrapMemoryIfEnabled(loadConfig({ MEMORY_ENABLED: "false" }), vault)

    expect(await readdir(vault)).toEqual([])
  })
})

describe("resolveDataPaths", () => {
  it.each([
    { label: "unset", indexDbPathSetting: undefined },
    { label: "empty", indexDbPathSetting: "" },
  ])("keeps everything in /data when INDEX_DB_PATH is $label", ({ indexDbPathSetting }) => {
    expect(resolveDataPaths(indexDbPathSetting)).toEqual({
      searchDbPath: "/data/search.db",
      oauthDbPath: "/data/oauth.db",
      modelCacheDir: "/data/models",
    })
  })

  it.each([
    {
      label: "an absolute path",
      indexDbPathSetting: "/persist/data/index.db",
      expectedPaths: {
        searchDbPath: "/persist/data/index.db",
        oauthDbPath: "/persist/data/oauth.db",
        modelCacheDir: "/persist/data/models",
      },
    },
    {
      label: "a relative path",
      indexDbPathSetting: ".data/index.db",
      expectedPaths: {
        searchDbPath: ".data/index.db",
        oauthDbPath: ".data/oauth.db",
        modelCacheDir: ".data/models",
      },
    },
    {
      label: "a bare file name",
      indexDbPathSetting: "index.db",
      expectedPaths: {
        searchDbPath: "index.db",
        oauthDbPath: "./oauth.db",
        modelCacheDir: "./models",
      },
    },
  ])(
    "puts the OAuth database and the search models beside INDEX_DB_PATH when it is $label",
    ({ indexDbPathSetting, expectedPaths }) => {
      expect(resolveDataPaths(indexDbPathSetting)).toEqual(expectedPaths)
    },
  )
})
