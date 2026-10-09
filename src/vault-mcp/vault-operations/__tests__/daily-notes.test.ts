import { describe, it, expect, onTestFinished, vi } from "vitest"
import { DateTime } from "luxon"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { logger } from "../../../logger.js"
import {
  readDailyNotesConfig,
  readDailyNotesFileConfig,
  getDailyNotePath,
  getDailyNote,
} from "../daily-notes.js"

const createVault = async (): Promise<string> => {
  const vaultDir = await mkdtemp(join(tmpdir(), "daily-notes-test-"))
  onTestFinished(async () => rm(vaultDir, { recursive: true }))
  await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
  return vaultDir
}

const writeDailyNotesConfig = async (vaultDir: string, config: unknown): Promise<void> => {
  await writeFile(join(vaultDir, ".obsidian", "daily-notes.json"), JSON.stringify(config), "utf8")
}

/** The message JSON.parse throws for `malformedJson`. Its wording varies by
 *  engine version, so tests read it from the engine. */
const jsonParseFailureMessage = (malformedJson: string): string => {
  try {
    JSON.parse(malformedJson)
  } catch (error) {
    if (error instanceof SyntaxError) return error.message
  }
  throw new Error("expected JSON.parse to reject the malformed input")
}

const FALLBACK_CONFIG = { folder: "Daily Notes", format: "YYYY-MM-DD" }

// ── readDailyNotesConfig ─────────────────────────────────────────

describe("readDailyNotesConfig", () => {
  it("reads folder and format from .obsidian/daily-notes.json", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD-dddd" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual({ folder: "Journal", format: "YYYY-MM-DD-dddd" })
  })

  it("falls back to defaults when file is missing", async () => {
    const vaultDir = await createVault()

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual(FALLBACK_CONFIG)
  })

  it("falls back to defaults when .obsidian is a file rather than a folder", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "daily-notes-test-"))
    onTestFinished(async () => rm(vaultDir, { recursive: true }))
    await writeFile(join(vaultDir, ".obsidian"), "not a folder", "utf8")
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    // No settings exist, so nothing is wrong to warn about.
    expect(config).toEqual(FALLBACK_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("falls back to defaults on malformed JSON and warns on the caller's logger, not the root logger", async () => {
    const vaultDir = await createVault()
    const malformedJson = "not valid json{{{"
    await writeFile(join(vaultDir, ".obsidian", "daily-notes.json"), malformedJson, "utf8")

    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn")
    const rootWarnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => rootWarnSpy.mockRestore())

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, requestLogger)

    expect(config).toEqual(FALLBACK_CONFIG)
    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("cannot read daily notes config, using defaults", {
      error: `[SyntaxError]: ${jsonParseFailureMessage(malformedJson)}`,
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })

  it("uses default folder when config has empty folder string", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "", format: "YYYY-MM-DD" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual(FALLBACK_CONFIG)
  })

  it("reads a file holding the JSON literal null as no settings, without a warn", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, null)
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual(FALLBACK_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("uses default format when config has empty format string", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual({ folder: "Journal", format: "YYYY-MM-DD" })
  })

  it("follows a folder and format change between two reads", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD" })

    const first = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(first).toEqual({ folder: "Journal", format: "YYYY-MM-DD" })

    await writeDailyNotesConfig(vaultDir, { folder: "Changed", format: "DD-MM-YYYY" })
    const second = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(second).toEqual({ folder: "Changed", format: "DD-MM-YYYY" })
  })

  it("picks up a config file that appears after an earlier read", async () => {
    const vaultDir = await createVault()

    const beforeFileExists = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(beforeFileExists).toEqual(FALLBACK_CONFIG)

    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })
    const afterFileExists = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(afterFileExists).toEqual({ folder: "Journal", format: "DD-MM-YYYY" })
  })

  it("picks up a repaired config file after a malformed read", async () => {
    const vaultDir = await createVault()
    const configFilePath = join(vaultDir, ".obsidian", "daily-notes.json")
    await writeFile(configFilePath, "not valid json{{{", "utf8")
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const whileMalformed = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(whileMalformed).toEqual(FALLBACK_CONFIG)

    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })
    const afterFix = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(afterFix).toEqual({ folder: "Journal", format: "DD-MM-YYYY" })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  describe("overrides precedence", () => {
    it("folder-only override wins over the file's folder, file keeps format", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder" } },
        logger,
      )

      expect(config).toEqual({ folder: "Override Folder", format: "DD-MM-YYYY" })
    })

    it("format-only override wins over the file's format, file keeps folder", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({ folder: "Journal", format: "YYYY_MM_DD" })
    })

    it("both overrides win over a conflicting file", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder", format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({ folder: "Override Folder", format: "YYYY_MM_DD" })
    })

    it("both overrides skip the file, so a malformed one is never read", async () => {
      const vaultDir = await createVault()
      await writeFile(join(vaultDir, ".obsidian", "daily-notes.json"), "not valid json{{{", "utf8")
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder", format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({ folder: "Override Folder", format: "YYYY_MM_DD" })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("both overrides apply without a config file", async () => {
      const vaultDir = await createVault()

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder", format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({ folder: "Override Folder", format: "YYYY_MM_DD" })
    })

    it("folder-only override without a config file falls back to the default format", async () => {
      const vaultDir = await createVault()

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder" } },
        logger,
      )

      expect(config).toEqual({ folder: "Override Folder", format: "YYYY-MM-DD" })
    })
  })
})

