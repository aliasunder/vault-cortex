import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  onTestFinished,
  vi,
} from "vitest"
import { DateTime } from "luxon"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { logger } from "../../../logger.js"

// ── readDailyNotesConfig ─────────────────────────────────────────

describe("readDailyNotesConfig", () => {
  let vaultDir: string

  beforeEach(async () => {
    vi.resetModules()
    vaultDir = await mkdtemp(join(tmpdir(), "daily-notes-test-"))
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
  })

  afterEach(async () => {
    await rm(vaultDir, { recursive: true })
  })

  it("reads folder and format from .obsidian/daily-notes.json", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD-dddd" }),
      "utf8",
    )
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.folder).toBe("Journal")
    expect(config.format).toBe("YYYY-MM-DD-dddd")
  })

  it("falls back to defaults when file is missing", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.folder).toBe("Daily Notes")
    expect(config.format).toBe("YYYY-MM-DD")
  })

  it("falls back to defaults when file is malformed JSON", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      "not valid json{{{",
      "utf8",
    )
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.folder).toBe("Daily Notes")
    expect(config.format).toBe("YYYY-MM-DD")
  })

  it("uses default folder when config has empty folder string", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      "utf8",
    )
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.folder).toBe("Daily Notes")
  })

  it("uses default format when config has empty format string", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal" }),
      "utf8",
    )
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.format).toBe("YYYY-MM-DD")
  })

  it("caches the config after first read", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD" }),
      "utf8",
    )
    const first = await readDailyNotesConfig(vaultDir)
    expect(first.folder).toBe("Journal")

    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Changed", format: "DD-MM-YYYY" }),
      "utf8",
    )
    const second = await readDailyNotesConfig(vaultDir)
    expect(second.folder).toBe("Journal")
  })

  it("keys the cache by vault path — a second vault gets its own config", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD" }),
      "utf8",
    )
    const firstVaultConfig = await readDailyNotesConfig(vaultDir)
    expect(firstVaultConfig.folder).toBe("Journal")

    const secondVaultDir = await mkdtemp(
      join(tmpdir(), "daily-notes-second-vault-"),
    )
    onTestFinished(async () => rm(secondVaultDir, { recursive: true }))
    await mkdir(join(secondVaultDir, ".obsidian"), { recursive: true })
    await writeFile(
      join(secondVaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Diary", format: "DD-MM-YYYY" }),
      "utf8",
    )
    const secondVaultConfig = await readDailyNotesConfig(secondVaultDir)
    expect(secondVaultConfig).toEqual({
      folder: "Diary",
      format: "DD-MM-YYYY",
    })
  })

  it("retries after ENOENT — a config file appearing later is picked up without a restart", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    const beforeFileExists = await readDailyNotesConfig(vaultDir)
    expect(beforeFileExists).toEqual({
      folder: "Daily Notes",
      format: "YYYY-MM-DD",
    })

    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
      "utf8",
    )
    const afterFileExists = await readDailyNotesConfig(vaultDir)
    expect(afterFileExists).toEqual({
      folder: "Journal",
      format: "DD-MM-YYYY",
    })
  })

  it("retries after malformed JSON — a fixed config file is picked up without a restart", async () => {
    const { readDailyNotesConfig } = await import("../daily-notes.js")
    const configFilePath = join(vaultDir, ".obsidian", "daily-notes.json")
    await writeFile(configFilePath, "not valid json{{{", "utf8")
    const whileMalformed = await readDailyNotesConfig(vaultDir)
    expect(whileMalformed).toEqual({
      folder: "Daily Notes",
      format: "YYYY-MM-DD",
    })

    await writeFile(
      configFilePath,
      JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
      "utf8",
    )
    const afterFix = await readDailyNotesConfig(vaultDir)
    expect(afterFix).toEqual({ folder: "Journal", format: "DD-MM-YYYY" })
  })

  describe("overrides precedence", () => {
    it("folder-only override wins over the file's folder, file keeps format", async () => {
      const { readDailyNotesConfig } = await import("../daily-notes.js")
      await writeFile(
        join(vaultDir, ".obsidian", "daily-notes.json"),
        JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
        "utf8",
      )
      const config = await readDailyNotesConfig(vaultDir, {
        folder: "Override Folder",
      })
      expect(config).toEqual({
        folder: "Override Folder",
        format: "DD-MM-YYYY",
      })
    })

    it("format-only override wins over the file's format, file keeps folder", async () => {
      const { readDailyNotesConfig } = await import("../daily-notes.js")
      await writeFile(
        join(vaultDir, ".obsidian", "daily-notes.json"),
        JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
        "utf8",
      )
      const config = await readDailyNotesConfig(vaultDir, {
        format: "YYYY_MM_DD",
      })
      expect(config).toEqual({ folder: "Journal", format: "YYYY_MM_DD" })
    })

    it("both overrides win over a conflicting file", async () => {
      const { readDailyNotesConfig } = await import("../daily-notes.js")
      await writeFile(
        join(vaultDir, ".obsidian", "daily-notes.json"),
        JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
        "utf8",
      )
      const config = await readDailyNotesConfig(vaultDir, {
        folder: "Override Folder",
        format: "YYYY_MM_DD",
      })
      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY_MM_DD",
      })
    })

    it("both overrides apply without a config file", async () => {
      const { readDailyNotesConfig } = await import("../daily-notes.js")
      const config = await readDailyNotesConfig(vaultDir, {
        folder: "Override Folder",
        format: "YYYY_MM_DD",
      })
      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY_MM_DD",
      })
    })

    it("folder-only override without a config file falls back to the default format", async () => {
      const { readDailyNotesConfig } = await import("../daily-notes.js")
      const config = await readDailyNotesConfig(vaultDir, {
        folder: "Override Folder",
      })
      expect(config).toEqual({
        folder: "Override Folder",
        format: "YYYY-MM-DD",
      })
    })
  })
})

