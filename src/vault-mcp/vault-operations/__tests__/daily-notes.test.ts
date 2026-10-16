import { describe, it, expect, onTestFinished, vi } from "vitest"
import { DateTime } from "luxon"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { logger } from "../../../logger.js"
import {
  readDailyNotesConfig,
  readProtectedDailyNotesFolder,
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

const FALLBACK_CONFIG = {
  folder: "Daily Notes",
  format: "YYYY-MM-DD",
  dedicatedFolder: "Daily Notes",
}

// ── readDailyNotesConfig ─────────────────────────────────────────

describe("readDailyNotesConfig", () => {
  it("reads folder and format from .obsidian/daily-notes.json", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD-dddd" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual({
      folder: "Journal",
      format: "YYYY-MM-DD-dddd",
      dedicatedFolder: "Journal",
    })
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

  it("reads Obsidian's vault-root setting, a lone slash, as the vault root", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "/", format: "YYYY-MM-DD" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual({ folder: "", format: "YYYY-MM-DD", dedicatedFolder: null })
  })

  it.each([
    { label: "leading and trailing slashes", setting: "/Journal/", expected: "Journal" },
    { label: "repeated slashes", setting: "Journal//2026", expected: "Journal/2026" },
    { label: "backslashes", setting: "Journal\\2026", expected: "Journal/2026" },
    { label: "no-break spaces", setting: "Daily\u00A0Notes\u202FLog", expected: "Daily Notes Log" },
    // "e" plus a combining acute accent, composed into "é"
    { label: "decomposed accents", setting: "Journe\u0301es", expected: "Journ\u00E9es" },
  ])("normalizes $label in the folder the way Obsidian does", async ({ setting, expected }) => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: setting, format: "YYYY-MM-DD" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual({ folder: expected, format: "YYYY-MM-DD", dedicatedFolder: expected })
  })

  describe("blank folder in daily-notes.json", () => {
    const writeAppConfig = async (vaultDir: string, appConfig: unknown): Promise<void> => {
      await writeFile(join(vaultDir, ".obsidian", "app.json"), JSON.stringify(appConfig), "utf8")
    }

    it("uses the vault root when app.json does not exist, as Obsidian's default", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "", format: "YYYY-MM-DD" })
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

      expect(config).toEqual({ folder: "", format: "YYYY-MM-DD", dedicatedFolder: null })
      // The unreadable-app.json fallback also gives the root, but with a warn
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("uses the folder app.json sets for new notes, without treating it as daily-only", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { format: "DD-MM-YYYY" })
      await writeAppConfig(vaultDir, { newFileLocation: "folder", newFileFolderPath: "Inbox/" })

      const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

      expect(config).toEqual({ folder: "Inbox", format: "DD-MM-YYYY", dedicatedFolder: null })
    })

    it("uses the vault root when new notes go next to the current file", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "" })
      await writeAppConfig(vaultDir, { newFileLocation: "current", newFileFolderPath: "Inbox" })
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

      expect(config).toEqual({ folder: "", format: "YYYY-MM-DD", dedicatedFolder: null })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it.each([
      {
        label: "a non-string folder path",
        appConfig: { newFileLocation: "folder", newFileFolderPath: 42 },
      },
      { label: "no folder path", appConfig: { newFileLocation: "folder" } },
      { label: "the JSON literal null", appConfig: null },
    ])(
      "uses the vault root, without a warn, for an app.json with $label",
      async ({ appConfig }) => {
        const vaultDir = await createVault()
        await writeDailyNotesConfig(vaultDir, { folder: "" })
        await writeAppConfig(vaultDir, appConfig)
        const warnSpy = vi.spyOn(logger, "warn")
        onTestFinished(() => warnSpy.mockRestore())

        const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

        expect(config).toEqual({ folder: "", format: "YYYY-MM-DD", dedicatedFolder: null })
        expect(warnSpy).not.toHaveBeenCalled()
      },
    )

    it("uses the vault root, without a warn, when app.json is a directory", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "" })
      await mkdir(join(vaultDir, ".obsidian", "app.json"))
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

      expect(config).toEqual({ folder: "", format: "YYYY-MM-DD", dedicatedFolder: null })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("reads a file holding the JSON literal null as a blank folder, without a warn", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, null)
      await writeAppConfig(vaultDir, { newFileLocation: "folder", newFileFolderPath: "Inbox" })
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

      expect(config).toEqual({ folder: "Inbox", format: "YYYY-MM-DD", dedicatedFolder: null })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("uses the vault root on a malformed app.json and warns on the caller's logger", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "" })
      const malformedJson = "not valid json{{{"
      await writeFile(join(vaultDir, ".obsidian", "app.json"), malformedJson, "utf8")
      const requestLogger = logger.child({ requestId: "request-1" })
      const requestWarnSpy = vi.spyOn(requestLogger, "warn")

      const config = await readDailyNotesConfig({ vaultPath: vaultDir }, requestLogger)

      expect(config).toEqual({ folder: "", format: "YYYY-MM-DD", dedicatedFolder: null })
      expect(requestWarnSpy).toHaveBeenCalledTimes(1)
      expect(requestWarnSpy).toHaveBeenCalledWith(
        "cannot read new note location, using the vault root",
        { error: `[SyntaxError]: ${jsonParseFailureMessage(malformedJson)}` },
      )
    })

    it("lets a folder override win without reading app.json", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "", format: "DD-MM-YYYY" })
      await writeFile(join(vaultDir, ".obsidian", "app.json"), "not valid json{{{", "utf8")
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder" } },
        logger,
      )

      expect(config).toEqual({
        folder: "Override Folder",
        format: "DD-MM-YYYY",
        dedicatedFolder: "Override Folder",
      })
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  it("uses default format when config has empty format string", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal" })

    const config = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)

    expect(config).toEqual({ folder: "Journal", format: "YYYY-MM-DD", dedicatedFolder: "Journal" })
  })

  it("follows a folder and format change between two reads", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD" })

    const first = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(first).toEqual({ folder: "Journal", format: "YYYY-MM-DD", dedicatedFolder: "Journal" })

    await writeDailyNotesConfig(vaultDir, { folder: "Changed", format: "DD-MM-YYYY" })
    const second = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(second).toEqual({ folder: "Changed", format: "DD-MM-YYYY", dedicatedFolder: "Changed" })
  })

  it("picks up a config file that appears after an earlier read", async () => {
    const vaultDir = await createVault()

    const beforeFileExists = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(beforeFileExists).toEqual(FALLBACK_CONFIG)

    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })
    const afterFileExists = await readDailyNotesConfig({ vaultPath: vaultDir }, logger)
    expect(afterFileExists).toEqual({
      folder: "Journal",
      format: "DD-MM-YYYY",
      dedicatedFolder: "Journal",
    })
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
    expect(afterFix).toEqual({
      folder: "Journal",
      format: "DD-MM-YYYY",
      dedicatedFolder: "Journal",
    })
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

      expect(config).toEqual({
        folder: "Override Folder",
        format: "DD-MM-YYYY",
        dedicatedFolder: "Override Folder",
      })
    })

    it("format-only override wins over the file's format, file keeps folder", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({
        folder: "Journal",
        format: "YYYY_MM_DD",
        dedicatedFolder: "Journal",
      })
    })

    it("both overrides win over a conflicting file", async () => {
      const vaultDir = await createVault()
      await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "DD-MM-YYYY" })

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder", format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY_MM_DD",
        dedicatedFolder: "Override Folder",
      })
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

      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY_MM_DD",
        dedicatedFolder: "Override Folder",
      })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("both overrides apply without a config file", async () => {
      const vaultDir = await createVault()

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder", format: "YYYY_MM_DD" } },
        logger,
      )

      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY_MM_DD",
        dedicatedFolder: "Override Folder",
      })
    })

    it("folder-only override without a config file falls back to the default format", async () => {
      const vaultDir = await createVault()

      const config = await readDailyNotesConfig(
        { vaultPath: vaultDir, envSettings: { folder: "Override Folder" } },
        logger,
      )

      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY-MM-DD",
        dedicatedFolder: "Override Folder",
      })
    })
  })
})

