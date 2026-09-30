/** Task format config — reads the Tasks plugin's metadata-format and
 *  recurrence-behavior settings.
 *
 *  The Tasks plugin stores its settings in
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json`. When the file is
 *  absent (plugin not installed, or .obsidian/ not synced to the server),
 *  every field falls back to the plugin's own default. */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../../logger.js"
import { DEFAULT_STATUS_REGISTRY } from "../obsidian-markdown/tasks.js"
import { describeError } from "../../utils/describe-error.js"
import { isMissingPathError } from "../../utils/fs.js"

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

  // Array.isArray narrows each element from unknown to any[] — keep only
  // the lists that are actually present and shaped as arrays.
  const statusLists: unknown[][] = [
    statusSettings.coreStatuses,
    statusSettings.customStatuses,
  ].filter(Array.isArray)

  if (statusLists.length === 0) return DEFAULT_STATUS_REGISTRY

  const entries: Array<[string, StatusClassification]> = statusLists.flatMap((statusList) => {
    return statusList.flatMap((status: unknown): Array<[string, StatusClassification]> => {
      if (!isRecord(status)) return []
      if (typeof status.symbol !== "string" || typeof status.type !== "string") return []
      const classification = pluginTypeToClassification(status.type)
      return classification !== null ? [[status.symbol, classification]] : []
    })
  })

  // Merge parsed entries ON TOP of defaults so chars the config omits
  // (notably uppercase X, which the plugin's coreStatuses never lists)
  // keep their built-in classification instead of falling to "todo".
  return new Map([...DEFAULT_STATUS_REGISTRY, ...entries])
}

// ── Config reader ───────────────────────────────────────────────

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

/** Reads and parses the plugin's data.json. Returns the defaults when no
 *  file exists there; any other failure propagates. */
const readTaskFormatFileConfig = async (vaultPath: string): Promise<TaskFormatConfig> => {
  const configPath = join(vaultPath, ".obsidian", "plugins", "obsidian-tasks-plugin", "data.json")

  try {
    // Read on every call, so a format or date-toggle change in the plugin's
    // settings applies to the next task write rather than after a restart.
    const fileContent = await readFile(configPath, "utf8")
    const parsed: Record<string, unknown> = JSON.parse(fileContent)

    const rawFormat = parsed.taskFormat
    const taskFormat: "emoji" | "dataview" = rawFormat === "dataview" ? "dataview" : "emoji"

    return {
      taskFormat,
      setDoneDate: booleanSetting(parsed, "setDoneDate"),
      setCancelledDate: booleanSetting(parsed, "setCancelledDate"),
      setCreatedDate: booleanSetting(parsed, "setCreatedDate"),
      recurrenceOnNextLine: booleanSetting(parsed, "recurrenceOnNextLine"),
      removeScheduledDateOnRecurrence: booleanSetting(parsed, "removeScheduledDateOnRecurrence"),
      statusRegistry: statusRegistryFrom(parsed),
    }
  } catch (error) {
    if (isMissingPathError(error)) return { ...DEFAULTS }
    throw error
  }
}

/** Reads the Tasks plugin's settings from
 *  `.obsidian/plugins/obsidian-tasks-plugin/data.json` on every call.
 *  Returns the plugin's defaults when the file is missing, and — with a
 *  `warn` on the caller's logger — when it exists but cannot be read or
 *  parsed. */
export const readTaskFormatConfig = async (
  vaultPath: string,
  logger: Logger,
): Promise<TaskFormatConfig> => {
  try {
    return await readTaskFormatFileConfig(vaultPath)
  } catch (error) {
    // The settings only shape what a task write emits, so the defaults are
    // a safe stand-in while the file is broken.
    logger.warn("cannot read Tasks plugin config, using defaults", {
      error: describeError(error),
    })
    return { ...DEFAULTS }
  }
}
