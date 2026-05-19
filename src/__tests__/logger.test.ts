import { describe, it, expect, onTestFinished } from "vitest"
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
import { Settings } from "luxon"
import { createFileSinkExtension, pruneOldLogFiles } from "../logger.js"

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
    timestamp: new Date().toISOString(),
    level: "info",
    name: "test",
    message,
  }) + "\n"

const sampleEntry = (message: string) => ({
  timestamp: new Date().toISOString(),
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

    const today = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(logDir, `vault-mcp-${today}.log`), "utf8")
    expect(content).toContain('"message":"hello"')
    expect(content).toContain('"message":"world"')
  })

  it("creates the log directory if it does not exist", () => {
    const parentDir = createTempDir()
    const nestedLogDir = join(parentDir, "nested", "logs")

    createFileSinkExtension(nestedLogDir)

    expect(existsSync(nestedLogDir)).toBe(true)
  })

  it("appends to an existing log file", () => {
    const logDir = createTempDir()
    const today = new Date().toISOString().slice(0, 10)
    const logFile = join(logDir, `vault-mcp-${today}.log`)

    writeFileSync(logFile, '{"message":"existing"}\n')

    const extension = createFileSinkExtension(logDir)
    extension(sampleEntry("appended"), sampleLine("appended"))

    const content = readFileSync(logFile, "utf8")
    expect(content).toContain('"message":"existing"')
    expect(content).toContain('"message":"appended"')
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
    expect(day1Content).toContain('"message":"day1"')
    expect(day2Content).toContain('"message":"day2"')
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
    const today = new Date().toISOString().slice(0, 10)
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

    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10)
    writeFileSync(join(logDir, `vault-mcp-${today}.log`), "today")
    writeFileSync(join(logDir, `vault-mcp-${yesterday}.log`), "yesterday")

    pruneOldLogFiles(logDir, 30)

    const remaining = readdirSync(logDir)
    expect(remaining).toHaveLength(2)
  })

  it("respects custom retention days", () => {
    const logDir = createTempDir()

    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    writeFileSync(join(logDir, `vault-mcp-${twoDaysAgo}.log`), "old-ish")

    pruneOldLogFiles(logDir, 1)

    const remaining = readdirSync(logDir)
    expect(remaining).toHaveLength(0)
  })
})
