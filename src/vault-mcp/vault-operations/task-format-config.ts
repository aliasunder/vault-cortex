/** Task format config — reads the Tasks plugin's preferred metadata format.
 *
 *  The Tasks plugin stores its format preference in
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json`. When the file is
 *  absent (plugin not installed, or .obsidian/ not synced to the server),
 *  defaults to emoji format with done/cancelled dates enabled. */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"

// ── Types ───────────────────────────────────────────────────────

export type TaskFormatConfig = {
  taskFormat: "emoji" | "dataview"
  setDoneDate: boolean
  setCancelledDate: boolean
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULTS: TaskFormatConfig = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
}

// ── Config reader ───────────────────────────────────────────────

// Mutable module-level cache of the last SUCCESSFUL file read, keyed by
// vault path — same pattern as daily-notes.ts. Fallback results (file
// missing or malformed) are deliberately never cached: on a fresh remote
// deploy the plugin config can arrive after the first read (initial
// Obsidian Sync still running), so retrying each call picks it up without
// a restart. Once a read succeeds, the value is cached for the process
// lifetime.
let cachedConfig: { vaultPath: string; config: TaskFormatConfig } | null = null

/** Reads the Tasks plugin's format preference from
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json`. Falls back to
 *  emoji format + dates enabled (uncached — see cache comment) when the
 *  file is missing or malformed. */
export const readTaskFormatConfig = async (
  vaultPath: string,
): Promise<TaskFormatConfig> => {
  if (cachedConfig?.vaultPath === vaultPath) return cachedConfig.config

  try {
    const configPath = join(
      vaultPath,
      ".obsidian",
      "plugins",
      "obsidian-tasks-plugin",
      "data.json",
    )
    const fileContent = await readFile(configPath, "utf8")
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawFormat = parsed.taskFormat
    const taskFormat: "emoji" | "dataview" =
      rawFormat === "dataview" ? "dataview" : "emoji"

    const fileConfig = {
      taskFormat,
      setDoneDate:
        typeof parsed.setDoneDate === "boolean"
          ? parsed.setDoneDate
          : DEFAULTS.setDoneDate,
      setCancelledDate:
        typeof parsed.setCancelledDate === "boolean"
          ? parsed.setCancelledDate
          : DEFAULTS.setCancelledDate,
    }
    cachedConfig = { vaultPath, config: fileConfig }
    return fileConfig
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) {
      logger.debug("failed to read Tasks plugin config, using defaults", {
        error: describeError(error),
      })
    }
    return { ...DEFAULTS }
  }
}

/** Resets the cached config — only for testing. */
export const resetTaskFormatConfigCache = (): void => {
  cachedConfig = null
}