// ── readDailyNotesFileConfig ─────────────────────────────────────

describe("readDailyNotesFileConfig", () => {
  it("reads folder and format from .obsidian/daily-notes.json", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

    const config = await readDailyNotesFileConfig(vaultDir, logger)

    expect(config).toEqual({ folder: "Journal", format: "DD-MM-YYYY" })
  })

  it("falls back to defaults when the file is missing", async () => {
    const vaultDir = await createVault()
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readDailyNotesFileConfig(vaultDir, logger)

    expect(config).toEqual(FALLBACK_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("falls back to defaults when .obsidian is a file rather than a folder", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "daily-notes-test-"))
    onTestFinished(async () => rm(vaultDir, { recursive: true }))
    await writeFile(join(vaultDir, ".obsidian"), "not a folder", "utf8")

    const config = await readDailyNotesFileConfig(vaultDir, logger)

    expect(config).toEqual(FALLBACK_CONFIG)
  })

  it("reads a file holding the JSON literal null as no settings, not as unreadable", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, null)
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readDailyNotesFileConfig(vaultDir, logger)

    expect(config).toEqual(FALLBACK_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("throws on malformed JSON and warns on the caller's logger, not the root logger", async () => {
    const vaultDir = await createVault()
    const malformedJson = "not valid json{{{"
    await writeFile(join(vaultDir, ".obsidian", "daily-notes.json"), malformedJson, "utf8")

    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn")
    const rootWarnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => rootWarnSpy.mockRestore())

    await expect(readDailyNotesFileConfig(vaultDir, requestLogger)).rejects.toThrow(
      new Error("cannot read daily notes config from .obsidian/daily-notes.json"),
    )

    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("cannot read daily notes config", {
      error: `[SyntaxError]: ${jsonParseFailureMessage(malformedJson)}`,
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })

  it("throws when daily-notes.json is a directory", async () => {
    const vaultDir = await createVault()
    await mkdir(join(vaultDir, ".obsidian", "daily-notes.json"), { recursive: true })
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    await expect(readDailyNotesFileConfig(vaultDir, logger)).rejects.toThrow(
      new Error("cannot read daily notes config from .obsidian/daily-notes.json"),
    )

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith("cannot read daily notes config", {
      error: "[Error]: EISDIR: illegal operation on a directory, read",
    })
  })

  it("follows a folder change between two reads", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal" })

    const first = await readDailyNotesFileConfig(vaultDir, logger)
    expect(first).toEqual({ folder: "Journal", format: "YYYY-MM-DD" })

    await writeDailyNotesConfig(vaultDir, { folder: "Diary" })
    const second = await readDailyNotesFileConfig(vaultDir, logger)
    expect(second).toEqual({ folder: "Diary", format: "YYYY-MM-DD" })
  })
})

// ── getDailyNotePath ─────────────────────────────────────────────