// ── readProtectedDailyNotesFolder ────────────────────────────────

describe("readProtectedDailyNotesFolder", () => {
  it("reads the folder from .obsidian/daily-notes.json", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal/", format: "DD-MM-YYYY" })

    const folder = await readProtectedDailyNotesFolder(vaultDir, logger)

    expect(folder).toBe("Journal")
  })

  it("falls back to Daily Notes when the file is missing", async () => {
    const vaultDir = await createVault()
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const folder = await readProtectedDailyNotesFolder(vaultDir, logger)

    expect(folder).toBe("Daily Notes")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("falls back to Daily Notes when .obsidian is a file rather than a folder", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "daily-notes-test-"))
    onTestFinished(async () => rm(vaultDir, { recursive: true }))
    await writeFile(join(vaultDir, ".obsidian"), "not a folder", "utf8")

    const folder = await readProtectedDailyNotesFolder(vaultDir, logger)

    expect(folder).toBe("Daily Notes")
  })

  it.each([
    { label: "the vault root", config: { folder: "/" } },
    { label: "a blank folder (Obsidian's new-note location)", config: { folder: "" } },
    { label: "the JSON literal null (a blank folder)", config: null },
  ])("protects no folder for $label", async ({ config }) => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, config)
    // A new-note folder in app.json must not become the protected folder
    await writeFile(
      join(vaultDir, ".obsidian", "app.json"),
      JSON.stringify({ newFileLocation: "folder", newFileFolderPath: "Inbox" }),
      "utf8",
    )
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const folder = await readProtectedDailyNotesFolder(vaultDir, logger)

    expect(folder).toBeNull()
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

    await expect(readProtectedDailyNotesFolder(vaultDir, requestLogger)).rejects.toThrow(
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

    await expect(readProtectedDailyNotesFolder(vaultDir, logger)).rejects.toThrow(
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

    const first = await readProtectedDailyNotesFolder(vaultDir, logger)
    expect(first).toBe("Journal")

    await writeDailyNotesConfig(vaultDir, { folder: "Diary" })
    const second = await readProtectedDailyNotesFolder(vaultDir, logger)
    expect(second).toBe("Diary")
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

  it("resolves a path at the vault root when daily notes live there", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "/", format: "DD-MM-YYYY" })

    const path = await getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger)

    expect(path).toBe("13-05-2026.md")
  })

  it("trims spaces the format leaves at either end of the filename, as Obsidian does", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: " YYYY-MM-DD " })

    const path = await getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger)

    expect(path).toBe("Journal/2026-05-13.md")
  })

  it("uses a resolved config as is, reading no config file", async () => {
    const vaultDir = await createVault()
    // A different folder and format on disk, so a file read would change the path
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD" })

    const path = await getDailyNotePath(
      {
        vaultPath: vaultDir,
        date: "2026-05-13",
        settings: {
          source: "resolved",
          config: { folder: "", format: "DD-MM-YYYY", dedicatedFolder: null },
        },
      },
      logger,
    )

    expect(path).toBe("13-05-2026.md")
  })

  it("resolves with env overrides winning over the config file", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD" })

    const path = await getDailyNotePath(
      {
        vaultPath: vaultDir,
        date: "2026-05-13",
        settings: {
          source: "env",
          envSettings: { folder: "Override Folder", format: "DD-MM-YYYY" },
        },
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
    ).rejects.toThrow(
      new Error('invalid date "not-a-date" — use YYYY-MM-DD format (e.g. "2026-05-13")'),
    )
  })

  it("rejects a well-formed date that is not on the calendar as not a calendar date", async () => {
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
      new Error('invalid date "2026" — use YYYY-MM-DD format (e.g. "2026-05-13")'),
    )
  })

  it("rejects partial ISO dates (year-month only)", async () => {
    const vaultDir = await createVault()

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05" }, logger),
    ).rejects.toThrow(
      new Error('invalid date "2026-05" — use YYYY-MM-DD format (e.g. "2026-05-13")'),
    )
  })

  it("rejects full ISO timestamps", async () => {
    const vaultDir = await createVault()

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13T14:30:00Z" }, logger),
    ).rejects.toThrow(
      new Error('invalid date "2026-05-13T14:30:00Z" — use YYYY-MM-DD format (e.g. "2026-05-13")'),
    )
  })

  it("rejects a format containing unsupported tokens (Do)", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "MMMM Do, YYYY" })

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger),
    ).rejects.toThrow(
      new Error(
        "daily note format contains unsupported token(s): Do — the server cannot reproduce the filenames Obsidian creates with these tokens; change the format in Obsidian or set DAILY_NOTES_FORMAT to a supported format",
      ),
    )
  })

  it("rejects a format containing unsupported tokens (dd)", async () => {
    const vaultDir = await createVault()
    await writeDailyNotesConfig(vaultDir, { folder: "Journal", format: "YYYY-MM-DD dd" })

    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13" }, logger),
    ).rejects.toThrow(
      new Error(
        "daily note format contains unsupported token(s): dd — the server cannot reproduce the filenames Obsidian creates with these tokens; change the format in Obsidian or set DAILY_NOTES_FORMAT to a supported format",
      ),
    )
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
      new Error('path traversal blocked: "../escape/2026-05-13.md" escapes vault root'),
    )
  })
})
