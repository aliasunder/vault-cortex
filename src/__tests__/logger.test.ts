import { describe, it, expect, onTestFinished, vi } from "vitest"
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  statSync,
  readSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime, Settings } from "luxon"
import { findSourceMap } from "node:module"
import { createFileSinkExtension, pruneOldLogFiles, logger, resolveLogDir } from "../logger.js"

vi.mock("node:module", { spy: true })
vi.mock("node:fs", { spy: true })

const captureConsoleRecords = (): (() => Record<string, unknown>[]) => {
  const chunks: string[] = []
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  })
  onTestFinished(() => stdoutSpy.mockRestore())
  return () => chunks.map((chunk) => JSON.parse(chunk))
}

const importFileLogger = async (logDir: string, level = "info") => {
  vi.resetModules()
  vi.stubEnv("LOG_DIR", logDir)
  vi.stubEnv("LOG_LEVEL", level)
  onTestFinished(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  return (await import("../logger.js")).logger
}

const expectedConsoleRecord = (message: string, data: Record<string, unknown> = {}) => ({
  timestamp: expect.any(String),
  level: "info",
  name: "vault-cortex",
  message,
  source: expect.stringMatching(/^logger\.test\.ts:\d+$/),
  ...data,
})

const expectedStoppedRecord = (error: string) => ({
  timestamp: expect.any(String),
  level: "warn",
  name: "vault-cortex",
  message: "file_logging_stopped",
  error,
})

/** JSON opener for nesting level `index`: objects at even levels, arrays at odd ones. */
const alternatingOpener = (index: number): string => (index % 2 === 0 ? '{"child":' : "[")

/** JSON text nesting `levels` containers that alternate object, array, object… around `innermost`. */
const alternatingNesting = ({
  levels,
  innermost,
}: {
  levels: number
  innermost: string
}): string => {
  const openers = Array.from({ length: levels }, (_, index) => alternatingOpener(index))
  const closers = openers.map((opener) => (opener === "[" ? "]" : "}")).toReversed()

  return openers.join("") + innermost + closers.join("")
}

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"))
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

const sampleLine = (message: string): string => {
  return (
    JSON.stringify({
      timestamp: DateTime.now().toISO(),
      level: "info",
      name: "test",
      message,
    }) + "\n"
  )
}

const sampleEntry = (message: string) => ({
  timestamp: DateTime.now().toISO(),
  level: "info" as const,
  name: "test",
  message,
  data: {},
})

describe("resolveLogDir", () => {
  it("returns the directory for an ordinary path", () => {
    expect(resolveLogDir("/data/logs")).toBe("/data/logs")
  })

  it("turns file logging off for the none sentinel", () => {
    expect(resolveLogDir("none")).toBeUndefined()
  })

  it("matches the none sentinel case-insensitively", () => {
    expect(resolveLogDir("NONE")).toBeUndefined()
    expect(resolveLogDir("None")).toBeUndefined()
  })

  it("turns file logging off when unset", () => {
    expect(resolveLogDir(undefined)).toBeUndefined()
  })

  it("turns file logging off when empty", () => {
    expect(resolveLogDir("")).toBeUndefined()
  })

  it("does not treat a directory literally named none under a path as the sentinel", () => {
    expect(resolveLogDir("/data/none")).toBe("/data/none")
  })
})

describe("file logging fails open", () => {
  it("disables the sink when a daily rollover prune fails", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const originalNow = Settings.now
    const dayOne = DateTime.fromISO("2026-01-15T12:00:00Z").toMillis()
    const dayTwo = DateTime.fromISO("2026-01-16T12:00:00Z").toMillis()
    onTestFinished(() => {
      Settings.now = originalNow
    })
    Settings.now = () => dayOne
    const fileLogger = await importFileLogger(logDir)
    fileLogger.info("day one")
    const pruneSpy = vi
      .mocked(readdirSync)
      .mockClear()
      .mockImplementationOnce(() => {
        throw new Error("rollover prune denied")
      })
    Settings.now = () => dayTwo

    fileLogger.info("day two")
    fileLogger.child({ component: "child" }).info("child continues")

    expect(pruneSpy).toHaveBeenCalledTimes(1)
    expect(pruneSpy).toHaveBeenCalledWith(logDir)
    expect(readdirSync(logDir)).toEqual(["vault-mcp-2026-01-15.log"])
    expect(records()).toEqual([
      expectedConsoleRecord("day one"),
      expectedConsoleRecord("day two"),
      expectedStoppedRecord("[Error]: rollover prune denied"),
      expectedConsoleRecord("child continues", { component: "child" }),
    ])
  })

  it("disables the sink if appending the daily limit notice fails", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const originalNow = Settings.now
    const now = DateTime.now()
    onTestFinished(() => {
      Settings.now = originalNow
    })
    Settings.now = () => now.toMillis()
    vi.stubEnv("LOG_MAX_DAILY_MB", "1")
    const fileLogger = await importFileLogger(logDir)
    const message = "x".repeat(1_000_000)
    const appendSpy = vi
      .mocked(appendFileSync)
      .mockClear()
      .mockImplementationOnce(() => {
        throw new Error("limit notice failed")
      })

    fileLogger.info(message)
    fileLogger.child({ component: "child" }).info("child continues")

    expect(appendSpy).toHaveBeenCalledTimes(1)
    expect(appendSpy).toHaveBeenCalledWith(
      join(logDir, `vault-mcp-${now.toISODate()}.log`),
      JSON.stringify({
        timestamp: now.toISO(),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes: 1_000_000,
      }) + "\n",
    )
    expect(readdirSync(logDir)).toEqual([])
    expect(records()).toEqual([
      expectedConsoleRecord(message),
      expectedStoppedRecord("[Error]: limit notice failed"),
      expectedConsoleRecord("child continues", { component: "child" }),
    ])
  })

  it("keeps console logging and disables failed appends across the root and children", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const fileLogger = await importFileLogger(logDir)
    const child = fileLogger.child({ component: "child" })
    fileLogger.info("persisted")
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const originalContent = readFileSync(logFile, "utf8")
    const appendSpy = vi
      .mocked(appendFileSync)
      .mockClear()
      .mockImplementationOnce(() => {
        throw new Error("disk full")
      })

    expect(() => fileLogger.info("failed append")).not.toThrow()
    child.info("child continues")
    fileLogger.info("root continues")

    expect(appendSpy).toHaveBeenCalledTimes(1)
    expect(appendSpy).toHaveBeenCalledWith(logFile, JSON.stringify(records()[1]) + "\n")
    expect(readFileSync(logFile, "utf8")).toBe(originalContent)
    expect(records()).toEqual([
      expectedConsoleRecord("persisted"),
      expectedConsoleRecord("failed append"),
      expectedStoppedRecord("[Error]: disk full"),
      expectedConsoleRecord("child continues", { component: "child" }),
      expectedConsoleRecord("root continues"),
    ])
  })

  it("keeps startup and console logging working when the log folder cannot be created", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error("folder denied")
    })
    const fileLogger = await importFileLogger(logDir)

    fileLogger.info("started")
    fileLogger.child({ component: "child" }).info("child continues")

    expect(readdirSync(logDir)).toEqual([])
    expect(records()).toEqual([
      expectedStoppedRecord("[Error]: folder denied"),
      expectedConsoleRecord("started"),
      expectedConsoleRecord("child continues", { component: "child" }),
    ])
  })

  it("keeps startup and console logging working when the initial prune fails", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw new Error("prune denied")
    })
    const fileLogger = await importFileLogger(logDir)

    fileLogger.info("started")
    fileLogger.info("still running")

    expect(readdirSync(logDir)).toEqual([])
    expect(records()).toEqual([
      expectedStoppedRecord("[Error]: prune denied"),
      expectedConsoleRecord("started"),
      expectedConsoleRecord("still running"),
    ])
  })

  it("disables the shared sink when the first size lookup after midnight fails", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const originalNow = Settings.now
    const dayOne = DateTime.fromISO("2026-01-15T12:00:00Z").toMillis()
    const dayTwo = DateTime.fromISO("2026-01-16T12:00:00Z").toMillis()
    onTestFinished(() => {
      Settings.now = originalNow
    })
    Settings.now = () => dayOne
    const fileLogger = await importFileLogger(logDir)
    fileLogger.info("day one")
    const originalContent = readFileSync(join(logDir, "vault-mcp-2026-01-15.log"), "utf8")
    const lookupSpy = vi
      .mocked(statSync)
      .mockClear()
      .mockImplementationOnce(() => {
        throw new Error("stat denied")
      })
    Settings.now = () => dayTwo

    expect(() => fileLogger.info("day two")).not.toThrow()
    fileLogger.child({ component: "child" }).info("child continues")

    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(lookupSpy).toHaveBeenCalledWith(join(logDir, "vault-mcp-2026-01-16.log"), {
      throwIfNoEntry: false,
    })
    expect(readdirSync(logDir)).toEqual(["vault-mcp-2026-01-15.log"])
    expect(readFileSync(join(logDir, "vault-mcp-2026-01-15.log"), "utf8")).toBe(originalContent)
    expect(records()).toEqual([
      expectedConsoleRecord("day one"),
      expectedConsoleRecord("day two"),
      expectedStoppedRecord("[Error]: stat denied"),
      expectedConsoleRecord("child continues", { component: "child" }),
    ])
  })
})

