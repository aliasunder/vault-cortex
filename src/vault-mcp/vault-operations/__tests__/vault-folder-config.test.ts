import { describe, expect, it, onTestFinished, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../config.js"
import { logger } from "../../../logger.js"
import {
  readEffectiveOrphanExcludeFolders,
  resolveEffectiveOrphanExcludeFolders,
  resolveEffectiveProtectedPaths,
} from "../vault-folder-config.js"

const createVault = async (settings?: string): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "vault-folder-config-"))
  onTestFinished(() => rm(vaultPath, { recursive: true, force: true }))
  await mkdir(join(vaultPath, ".obsidian"))

  if (settings !== undefined) {
    await writeFile(join(vaultPath, ".obsidian/daily-notes.json"), settings)
  }
  return vaultPath
}

describe("resolveEffectiveProtectedPaths", () => {
  it("returns the user's list unchanged without reading malformed daily settings", async () => {
    const vaultPath = await createVault("broken")
    const requestLogger = { ...logger, warn: vi.fn() }
    const config = loadConfig({ PROTECTED_PATHS: "Secrets,Custom" })

    expect(await resolveEffectiveProtectedPaths({ config, vaultPath }, requestLogger)).toEqual([
      "Secrets",
      "Custom",
    ])
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("protects the memory dir plus the file-configured daily folder", async () => {
    const vaultPath = await createVault('{"folder":"Journal"}')
    expect(
      await resolveEffectiveProtectedPaths({ config: loadConfig({}), vaultPath }, logger),
    ).toEqual(["About Me", "Journal"])
  })

  it("protects custom memory even when the memory feature is disabled", async () => {
    const vaultPath = await createVault()
    const config = loadConfig({ MEMORY_DIR: "Profile", MEMORY_ENABLED: "false" })
    expect(await resolveEffectiveProtectedPaths({ config, vaultPath }, logger)).toEqual([
      "Profile",
      "Daily Notes",
    ])
  })

  it("protects only memory when the file folder is whitespace-only", async () => {
    const vaultPath = await createVault('{"folder":"  "}')
    expect(
      await resolveEffectiveProtectedPaths({ config: loadConfig({}), vaultPath }, logger),
    ).toEqual(["About Me"])
  })

  it("preserves spaces in a nonblank file-configured daily folder", async () => {
    const vaultPath = await createVault('{"folder":" Journal "}')
    expect(
      await resolveEffectiveProtectedPaths({ config: loadConfig({}), vaultPath }, logger),
    ).toEqual(["About Me", " Journal "])
  })

  it("uses DAILY_NOTES_FOLDER without reading the file when the format is unset", async () => {
    const vaultPath = await createVault("broken")
    const requestLogger = { ...logger, warn: vi.fn() }
    const config = loadConfig({ DAILY_NOTES_FOLDER: "Journal" })
    expect(await resolveEffectiveProtectedPaths({ config, vaultPath }, requestLogger)).toEqual([
      "About Me",
      "Journal",
    ])
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("reads the file folder when only DAILY_NOTES_FORMAT is set", async () => {
    const vaultPath = await createVault('{"folder":"Journal"}')
    const config = loadConfig({ DAILY_NOTES_FORMAT: "DD-MM-YYYY" })
    expect(await resolveEffectiveProtectedPaths({ config, vaultPath }, logger)).toEqual([
      "About Me",
      "Journal",
    ])
  })

  it("rejects malformed existing settings and propagates the caller's logger", async () => {
    const vaultPath = await createVault("broken")
    const requestLogger = { ...logger.child({ requestId: "folder-request" }), warn: vi.fn() }
    await expect(
      resolveEffectiveProtectedPaths({ config: loadConfig({}), vaultPath }, requestLogger),
    ).rejects.toThrow(new Error("cannot read daily notes config from .obsidian/daily-notes.json"))
    expect(requestLogger.warn).toHaveBeenCalledTimes(1)
    expect(requestLogger.warn).toHaveBeenCalledWith("cannot read daily notes config", {
      error: expect.any(String),
    })
  })
})

describe("resolveEffectiveOrphanExcludeFolders", () => {
  it("keeps nonblank file spelling and default folder order", () => {
    expect(
      resolveEffectiveOrphanExcludeFolders({
        orphanExcludeFoldersOverride: null,
        memoryDir: "Profile",
        dailyNotesFolder: " Journal/Daily/ ",
      }),
    ).toEqual([" Journal/Daily/ ", "Templates", "Profile"])
  })

  it("omits a whitespace-only daily folder", () => {
    expect(
      resolveEffectiveOrphanExcludeFolders({
        orphanExcludeFoldersOverride: null,
        memoryDir: "About Me",
        dailyNotesFolder: "   ",
      }),
    ).toEqual(["Templates", "About Me"])
  })

  it("preserves an explicit empty list", () => {
    expect(
      resolveEffectiveOrphanExcludeFolders({
        orphanExcludeFoldersOverride: [],
        memoryDir: "About Me",
        dailyNotesFolder: "Journal",
      }),
    ).toEqual([])
  })
})

describe("readEffectiveOrphanExcludeFolders", () => {
  it.each([
    {
      label: "missing settings",
      settings: undefined,
      env: {},
      expected: ["Daily Notes", "Templates", "About Me"],
    },
    {
      label: "file-only nested folder",
      settings: '{"folder":"Planner/Daily"}',
      env: {},
      expected: ["Planner/Daily", "Templates", "About Me"],
    },
    {
      label: "custom memory with memory disabled",
      settings: undefined,
      env: { MEMORY_DIR: "Profile", MEMORY_ENABLED: "false" },
      expected: ["Daily Notes", "Templates", "Profile"],
    },
    {
      label: "format-only env",
      settings: '{"folder":"Journal"}',
      env: { DAILY_NOTES_FORMAT: "DD-MM-YYYY" },
      expected: ["Journal", "Templates", "About Me"],
    },
    {
      label: "blank file folder",
      settings: '{"folder":"   "}',
      env: {},
      expected: ["Templates", "About Me"],
    },
  ])("uses $label", async ({ settings, env, expected }) => {
    const vaultPath = await createVault(settings)
    expect(
      await readEffectiveOrphanExcludeFolders({ config: loadConfig(env), vaultPath }, logger),
    ).toEqual(expected)
  })

  it.each([
    {
      label: "daily folder override",
      env: { DAILY_NOTES_FOLDER: "Env/Journal" },
      expected: ["Env/Journal", "Templates", "About Me"],
    },
    {
      label: "explicit orphan override",
      env: { ORPHAN_EXCLUDE_FOLDERS: "Archive,Scratch" },
      expected: ["Archive", "Scratch"],
    },
    { label: "comma-only empty override", env: { ORPHAN_EXCLUDE_FOLDERS: ", ," }, expected: [] },
  ])("bypasses malformed settings for $label", async ({ env, expected }) => {
    const vaultPath = await createVault("broken")
    const requestLogger = { ...logger, warn: vi.fn() }
    expect(
      await readEffectiveOrphanExcludeFolders(
        { config: loadConfig(env), vaultPath },
        requestLogger,
      ),
    ).toEqual(expected)
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("warns and falls back when existing settings are malformed", async () => {
    const vaultPath = await createVault("broken")
    const requestLogger = { ...logger, warn: vi.fn() }
    expect(
      await readEffectiveOrphanExcludeFolders({ config: loadConfig({}), vaultPath }, requestLogger),
    ).toEqual(["Daily Notes", "Templates", "About Me"])
    expect(requestLogger.warn).toHaveBeenCalledTimes(1)
    expect(requestLogger.warn).toHaveBeenCalledWith(
      "cannot read daily notes config, using defaults",
      {
        error: expect.any(String),
      },
    )
  })
})
