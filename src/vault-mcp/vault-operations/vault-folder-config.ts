import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { readDailyNotesConfig, readProtectedDailyNotesFolder } from "./daily-notes.js"

/** The daily folder to add to a default list, or null when there is none to
 *  add: a vault-root or blank setting (null) and a whitespace-only one. */
const pickDailyFolderToAdd = (dailyFolder: string | null): string | null => {
  return dailyFolder?.trim() ? dailyFolder : null
}

/** The folders that delete and move refuse to touch.
 *  - PROTECTED_PATHS, when set, replaces the defaults entirely, so only the
 *    folders it lists are protected.
 *  - Otherwise the memory dir (protected even when MEMORY_ENABLED is false)
 *    plus the daily notes folder, resolved on each call (DAILY_NOTES_FOLDER →
 *    .obsidian/daily-notes.json → "Daily Notes") so a folder configured only
 *    in the vault is protected too.
 *  - No daily folder is protected when the setting is the vault root, from
 *    DAILY_NOTES_FOLDER or daily-notes.json, or is blank in daily-notes.json,
 *    which means Obsidian's new-note folder. Protecting either folder would
 *    cover every other note in it.
 *  Throws when daily-notes.json exists but cannot be read, since the folder
 *  it names is then unknown; DAILY_NOTES_FOLDER or PROTECTED_PATHS bypasses
 *  the file. */
export const resolveEffectiveProtectedPaths = async (
  { config, vaultPath }: { config: VaultConfig; vaultPath: string },
  logger: Logger,
): Promise<readonly string[]> => {
  if (config.protectedPathsOverride) return config.protectedPathsOverride

  // DAILY_NOTES_FOLDER="/" loads as "" (the vault root), which protects no
  // daily folder. loadConfig trims and rejects blank values, so any other set
  // value needs no pickDailyFolderToAdd check.
  if (config.dailyNotesFolder !== undefined) {
    return config.dailyNotesFolder
      ? [config.memoryDir, config.dailyNotesFolder]
      : [config.memoryDir]
  }

  const protectedDailyFolder = await readProtectedDailyNotesFolder(vaultPath, logger)
  const dailyFolder = pickDailyFolderToAdd(protectedDailyFolder)

  return dailyFolder ? [config.memoryDir, dailyFolder] : [config.memoryDir]
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

  const dailyFolder = pickDailyFolderToAdd(dailyNotesFolder)

  return dailyFolder ? [dailyFolder, "Templates", memoryDir] : ["Templates", memoryDir]
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
  // it means no file read. The vault root ("") adds no daily folder.
  if (config.dailyNotesFolder !== undefined) {
    return resolveEffectiveOrphanExcludeFolders({
      orphanExcludeFoldersOverride: null,
      memoryDir: config.memoryDir,
      dailyNotesFolder: config.dailyNotesFolder || null,
    })
  }

  const dailyNotesConfig = await readDailyNotesConfig({ vaultPath }, logger)
  return resolveEffectiveOrphanExcludeFolders({
    orphanExcludeFoldersOverride: null,
    memoryDir: config.memoryDir,
    dailyNotesFolder: dailyNotesConfig.dedicatedFolder,
  })
}
