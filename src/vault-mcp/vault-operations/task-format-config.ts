/** Task format config — reads the Tasks plugin's metadata-format and
 *  recurrence-behavior settings.
 *
 *  The Tasks plugin stores its settings in
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json`. When the file is
 *  absent (plugin not installed, or .obsidian/ not synced to the server),
 *  every field falls back to the plugin's own default. */

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
  /** Stamp ➕ today on a spawned recurrence (plugin default: off). */
  setCreatedDate: boolean
  /** Write the spawned recurrence below the completed task instead of above. */
  recurrenceOnNextLine: boolean
  /** Drop the scheduled date from a spawned recurrence when another date
   *  carries the series. */
  removeScheduledDateOnRecurrence: boolean
  /** Checkbox chars the plugin's status registry types as DONE, beyond
   *  `x`/`X` — a task on one of these must not spawn a recurrence when an
   *  update marks it done (it already was). Empty when the vault defines no
   *  custom statuses. */
  doneStatusSymbols: readonly string[]
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULTS: TaskFormatConfig = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
  setCreatedDate: false,
  recurrenceOnNextLine: false,
  removeScheduledDateOnRecurrence: false,
  doneStatusSymbols: [],
}

// ── Status-registry parsing ─────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Checkbox symbols typed DONE in the plugin's status registry
 *  (`statusSettings.coreStatuses` + `.customStatuses`, entries shaped
 *  `{ symbol, type, ... }`). The legacy pre-type format
 *  (`customStatusTypes` with `indicator`) carries no DONE typing and is
 *  ignored. */
const doneStatusSymbolsFrom = (parsed: Record<string, unknown>): string[] => {
  const { statusSettings } = parsed
  if (!isRecord(statusSettings)) return []

  const statusLists = [
    statusSettings.coreStatuses,
    statusSettings.customStatuses,
  ].filter(Array.isArray)

  return statusLists.flatMap((statusList) => {
    return statusList.flatMap((status: unknown) => {
      if (!isRecord(status)) return []
      return typeof status.symbol === "string" && status.type === "DONE"
        ? [status.symbol]
        : []
    })
  })
}

// ── Config reader ───────────────────────────────────────────────

// Caches only SUCCESSFUL reads — same pattern and rationale as
// daily-notes.ts: uncached fallbacks are retried, so a plugin config
// arriving after boot is picked up without a restart.
let cachedConfig: TaskFormatConfig | null = null

/** The config keys that hold booleans — the settings file uses the same
 *  key names. */
type BooleanSettingKey =
  | "setDoneDate"
  | "setCancelledDate"
  | "setCreatedDate"
  | "recurrenceOnNextLine"
  | "removeScheduledDateOnRecurrence"

/** A boolean setting from the parsed config, or its default when absent or
 *  not a boolean. */
const booleanSetting = (
  parsed: Record<string, unknown>,
  key: BooleanSettingKey,
): boolean => {
  const value = parsed[key]
  return typeof value === "boolean" ? value : DEFAULTS[key]
}

/** Reads the Tasks plugin's settings from
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json`. Falls back to the
 *  plugin's defaults (uncached — see cache comment) when the file is
 *  missing or malformed. */
export const readTaskFormatConfig = async (
  vaultPath: string,
): Promise<TaskFormatConfig> => {
  if (cachedConfig) return cachedConfig

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
      setDoneDate: booleanSetting(parsed, "setDoneDate"),
      setCancelledDate: booleanSetting(parsed, "setCancelledDate"),
      setCreatedDate: booleanSetting(parsed, "setCreatedDate"),
      recurrenceOnNextLine: booleanSetting(parsed, "recurrenceOnNextLine"),
      removeScheduledDateOnRecurrence: booleanSetting(
        parsed,
        "removeScheduledDateOnRecurrence",
      ),
      doneStatusSymbols: doneStatusSymbolsFrom(parsed),
    }
    cachedConfig = fileConfig
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
