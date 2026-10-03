import { describe, it, expect, onTestFinished, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readTaskFormatConfig } from "../task-format-config.js"
import type { StatusClassification } from "../task-format-config.js"
import { logger } from "../../../logger.js"

const createVault = async (): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "task-format-config-test-"))
  onTestFinished(async () => rm(vaultPath, { recursive: true }))
  return vaultPath
}

const writePluginConfig = async (
  vaultPath: string,
  config: Record<string, unknown>,
): Promise<void> => {
  const pluginDir = join(vaultPath, ".obsidian", "plugins", "obsidian-tasks-plugin")
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, "data.json"), JSON.stringify(config), "utf8")
}

/** The message JSON.parse throws for `malformedJson`. Its wording varies by
 *  engine version, so tests read it from the engine. */
const jsonParseFailureMessage = (malformedJson: string): string => {
  try {
    JSON.parse(malformedJson)
  } catch (error) {
    if (error instanceof SyntaxError) return error.message
  }
  throw new Error("expected JSON.parse to reject the malformed input")
}

const DEFAULT_STATUS_REGISTRY: ReadonlyMap<string, StatusClassification> = new Map([
  [" ", "todo"],
  ["x", "done"],
  ["X", "done"],
  ["/", "in_progress"],
  ["-", "cancelled"],
])

/** Plugin defaults shared by every config assertion: recurrence behavior + status registry. */
const DEFAULT_PLUGIN_FIELDS = {
  setCreatedDate: false,
  recurrenceOnNextLine: false,
  removeScheduledDateOnRecurrence: false,
  statusRegistry: DEFAULT_STATUS_REGISTRY,
} as const

/** Every field at its plugin default — what an absent or unreadable file yields. */
const DEFAULT_CONFIG = {
  taskFormat: "emoji",
  setDoneDate: true,
  setCancelledDate: true,
  ...DEFAULT_PLUGIN_FIELDS,
} as const

