import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"
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
  ["A", "a"],
]

/** Matches Moment.js [literal] escape groups — e.g. [Daily Note]. */
const MOMENT_ESCAPE_RE = /\[([^\]]*)\]/g

/** Converts a Moment.js format string to Luxon format tokens.
 *  Handles [literal] escapes (Moment) → 'literal' (Luxon) and
 *  common date/time tokens. Unsupported tokens (Do, d, dd) are
 *  left as-is — Luxon will throw on unknown tokens, making the
 *  failure visible rather than producing a wrong path. */
export const momentToLuxonFormat = (momentFormat: string): string => {
  // First pass: convert Moment [literal] escapes to Luxon 'literal' syntax.
  // Single quotes inside literals are doubled per Luxon's escape convention.
  const withLiteralsConverted = momentFormat.replace(
    MOMENT_ESCAPE_RE,
    (_, literal) => {
      const escapedContent = ((literal as string) ?? "").replace(/'/g, "''")
      return `'${escapedContent}'`
    },
  )
  // Second pass: replace date/time tokens from longest to shortest
  return MOMENT_TO_LUXON.reduce(
    (formatString, [momentToken, luxonToken]) =>
      formatString.replaceAll(momentToken, luxonToken),
    withLiteralsConverted,
  )
}

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
    const parsedConfig = JSON.parse(configFileContent) as Record<
      string,
      unknown
    >
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
  } catch {
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
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (errorMessage.startsWith("note not found")) {
      logger.info("daily note not found", { path })
      return { path, content: null, exists: false }
    }
    throw err
  }
}
