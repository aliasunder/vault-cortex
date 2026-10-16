import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"
import { vaultFs } from "./vault-filesystem.js"
import { momentToLuxonFormat, findUnsupportedTokens } from "../obsidian-markdown/moment-format.js"
import { describeError } from "../../utils/describe-error.js"
import { isMissingPathError, readFileOrNull } from "../../utils/fs.js"
import { isRecord } from "../../utils/is-record.js"

// ── Config reading ──────────────────────────────────────────────
//
// Three readers, each wrapping readDailyNotesFile:
//   readProtectedDailyNotesFolder — strict: throws on an unreadable file (for the delete/move guard)
//   readDailyNotesFileOrFallback  — tolerant: warns + falls back (for reads and prompts)
//   readDailyNotesConfig          — public: env → file → fallbacks, uses the tolerant reader

type DailyNotesConfig = {
  /** Where daily notes are read from: vault-relative, with no leading or
   *  trailing slash; "" is the vault root. */
  folder: string
  format: string
  /** The folder when it holds daily notes apart from other notes, for the
   *  delete guard, orphan exclusion and forward-reference counts. Null when
   *  the setting is the vault root or blank (Obsidian's new-note folder),
   *  since treating those as daily-only would cover every other note there. */
  dedicatedFolder: string | null
}

/** The folder setting in daily-notes.json:
 *  - `no-file`: the file does not exist.
 *  - `blank`: the file exists with a missing or empty folder, so Obsidian
 *    puts daily notes in its location for new notes.
 *  - `named`: the normalized folder; "" is the vault root. */
type DailyNotesFolderSetting =
  { kind: "no-file" } | { kind: "blank" } | { kind: "named"; folder: string }

type DailyNotesFileSettings = {
  folderSetting: DailyNotesFolderSetting
  format: string
}

/** Per-field settings from the DAILY_NOTES_FOLDER / DAILY_NOTES_FORMAT env
 *  vars; each set field takes precedence over .obsidian/daily-notes.json. */
export type DailyNotesEnvSettings = {
  folder?: string | undefined
  format?: string | undefined
}

export const DEFAULT_DAILY_NOTES_FOLDER = "Daily Notes"

const DEFAULT_DAILY_NOTES_FORMAT = "YYYY-MM-DD"

// The format matches Obsidian's default; the folder is this server's own
// choice — Obsidian with no daily-notes.json creates dailies in its location
// for new notes, which is not a sensible folder for the server to assume.
const FALLBACK_FILE_SETTINGS: DailyNotesFileSettings = {
  folderSetting: { kind: "no-file" },
  format: DEFAULT_DAILY_NOTES_FORMAT,
}

/** Matches each run of forward or back slashes in a folder setting. */
const SLASH_RUN_RE = /[\\/]+/g

/** Normalizes a folder setting the way Obsidian does before using it:
 *  slash runs (either direction) become one "/", and leading and trailing
 *  slashes are dropped. Obsidian saves the vault root as "/", which
 *  becomes "". */
const normalizeFolderSetting = (folderSetting: string): string => {
  return folderSetting.replace(SLASH_RUN_RE, "/").replace(/^\/|\/$/g, "")
}

/** Reads and parses .obsidian/daily-notes.json. A missing file gives the
 *  `no-file` setting; any other failure propagates. */
const readDailyNotesFile = async (vaultPath: string): Promise<DailyNotesFileSettings> => {
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
    const folderSetting: DailyNotesFolderSetting =
      typeof settings.folder === "string" && settings.folder.length > 0
        ? { kind: "named", folder: normalizeFolderSetting(settings.folder) }
        : { kind: "blank" }
    return {
      folderSetting,
      format:
        typeof settings.format === "string" && settings.format.length > 0
          ? settings.format
          : DEFAULT_DAILY_NOTES_FORMAT,
    }
  } catch (error) {
    // No file, or no .obsidian/ folder at all: on a fresh remote deploy the
    // config can arrive after boot, so the fallbacks stand in until it does.
    if (isMissingPathError(error)) return FALLBACK_FILE_SETTINGS
    throw error
  }
}

const resolveDedicatedFolder = (folderSetting: DailyNotesFolderSetting): string | null => {
  if (folderSetting.kind === "no-file") return DEFAULT_DAILY_NOTES_FOLDER
  if (folderSetting.kind === "blank") return null
  return folderSetting.folder || null
}

/** Reads the daily notes folder the delete and move guard protects, from
 *  .obsidian/daily-notes.json.
 *  - Returns "Daily Notes" when the file is missing, and null when its
 *    folder is the vault root or blank.
 *  - Throws when the file exists but cannot be read or parsed. */
