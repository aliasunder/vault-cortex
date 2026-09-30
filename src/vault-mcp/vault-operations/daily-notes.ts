import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"
import { vaultFs } from "./vault-filesystem.js"
import { momentToLuxonFormat, findUnsupportedTokens } from "../obsidian-markdown/moment-format.js"
import { describeError } from "../../utils/describe-error.js"
import { isMissingPathError } from "../../utils/fs.js"
import { isRecord } from "../../utils/is-record.js"

// ── Config reading ──────────────────────────────────────────────
//
// Three readers, each wrapping readDailyNotesFile:
//   readDailyNotesFileConfig        — strict: throws on an unreadable file (for the delete/move guard)
//   readDailyNotesFileConfigOrFallback — tolerant: warns + falls back (for reads and prompts)
//   readDailyNotesConfig            — public: env → file → fallbacks, uses the tolerant reader

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

/** Reads and parses .obsidian/daily-notes.json. Returns the fallbacks when
 *  no file exists there, and for each field the file does not set; any
 *  other failure propagates. */
const readDailyNotesFile = async (vaultPath: string): Promise<DailyNotesConfig> => {
  try {
    // Read on every call, so a folder or format change in Obsidian applies
    // to the next operation rather than after a restart.
    const configFileContent = await readFile(
      join(vaultPath, ".obsidian", "daily-notes.json"),
      "utf8",
    )
    const parsedConfig: unknown = JSON.parse(configFileContent)
    // Valid JSON can be `null` or a bare value, which has no keys to read.
    const settings = isRecord(parsedConfig) ? parsedConfig : {}
    return {
      folder:
        typeof settings.folder === "string" && settings.folder.length > 0
          ? settings.folder
          : FALLBACK_CONFIG.folder,
      format:
        typeof settings.format === "string" && settings.format.length > 0
          ? settings.format
          : FALLBACK_CONFIG.format,
    }
  } catch (error) {
    // No file, or no .obsidian/ folder at all: on a fresh remote deploy the
    // config can arrive after boot, so the fallbacks stand in until it does.
    if (isMissingPathError(error)) return { ...FALLBACK_CONFIG }
    throw error
  }
}

/** Reads the folder and filename format from .obsidian/daily-notes.json, for
 *  the protected-path guard.
 *  - Returns the fallbacks ("Daily Notes", "YYYY-MM-DD") when the file is missing.
 *  - Throws when the file exists but cannot be read or parsed. */
export const readDailyNotesFileConfig = async (
  vaultPath: string,
  logger: Logger,
): Promise<DailyNotesConfig> => {
  try {
    return await readDailyNotesFile(vaultPath)
  } catch (error) {
    // A fallback here would protect "Daily Notes" while the user's folder is
    // whatever the broken file says. The warn carries the raw cause; only the
    // thrown message reaches the client.
    logger.warn("cannot read daily notes config", { error: describeError(error) })
    throw new Error("cannot read daily notes config from .obsidian/daily-notes.json", {
      cause: error,
    })
  }
}

/** The file config, or the fallbacks with a `warn` when the file exists but
 *  cannot be read or parsed — for reads and prompts, where a wrong folder
 *  costs a missed note, not a deleted one. */
const readDailyNotesFileConfigOrFallback = async (
  vaultPath: string,
  logger: Logger,
): Promise<DailyNotesConfig> => {
  try {
    return await readDailyNotesFile(vaultPath)
  } catch (error) {
    logger.warn("cannot read daily notes config, using defaults", {
      error: describeError(error),
    })
    return { ...FALLBACK_CONFIG }
  }
}

/** Resolves the vault's daily note folder and filename format with
 *  per-field precedence: env setting → .obsidian/daily-notes.json →
 *  the fallbacks ("Daily Notes", "YYYY-MM-DD"). When both fields are
 *  set via env the config file is not read at all. A file that exists but
 *  cannot be read or parsed logs a `warn` and counts as absent. */
export const readDailyNotesConfig = async (
  params: {
    vaultPath: string
    envSettings?: DailyNotesEnvSettings | undefined
  },
  logger: Logger,
): Promise<DailyNotesConfig> => {
  const { vaultPath, envSettings } = params

  // Both fields set via env — the file can't contribute anything, skip I/O.
  if (envSettings?.folder && envSettings.format) {
    return { folder: envSettings.folder, format: envSettings.format }
  }

  const fileConfig = await readDailyNotesFileConfigOrFallback(vaultPath, logger)
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
export const getDailyNotePath = async (
  params: {
    vaultPath: string
    date?: string | undefined
    envSettings?: DailyNotesEnvSettings | undefined
  },
  logger: Logger,
): Promise<string> => {
  const { vaultPath, date, envSettings } = params
  const config = await readDailyNotesConfig({ vaultPath, envSettings }, logger)

  const unsupportedTokens = findUnsupportedTokens(config.format)

  if (unsupportedTokens.length > 0) {
    throw new Error(
      `daily note format contains unsupported token(s): ${unsupportedTokens.join(", ")} — the server cannot reproduce the filenames Obsidian creates with these tokens; change the format in Obsidian or set DAILY_NOTES_FORMAT to a supported format`,
    )
  }

  const luxonFormat = momentToLuxonFormat(config.format)

  if (date && !STRICT_ISO_DATE_RE.test(date)) {
    throw new Error(`invalid date "${date}" — use YYYY-MM-DD format (e.g. "2026-05-13")`)
  }

  const dateTime = date ? DateTime.fromISO(date) : DateTime.now()

  if (!dateTime.isValid) {
    throw new Error(`invalid date "${date}" — use YYYY-MM-DD format (e.g. "2026-05-13")`)
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
  const path = await getDailyNotePath(
    {
      vaultPath: params.vaultPath,
      date: params.date,
      envSettings: params.envSettings,
    },
    logger,
  )

  try {
    const content = await vaultFs.readNote({ vaultPath: params.vaultPath, path }, logger)
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
