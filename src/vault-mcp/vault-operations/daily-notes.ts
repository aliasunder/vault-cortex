import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import { logger, type Logger } from "../../logger.js"
import { vaultFs } from "./vault-filesystem.js"
import { momentToLuxonFormat } from "./moment-format.js"
import { describeError } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"

// ── Config reading ──────────────────────────────────────────────

type DailyNotesConfig = {
  folder: string
  format: string
}

const OBSIDIAN_DEFAULTS: DailyNotesConfig = {
  folder: "Daily Notes",
  format: "YYYY-MM-DD",
}

// TODO: Consider refactoring to factory/closure pattern (like createSearchIndex,
// createMemoryStore) so the cache lives in the closure instead of at module scope.
// Mutable module-level cache — justified because the config is read from
// the filesystem once and never changes during the server's lifetime.
// Avoids re-reading .obsidian/daily-notes.json on every tool call.
let cachedConfig: DailyNotesConfig | null = null

/** Reads .obsidian/daily-notes.json for the vault's daily note folder
 *  and filename format. Falls back to Obsidian defaults if the file
 *  is missing or malformed. Result is cached after first read. */
export const readDailyNotesConfig = async (
  vaultPath: string,
): Promise<DailyNotesConfig> => {
  if (cachedConfig) return cachedConfig

  try {
    const configFileContent = await readFile(
      join(vaultPath, ".obsidian", "daily-notes.json"),
      "utf8",
    )
    const parsedConfig: Record<string, unknown> = JSON.parse(configFileContent)
    cachedConfig = {
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
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      logger.debug("failed to read daily notes config, using defaults", {
        error: describeError(error),
      })
    }
    cachedConfig = { ...OBSIDIAN_DEFAULTS }
  }

  return cachedConfig
}

// ── Path resolution + read ──────────────────────────────────────

/** Matches strict YYYY-MM-DD date strings (no time component, no partial dates). */
const STRICT_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Resolves a date to a vault-relative daily note path using the
 *  vault's .obsidian/daily-notes.json config. */
export const getDailyNotePath = async (
  vaultPath: string,
  date?: string,
): Promise<string> => {
  const config = await readDailyNotesConfig(vaultPath)
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
  params: { vaultPath: string; date?: string | undefined },
  logger: Logger,
): Promise<DailyNoteResult> => {
  const path = await getDailyNotePath(params.vaultPath, params.date)

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