describe("createFileSinkExtension", () => {
  it("writes through the exact byte cap and emits only one limit notice per day", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const line = '{"message":"🎉"}\n'
    const maxDailyBytes = Buffer.byteLength(line)
    const extension = createFileSinkExtension({ logDir, maxDailyBytes })

    extension(sampleEntry("first"), line)
    extension(sampleEntry("second"), line)
    extension(sampleEntry("third"), line)

    const expectedNotice = {
      timestamp: DateTime.now().toISO(),
      level: "warn",
      name: "vault-cortex",
      message: "file_log_daily_limit_reached",
      maxDailyBytes,
    }
    const notices = records()
    expect(notices).toEqual([{ ...expectedNotice, timestamp: expect.any(String) }])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      line + JSON.stringify(notices[0]) + "\n",
    )
  })

  it("counts UTF-8 bytes when deciding whether another line fits", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const line = '{"message":"🎉🎉"}\n'
    const maxDailyBytes = Buffer.byteLength(line) + line.length
    const extension = createFileSinkExtension({ logDir, maxDailyBytes })

    extension(sampleEntry("first"), line)
    extension(sampleEntry("second"), line)

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes,
      },
    ])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      line + JSON.stringify(records()[0]) + "\n",
    )
  })

  it("counts a pre-existing file when a new sink starts", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const existingLine = '{"message":"existing"}\n'
    writeFileSync(logFile, existingLine)
    const maxDailyBytes = Buffer.byteLength(existingLine)
    const extension = createFileSinkExtension({ logDir, maxDailyBytes })

    extension(sampleEntry("new"), '{"message":"new"}\n')
    extension(sampleEntry("later"), '{"message":"later"}\n')

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes,
      },
    ])
    expect(readFileSync(logFile, "utf8")).toBe(existingLine + JSON.stringify(records()[0]) + "\n")
  })

  it("keeps an under-cap file unchanged after restarting past its limit notice", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const maxDailyBytes = 10_000
    const line = '{"message":"first"}\n'
    const extension = createFileSinkExtension({ logDir, maxDailyBytes })
    extension(sampleEntry("first"), line)
    extension(sampleEntry("too large"), sampleLine("x".repeat(maxDailyBytes)))
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const cappedContent = readFileSync(logFile, "utf8")
    expect(Buffer.byteLength(cappedContent)).toBeLessThan(maxDailyBytes)
    const restartedExtension = createFileSinkExtension({ logDir, maxDailyBytes })

    restartedExtension(sampleEntry("after restart"), line)
    restartedExtension(sampleEntry("too large again"), sampleLine("x".repeat(maxDailyBytes)))

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes,
      },
    ])
    expect(readFileSync(logFile, "utf8")).toBe(cappedContent)
  })

  it("resumes after restarting with a raised cap and stops at the new cap", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const line = '{"message":"first"}\n'
    const extension = createFileSinkExtension({ logDir, maxDailyBytes: 10_000 })
    extension(sampleEntry("first"), line)
    extension(sampleEntry("too large"), sampleLine("x".repeat(10_000)))
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const cappedContent = readFileSync(logFile, "utf8")
    const maxDailyBytes = 20_000
    const restartedExtension = createFileSinkExtension({ logDir, maxDailyBytes })
    const remainingBytes = maxDailyBytes - Buffer.byteLength(cappedContent)
    const resumedLine = sampleLine("x".repeat(remainingBytes - Buffer.byteLength(sampleLine(""))))

    restartedExtension(sampleEntry("after restart"), resumedLine)

    expect(readFileSync(logFile, "utf8")).toBe(cappedContent + resumedLine)
    expect(statSync(logFile).size).toBe(maxDailyBytes)

    restartedExtension(sampleEntry("new cap"), line)
    restartedExtension(sampleEntry("still capped"), line)

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes: 10_000,
      },
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes,
      },
    ])
    expect(readFileSync(logFile, "utf8")).toBe(
      cappedContent + resumedLine + JSON.stringify(records()[1]) + "\n",
    )
  })

  it("keeps the day capped after restarting with a lowered cap", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const line = '{"message":"first"}\n'
    const extension = createFileSinkExtension({ logDir, maxDailyBytes: 10_000 })
    extension(sampleEntry("first"), line)
    extension(sampleEntry("too large"), sampleLine("x".repeat(10_000)))
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const cappedContent = readFileSync(logFile, "utf8")
    const maxDailyBytes = 5_000
    expect(Buffer.byteLength(cappedContent)).toBeLessThan(maxDailyBytes)
    const restartedExtension = createFileSinkExtension({ logDir, maxDailyBytes })

    restartedExtension(sampleEntry("after restart"), line)
    restartedExtension(sampleEntry("again"), line)

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes: 10_000,
      },
    ])
    expect(readFileSync(logFile, "utf8")).toBe(cappedContent)
  })

  it("keeps the day capped and warns once after a malformed limit notice", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const malformedNotice =
      '{"timestamp":"2026-11-08T12:00:00.000-05:00","level":"warn","name":"vault-cortex","message":"file_log_daily_limit_reached",broken\n'
    writeFileSync(logFile, malformedNotice)
    const line = '{"message":"after restart"}\n'
    const extension = createFileSinkExtension({ logDir, maxDailyBytes: 10_000 })

    extension(sampleEntry("after restart"), line)
    extension(sampleEntry("again"), line)

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "invalid_file_log_daily_limit_notice",
        error: expect.stringMatching(/^\[SyntaxError\]: /),
      },
    ])
    expect(readFileSync(logFile, "utf8")).toBe(malformedNotice)
  })

  it("writes after a malformed limit notice when the cap is off", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const malformedNotice =
      '{"timestamp":"2026-11-08T12:00:00.000-05:00","level":"warn","name":"vault-cortex","message":"file_log_daily_limit_reached",broken\n'
    writeFileSync(logFile, malformedNotice)
    const line = '{"message":"after restart"}\n'
    const extension = createFileSinkExtension({
      logDir,
      maxDailyBytes: Number.POSITIVE_INFINITY,
    })

    extension(sampleEntry("after restart"), line)

    expect(records()).toEqual([])
    expect(readFileSync(logFile, "utf8")).toBe(malformedNotice + line)
  })

  it("resumes after restarting with LOG_MAX_DAILY_MB set to none", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.stubEnv("LOG_MAX_DAILY_MB", "1")
    const fileLogger = await importFileLogger(logDir)
    const message = "x".repeat(1_000_000)
    fileLogger.info(message)
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const cappedContent = readFileSync(logFile, "utf8")
    expect(records()).toEqual([
      expectedConsoleRecord(message),
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes: 1_000_000,
      },
    ])
    vi.stubEnv("LOG_MAX_DAILY_MB", "none")
    const restartedLogger = await importFileLogger(logDir)

    restartedLogger.info(message)
    restartedLogger.info("still writing")

    expect(records()).toEqual([
      expectedConsoleRecord(message),
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes: 1_000_000,
      },
      expectedConsoleRecord(message),
      expectedConsoleRecord("still writing"),
    ])
    expect(readFileSync(logFile, "utf8")).toBe(
      cappedContent +
        records()
          .slice(2)
          .map((record) => JSON.stringify(record) + "\n")
          .join(""),
    )
  })

  it("continues an under-cap file without a limit notice after restarting", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const maxDailyBytes = 10_000
    const line = sampleLine("x".repeat(1_000))
    const extension = createFileSinkExtension({ logDir, maxDailyBytes })
    extension(sampleEntry("first"), line)
    const restartedExtension = createFileSinkExtension({ logDir, maxDailyBytes })
    vi.mocked(readSync).mockClear()

    restartedExtension(sampleEntry("after restart"), line)

    expect(readSync).toHaveBeenCalledTimes(1)
    expect(readSync).toHaveBeenCalledWith(
      expect.any(Number),
      Buffer.from(line).subarray(-512),
      0,
      512,
      Buffer.byteLength(line) - 512,
    )
    expect(records()).toEqual([])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      line + line,
    )
  })

  it("disables the sink when reading the restart tail fails", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    writeFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "existing\n")
    const fileLogger = await importFileLogger(logDir)
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw new Error("tail read denied")
    })

    fileLogger.info("first")
    fileLogger.info("second")

    expect(records()).toEqual([
      expectedConsoleRecord("first"),
      expectedStoppedRecord("[Error]: tail read denied"),
      expectedConsoleRecord("second"),
    ])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      "existing\n",
    )
  })

  it("keeps an over-cap file unchanged when the sink restarts", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const line = '{"message":"first"}\n'
    const maxDailyBytes = Buffer.byteLength(line)
    const extension = createFileSinkExtension({ logDir, maxDailyBytes })
    extension(sampleEntry("first"), line)
    extension(sampleEntry("over cap"), line)
    const logFile = join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`)
    const cappedContent = readFileSync(logFile, "utf8")
    const restartedExtension = createFileSinkExtension({ logDir, maxDailyBytes })

    restartedExtension(sampleEntry("after restart"), line)

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes,
      },
    ])
    expect(readFileSync(logFile, "utf8")).toBe(cappedContent)
  })

  it("resumes writing after midnight and prunes exactly the dates before the retention cutoff", () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const originalNow = Settings.now
    // Mutable because the test advances across the daily rollover.
    const clock = { millis: DateTime.fromISO("2026-01-15T12:00:00Z").toMillis() }
    onTestFinished(() => {
      Settings.now = originalNow
    })
    Settings.now = () => clock.millis
    const line = '{"message":"hello"}\n'
    const maxDailyBytes = Buffer.byteLength(line)
    const extension = createFileSinkExtension({ logDir, retentionDays: 7, maxDailyBytes })
    writeFileSync(join(logDir, "vault-mcp-2026-01-08.log"), "expires tomorrow")
    writeFileSync(join(logDir, "vault-mcp-2026-01-09.log"), "on tomorrow's cutoff")
    writeFileSync(join(logDir, "keep.txt"), "unrelated")
    extension(sampleEntry("first"), line)
    extension(sampleEntry("over cap"), line)
    clock.millis = DateTime.fromISO("2026-01-16T12:00:00Z").toMillis()

    extension(sampleEntry("tomorrow"), line)

    expect(readdirSync(logDir).toSorted()).toEqual([
      "keep.txt",
      "vault-mcp-2026-01-09.log",
      "vault-mcp-2026-01-15.log",
      "vault-mcp-2026-01-16.log",
    ])
    expect(readFileSync(join(logDir, "vault-mcp-2026-01-09.log"), "utf8")).toBe(
      "on tomorrow's cutoff",
    )
    expect(readFileSync(join(logDir, "vault-mcp-2026-01-16.log"), "utf8")).toBe(line)
    expect(records()).toEqual([
      {
        timestamp: DateTime.fromISO("2026-01-15T12:00:00Z").toISO(),
        level: "warn",
        name: "vault-cortex",
        message: "file_log_daily_limit_reached",
        maxDailyBytes,
      },
    ])
  })

  it("writes log lines to a date-stamped file", () => {
    const logDir = createTempDir()
    const extension = createFileSinkExtension({ logDir })

    const helloLine = sampleLine("hello")
    const worldLine = sampleLine("world")

    extension(sampleEntry("hello"), helloLine)
    extension(sampleEntry("world"), worldLine)

    const today = DateTime.now().toISODate()
    expect(readFileSync(join(logDir, `vault-mcp-${today}.log`), "utf8")).toBe(helloLine + worldLine)
  })

  it("creates the log directory if it does not exist", () => {
    const parentDir = createTempDir()
    const nestedLogDir = join(parentDir, "nested", "logs")

    createFileSinkExtension({ logDir: nestedLogDir })

    expect(existsSync(nestedLogDir)).toBe(true)
  })

  it("appends to an existing log file", () => {
    const logDir = createTempDir()
    const today = DateTime.now().toISODate()
    const logFile = join(logDir, `vault-mcp-${today}.log`)

    writeFileSync(logFile, '{"message":"existing"}\n')

    const extension = createFileSinkExtension({ logDir })
    const appendedLine = sampleLine("appended")
    extension(sampleEntry("appended"), appendedLine)

    expect(readFileSync(logFile, "utf8")).toBe('{"message":"existing"}\n' + appendedLine)
  })

  it("rolls to a new file when the date changes", () => {
    const logDir = createTempDir()
    onTestFinished(() => {
      Settings.now = () => Date.now()
    })

    // Day 1
    Settings.now = () => Date.parse("2026-01-15T12:00:00Z")
    const extension = createFileSinkExtension({ logDir, retentionDays: 30 })
    extension(sampleEntry("day1"), '{"message":"day1"}\n')

    // Day 2
    Settings.now = () => Date.parse("2026-01-16T12:00:00Z")
    extension(sampleEntry("day2"), '{"message":"day2"}\n')

    const files = readdirSync(logDir)
      .filter((filename) => filename.endsWith(".log"))
      .toSorted()
    expect(files).toEqual(["vault-mcp-2026-01-15.log", "vault-mcp-2026-01-16.log"])

    const day1Content = readFileSync(join(logDir, "vault-mcp-2026-01-15.log"), "utf8")
    const day2Content = readFileSync(join(logDir, "vault-mcp-2026-01-16.log"), "utf8")
    expect(day1Content).toBe('{"message":"day1"}\n')
    expect(day2Content).toBe('{"message":"day2"}\n')
  })

  it("prunes old files on creation", () => {
    const logDir = createTempDir()
    writeFileSync(join(logDir, "vault-mcp-2020-01-01.log"), "ancient")

    createFileSinkExtension({ logDir, retentionDays: 7 })

    const remaining = readdirSync(logDir)
    expect(remaining).toEqual([])
  })
})

describe("LOG_MAX_DAILY_MB", () => {
  it.each([
    { label: "unset", value: undefined },
    { label: "invalid", value: "bad" },
    { label: "non-finite byte count", value: "9".repeat(400) },
    { label: "overflowing byte count from finite megabytes", value: "1" + "0".repeat(303) },
  ])("enforces the 25 MB default when the value is $label", async ({ value }) => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.stubEnv("LOG_MAX_DAILY_MB", value)
    const fileLogger = await importFileLogger(logDir)
    const message = "x".repeat(25_000_001)

    fileLogger.info(message)

    const expectedWarning = {
      timestamp: expect.any(String),
      level: "warn",
      name: "vault-cortex",
      message: "invalid LOG_MAX_DAILY_MB; using default",
      maxDailyMb: 25,
    }
    const expectedNotice = {
      timestamp: expect.any(String),
      level: "warn",
      name: "vault-cortex",
      message: "file_log_daily_limit_reached",
      maxDailyBytes: 25_000_000,
    }
    expect(records()).toEqual([
      ...(value === undefined ? [] : [expectedWarning]),
      expectedConsoleRecord(message),
      expectedNotice,
    ])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      JSON.stringify(records().at(-1)) + "\n",
    )
  })

  it.each([
    { label: "lowercase", value: "none" },
    { label: "uppercase", value: "NONE" },
  ])("disables the cap for the $label sentinel", async ({ value }) => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.stubEnv("LOG_MAX_DAILY_MB", value)
    const fileLogger = await importFileLogger(logDir)
    const message = "x".repeat(25_000_001)

    fileLogger.info(message)
    fileLogger.info("still writing")

    expect(records()).toEqual([
      expectedConsoleRecord(message),
      expectedConsoleRecord("still writing"),
    ])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      records()
        .map((record) => JSON.stringify(record) + "\n")
        .join(""),
    )
  })

  it.each([
    { label: "empty", value: "" },
    { label: "zero", value: "0" },
    { label: "negative", value: "-1" },
    { label: "fractional", value: "1.5" },
    { label: "malformed", value: "25MB" },
    { label: "non-number", value: "bad" },
    { label: "signed whole number", value: "+1" },
    { label: "surrounding whitespace", value: " 1 " },
    { label: "trailing newline", value: "1\n" },
    { label: "exponent", value: "1e1" },
    { label: "non-finite byte count", value: "9".repeat(400) },
  ])("uses the default with one startup warning for a $label value", async ({ value }) => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.stubEnv("LOG_MAX_DAILY_MB", value)
    const fileLogger = await importFileLogger(logDir)

    fileLogger.info("first")
    fileLogger.info("second")

    expect(records()).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "invalid LOG_MAX_DAILY_MB; using default",
        maxDailyMb: 25,
      },
      expectedConsoleRecord("first"),
      expectedConsoleRecord("second"),
    ])
  })

  it.each([{ label: "unsafe byte count", value: "9007199255" }])(
    "accepts a whole megabyte limit with a $label",
    async ({ value }) => {
      const logDir = createTempDir()
      const records = captureConsoleRecords()
      vi.stubEnv("LOG_MAX_DAILY_MB", value)
      const fileLogger = await importFileLogger(logDir)
      const message = "x".repeat(25_000_001)

      fileLogger.info(message)

      expect(records()).toEqual([expectedConsoleRecord(message)])
      expect(
        readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8"),
      ).toBe(JSON.stringify(records()[0]) + "\n")
    },
  )

  it("uses whole decimal megabytes for the configured cap and keeps console output after it", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    vi.stubEnv("LOG_MAX_DAILY_MB", "1")
    const fileLogger = await importFileLogger(logDir)
    const message = "x".repeat(1_000_000)

    fileLogger.info(message)
    fileLogger.child({ component: "child" }).info("still on console")

    const notice = {
      timestamp: expect.any(String),
      level: "warn",
      name: "vault-cortex",
      message: "file_log_daily_limit_reached",
      maxDailyBytes: 1_000_000,
    }
    expect(records()).toEqual([
      expectedConsoleRecord(message),
      notice,
      expectedConsoleRecord("still on console", { component: "child" }),
    ])
    expect(readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")).toBe(
      JSON.stringify(records()[1]) + "\n",
    )
  })
})

describe("LOG_RETENTION_DAYS", () => {
  it.each([
    { label: "negative", value: "-1" },
    { label: "non-number", value: "bad" },
    { label: "fraction", value: "0.5" },
    { label: "exponent", value: "1e1" },
    { label: "trailing text", value: "90abc" },
    { label: "trailing newline", value: "90\n" },
    { label: "signed whole number", value: "+1" },
    { label: "surrounding whitespace", value: " 1 " },
    { label: "empty", value: "" },
    { label: "non-finite", value: "9".repeat(400) },
  ])("warns once and keeps the default retention for a $label value", async ({ value }) => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const now = DateTime.now()
    const originalNow = Settings.now
    onTestFinished(() => {
      Settings.now = originalNow
    })
    Settings.now = () => now.toMillis()
    const cutoffFile = `vault-mcp-${now.minus({ days: 90 }).toISODate()}.log`
    const expiredFile = `vault-mcp-${now.minus({ days: 91 }).toISODate()}.log`
    writeFileSync(join(logDir, cutoffFile), "kept")
    writeFileSync(join(logDir, expiredFile), "pruned")
    vi.stubEnv("LOG_RETENTION_DAYS", value)
    const fileLogger = await importFileLogger(logDir)

    fileLogger.info("first")
    fileLogger.info("second")

    expect(records()).toEqual([
      {
        timestamp: now.toISO(),
        level: "warn",
        name: "vault-cortex",
        message: "invalid LOG_RETENTION_DAYS; using default",
        retentionDays: 90,
      },
      expectedConsoleRecord("first"),
      expectedConsoleRecord("second"),
    ])
    expect(readdirSync(logDir).toSorted()).toEqual(
      [cutoffFile, `vault-mcp-${now.toISODate()}.log`].toSorted(),
    )
    expect(readFileSync(join(logDir, cutoffFile), "utf8")).toBe("kept")
  })

  it.each([
    { label: "zero", value: "0", days: 0 },
    { label: "positive", value: "7", days: 7 },
  ])("keeps today's existing file with $label retention", async ({ value, days }) => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const now = DateTime.now()
    const originalNow = Settings.now
    onTestFinished(() => {
      Settings.now = originalNow
    })
    Settings.now = () => now.toMillis()
    const todayFile = `vault-mcp-${now.toISODate()}.log`
    const expiredFile = `vault-mcp-${now.minus({ days: days + 1 }).toISODate()}.log`
    writeFileSync(join(logDir, todayFile), "existing\n")
    writeFileSync(join(logDir, expiredFile), "pruned")
    vi.stubEnv("LOG_RETENTION_DAYS", value)
    const fileLogger = await importFileLogger(logDir)

    fileLogger.info("continued")

    expect(records()).toEqual([expectedConsoleRecord("continued")])
    expect(readdirSync(logDir)).toEqual([todayFile])
    expect(readFileSync(join(logDir, todayFile), "utf8")).toBe(
      "existing\n" + JSON.stringify(records()[0]) + "\n",
    )
  })
})

describe("pruneOldLogFiles", () => {
  it("deletes log files older than retention period", () => {
    const logDir = createTempDir()

    writeFileSync(join(logDir, "vault-mcp-2020-01-01.log"), "old")
    writeFileSync(join(logDir, "vault-mcp-2020-06-15.log"), "also old")
    const today = DateTime.now().toISODate()
    writeFileSync(join(logDir, `vault-mcp-${today}.log`), "current")

    pruneOldLogFiles(logDir, 30)

    const remaining = readdirSync(logDir)
    expect(remaining).toEqual([`vault-mcp-${today}.log`])
  })

  it("ignores non-matching files", () => {
    const logDir = createTempDir()

    writeFileSync(join(logDir, "vault-mcp-2020-01-01.log"), "old")
    writeFileSync(join(logDir, "other-file.txt"), "keep me")
    writeFileSync(join(logDir, "README.md"), "keep me too")

    pruneOldLogFiles(logDir, 30)

    const remaining = readdirSync(logDir).toSorted()
    expect(remaining).toEqual(["README.md", "other-file.txt"])
  })

  it("keeps files within retention window", () => {
    const logDir = createTempDir()

    const today = DateTime.now().toISODate()
    const yesterday = DateTime.now().minus({ days: 1 }).toISODate()
    writeFileSync(join(logDir, `vault-mcp-${today}.log`), "today")
    writeFileSync(join(logDir, `vault-mcp-${yesterday}.log`), "yesterday")

    pruneOldLogFiles(logDir, 30)

    const remaining = readdirSync(logDir).toSorted()
    expect(remaining).toEqual([`vault-mcp-${yesterday}.log`, `vault-mcp-${today}.log`])
  })

  it("keeps 90 days of log files when no retention is configured", () => {
    const logDir = createTempDir()

    const sixtyDaysAgo = DateTime.now().minus({ days: 60 }).toISODate()
    const hundredDaysAgo = DateTime.now().minus({ days: 100 }).toISODate()
    writeFileSync(join(logDir, `vault-mcp-${sixtyDaysAgo}.log`), "kept")
    writeFileSync(join(logDir, `vault-mcp-${hundredDaysAgo}.log`), "pruned")

    createFileSinkExtension({ logDir })

    expect(readdirSync(logDir)).toEqual([`vault-mcp-${sixtyDaysAgo}.log`])
  })

  it("respects custom retention days", () => {
    const logDir = createTempDir()

    const twoDaysAgo = DateTime.now().minus({ days: 2 }).toISODate()
    writeFileSync(join(logDir, `vault-mcp-${twoDaysAgo}.log`), "old-ish")

    pruneOldLogFiles(logDir, 1)

    const remaining = readdirSync(logDir)
    expect(remaining).toEqual([])
  })
})

describe("source location resolution", () => {
  /** Captures JSON log lines emitted to stdout while the spy is active. */
  const captureEmittedLines = (): (() => Record<string, unknown>[]) => {
    const writtenChunks: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writtenChunks.push(String(chunk))
      return true
    })
    onTestFinished(() => stdoutSpy.mockRestore())
    return () => {
      return writtenChunks
        .filter((chunk) => chunk.startsWith("{"))
        .map((chunk) => JSON.parse(chunk))
    }
  }

  it("emits a source field with a .ts extension when source maps are available", () => {
    const emittedLines = captureEmittedLines()

    logger.info("source location test")

    const source = emittedLines()[0]?.source
    expect(source).toMatch(/\.ts:\d+$/)
  })

  it("emits a source field pointing to this test file", () => {
    const emittedLines = captureEmittedLines()

    logger.info("self-reference test")

    const source = String(emittedLines()[0]?.source)
    expect(source).toMatch(/^logger\.test\.ts:\d+$/)
  })

  it("uses findOrigin to resolve the original source location", () => {
    const emittedLines = captureEmittedLines()
    const fakeOrigin = {
      name: undefined,
      fileName: "file:///fake/path/resolved-module.ts",
      lineNumber: 42,
      columnNumber: 5,
    }
    vi.mocked(findSourceMap).mockReturnValueOnce({
      findEntry: vi.fn(),
      findOrigin: () => fakeOrigin,
      payload: {
        file: "",
        version: 3,
        sources: [],
        sourcesContent: [],
        names: [],
        mappings: "",
        sourceRoot: "",
      },
    })

    logger.info("resolved via source map")

    expect(emittedLines()[0]?.source).toBe("resolved-module.ts:42")
  })

  it("falls back to the compiled filename when findSourceMap returns undefined", () => {
    const emittedLines = captureEmittedLines()
    vi.mocked(findSourceMap).mockReturnValueOnce(undefined)

    logger.info("no source map")

    const source = String(emittedLines()[0]?.source)
    expect(source).toMatch(/\.(ts|js):\d+$/)
  })

  it("falls back to the compiled filename when findOrigin returns an empty object", () => {
    const emittedLines = captureEmittedLines()
    vi.mocked(findSourceMap).mockReturnValueOnce({
      findEntry: vi.fn(),
      findOrigin: () => ({}),
      payload: {
        file: "",
        version: 3,
        sources: [],
        sourcesContent: [],
        names: [],
        mappings: "",
        sourceRoot: "",
      },
    })

    logger.info("unmapped line")

    const source = String(emittedLines()[0]?.source)
    expect(source).toMatch(/\.(ts|js):\d+$/)
  })

  it("does not emit a source field for debug-level logs", async () => {
    const emittedLines = captureEmittedLines()
    const debugLogger = await importFileLogger("none", "debug")

    debugLogger.debug("debug message")

    expect(emittedLines()).toEqual([
      {
        timestamp: expect.any(String),
        level: "debug",
        name: "vault-cortex",
        message: "debug message",
      },
    ])
  })
})

describe("logger field caps", () => {
  it.each([
    { label: "ASCII", value: "a".repeat(300), expected: "a".repeat(255) + "…" },
    { label: "code points", value: "🎉".repeat(300), expected: "🎉".repeat(255) + "…" },
    {
      label: "joined emoji",
      value: "a".repeat(254) + "👩‍💻" + "suffix",
      expected: "a".repeat(254) + "…",
    },
  ])("caps a top-level string at 256 code points for $label", ({ value, expected }) => {
    const records = captureConsoleRecords()

    logger.info("field cap", { value })

    expect(records()).toEqual([expectedConsoleRecord("field cap", { value: expected })])
  })

  it("keeps a string at exactly 256 code points", () => {
    const records = captureConsoleRecords()
    const value = "🎉".repeat(256)

    logger.info("field boundary", { value })

    expect(records()).toEqual([expectedConsoleRecord("field boundary", { value })])
  })

  it("caps strings inside nested plain objects without mutating them", () => {
    const records = captureConsoleRecords()
    const context = Object.freeze({ detail: Object.freeze({ text: "a".repeat(300) }) })

    logger.info("nested field", { context })

    expect(records()).toEqual([
      expectedConsoleRecord("nested field", {
        context: { detail: { text: "a".repeat(255) + "…" } },
      }),
    ])
    expect(context).toEqual({ detail: { text: "a".repeat(300) } })
  })

  it("caps strings inside objects with a null prototype", () => {
    const records = captureConsoleRecords()
    const context = Object.setPrototypeOf({ text: "a".repeat(300) }, null)

    logger.info("null prototype", { context })

    expect(records()).toEqual([
      expectedConsoleRecord("null prototype", { context: { text: "a".repeat(255) + "…" } }),
    ])
  })

  it("caps array strings and objects nested inside arrays", () => {
    const records = captureConsoleRecords()
    const values = ["a".repeat(300), { text: "b".repeat(300) }, ["c".repeat(300)]]

    logger.info("array fields", { values })

    expect(records()).toEqual([
      expectedConsoleRecord("array fields", {
        values: ["a".repeat(255) + "…", { text: "b".repeat(255) + "…" }, ["c".repeat(255) + "…"]],
      }),
    ])
  })

  it("caps child logger props after merging call data", () => {
    const records = captureConsoleRecords()
    const child = logger.child({ sessionId: "a".repeat(300), requestId: "overridden" })

    child.info("child fields", { requestId: "b".repeat(300) })

    expect(records()).toEqual([
      expectedConsoleRecord("child fields", {
        sessionId: "a".repeat(255) + "…",
        requestId: "b".repeat(255) + "…",
      }),
    ])
  })

  it("caps lazy child props after resolving their current value", () => {
    const records = captureConsoleRecords()
    const transport = { sessionId: "initial" }
    const child = logger.child({ sessionId: () => transport.sessionId })
    transport.sessionId = "a".repeat(300)

    child.info("lazy field")

    expect(records()).toEqual([
      expectedConsoleRecord("lazy field", { sessionId: "a".repeat(255) + "…" }),
    ])
  })

  it.each([{ key: "error" }, { key: "cause" }, { key: "stack" }])(
    "keeps $key text at exactly 4096 code points",
    ({ key }) => {
      const records = captureConsoleRecords()
      const value = "🎉".repeat(4096)

      logger.info("diagnostic boundary", { [key]: value })

      expect(records()).toEqual([expectedConsoleRecord("diagnostic boundary", { [key]: value })])
    },
  )

  it.each([{ key: "error" }, { key: "cause" }, { key: "stack" }])(
    "caps $key text past 4096 code points",
    ({ key }) => {
      const records = captureConsoleRecords()

      logger.info("diagnostic cap", { [key]: "🎉".repeat(4200) })

      expect(records()).toEqual([
        expectedConsoleRecord("diagnostic cap", { [key]: "🎉".repeat(4095) + "…" }),
      ])
    },
  )

  it("applies the diagnostic limit to a nested error key", () => {
    const records = captureConsoleRecords()

    logger.info("nested diagnostic", {
      context: { error: "a".repeat(4200), value: "b".repeat(300) },
    })

    expect(records()).toEqual([
      expectedConsoleRecord("nested diagnostic", {
        context: { error: "a".repeat(4095) + "…", value: "b".repeat(255) + "…" },
      }),
    ])
  })

  it("preserves numbers, booleans, null, absent, empty and short fields", () => {
    const records = captureConsoleRecords()

    logger.info("unchanged fields", {
      zero: 0,
      requestId: 12,
      enabled: true,
      disabled: false,
      missing: null,
      absent: undefined,
      empty: "",
      path: "/mcp",
      values: [undefined, null, 0, false],
    })

    expect(records()).toEqual([
      expectedConsoleRecord("unchanged fields", {
        zero: 0,
        requestId: 12,
        enabled: true,
        disabled: false,
        missing: null,
        empty: "",
        path: "/mcp",
        values: [null, null, 0, false],
      }),
    ])
  })

  it("replaces arrays at depth 64 when emitting 3000 nested arrays without throwing", () => {
    const records = captureConsoleRecords()
    const nestedArrays: unknown = JSON.parse("[".repeat(3000) + '"short"' + "]".repeat(3000))

    logger.info("deep arrays", { nestedArrays })

    expect(JSON.stringify(records()[0]?.nestedArrays)).toBe(
      "[".repeat(63) + '"[nested too deep]"' + "]".repeat(63),
    )
  })

  it("keeps arrays through depth 63 unchanged", () => {
    const records = captureConsoleRecords()
    const serializedArrays = "[".repeat(63) + '"short"' + "]".repeat(63)
    const nestedArrays: unknown = JSON.parse(serializedArrays)

    logger.info("boundary arrays", { nestedArrays })

    expect(JSON.stringify(records()[0]?.nestedArrays)).toBe(serializedArrays)
  })

  it("replaces plain objects at depth 64", () => {
    const records = captureConsoleRecords()
    const nestedObjects: unknown = JSON.parse('{"child":'.repeat(64) + '"short"' + "}".repeat(64))

    logger.info("deep objects", { nestedObjects })

    expect(JSON.stringify(records()[0]?.nestedObjects)).toBe(
      '{"child":'.repeat(63) + '"[nested too deep]"' + "}".repeat(63),
    )
  })

  it("keeps plain objects through depth 63 unchanged", () => {
    const records = captureConsoleRecords()
    const serializedObjects = '{"child":'.repeat(63) + '"short"' + "}".repeat(63)
    const nestedObjects: unknown = JSON.parse(serializedObjects)

    logger.info("boundary objects", { nestedObjects })

    expect(JSON.stringify(records()[0]?.nestedObjects)).toBe(serializedObjects)
  })

  it("keeps alternating object and array nesting through depth 63 unchanged", () => {
    const records = captureConsoleRecords()
    const serializedNesting = alternatingNesting({ levels: 63, innermost: '"short"' })
    const nestedValues: unknown = JSON.parse(serializedNesting)

    logger.info("boundary mixed nesting", { nestedValues })

    expect(JSON.stringify(records()[0]?.nestedValues)).toBe(serializedNesting)
  })

  it("replaces alternating object and array nesting at depth 64", () => {
    const records = captureConsoleRecords()
    const nestedValues: unknown = JSON.parse(
      alternatingNesting({ levels: 64, innermost: '"short"' }),
    )

    logger.info("deep mixed nesting", { nestedValues })

    expect(JSON.stringify(records()[0]?.nestedValues)).toBe(
      alternatingNesting({ levels: 63, innermost: '"[nested too deep]"' }),
    )
  })

  it("passes non-plain objects through for normal JSON serialization", () => {
    const records = captureConsoleRecords()
    const url = new URL(`https://example.com/${"a".repeat(300)}`)

    logger.info("non-plain field", { url })

    expect(records()).toEqual([
      expectedConsoleRecord("non-plain field", { url: `https://example.com/${"a".repeat(300)}` }),
    ])
  })

  it("writes the same capped JSON line to the console and file sink", async () => {
    const logDir = createTempDir()
    const records = captureConsoleRecords()
    const fileLogger = await importFileLogger(logDir)
    const stdoutSpy = vi.mocked(process.stdout.write)
    const context = { text: "a".repeat(300), error: "b".repeat(4200) }

    fileLogger.info("persisted fields", { context })

    expect(records()).toEqual([
      expectedConsoleRecord("persisted fields", {
        context: { text: "a".repeat(255) + "…", error: "b".repeat(4095) + "…" },
      }),
    ])
    const line = readFileSync(join(logDir, `vault-mcp-${DateTime.now().toISODate()}.log`), "utf8")

    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledWith(line)
  })
})

