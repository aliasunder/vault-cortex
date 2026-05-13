import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { DateTime } from "luxon"
import {
  mkdtemp,
  rm as removeDirectory,
  writeFile,
  mkdir,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  momentToLuxonFormat,
  readDailyNotesConfig,
  getDailyNotePath,
  getDailyNote,
  clearConfigCache,
} from "../daily-notes.js"
import { logger } from "../../logger.js"

// ── momentToLuxonFormat ──────────────────────────────────────────

describe("momentToLuxonFormat", () => {
  const scenarios = [
    {
      name: "standard daily note format",
      input: "YYYY-MM-DD",
      expected: "yyyy-MM-dd",
    },
    {
      name: "date with full weekday name",
      input: "YYYY-MM-DD-dddd",
      expected: "yyyy-MM-dd-cccc",
    },
    {
      name: "date with short weekday name",
      input: "YYYY-MM-DD-ddd",
      expected: "yyyy-MM-dd-ccc",
    },
    {
      name: "nested folder format",
      input: "YYYY/MM/DD",
      expected: "yyyy/MM/dd",
    },
    {
      name: "European date format",
      input: "DD-MM-YYYY",
      expected: "dd-MM-yyyy",
    },
    {
      name: "two-digit year",
      input: "YY-MM-DD",
      expected: "yy-MM-dd",
    },
    {
      name: "preserves non-token characters",
      input: "YYYY_MM_DD journal",
      expected: "yyyy_MM_dd journal",
    },
    {
      name: "converts [literal] escapes to Luxon single-quote syntax",
      input: "YYYY-MM-DD [Daily Note]",
      expected: "yyyy-MM-dd 'Daily Note'",
    },
    {
      name: "handles [literal] with apostrophe",
      input: "YYYY-MM-DD [it's]",
      expected: "yyyy-MM-dd 'it''s'",
    },
    {
      name: "handles empty [literal] brackets",
      input: "YYYY-MM-DD []",
      expected: "yyyy-MM-dd ''",
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(momentToLuxonFormat(input)).toBe(expected)
  })
})

// ── readDailyNotesConfig ─────────────────────────────────────────

describe("readDailyNotesConfig", () => {
  let vaultDir: string

  beforeEach(async () => {
    clearConfigCache()
    vaultDir = await mkdtemp(join(tmpdir(), "daily-notes-test-"))
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
  })

  afterEach(async () => {
    await removeDirectory(vaultDir, { recursive: true })
  })

  it("reads folder and format from .obsidian/daily-notes.json", async () => {
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
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.folder).toBe("Daily Notes")
    expect(config.format).toBe("YYYY-MM-DD")
  })

  it("falls back to defaults when file is malformed JSON", async () => {
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
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      "utf8",
    )
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.folder).toBe("Daily Notes")
  })

  it("uses default format when config has empty format string", async () => {
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal" }),
      "utf8",
    )
    const config = await readDailyNotesConfig(vaultDir)
    expect(config.format).toBe("YYYY-MM-DD")
  })

  it("caches the config after first read", async () => {
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
})

// ── getDailyNotePath ─────────────────────────────────────────────

describe("getDailyNotePath", () => {
  let vaultDir: string

  beforeEach(async () => {
    clearConfigCache()
    vaultDir = await mkdtemp(join(tmpdir(), "daily-path-test-"))
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
  })

  afterEach(async () => {
    await removeDirectory(vaultDir, { recursive: true })
  })

  it("resolves a specific date with default config", async () => {
    const path = await getDailyNotePath(vaultDir, "2026-05-13")
    expect(path).toBe("Daily Notes/2026-05-13.md")
  })

  it("resolves with custom folder and format", async () => {
    await writeFile(
      join(vaultDir, ".obsidian", "daily-notes.json"),
      JSON.stringify({ folder: "Journal", format: "DD-MM-YYYY" }),
      "utf8",
    )
    const path = await getDailyNotePath(vaultDir, "2026-05-13")
    expect(path).toBe("Journal/13-05-2026.md")
  })

  it("defaults to today when no date provided", async () => {
    const path = await getDailyNotePath(vaultDir)
    // Use Luxon's local-timezone today (same as the code under test) to
    // avoid UTC/local date mismatch near midnight
    const todayLocal = DateTime.now().toFormat("yyyy-MM-dd")
    expect(path).toBe(`Daily Notes/${todayLocal}.md`)
  })

  it("throws on invalid date format", async () => {
    await expect(getDailyNotePath(vaultDir, "not-a-date")).rejects.toThrow(
      "invalid date",
    )
  })

  it("rejects partial ISO dates (year only)", async () => {
    await expect(getDailyNotePath(vaultDir, "2026")).rejects.toThrow(
      "invalid date",
    )
  })

  it("rejects partial ISO dates (year-month only)", async () => {
    await expect(getDailyNotePath(vaultDir, "2026-05")).rejects.toThrow(
      "invalid date",
    )
  })

  it("rejects full ISO timestamps", async () => {
    await expect(
      getDailyNotePath(vaultDir, "2026-05-13T14:30:00Z"),
    ).rejects.toThrow("invalid date")
  })
})

// ── getDailyNote ─────────────────────────────────────────────────

describe("getDailyNote", () => {
  let vaultDir: string

  beforeEach(async () => {
    clearConfigCache()
    vaultDir = await mkdtemp(join(tmpdir(), "daily-read-test-"))
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
    await mkdir(join(vaultDir, "Daily Notes"), { recursive: true })
  })

  afterEach(async () => {
    await removeDirectory(vaultDir, { recursive: true })
  })

  it("reads an existing daily note", async () => {
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
    const result = await getDailyNote(
      { vaultPath: vaultDir, date: "2026-01-01" },
      logger,
    )
    expect(result.exists).toBe(false)
    expect(result.path).toBe("Daily Notes/2026-01-01.md")
    expect(result.content).toBeNull()
  })

  it("rethrows non-ENOENT errors (e.g. path traversal)", async () => {
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
