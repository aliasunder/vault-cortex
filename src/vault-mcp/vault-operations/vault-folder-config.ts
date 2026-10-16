import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { readDailyNotesConfig, readProtectedDailyNotesFolder } from "./daily-notes.js"

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

  // A whitespace-only folder in daily-notes.json protects nothing.
  return dailyFolder?.trim() ? [config.memoryDir, dailyFolder] : [config.memoryDir]
}

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

  /** Whitespace-only settings exclude no daily folder; spaces in a nonblank folder name stay. */
  return dailyNotesFolder?.trim()
    ? [dailyNotesFolder, "Templates", memoryDir]
    : ["Templates", memoryDir]
}

/** Only the daily folder affects orphan exclusions, so its env override skips file I/O. */
export const readEffectiveOrphanExcludeFolders = async (
  { config, vaultPath }: { config: VaultConfig; vaultPath: string },
  logger: Logger,
): Promise<readonly string[]> => {
  if (config.orphanExcludeFoldersOverride) return config.orphanExcludeFoldersOverride

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
