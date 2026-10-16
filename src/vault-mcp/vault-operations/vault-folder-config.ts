import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { readDailyNotesConfig, readProtectedDailyNotesFolder } from "./daily-notes.js"

/** False for null (a vault-root or blank setting) and for a whitespace-only
 *  setting: neither names a daily folder to add. */
const isDailyFolderSet = (dailyFolder: string | null): dailyFolder is string => {
  return Boolean(dailyFolder?.trim())
}

/** The folders that delete and move refuse to touch.
 *  - PROTECTED_PATHS, when set, replaces the defaults entirely, so only the
 *    folders it lists are protected.
 *  - Otherwise the memory dir (protected even when MEMORY_ENABLED is false)
 *    plus the daily notes folder, resolved on each call (DAILY_NOTES_FOLDER →
 *    .obsidian/daily-notes.json → "Daily Notes") so a folder configured only
 *    in the vault is protected too.
 *  - A daily-notes.json folder that is the vault root or blank (Obsidian's
 *    new-note folder) protects no daily folder, since protecting either
 *    would cover every other note in it.
 *  Throws when daily-notes.json exists but cannot be read, since the folder
 *  it names is then unknown; DAILY_NOTES_FOLDER or PROTECTED_PATHS bypasses
 *  the file. */
export const resolveEffectiveProtectedPaths = async (
  { config, vaultPath }: { config: VaultConfig; vaultPath: string },
  logger: Logger,
): Promise<readonly string[]> => {
  if (config.protectedPathsOverride) return config.protectedPathsOverride

  // loadConfig trims DAILY_NOTES_FOLDER, so a set value is never blank.
  if (config.dailyNotesFolder) return [config.memoryDir, config.dailyNotesFolder]

  const dailyFolder = await readProtectedDailyNotesFolder(vaultPath, logger)

  return isDailyFolderSet(dailyFolder) ? [config.memoryDir, dailyFolder] : [config.memoryDir]
}

/** The folders orphan results leave out: ORPHAN_EXCLUDE_FOLDERS when set,
 *  otherwise the daily notes folder, "Templates", and the memory dir. */
export const resolveEffectiveOrphanExcludeFolders = ({
  orphanExcludeFoldersOverride,
  memoryDir,
  dailyNotesFolder,
}: {
  orphanExcludeFoldersOverride: readonly string[] | null
  memoryDir: string
  /** Null when the daily folder setting is the vault root or blank. */
  dailyNotesFolder: string | null
}): readonly string[] => {
  if (orphanExcludeFoldersOverride) return orphanExcludeFoldersOverride

  return isDailyFolderSet(dailyNotesFolder)
    ? [dailyNotesFolder, "Templates", memoryDir]
    : ["Templates", memoryDir]
}

/** resolveEffectiveOrphanExcludeFolders for callers holding only the config:
 *  reads .obsidian/daily-notes.json unless ORPHAN_EXCLUDE_FOLDERS or
 *  DAILY_NOTES_FOLDER already settles the list. */
export const readEffectiveOrphanExcludeFolders = async (
  { config, vaultPath }: { config: VaultConfig; vaultPath: string },
  logger: Logger,
): Promise<readonly string[]> => {
  if (config.orphanExcludeFoldersOverride) return config.orphanExcludeFoldersOverride

  // The daily folder is the only default that varies, so an env value for
  // it means no file read.
  if (config.dailyNotesFolder) {
    return resolveEffectiveOrphanExcludeFolders({
      orphanExcludeFoldersOverride: null,
      memoryDir: config.memoryDir,
      dailyNotesFolder: config.dailyNotesFolder,
    })
  }

  const dailyNotesConfig = await readDailyNotesConfig({ vaultPath }, logger)
  return resolveEffectiveOrphanExcludeFolders({
    orphanExcludeFoldersOverride: null,
    memoryDir: config.memoryDir,
    dailyNotesFolder: dailyNotesConfig.dedicatedFolder,
  })
}
