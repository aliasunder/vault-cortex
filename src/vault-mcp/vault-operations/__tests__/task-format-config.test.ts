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
    })
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
    })
  })

  it("keys the cache by vault path — a second vault gets its own config", async () => {
    resetTaskFormatConfigCache()
    const firstVault = await createVault()
    await writePluginConfig(firstVault, {
      taskFormat: "dataview",
      setDoneDate: true,
      setCancelledDate: true,
    })
    const firstVaultConfig = await readTaskFormatConfig(firstVault)
    expect(firstVaultConfig.taskFormat).toBe("dataview")

    const secondVault = await createVault()
    await writePluginConfig(secondVault, {
      taskFormat: "tasksPluginEmoji",
      setDoneDate: false,
      setCancelledDate: false,
    })
    const secondVaultConfig = await readTaskFormatConfig(secondVault)
    expect(secondVaultConfig).toEqual({
      taskFormat: "emoji",
      setDoneDate: false,
      setCancelledDate: false,
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
    expect(first.taskFormat).toBe("dataview")

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
    })
  })
})
