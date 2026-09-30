import { describe, it, expect, onTestFinished, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { logger } from "../../../logger.js"
import { readTrashConfig } from "../trash-config.js"

const createVault = async (): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), "trash-config-test-"))
  onTestFinished(async () => rm(vaultPath, { recursive: true }))
  return vaultPath
}

const writeAppConfig = async (
  vaultPath: string,
  config: Record<string, unknown>,
): Promise<void> => {
  const obsidianDir = join(vaultPath, ".obsidian")
  await mkdir(obsidianDir, { recursive: true })
  await writeFile(join(obsidianDir, "app.json"), JSON.stringify(config), "utf8")
}

describe("readTrashConfig", () => {
  it('reads "local" from a valid app.json', async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "local" })

    const result = await readTrashConfig(vault, logger)

    expect(result).toBe("local")
  })

  it('reads "none" from a valid app.json', async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "none" })

    const result = await readTrashConfig(vault, logger)

    expect(result).toBe("none")
  })

  it('reads "system" when explicitly set in app.json', async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "system" })

    const result = await readTrashConfig(vault, logger)

    expect(result).toBe("system")
  })

  it('defaults to "system" when app.json is absent', async () => {
    const vault = await createVault()

    const result = await readTrashConfig(vault, logger)

    expect(result).toBe("system")
  })

  it('defaults to "system" when the trashOption key is missing', async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { someOtherSetting: true })

    const result = await readTrashConfig(vault, logger)

    expect(result).toBe("system")
  })

  it('defaults to "system" for an unrecognized value', async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "recycle-bin" })

    const result = await readTrashConfig(vault, logger)

    expect(result).toBe("system")
  })

  it("throws on malformed JSON so a broken config never silently causes permanent delete", async () => {
    const vault = await createVault()
    const obsidianDir = join(vault, ".obsidian")
    await mkdir(obsidianDir, { recursive: true })
    await writeFile(join(obsidianDir, "app.json"), "not valid json{{{", "utf8")

    await expect(readTrashConfig(vault, logger)).rejects.toThrow(
      "cannot read trash config from .obsidian/app.json",
    )
  })

  it("warns about an unreadable config on the caller's logger, not the root logger", async () => {
    const vault = await createVault()
    const obsidianDir = join(vault, ".obsidian")
    await mkdir(obsidianDir, { recursive: true })
    const malformedJson = "not valid json{{{"
    await writeFile(join(obsidianDir, "app.json"), malformedJson, "utf8")
    // JSON.parse's message varies by engine version, so read it from the engine
    const parseFailureMessage = ((): string => {
      try {
        JSON.parse(malformedJson)
      } catch (error) {
        if (error instanceof SyntaxError) return error.message
      }
      throw new Error("expected JSON.parse to reject the malformed config")
    })()
    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn")
    const rootWarnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => rootWarnSpy.mockRestore())

    await expect(readTrashConfig(vault, requestLogger)).rejects.toThrow(
      "cannot read trash config from .obsidian/app.json",
    )

    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("cannot read trash config", {
      error: `[SyntaxError]: ${parseFailureMessage}`,
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })

  it("retries after ENOENT — a config appearing later is picked up without a restart", async () => {
    const vault = await createVault()

    const beforeConfig = await readTrashConfig(vault, logger)
    expect(beforeConfig).toBe("system")

    await writeAppConfig(vault, { trashOption: "local" })
    const afterConfig = await readTrashConfig(vault, logger)
    expect(afterConfig).toBe("local")
  })

  it("retries when app.json exists but key is absent — a later Sync delivery is picked up", async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { someOtherSetting: true })

    const beforeKey = await readTrashConfig(vault, logger)
    expect(beforeKey).toBe("system")

    await writeAppConfig(vault, { trashOption: "local" })
    const afterKey = await readTrashConfig(vault, logger)
    expect(afterKey).toBe("local")
  })

  it("re-reads on every call — a switch from permanent delete to a trash option is followed", async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "none" })

    const beforeSwitch = await readTrashConfig(vault, logger)
    expect(beforeSwitch).toBe("none")

    await writeAppConfig(vault, { trashOption: "local" })
    const afterSwitch = await readTrashConfig(vault, logger)
    expect(afterSwitch).toBe("local")
  })

  it("re-reads on every call — a switch from a trash option to permanent delete is followed", async () => {
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "local" })

    const beforeSwitch = await readTrashConfig(vault, logger)
    expect(beforeSwitch).toBe("local")

    await writeAppConfig(vault, { trashOption: "none" })
    const afterSwitch = await readTrashConfig(vault, logger)
    expect(afterSwitch).toBe("none")
  })
})