describe("logger child lazy props", () => {
  /** Captures JSON log lines emitted to stdout while the spy is active.
   *  Non-JSON stdout writes (test-runner output) are filtered out. */
  const captureEmittedLines = (): (() => Record<string, unknown>[]) => {
    const writtenChunks: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writtenChunks.push(String(chunk))
      return true
    })
    onTestFinished(() => stdoutSpy.mockRestore())
    return () => {
      return writtenChunks
        .filter((chunk) => chunk.startsWith("{"))
        .map((chunk) => JSON.parse(chunk))
    }
  }

  it("resolves a function-valued prop at emit time, not at child creation", () => {
    const emittedLines = captureEmittedLines()
    // Mutable — models the MCP transport, whose sessionId is assigned only
    // after the session logger child has been created
    const transport: { sessionId: string | undefined } = {
      sessionId: undefined,
    }
    const childLogger = logger.child({ sessionId: () => transport.sessionId })

    transport.sessionId = "session-abc"
    childLogger.info("tool_call")

    expect(emittedLines()[0]?.sessionId).toBe("session-abc")
  })

  it("re-resolves the prop on every emit", () => {
    const emittedLines = captureEmittedLines()
    // Mutable — the test verifies each emit reads the current value
    const transport: { sessionId: string | undefined } = {
      sessionId: "first-session",
    }
    const childLogger = logger.child({ sessionId: () => transport.sessionId })

    childLogger.info("first line")
    transport.sessionId = "second-session"
    childLogger.info("second line")

    expect(emittedLines()).toEqual([
      expectedConsoleRecord("first line", { sessionId: "first-session" }),
      expectedConsoleRecord("second line", { sessionId: "second-session" }),
    ])
  })

  it("omits a lazy prop that resolves to undefined", () => {
    const emittedLines = captureEmittedLines()
    const childLogger = logger.child({
      sessionId: () => undefined,
      // Companion lazy prop with a defined value — proves resolution actually
      // ran, so the absent sessionId can't be JSON.stringify silently
      // dropping an unresolved function value.
      clientIp: () => "203.0.113.7",
    })

    childLogger.info("tool_call")

    expect(emittedLines()).toEqual([
      expectedConsoleRecord("tool_call", { clientIp: "203.0.113.7" }),
    ])
  })

  it("passes static props through unchanged alongside a lazy prop", () => {
    const emittedLines = captureEmittedLines()
    const childLogger = logger.child({
      sessionId: () => "session-abc",
      clientIp: "203.0.113.7",
    })

    childLogger.info("tool_call")

    expect(emittedLines()).toEqual([
      expectedConsoleRecord("tool_call", { sessionId: "session-abc", clientIp: "203.0.113.7" }),
    ])
  })

  it("resolves a lazy prop inherited through a grandchild logger", () => {
    const emittedLines = captureEmittedLines()
    // Mirrors the production chain: session logger (lazy sessionId) →
    // request logger child({ requestId, tool }) → tool_call line
    const transport: { sessionId: string | undefined } = {
      sessionId: undefined,
    }
    const sessionLogger = logger.child({
      sessionId: () => transport.sessionId,
    })
    const requestLogger = sessionLogger.child({ requestId: 12 })

    transport.sessionId = "session-abc"
    requestLogger.info("tool_call")

    expect(emittedLines()).toEqual([
      expectedConsoleRecord("tool_call", { sessionId: "session-abc", requestId: 12 }),
    ])
  })
})

// The test setup file helpers/route-log-lines-to-console.ts sends a write to
// the console only when it has this shape. A write of any other shape goes to
// the stream, so passing tests would print every log line again.
describe("console write shape", () => {
  it("writes each line as one string that opens with its timestamp field, with no encoding or callback", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    onTestFinished(() => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    })

    logger.info("shape probe info")
    logger.error("shape probe error")

    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"timestamp":/))
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"timestamp":/))
  })
})
