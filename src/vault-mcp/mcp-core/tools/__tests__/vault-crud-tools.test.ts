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
      | "protectedPaths"
      | "protectedPathsOverridden"
      | "dailyNotesFolder"
      | "dailyNotesFormat"
    >
  > = {},
): VaultConfig =>
  ({
    protectedPaths: overrides.protectedPaths ?? ["About Me", "Daily Notes"],
    protectedPathsOverridden: overrides.protectedPathsOverridden ?? false,
    dailyNotesFolder: overrides.dailyNotesFolder,
    dailyNotesFormat: overrides.dailyNotesFormat,
  }) as unknown as VaultConfig

describe("resolveEffectiveProtectedPaths", () => {
  beforeEach(() => {
    mockedReadDailyNotesConfig.mockClear()
  })

  it("returns the static list unchanged when PROTECTED_PATHS is explicitly set", async () => {
    const config = makeConfig({
      protectedPathsOverridden: true,
      protectedPaths: ["About Me", "Custom"],
    })
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me", "Custom"])
    expect(mockedReadDailyNotesConfig).not.toHaveBeenCalled()
  })

  it("adds the file-configured daily folder when it differs from defaults", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Journal",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig()
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me", "Daily Notes", "Journal"])
    expect(mockedReadDailyNotesConfig).toHaveBeenCalledWith("/vault", {
      folder: undefined,
      format: undefined,
    })
  })

  it("deduplicates when the file-configured folder matches a default", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Daily Notes",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig()
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me", "Daily Notes"])
  })

  it("deduplicates when the env folder matches the file-configured folder", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Journal",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig({
      dailyNotesFolder: "Journal",
      protectedPaths: ["About Me", "Journal"],
    })
    const result = await resolveEffectiveProtectedPaths(config, "/vault")

    expect(result).toEqual(["About Me", "Journal"])
  })

  it("passes env settings through to readDailyNotesConfig", async () => {
    mockedReadDailyNotesConfig.mockResolvedValue({
      folder: "Journal",
      format: "YYYY-MM-DD",
    })
    const config = makeConfig({
      dailyNotesFolder: "Journal",
      dailyNotesFormat: "DD-MM-YYYY",
    })
    await resolveEffectiveProtectedPaths(config, "/vault")

    expect(mockedReadDailyNotesConfig).toHaveBeenCalledWith("/vault", {
      folder: "Journal",
      format: "DD-MM-YYYY",
    })
  })
})
