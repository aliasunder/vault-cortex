import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  readTaskFormatConfig,
  resetTaskFormatConfigCache,
} from "../task-format-config.js"

const createVault = async (): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "task-format-config-test-"))
  onTestFinished(async () => rm(vaultPath, { recursive: true }))
  return vaultPath
}

const writePluginConfig = async (
  vaultPath: string,
  config: Record<string, unknown>,
): Promise<void> => {
  const pluginDir = join(
    vaultPath,
    ".obsidian",
    "plugins",
    "obsidian-tasks-plugin",
  )
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, "data.json"), JSON.stringify(config), "utf8")
}

/** The recurrence-behavior fields at the plugin's defaults — what a config
 *  file that doesn't mention them must produce. */
const DEFAULT_RECURRENCE_FIELDS = {
  setCreatedDate: false,
  recurrenceOnNextLine: false,
  removeScheduledDateOnRecurrence: false,
  doneStatusSymbols: [],
}

describe("readTaskFormatConfig", () => {
  it("reads emoji format from a valid config file", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "tasksPluginEmoji",
      setDoneDate: true,
      setCancelledDate: false,
    })

    const config = await readTaskFormatConfig(vault)

    expect(config).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: false,
      ...DEFAULT_RECURRENCE_FIELDS,
    })
  })

  it("reads the recurrence-behavior settings from the config file", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "tasksPluginEmoji",
      setCreatedDate: true,
      recurrenceOnNextLine: true,
      removeScheduledDateOnRecurrence: true,
    })

    const config = await readTaskFormatConfig(vault)

    expect(config).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: true,
      setCreatedDate: true,
      recurrenceOnNextLine: true,
      removeScheduledDateOnRecurrence: true,
      doneStatusSymbols: [],
    })
  })

  it("collects DONE-typed checkbox symbols from the status registry", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        coreStatuses: [
          { symbol: " ", name: "Todo", nextStatusSymbol: "x", type: "TODO" },
          { symbol: "x", name: "Done", nextStatusSymbol: " ", type: "DONE" },
        ],
        customStatuses: [
          {
            symbol: "D",
            name: "Deployed",
            nextStatusSymbol: " ",
            type: "DONE",
          },
          { symbol: "!", name: "Urgent", nextStatusSymbol: "x", type: "TODO" },
        ],
      },
    })

    const config = await readTaskFormatConfig(vault)

    expect(config.doneStatusSymbols).toEqual(["x", "D"])
  })

  it("ignores the legacy pre-type status format", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        customStatusTypes: [
          { indicator: "P", name: "Pro", nextStatusIndicator: "C" },
        ],
      },
    })

    const config = await readTaskFormatConfig(vault)

    expect(config.doneStatusSymbols).toEqual([])
  })

  it("ignores malformed status-registry entries", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        coreStatuses: ["not-an-object", { type: "DONE" }, { symbol: 3 }],
        customStatuses: "not-an-array",
      },
    })

    const config = await readTaskFormatConfig(vault)

    expect(config.doneStatusSymbols).toEqual([])
  })

  it("reads dataview format from a valid config file", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: true,
    })

    const config = await readTaskFormatConfig(vault)

    expect(config).toEqual({
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: true,
      ...DEFAULT_RECURRENCE_FIELDS,
    })
  })

  it("falls back to defaults when the config file is missing", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()

    const config = await readTaskFormatConfig(vault)

    expect(config).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: true,
      ...DEFAULT_RECURRENCE_FIELDS,
    })
  })

  it("falls back to defaults on malformed JSON", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    const pluginDir = join(
      vault,
      ".obsidian",
      "plugins",
      "obsidian-tasks-plugin",
    )
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, "data.json"), "not valid json{{{", "utf8")

    const config = await readTaskFormatConfig(vault)

    expect(config).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: true,
      ...DEFAULT_RECURRENCE_FIELDS,
    })
  })

  it("retries after ENOENT — a plugin config appearing later is picked up without a restart", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()

    const beforeFileExists = await readTaskFormatConfig(vault)
    expect(beforeFileExists).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: true,
      ...DEFAULT_RECURRENCE_FIELDS,
    })

    await writePluginConfig(vault, {
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: false,
    })
    const afterFileExists = await readTaskFormatConfig(vault)
    expect(afterFileExists).toEqual({
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: false,
      ...DEFAULT_RECURRENCE_FIELDS,
    })
  })

  it("caches a successful read — later file changes are not re-read", async () => {
    resetTaskFormatConfigCache()
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "dataview",
      setDoneDate: true,
      setCancelledDate: true,
    })

    const first = await readTaskFormatConfig(vault)
    expect(first).toEqual({
      taskFormat: "dataview",
      setDoneDate: true,
      setCancelledDate: true,
      ...DEFAULT_RECURRENCE_FIELDS,
    })

    await writePluginConfig(vault, {
      taskFormat: "tasksPluginEmoji",
      setDoneDate: false,
      setCancelledDate: false,
    })
    const second = await readTaskFormatConfig(vault)
    expect(second).toEqual({
      taskFormat: "dataview",
      setDoneDate: true,
      setCancelledDate: true,
      ...DEFAULT_RECURRENCE_FIELDS,
    })
  })
})
