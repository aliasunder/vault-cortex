import { describe, it, expect, vi, beforeEach } from "vitest"
import type { VaultConfig } from "../../../config.js"

vi.mock("../../../vault-operations/daily-notes.js", () => ({
  readDailyNotesConfig: vi.fn(),
}))

import { resolveEffectiveProtectedPaths } from "../vault-crud-tools.js"
import { readDailyNotesConfig } from "../../../vault-operations/daily-notes.js"

const mockedReadDailyNotesConfig = vi.mocked(readDailyNotesConfig)

const makeConfig = (
  overrides: Partial<
    Pick<
      VaultConfig,
      | "memoryDir"
      | "protectedPathsOverride"
      | "dailyNotesFolder"
      | "dailyNotesFormat"
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
    mockedReadDailyNotesConfig.mockClear()
  })

  it("returns the user's list unchanged when PROTECTED_PATHS is set", async () => {
    const config = makeConfig({ protectedPathsOverride: ["Secrets", "Custom"] })
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["Secrets", "Custom"])
    expect(mockedReadDailyNotesConfig).not.toHaveBeenCalled()
  })

  it("protects the memory dir plus the file-configured daily folder by default", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Journal",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig()
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me", "Journal"])
    expect(mockedReadDailyNotesConfig).toHaveBeenCalledWith("/vault", {
      folder: undefined,
      format: undefined,
    })
  })

  it("uses the configured memory dir in the default set", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Daily Notes",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig({ memoryDir: "Profile" })
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["Profile", "Daily Notes"])
  })

  it("protects only the memory dir when the resolved daily folder is blank", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "  ",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig()
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me"])
  })

  it("passes env settings through to readDailyNotesConfig", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Journal",
      format: "DD-MM-YYYY",
    })
    const config = makeConfig({
      dailyNotesFolder: "Journal",
      dailyNotesFormat: "DD-MM-YYYY",
    })
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me", "Journal"])
    expect(mockedReadDailyNotesConfig).toHaveBeenCalledWith("/vault", {
      folder: "Journal",
      format: "DD-MM-YYYY",
    })
  })
})
