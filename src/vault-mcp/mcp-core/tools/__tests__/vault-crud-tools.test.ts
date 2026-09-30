import { describe, it, expect, vi, beforeEach } from "vitest"
import type { VaultConfig } from "../../../config.js"
import { logger } from "../../../../logger.js"

vi.mock("../../../vault-operations/daily-notes.js", () => ({
  readDailyNotesFileConfig: vi.fn(),
}))

import { resolveEffectiveProtectedPaths } from "../vault-crud-tools.js"
import { readDailyNotesFileConfig } from "../../../vault-operations/daily-notes.js"

const mockedReadDailyNotesFileConfig = vi.mocked(readDailyNotesFileConfig)

const makeConfig = (
  overrides: Partial<
    Pick<
      VaultConfig,
      "memoryDir" | "protectedPathsOverride" | "dailyNotesFolder" | "dailyNotesFormat"
    >
  > = {},
): VaultConfig =>
  ({
    memoryDir: overrides.memoryDir ?? "About Me",
    protectedPathsOverride: overrides.protectedPathsOverride ?? null,
    dailyNotesFolder: overrides.dailyNotesFolder,
    dailyNotesFormat: overrides.dailyNotesFormat,
  }) as unknown as VaultConfig

describe("resolveEffectiveProtectedPaths", () => {
  beforeEach(() => {
    mockedReadDailyNotesFileConfig.mockReset()
  })

  it("returns the user's list unchanged when PROTECTED_PATHS is set", async () => {
    const config = makeConfig({ protectedPathsOverride: ["Secrets", "Custom"] })
    const result = await resolveEffectiveProtectedPaths(config, "/vault", logger)

    expect(result).toEqual(["Secrets", "Custom"])
    expect(mockedReadDailyNotesFileConfig).not.toHaveBeenCalled()
  })

  it("protects the memory dir plus the file-configured daily folder by default", async () => {
    mockedReadDailyNotesFileConfig.mockResolvedValue({
      folder: "Journal",
      format: "YYYY-MM-DD",
    })
    const requestLogger = logger.child({ requestId: "request-1" })
    const config = makeConfig()
    const result = await resolveEffectiveProtectedPaths(config, "/vault", requestLogger)

    expect(result).toEqual(["About Me", "Journal"])
    expect(mockedReadDailyNotesFileConfig).toHaveBeenCalledTimes(1)
    expect(mockedReadDailyNotesFileConfig).toHaveBeenCalledWith("/vault", requestLogger)
  })

  it("uses the configured memory dir in the default set", async () => {
    mockedReadDailyNotesFileConfig.mockResolvedValue({
      folder: "Daily Notes",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig({ memoryDir: "Profile" })
    const result = await resolveEffectiveProtectedPaths(config, "/vault", logger)

    expect(result).toEqual(["Profile", "Daily Notes"])
  })

  it("protects only the memory dir when the resolved daily folder is blank", async () => {
    mockedReadDailyNotesFileConfig.mockResolvedValue({
      folder: "  ",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig()
    const result = await resolveEffectiveProtectedPaths(config, "/vault", logger)

    expect(result).toEqual(["About Me"])
  })

  it("protects DAILY_NOTES_FOLDER without reading the file, even when the format is unset", async () => {
    const config = makeConfig({ dailyNotesFolder: "Journal" })
    const result = await resolveEffectiveProtectedPaths(config, "/vault", logger)

    expect(result).toEqual(["About Me", "Journal"])
    expect(mockedReadDailyNotesFileConfig).not.toHaveBeenCalled()
  })

  it("reads the file for the folder when only DAILY_NOTES_FORMAT is set", async () => {
    mockedReadDailyNotesFileConfig.mockResolvedValue({
      folder: "Journal",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig({ dailyNotesFormat: "DD-MM-YYYY" })
    const result = await resolveEffectiveProtectedPaths(config, "/vault", logger)

    expect(result).toEqual(["About Me", "Journal"])
    expect(mockedReadDailyNotesFileConfig).toHaveBeenCalledTimes(1)
  })

  it("rejects when the file exists but cannot be read, instead of protecting the default folder", async () => {
    mockedReadDailyNotesFileConfig.mockRejectedValue(
      new Error("cannot read daily notes config from .obsidian/daily-notes.json"),
    )
    const config = makeConfig()

    await expect(resolveEffectiveProtectedPaths(config, "/vault", logger)).rejects.toThrow(
      new Error("cannot read daily notes config from .obsidian/daily-notes.json"),
    )
  })
})