describe("getDailyNotePath", () => {
  it("resolves a specific date with default config", async () => {
    const vaultDir = await createVault()

    const path = await getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger)

    expect(path).toBe("Daily Notes/2026-05-13.md")
  })

  it("resolves with custom folder and format", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

    const path = await getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger)

    expect(path).toBe("Journal/13-05-2026.md")
  })

  it("resolves with env overrides winning over the config file", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD" })

    const path = await getDailyNotePath(
      {
        vaultPath: vaultDir,
        date: "2026-05-13",
        envSettings: { folder: "Override Folder", format: "DD-MM-YYYY" },
      },
      logger,
    )

    expect(path).toBe("Override Folder/13-05-2026.md")
  })

  it("follows a folder change between two calls", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal" })

    const first = await getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger)
    expect(first).toBe("Journal/2026-05-13.md")

    await writeDailyNotesConfig(vaultDir, { folder: "Diary" })
    const second = await getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger)
    expect(second).toBe("Diary/2026-05-13.md")
  })

  it("defaults to today when no date provided", async () => {
    const vaultDir = await createVault()

    const path = await getDailyNotePath({ vaultPath: vaultDir }, logger)

    // Use Luxon's local-timezone today (same as the code under test) to
    // avoid UTC/local date mismatch near midnight
    const todayLocal = DateTime.now().toFormat("yyyy-MM-dd")
    expect(path).toBe(`Daily Notes/${todayLocal}.md`)
  })

  it("throws on invalid date format", async () => {
    const vaultDir = await createVault()

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "not-a-date" }, logger),
    ).rejects.toThrow("invalid date")
  })

  it("rejects a well-formed date that is not on the calendar as such", async () => {
    const vaultDir = await createVault()

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-02-30" }, logger),
    ).rejects.toThrow(
      new Error('"2026-02-30" is not a calendar date. Pass a real date in YYYY-MM-DD format.'),
    )
  })

  it("rejects partial ISO dates (year only)", async () => {
    const vaultDir = await createVault()

    await expect(getDailyNotePath({ vaultPath: vaultDir, date: "2026" }, logger)).rejects.toThrow(
      "invalid date",
    )
  })

  it("rejects partial ISO dates (year-month only)", async () => {
    const vaultDir = await createVault()

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05" }, logger),
    ).rejects.toThrow("invalid date")
  })

  it("rejects full ISO timestamps", async () => {
    const vaultDir = await createVault()

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13T14:30:00Z" }, logger),
    ).rejects.toThrow("invalid date")
  })

  it("rejects a format containing unsupported tokens (Do)", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "MMMM Do, YYYY" })

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger),
    ).rejects.toThrow("unsupported token(s): Do")
  })

  it("rejects a format containing unsupported tokens (dd)", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD dd" })

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger),
    ).rejects.toThrow("unsupported token(s): dd")
  })
})

// ── getDailyNote ─────────────────────────────────────────────────

describe("getDailyNote", () => {
  it("reads an existing daily note", async () => {
    const vaultDir = await createVault()
    await mkdir(join(vaultDir, "Daily Notes"), { recursive: true })
    await writeFile(
      join(vaultDir, "Daily Notes", "2026-05-13.md"),
      "---\ndate: 2026-05-13\n---\n\n# 2026-05-13\n\nToday's notes.\n",
      "utf8",
    )

    const result = await getDailyNote({ vaultPath: vaultDir, date: "2026-05-13" }, logger)

    expect(result).toEqual({
      path: "Daily Notes/2026-05-13.md",
      content: "---\ndate: 2026-05-13\n---\n\n# 2026-05-13\n\nToday's notes.\n",
      exists: true,
    })
  })

  it("returns exists: false for missing daily note", async () => {
    const vaultDir = await createVault()
    await mkdir(join(vaultDir, "Daily Notes"), { recursive: true })

    const result = await getDailyNote({ vaultPath: vaultDir, date: "2026-01-01" }, logger)

    expect(result).toEqual({ path: "Daily Notes/2026-01-01.md", content: null, exists: false })
  })

  it("rethrows non-ENOENT errors (e.g. path traversal)", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "../escape", format: "YYYY-MM-DD" })

    await expect(getDailyNote({ vaultPath: vaultDir, date: "2026-05-13" }, logger)).rejects.toThrow(
      "path traversal blocked",
    )
  })
})
