import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import { logger, type Logger } from "../../logger.js"
import { vaultFs } from "./vault-filesystem.js"
import { momentToLuxonFormat } from "../obsidian-markdown/moment-format.js"
import { describeError } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"

// ── Config reading ──────────────────────────────────────────────

type DailyNotesConfig = {
  folder: string
  format: string
}

/** Per-field overrides (from DAILY_NOTES_FOLDER / DAILY_NOTES_FORMAT env
 *  vars) that take precedence over .obsidian/daily-notes.json. */
export type DailyNotesOverrides = {
  folder?: string | undefined
  format?: string | undefined
}

const OBSIDIAN_DEFAULTS: DailyNotesConfig = {
  folder: "Daily Notes",
  format: "YYYY-MM-DD",
}

// TODO: Consider refactoring to factory/closure pattern (like createSearchIndex,
// createMemoryStore) so the cache lives in the closure instead of at module scope.
// Mutable module-level cache of the last SUCCESSFUL file read, keyed by
// vault path so a different vault (tests recycle the module across vault
// tempdirs) never sees another vault's cached config. Fallback results
// (file missing or malformed) are deliberately never cached: on a fresh
// remote deploy the server boots before the initial Obsidian Sync delivers
// .obsidian/, so the config file can appear after the first read — retrying
// each call picks it up without a restart. Once a read succeeds, the value
// is cached for the process lifetime.
let cachedFileConfig: { vaultPath: string; config: DailyNotesConfig } | null =
  null

/** Reads .obsidian/daily-notes.json, caching only successful reads.
 *  Returns Obsidian defaults (uncached — see cache comment) when the
 *  file is missing or malformed. */
const readDailyNotesFileConfig = async (
  vaultPath: string,
): Promise<DailyNotesConfig> => {
  if (cachedFileConfig?.vaultPath === vaultPath) return cachedFileConfig.config

  try {
    const configFileContent = await readFile(
      join(vaultPath, ".obsidian", "daily-notes.json"),
      "utf8",
    )
    const parsedConfig: Record<string, unknown> = JSON.parse(configFileContent)
    const fileConfig = {
      folder:
        typeof parsedConfig.folder === "string" &&
        parsedConfig.folder.length > 0
          ? parsedConfig.folder
          : OBSIDIAN_DEFAULTS.folder,
      format:
        typeof parsedConfig.format === "string" &&
        parsedConfig.format.length > 0
          ? parsedConfig.format
          : OBSIDIAN_DEFAULTS.format,
    }
    cachedFileConfig = { vaultPath, config: fileConfig }
    return fileConfig
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      logger.debug("failed to read daily notes config, using defaults", {
        error: describeError(error),
      })
    }
    return { ...OBSIDIAN_DEFAULTS }
  }
}

/** Resolves the vault's daily note folder and filename format with
 *  per-field precedence: env override → .obsidian/daily-notes.json →
 *  Obsidian defaults. When both fields are overridden the config file
 *  is not read at all. */
export const readDailyNotesConfig = async (
  vaultPath: string,
  overrides?: DailyNotesOverrides,
): Promise<DailyNotesConfig> => {
  // Both fields overridden — the file can't contribute anything, skip I/O.
  if (overrides?.folder && overrides.format) {
    return { folder: overrides.folder, format: overrides.format }
  }

  const fileConfig = await readDailyNotesFileConfig(vaultPath)
  return {
    folder: overrides?.folder ?? fileConfig.folder,
    format: overrides?.format ?? fileConfig.format,
  }
}

// ── Path resolution + read ──────────────────────────────────────

/** Matches strict YYYY-MM-DD date strings (no time component, no partial dates). */
const STRICT_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Resolves a date to a vault-relative daily note path using env
 *  overrides, the vault's .obsidian/daily-notes.json config, and
 *  Obsidian defaults — in that per-field precedence order. */
export const getDailyNotePath = async (params: {
  vaultPath: string
  date?: string | undefined
  overrides?: DailyNotesOverrides | undefined
}): Promise<string> => {
  const { vaultPath, date, overrides } = params
  const config = await readDailyNotesConfig(vaultPath, overrides)
  const luxonFormat = momentToLuxonFormat(config.format)

  if (date && !STRICT_ISO_DATE_RE.test(date)) {
    throw new Error(
      `invalid date "${date}" — use YYYY-MM-DD format (e.g. "2026-05-13")`,
    )
  }

  const dateTime = date ? DateTime.fromISO(date) : DateTime.now()
  if (!dateTime.isValid) {
    throw new Error(
      `invalid date "${date}" — use YYYY-MM-DD format (e.g. "2026-05-13")`,
    )
  }

  const filename = dateTime.toFormat(luxonFormat)
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
  params: {
    vaultPath: string
    date?: string | undefined
    overrides?: DailyNotesOverrides | undefined
  },
  logger: Logger,
): Promise<DailyNoteResult> => {
  const path = await getDailyNotePath({
    vaultPath: params.vaultPath,
    date: params.date,
    overrides: params.overrides,
  })

  try {
    const content = await vaultFs.readNote(
      { vaultPath: params.vaultPath, path },
      logger,
    )
    return { path, content, exists: true }
  } catch (err) {
    const errorMessage = describeError(err)
    if (errorMessage.startsWith("[Error]: note not found")) {
      logger.info("daily note not found", { path })
      return { path, content: null, exists: false }
    }
    throw err
  }
}
