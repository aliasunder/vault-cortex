import { describe, it, expect, onTestFinished, vi } from "vitest"
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime, Settings } from "luxon"
import { createFileSinkExtension, pruneOldLogFiles, logger } from "../logger.js"

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"))
  onTestFinished(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore — OS tmp dir handles stragglers
    }
  })
  return dir
}

const sampleLine = (message: string): string =>
  JSON.stringify({
    timestamp: DateTime.now().toISO(),
    level: "info",
    name: "test",
    message,
  }) + "\n"

const sampleEntry = (message: string) => ({
  timestamp: DateTime.now().toISO(),
  level: "info" as const,
  name: "test",
  message,
  data: {},
})

describe("createFileSinkExtension", () => {
  it("writes log lines to a date-stamped file", () => {
    const logDir = createTempDir()
    const extension = createFileSinkExtension(logDir)

    extension(sampleEntry("hello"), sampleLine("hello"))
    extension(sampleEntry("world"), sampleLine("world"))

    const today = DateTime.now().toISODate()
    const lines = readFileSync(join(logDir, `vault-mcp-${today}.log`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0].message).toBe("hello")
    expect(lines[1].message).toBe("world")
  })

  it("creates the log directory if it does not exist", () => {
    const parentDir = createTempDir()
    const nestedLogDir = join(parentDir, "nested", "logs")

    createFileSinkExtension(nestedLogDir)

    expect(existsSync(nestedLogDir)).toBe(true)
  })

  it("appends to an existing log file", () => {
    const logDir = createTempDir()
    const today = DateTime.now().toISODate()
    const logFile = join(logDir, `vault-mcp-${today}.log`)

    writeFileSync(logFile, '{"message":"existing"}\n')

    const extension = createFileSinkExtension(logDir)
    extension(sampleEntry("appended"), sampleLine("appended"))

    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0].message).toBe("existing")
    expect(lines[1].message).toBe("appended")
  })

  it("rolls to a new file when the date changes", () => {
    const logDir = createTempDir()
    onTestFinished(() => {
      Settings.now = () => Date.now()
    })

    // Day 1
    Settings.now = () => Date.parse("2026-01-15T12:00:00Z")
    const extension = createFileSinkExtension(logDir, 30)
    extension(sampleEntry("day1"), '{"message":"day1"}\n')

    // Day 2
    Settings.now = () => Date.parse("2026-01-16T12:00:00Z")
    extension(sampleEntry("day2"), '{"message":"day2"}\n')

    const files = readdirSync(logDir)
      .filter((filename) => filename.endsWith(".log"))
      .sort()
    expect(files).toEqual([
      "vault-mcp-2026-01-15.log",
      "vault-mcp-2026-01-16.log",
    ])

    const day1Content = readFileSync(
      join(logDir, "vault-mcp-2026-01-15.log"),
      "utf8",
    )
    const day2Content = readFileSync(
      join(logDir, "vault-mcp-2026-01-16.log"),
      "utf8",
    )
    const day1Line = JSON.parse(day1Content.trim())
    const day2Line = JSON.parse(day2Content.trim())
    expect(day1Line.message).toBe("day1")
    expect(day2Line.message).toBe("day2")
  })

  it("prunes old files on creation", () => {
    const logDir = createTempDir()
    writeFileSync(join(logDir, "vault-mcp-2020-01-01.log"), "ancient")

    createFileSinkExtension(logDir, 7)

    const remaining = readdirSync(logDir)
    expect(remaining).toHaveLength(0)
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
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toBe(`vault-mcp-${today}.log`)
  })

  it("ignores non-matching files", () => {
    const logDir = createTempDir()

    writeFileSync(join(logDir, "vault-mcp-2020-01-01.log"), "old")
    writeFileSync(join(logDir, "other-file.txt"), "keep me")
    writeFileSync(join(logDir, "README.md"), "keep me too")

    pruneOldLogFiles(logDir, 30)

    const remaining = readdirSync(logDir).sort()
    expect(remaining).toEqual(["README.md", "other-file.txt"])
  })

  it("keeps files within retention window", () => {
    const logDir = createTempDir()

    const today = DateTime.now().toISODate()
    const yesterday = DateTime.now().minus({ days: 1 }).toISODate()
    writeFileSync(join(logDir, `vault-mcp-${today}.log`), "today")
    writeFileSync(join(logDir, `vault-mcp-${yesterday}.log`), "yesterday")

    pruneOldLogFiles(logDir, 30)

    const remaining = readdirSync(logDir).sort()
    expect(remaining).toEqual([
      `vault-mcp-${yesterday}.log`,
      `vault-mcp-${today}.log`,
    ])
  })

  it("respects custom retention days", () => {
    const logDir = createTempDir()

    const twoDaysAgo = DateTime.now().minus({ days: 2 }).toISODate()
    writeFileSync(join(logDir, `vault-mcp-${twoDaysAgo}.log`), "old-ish")

    pruneOldLogFiles(logDir, 1)

    const remaining = readdirSync(logDir)
    expect(remaining).toHaveLength(0)
  })
})

describe("logger child lazy props", () => {
  /** Captures JSON log lines emitted to stdout while the spy is active.
   *  Non-JSON stdout writes (test-runner output) are filtered out. */
  const captureEmittedLines = (): (() => Record<string, unknown>[]) => {
    const writtenChunks: string[] = []
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        writtenChunks.push(String(chunk))
        return true
      })
    onTestFinished(() => stdoutSpy.mockRestore())
    return () =>
      writtenChunks
        .filter((chunk) => chunk.startsWith("{"))
        .map((chunk) => JSON.parse(chunk))
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

    expect(emittedLines()[0]?.sessionId).toBe("first-session")
    expect(emittedLines()[1]?.sessionId).toBe("second-session")
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

    const emittedLine = emittedLines()[0]
    expect(emittedLine?.message).toBe("tool_call")
    expect(emittedLine?.clientIp).toBe("203.0.113.7")
    expect(emittedLine).not.toHaveProperty("sessionId")
  })

  it("passes static props through unchanged alongside a lazy prop", () => {
    const emittedLines = captureEmittedLines()
    const childLogger = logger.child({
      sessionId: () => "session-abc",
      clientIp: "203.0.113.7",
    })

    childLogger.info("tool_call")

    expect(emittedLines()[0]?.sessionId).toBe("session-abc")
    expect(emittedLines()[0]?.clientIp).toBe("203.0.113.7")
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

    expect(emittedLines()[0]?.sessionId).toBe("session-abc")
    expect(emittedLines()[0]?.requestId).toBe(12)
  })
})
