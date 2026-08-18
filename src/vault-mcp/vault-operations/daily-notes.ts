import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import { logger, type Logger } from "../../logger.js"
import { vaultFs } from "./vault-filesystem.js"
import {
  momentToLuxonFormat,
  hasOrdinalDayToken,
} from "../obsidian-markdown/moment-format.js"
import { describeError } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"

// ── Config reading ──────────────────────────────────────────────

type DailyNotesConfig = {
  folder: string
  format: string
}

/** Per-field settings from the DAILY_NOTES_FOLDER / DAILY_NOTES_FORMAT env
 *  vars; each set field takes precedence over .obsidian/daily-notes.json. */
export type DailyNotesEnvSettings = {
  folder?: string | undefined
  format?: string | undefined
}

// The format matches Obsidian's default; the folder is this server's own
// choice — Obsidian with no configured location creates dailies in the
// vault root, which is not a sensible folder for the server to assume.
const FALLBACK_CONFIG: DailyNotesConfig = {
  folder: "Daily Notes",
  format: "YYYY-MM-DD",
}

// TODO: Consider refactoring to factory/closure pattern (like createSearchIndex,
// createMemoryStore) so the cache lives in the closure instead of at module scope.
// Caches only SUCCESSFUL reads. Fallbacks are never cached: on a fresh
// remote deploy the config file can arrive after boot (initial sync still
// running), and retrying each call picks it up without a restart.
let cachedFileConfig: DailyNotesConfig | null = null
// Tracks whether the Do ordinal warning has already been emitted — the
// warning is meaningful once (the format doesn't change at runtime).
let ordinalDayWarningEmitted = false

/** Reads .obsidian/daily-notes.json, caching only successful reads.
 *  Returns the fallback config (uncached — see cache comment) when the
 *  file is missing or malformed. */
const readDailyNotesFileConfig = async (
  vaultPath: string,
): Promise<DailyNotesConfig> => {
  if (cachedFileConfig) return cachedFileConfig

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
          : FALLBACK_CONFIG.folder,
      format:
        typeof parsedConfig.format === "string" &&
        parsedConfig.format.length > 0
          ? parsedConfig.format
          : FALLBACK_CONFIG.format,
    }
    cachedFileConfig = fileConfig
    return fileConfig
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      logger.debug("failed to read daily notes config, using defaults", {
        error: describeError(error),
      })
    }
    return { ...FALLBACK_CONFIG }
  }
}

/** Resolves the vault's daily note folder and filename format with
 *  per-field precedence: env setting → .obsidian/daily-notes.json →
 *  the fallbacks ("Daily Notes", "YYYY-MM-DD"). When both fields are
 *  set via env the config file is not read at all. */
export const readDailyNotesConfig = async (
  vaultPath: string,
  envSettings?: DailyNotesEnvSettings,
): Promise<DailyNotesConfig> => {
  // Both fields set via env — the file can't contribute anything, skip I/O.
  if (envSettings?.folder && envSettings.format) {
    return { folder: envSettings.folder, format: envSettings.format }
  }

  const fileConfig = await readDailyNotesFileConfig(vaultPath)
  // Warn about Do only when the file format is the effective format —
  // an env override makes the file's Do irrelevant.
  if (
    !ordinalDayWarningEmitted &&
    !envSettings?.format &&
    hasOrdinalDayToken(fileConfig.format)
  ) {
    logger.warn(
      "daily-notes.json format contains Do (ordinal day) — the server will use the day number without suffix, so filenames will differ from Obsidian's",
    )
    ordinalDayWarningEmitted = true
  }
  return {
    folder: envSettings?.folder ?? fileConfig.folder,
    format: envSettings?.format ?? fileConfig.format,
  }
}

// ── Path resolution + read ──────────────────────────────────────

/** Matches strict YYYY-MM-DD date strings (no time component, no partial dates). */
const STRICT_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Resolves a date to a vault-relative daily note path using the env
 *  settings, the vault's .obsidian/daily-notes.json config, and
 *  the fallbacks — in that per-field precedence order. */
export const getDailyNotePath = async (params: {
  vaultPath: string
  date?: string | undefined
  envSettings?: DailyNotesEnvSettings | undefined
}): Promise<string> => {
  const { vaultPath, date, envSettings } = params
  const config = await readDailyNotesConfig(vaultPath, envSettings)
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
    envSettings?: DailyNotesEnvSettings | undefined
  },
  logger: Logger,
): Promise<DailyNoteResult> => {
  const path = await getDailyNotePath({
    vaultPath: params.vaultPath,
    date: params.date,
    envSettings: params.envSettings,
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
