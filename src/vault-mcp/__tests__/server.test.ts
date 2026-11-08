import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { bootstrapMemoryIfEnabled, createShutdownHandler, resolveDataPaths } from "../server.js"
import { loadConfig } from "../config.js"
import { logger } from "../../logger.js"

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

  it("closes the body-tag parser and the server, and exits 0 once draining completes", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    // close() that immediately invokes its callback = drain completes at once.
    const close = vi.fn((callback: () => void) => callback())
    const bodyTagParser = createClosingParser()

    createShutdownHandler({ httpServer: { close }, bodyTagParser })()

    expect(bodyTagParser.close).toHaveBeenCalledOnce()
    // The parser closes first, so the background pass stops before the drain
    expect(bodyTagParser.close).toHaveBeenCalledBefore(close)
    expect(close).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(0)
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

    createShutdownHandler({ httpServer: { close }, bodyTagParser: createClosingParser() })()

    vi.advanceTimersByTime(9_999)
    expect(exitSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
  })

  it("logs a body-tag parser that fails to close and still drains", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    const close = vi.fn((callback: () => void) => callback())
    const bodyTagParser = {
      close: vi.fn(async () => Promise.reject(new Error("terminate failed"))),
    }

    createShutdownHandler({ httpServer: { close }, bodyTagParser })()
    // Settles the rejected close without reaching the force-exit timer
    await vi.advanceTimersByTimeAsync(0)

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("body-tag parser did not close cleanly", {
      error: "[Error]: terminate failed",
    })
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(0)
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