describe("readTaskFormatConfig", () => {
  it("reads emoji format from a valid config file", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "tasksPluginEmoji",
      setDoneDate: true,
      setCancelledDate: false,
    })

    const config = await readTaskFormatConfig(vault, logger)

    expect(config).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: false,
      ...DEFAULT_PLUGIN_FIELDS,
    })
  })

  it("reads the recurrence-behavior settings from the config file", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "tasksPluginEmoji",
      setCreatedDate: true,
      recurrenceOnNextLine: true,
      removeScheduledDateOnRecurrence: true,
    })

    const config = await readTaskFormatConfig(vault, logger)

    expect(config).toEqual({
      taskFormat: "emoji",
      setDoneDate: true,
      setCancelledDate: true,
      setCreatedDate: true,
      recurrenceOnNextLine: true,
      removeScheduledDateOnRecurrence: true,
      statusRegistry: DEFAULT_STATUS_REGISTRY,
    })
  })

  it("builds the full status registry from core + custom statuses", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        coreStatuses: [
          { symbol: " ", name: "Todo", nextStatusSymbol: "x", type: "TODO" },
          { symbol: "x", name: "Done", nextStatusSymbol: " ", type: "DONE" },
          { symbol: "/", name: "In Progress", nextStatusSymbol: "x", type: "IN_PROGRESS" },
          { symbol: "-", name: "Deferred", nextStatusSymbol: " ", type: "TODO" },
        ],
        customStatuses: [
          { symbol: "D", name: "Deployed", nextStatusSymbol: " ", type: "DONE" },
          { symbol: "!", name: "Urgent", nextStatusSymbol: "x", type: "TODO" },
          { symbol: ">", name: "Forwarded", nextStatusSymbol: " ", type: "NON_TASK" },
          { symbol: "?", name: "Question", nextStatusSymbol: " ", type: "IN_PROGRESS" },
          { symbol: "~", name: "Dropped", nextStatusSymbol: " ", type: "CANCELLED" },
        ],
      },
    })

    const config = await readTaskFormatConfig(vault, logger)

    // Config wins on overlap (- is retyped from cancelled to todo),
    // defaults fill in what the config omits (X stays done).
    expect(config.statusRegistry).toEqual(
      new Map<string, StatusClassification>([
        [" ", "todo"],
        ["x", "done"],
        ["X", "done"],
        ["/", "in_progress"],
        ["-", "todo"],
        ["D", "done"],
        ["!", "todo"],
        [">", "non_task"],
        ["?", "in_progress"],
        ["~", "cancelled"],
      ]),
    )
  })

  it("resolves intra-config duplicate symbols with last-wins (custom over core)", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        coreStatuses: [{ symbol: "!", name: "Urgent", nextStatusSymbol: "x", type: "TODO" }],
        customStatuses: [
          { symbol: "!", name: "Important", nextStatusSymbol: " ", type: "IN_PROGRESS" },
        ],
      },
    })

    const config = await readTaskFormatConfig(vault, logger)

    expect(config.statusRegistry.get("!")).toBe("in_progress")
  })

  it("ignores the legacy pre-type status format", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        customStatusTypes: [{ indicator: "P", name: "Pro", nextStatusIndicator: "C" }],
      },
    })

    const config = await readTaskFormatConfig(vault, logger)

    expect(config.statusRegistry).toEqual(DEFAULT_STATUS_REGISTRY)
  })

  it("ignores malformed status-registry entries", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        coreStatuses: ["not-an-object", { type: "DONE" }, { symbol: 3 }],
        customStatuses: "not-an-array",
      },
    })

    const config = await readTaskFormatConfig(vault, logger)

    expect(config.statusRegistry).toEqual(DEFAULT_STATUS_REGISTRY)
  })

  it("ignores entries with unrecognized plugin type strings", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      statusSettings: {
        coreStatuses: [
          { symbol: " ", name: "Todo", type: "TODO" },
          { symbol: "x", name: "Done", type: "DONE" },
        ],
        customStatuses: [
          { symbol: "D", name: "Deployed", nextStatusSymbol: " ", type: "DONE" },
          { symbol: "?", name: "Unknown", nextStatusSymbol: " ", type: "MYSTERY" },
        ],
      },
    })

    const config = await readTaskFormatConfig(vault, logger)

    // The parsed entries merge on top of the defaults; the MYSTERY entry
    // is dropped, but the valid D→done entry survives alongside the defaults.
    expect(config.statusRegistry).toEqual(
      new Map<string, StatusClassification>([
        [" ", "todo"],
        ["x", "done"],
        ["X", "done"],
        ["/", "in_progress"],
        ["-", "cancelled"],
        ["D", "done"],
      ]),
    )
  })

  it("reads dataview format from a valid config file", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: true,
    })

    const config = await readTaskFormatConfig(vault, logger)

    expect(config).toEqual({
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: true,
      ...DEFAULT_PLUGIN_FIELDS,
    })
  })

  it("falls back to defaults when the config file is missing", async () => {
    const vault = await createVault()

    const config = await readTaskFormatConfig(vault, logger)

    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it("reads a file holding the JSON literal null as no settings, without a warn", async () => {
    const vault = await createVault()
    const pluginDir = join(vault, ".obsidian", "plugins", "obsidian-tasks-plugin")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, "data.json"), "null", "utf8")
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readTaskFormatConfig(vault, logger)

    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("falls back to defaults when .obsidian is a file rather than a folder", async () => {
    const vault = await createVault()
    await writeFile(join(vault, ".obsidian"), "not a folder", "utf8")
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readTaskFormatConfig(vault, logger)

    // No settings exist, so nothing is wrong to warn about.
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("falls back to defaults on malformed JSON and warns on the caller's logger, not the root logger", async () => {
    const vault = await createVault()
    const pluginDir = join(vault, ".obsidian", "plugins", "obsidian-tasks-plugin")
    await mkdir(pluginDir, { recursive: true })
    const malformedJson = "not valid json{{{"
    await writeFile(join(pluginDir, "data.json"), malformedJson, "utf8")

    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn")
    const rootWarnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => rootWarnSpy.mockRestore())

    const config = await readTaskFormatConfig(vault, requestLogger)

    expect(config).toEqual(DEFAULT_CONFIG)
    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("cannot read Tasks plugin config, using defaults", {
      error: `[SyntaxError]: ${jsonParseFailureMessage(malformedJson)}`,
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })

  it("falls back to defaults when data.json is a directory", async () => {
    const vault = await createVault()
    await mkdir(join(vault, ".obsidian", "plugins", "obsidian-tasks-plugin", "data.json"), {
      recursive: true,
    })
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())

    const config = await readTaskFormatConfig(vault, logger)

    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith("cannot read Tasks plugin config, using defaults", {
      error: "[Error]: EISDIR: illegal operation on a directory, read",
    })
  })

  it("picks up a plugin config that appears after an earlier read", async () => {
    const vault = await createVault()

    const beforeFileExists = await readTaskFormatConfig(vault, logger)
    expect(beforeFileExists).toEqual(DEFAULT_CONFIG)

    await writePluginConfig(vault, {
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: false,
    })
    const afterFileExists = await readTaskFormatConfig(vault, logger)
    expect(afterFileExists).toEqual({
      taskFormat: "dataview",
      setDoneDate: false,
      setCancelledDate: false,
      ...DEFAULT_PLUGIN_FIELDS,
    })
  })

  it("follows a change to the config file between two reads", async () => {
    const vault = await createVault()
    await writePluginConfig(vault, {
      taskFormat: "dataview",
      setDoneDate: true,
      setCancelledDate: true,
    })

    const first = await readTaskFormatConfig(vault, logger)
    expect(first).toEqual({
      taskFormat: "dataview",
      setDoneDate: true,
      setCancelledDate: true,
      ...DEFAULT_PLUGIN_FIELDS,
    })

    await writePluginConfig(vault, {
      taskFormat: "tasksPluginEmoji",
      setDoneDate: false,
      setCancelledDate: false,
    })
    const second = await readTaskFormatConfig(vault, logger)
    expect(second).toEqual({
      taskFormat: "emoji",
      setDoneDate: false,
      setCancelledDate: false,
      ...DEFAULT_PLUGIN_FIELDS,
    })
  })
})