// ── getDailyNotePath ─────────────────────────────────────────────

describe("getDailyNotePath", () => {
  let vaultDir: string

  beforeEach(async () => {
    vi.resetModules()
    vaultDir = await mkdtemp(join(tmpdir(), "daily-path-test-"))
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
  })

  afterEach(async () => {
    await rm(vaultDir, { recursive: true })
  })

  it("resolves a specific date with default config", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    const path = await getDailyNotePath({
      vaultPath: vaultDir,
      date: "2026-05-13",
    })
    expect(path).toBe("Daily Notes/2026-05-13.md")
  })

  it("resolves with custom folder and format", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
      "utf8",
    )
    const path = await getDailyNotePath({
      vaultPath: vaultDir,
      date: "2026-05-13",
    })
    expect(path).toBe("Journal/13-05-2026.md")
  })

  it("resolves with env overrides winning over the config file", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD" }),
      "utf8",
    )
    const path = await getDailyNotePath({
      vaultPath: vaultDir,
      date: "2026-05-13",
      overrides: { folder: "Override Folder", format: "DD-MM-YYYY" },
    })
    expect(path).toBe("Override Folder/13-05-2026.md")
  })

  it("defaults to today when no date provided", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    const path = await getDailyNotePath({ vaultPath: vaultDir })
    // Use Luxon's local-timezone today (same as the code under test) to
    // avoid UTC/local date mismatch near midnight
    const todayLocal = DateTime.now().toFormat("yyyy-MM-dd")
    expect(path).toBe(`Daily Notes/${todayLocal}.md`)
  })

  it("throws on invalid date format", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "not-a-date" }),
    ).rejects.toThrow("invalid date")
  })

  it("rejects partial ISO dates (year only)", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026" }),
    ).rejects.toThrow("invalid date")
  })

  it("rejects partial ISO dates (year-month only)", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05" }),
    ).rejects.toThrow("invalid date")
  })

  it("rejects full ISO timestamps", async () => {
    const { getDailyNotePath } = await import("../daily-notes.js")
    await expect(
      getDailyNotePath({ vaultPath: vaultDir, date: "2026-05-13T14:30:00Z" }),
    ).rejects.toThrow("invalid date")
  })
})

// ── getDailyNote ─────────────────────────────────────────────────

describe("getDailyNote", () => {
  let vaultDir: string

  beforeEach(async () => {
    vi.resetModules()
    vaultDir = await mkdtemp(join(tmpdir(), "daily-read-test-"))
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
    await mkdir(join(vaultDir, "Daily Notes"), { recursive: true })
  })

  afterEach(async () => {
    await rm(vaultDir, { recursive: true })
  })

  it("reads an existing daily note", async () => {
    const { getDailyNote } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, "Daily Notes", "2026-05-13.md"),
      "---\ndate: 2026-05-13\n---\n\n# 2026-05-13\n\nToday's notes.\n",
      "utf8",
    )
    const result = await getDailyNote(
      { vaultPath: vaultDir, date: "2026-05-13" },
      logger,
    )
    expect(result.exists).toBe(true)
    expect(result.path).toBe("Daily Notes/2026-05-13.md")
    expect(result.content).toContain("Today's notes.")
  })

  it("returns exists: false for missing daily note", async () => {
    const { getDailyNote } = await import("../daily-notes.js")
    const result = await getDailyNote(
      { vaultPath: vaultDir, date: "2026-01-01" },
      logger,
    )
    expect(result.exists).toBe(false)
    expect(result.path).toBe("Daily Notes/2026-01-01.md")
    expect(result.content).toBeNull()
  })

  it("rethrows non-ENOENT errors (e.g. path traversal)", async () => {
    const { getDailyNote } = await import("../daily-notes.js")
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "../escape", format: "YYYY-MM-DD" }),
      "utf8",
    )
    await expect(
      getDailyNote({ vaultPath: vaultDir, date: "2026-05-13" }, logger),
    ).rejects.toThrow("path traversal blocked")
  })
})