export const readProtectedDailyNotesFolder = async (
  vaultPath: string,
  logger: Logger,
): Promise<string | null> => {
  try {
    const { folderSetting } = await readDailyNotesFile(vaultPath)
    return resolveDedicatedFolder(folderSetting)
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

/** The file settings, or the fallbacks with a `warn` when the file exists but
 *  cannot be read or parsed — for reads and prompts, where a wrong folder
 *  costs a missed note, not a deleted one. */
const readDailyNotesFileOrFallback = async (
  vaultPath: string,
  logger: Logger,
): Promise<DailyNotesFileSettings> => {
  try {
    return await readDailyNotesFile(vaultPath)
  } catch (error) {
    logger.warn("cannot read daily notes config, using defaults", {
      error: describeError(error),
    })
    return FALLBACK_FILE_SETTINGS
  }
}

/** Obsidian's location for new notes, read from `newFileLocation` and
 *  `newFileFolderPath` in .obsidian/app.json.
 *  - Returns the folder when new notes go to a set folder, else the vault
 *    root (""). "Same folder as current file" also means the root, since a
 *    daily note has no current file.
 *  - A missing or unreadable app.json means Obsidian's default, the root.
 *  - Unlike Obsidian, a set folder that no longer exists is not swapped for
 *    the root; the daily note then reads as missing. */
const readNewNoteFolder = async (vaultPath: string, logger: Logger): Promise<string> => {
  try {
    const appConfigContent = await readFileOrNull(join(vaultPath, ".obsidian", "app.json"))

    if (appConfigContent === null) return ""

    const parsedConfig: unknown = JSON.parse(appConfigContent)
    const settings = isRecord(parsedConfig) ? parsedConfig : {}
    const { newFileLocation, newFileFolderPath } = settings

    if (newFileLocation === "folder" && typeof newFileFolderPath === "string") {
      return normalizeFolderSetting(newFileFolderPath)
    }
    return ""
  } catch (error) {
    // Reads and prompts only, so a wrong folder costs a missed note.
    logger.warn("cannot read new note location, using the vault root", {
      error: describeError(error),
    })
    return ""
  }
}

const resolveDailyNotesFolder = async (
  { folderSetting, vaultPath }: { folderSetting: DailyNotesFolderSetting; vaultPath: string },
  logger: Logger,
): Promise<string> => {
  if (folderSetting.kind === "no-file") return DEFAULT_DAILY_NOTES_FOLDER
  if (folderSetting.kind === "blank") return readNewNoteFolder(vaultPath, logger)
  return folderSetting.folder
}

/** Resolves the vault's daily note folder and filename format with
 *  per-field precedence: env setting → .obsidian/daily-notes.json →
 *  the fallbacks ("Daily Notes", "YYYY-MM-DD").
 *  - A blank folder in daily-notes.json means Obsidian's location for new
 *    notes, read from .obsidian/app.json.
 *  - When both fields are set via env, no config file is read.
 *  - A daily-notes.json that exists but cannot be read or parsed logs a
 *    `warn` and counts as absent. */
export const readDailyNotesConfig = async (
  params: {
    vaultPath: string
    envSettings?: DailyNotesEnvSettings | undefined
  },
  logger: Logger,
): Promise<DailyNotesConfig> => {
  const { vaultPath, envSettings } = params
  const envFolder = envSettings?.folder

  // Both fields set — the files can't contribute anything, skip I/O. A
  // resolved config passed back in can carry "" (the vault root) as its folder.
  if (envFolder !== undefined && envSettings?.format) {
    return { folder: envFolder, format: envSettings.format, dedicatedFolder: envFolder || null }
  }

  const { folderSetting, format: fileFormat } = await readDailyNotesFileOrFallback(
    vaultPath,
    logger,
  )
  const format = envSettings?.format ?? fileFormat

  if (envFolder !== undefined) {
    return { folder: envFolder, format, dedicatedFolder: envFolder || null }
  }

  const folder = await resolveDailyNotesFolder({ folderSetting, vaultPath }, logger)
  return { folder, format, dedicatedFolder: resolveDedicatedFolder(folderSetting) }
}

// ── Path resolution + read ──────────────────────────────────────

/** Matches strict YYYY-MM-DD date strings (no time component, no partial dates). */
const STRICT_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The refusal for a YYYY-MM-DD date the calendar lacks, such as February 30.
 *  Shared so the daily-note tool and the daily-review prompt refuse it in the
 *  same words. */
export const describeNonCalendarDate = (date: string): string => {
  return `"${date}" is not a calendar date. Pass a real date in YYYY-MM-DD format.`
}

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

  // The shape check above passed, so Luxon rejects only a day the calendar
  // lacks, such as February 30. The message says so, because a caller told
  // only the format would send the same date again
  if (date && !dateTime.isValid) {
    throw new Error(describeNonCalendarDate(date))
  }

  const filename = dateTime.toFormat(luxonFormat)
  return config.folder ? `${config.folder}/${filename}.md` : `${filename}.md`
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
  } catch (error) {
    const errorMessage = describeError(error)

    if (errorMessage.startsWith("[Error]: note not found")) {
      logger.info("daily note not found", { path })
      return { path, content: null, exists: false }
    }
    throw error
  }
}
