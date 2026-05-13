import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import type { Logger } from "../logger.js"
import { vaultFs } from "./vault-filesystem.js"

// ── Moment.js → Luxon format conversion ────────────────────────

/** Sorted longest-first to avoid partial replacement collisions
 *  (e.g. YYYY before YY, dddd before ddd). */
const MOMENT_TO_LUXON: ReadonlyArray<readonly [string, string]> = [
  ["YYYY", "yyyy"],
  ["dddd", "cccc"],
  ["MMMM", "MMMM"],
  ["ddd", "ccc"],
  ["MMM", "MMM"],
  ["YY", "yy"],
  ["MM", "MM"],
  ["DD", "dd"],
  ["HH", "HH"],
  ["hh", "hh"],
  ["mm", "mm"],
  ["ss", "ss"],
  ["Do", "d"],
  ["A", "a"],
]

/** Converts a Moment.js format string to Luxon format tokens.
 *  Covers YYYY, YY, MM, DD, dddd, ddd, HH, hh, mm, ss, Do, A —
 *  sufficient for 99%+ of daily note filename patterns. */
export const momentToLuxonFormat = (momentFormat: string): string =>
  MOMENT_TO_LUXON.reduce(
    (fmt, [moment, luxon]) => fmt.replaceAll(moment, luxon),
    momentFormat,
  )

// ── Config reading ──────────────────────────────────────────────

type DailyNotesConfig = {
  folder: string
  format: string
}

const OBSIDIAN_DEFAULTS: DailyNotesConfig = {
  folder: "Daily Notes",
  format: "YYYY-MM-DD",
}

let cachedConfig: DailyNotesConfig | null = null

/** Reads .obsidian/daily-notes.json for the vault's daily note folder
 *  and filename format. Falls back to Obsidian defaults if the file
 *  is missing or malformed. Result is cached after first read. */
export const readDailyNotesConfig = async (
  vaultPath: string,
): Promise<DailyNotesConfig> => {
  if (cachedConfig) return cachedConfig

  try {
    const raw = await readFile(
      join(vaultPath, ".obsidian", "daily-notes.json"),
      "utf8",
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    cachedConfig = {
      folder:
        typeof parsed.folder === "string" && parsed.folder.length > 0
          ? parsed.folder
          : OBSIDIAN_DEFAULTS.folder,
      format:
        typeof parsed.format === "string" && parsed.format.length > 0
          ? parsed.format
          : OBSIDIAN_DEFAULTS.format,
    }
  } catch {
    cachedConfig = { ...OBSIDIAN_DEFAULTS }
  }

  return cachedConfig
}

/** Clears the cached config. Exposed for testing only. */
export const clearConfigCache = (): void => {
  cachedConfig = null
}

// ── Path resolution + read ──────────────────────────────────────

/** Resolves a date to a vault-relative daily note path using the
 *  vault's .obsidian/daily-notes.json config. */
export const getDailyNotePath = async (
  vaultPath: string,
  date?: string,
): Promise<string> => {
  const config = await readDailyNotesConfig(vaultPath)
  const luxonFormat = momentToLuxonFormat(config.format)

  const dt = date ? DateTime.fromISO(date) : DateTime.now()
  if (!dt.isValid) {
    throw new Error(
      `invalid date "${date}" — use YYYY-MM-DD format (e.g. "2026-05-13")`,
    )
  }

  const filename = dt.toFormat(luxonFormat)
  return `${config.folder}/${filename}.md`
}

type DailyNoteResult = {
  path: string
  content: string | null
  exists: boolean
}

/** Reads a daily note by date. Returns the resolved path, content
 *  (if the note exists), and an exists flag. */
export const getDailyNote = async (
  params: { vaultPath: string; date?: string },
  logger: Logger,
): Promise<DailyNoteResult> => {
  const path = await getDailyNotePath(params.vaultPath, params.date)

  try {
    const content = await vaultFs.readNote(
      { vaultPath: params.vaultPath, path },
      logger,
    )
    return { path, content, exists: true }
  } catch {
    logger.info("daily note not found", { path })
    return { path, content: null, exists: false }
  }
}
