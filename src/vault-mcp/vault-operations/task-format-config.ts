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

/** The five status types the Tasks plugin's registry can assign to a
 *  checkbox char. The first four match `TaskStatus` in tasks.ts;
 *  `non_task` means the plugin doesn't treat this checkbox as a task. */
export type StatusClassification = "todo" | "in_progress" | "done" | "cancelled" | "non_task"

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
  /** The Tasks plugin's status registry: checkbox char → classified type.
   *  When the plugin config is absent, the map contains only the five
   *  built-in chars (` `, `x`, `X`, `/`, `-`). A char not in the map is
   *  treated as `"todo"` by the parser — matching the plugin's
   *  unknown-symbol behavior. */
  statusRegistry: ReadonlyMap<string, StatusClassification>
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULT_STATUS_REGISTRY: ReadonlyMap<string, StatusClassification> = new Map([
  [" ", "todo"],
  ["x", "done"],
  ["X", "done"],
  ["/", "in_progress"],
  ["-", "cancelled"],
])

const DEFAULTS: TaskFormatConfig = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
  setCreatedDate: false,
  recurrenceOnNextLine: false,
  removeScheduledDateOnRecurrence: false,
  statusRegistry: DEFAULT_STATUS_REGISTRY,
}

// ── Status-registry parsing ─────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Maps the plugin's type strings to our status classification. */
const pluginTypeToClassification = (pluginType: string): StatusClassification | null => {
  switch (pluginType) {
    case "TODO":
      return "todo"
    case "IN_PROGRESS":
      return "in_progress"
    case "DONE":
      return "done"
    case "CANCELLED":
      return "cancelled"
    case "NON_TASK":
      return "non_task"
    default:
      return null
  }
}

/** Builds the status registry from the plugin's `statusSettings`
 *  (`coreStatuses` + `customStatuses`, entries shaped
 *  `{ symbol, type, ... }`). The legacy pre-type format
 *  (`customStatusTypes` with `indicator`) carries no type mapping and is
 *  ignored. Falls back to the default registry when the settings are
 *  absent or malformed. */
const statusRegistryFrom = (
  parsed: Record<string, unknown>,
): ReadonlyMap<string, StatusClassification> => {
  const { statusSettings } = parsed

  if (!isRecord(statusSettings)) return DEFAULT_STATUS_REGISTRY

  const statusLists = [statusSettings.coreStatuses, statusSettings.customStatuses].filter(
    Array.isArray,
  )

  if (statusLists.length === 0) return DEFAULT_STATUS_REGISTRY

  const entries: Array<[string, StatusClassification]> = statusLists.flatMap((statusList) => {
    return statusList.flatMap((status: unknown): Array<[string, StatusClassification]> => {
      if (!isRecord(status)) return []
      if (typeof status.symbol !== "string" || typeof status.type !== "string") return []
      const classification = pluginTypeToClassification(status.type)
      return classification !== null ? [[status.symbol, classification]] : []
    })
  })

  return entries.length > 0 ? new Map(entries) : DEFAULT_STATUS_REGISTRY
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
const booleanSetting = (parsed: Record<string, unknown>, key: BooleanSettingKey): boolean => {
  const value = parsed[key]
  return typeof value === "boolean" ? value : DEFAULTS[key]
}

/** Reads the Tasks plugin's settings from
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json`. Falls back to the
 *  plugin's defaults (uncached — see cache comment) when the file is
 *  missing or malformed. */
export const readTaskFormatConfig = async (vaultPath: string): Promise<TaskFormatConfig> => {
  if (cachedConfig) return cachedConfig

  try {
    const configPath = join(vaultPath, ".obsidian", "plugins", "obsidian-tasks-plugin", "data.json")
    const fileContent = await readFile(configPath, "utf8")
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawFormat = parsed.taskFormat
    const taskFormat: "emoji" | "dataview" = rawFormat === "dataview" ? "dataview" : "emoji"

    const fileConfig: TaskFormatConfig = {
      taskFormat,
      setDoneDate: booleanSetting(parsed, "setDoneDate"),
      setCancelledDate: booleanSetting(parsed, "setCancelledDate"),
      setCreatedDate: booleanSetting(parsed, "setCreatedDate"),
      recurrenceOnNextLine: booleanSetting(parsed, "recurrenceOnNextLine"),
      removeScheduledDateOnRecurrence: booleanSetting(parsed, "removeScheduledDateOnRecurrence"),
      statusRegistry: statusRegistryFrom(parsed),
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
