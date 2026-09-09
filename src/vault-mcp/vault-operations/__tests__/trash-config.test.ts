import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readTrashConfig, resetTrashConfigCache } from "../trash-config.js"

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
    resetTrashConfigCache()
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "local" })

    const result = await readTrashConfig(vault)

    expect(result).toBe("local")
  })

  it('reads "none" from a valid app.json', async () => {
    resetTrashConfigCache()
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "none" })

    const result = await readTrashConfig(vault)

    expect(result).toBe("none")
  })

  it('reads "system" when explicitly set in app.json', async () => {
    resetTrashConfigCache()
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "system" })

    const result = await readTrashConfig(vault)

    expect(result).toBe("system")
  })

  it('defaults to "system" when app.json is absent', async () => {
    resetTrashConfigCache()
    const vault = await createVault()

    const result = await readTrashConfig(vault)

    expect(result).toBe("system")
  })

  it('defaults to "system" when the trashOption key is missing', async () => {
    resetTrashConfigCache()
    const vault = await createVault()
    await writeAppConfig(vault, { someOtherSetting: true })

    const result = await readTrashConfig(vault)

    expect(result).toBe("system")
  })

  it('defaults to "system" for an unrecognized value', async () => {
    resetTrashConfigCache()
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "recycle-bin" })

    const result = await readTrashConfig(vault)

    expect(result).toBe("system")
  })

  it('defaults to "system" on malformed JSON', async () => {
    resetTrashConfigCache()
    const vault = await createVault()
    const obsidianDir = join(vault, ".obsidian")
    await mkdir(obsidianDir, { recursive: true })
    await writeFile(join(obsidianDir, "app.json"), "not valid json{{{", "utf8")

    const result = await readTrashConfig(vault)

    expect(result).toBe("system")
  })

  it("retries after ENOENT — a config appearing later is picked up without a restart", async () => {
    resetTrashConfigCache()
    const vault = await createVault()

    const beforeConfig = await readTrashConfig(vault)
    expect(beforeConfig).toBe("system")

    await writeAppConfig(vault, { trashOption: "local" })
    const afterConfig = await readTrashConfig(vault)
    expect(afterConfig).toBe("local")
  })

  it("caches a successful read — later file changes are not re-read", async () => {
    resetTrashConfigCache()
    const vault = await createVault()
    await writeAppConfig(vault, { trashOption: "local" })

    const first = await readTrashConfig(vault)
    expect(first).toBe("local")

    await writeAppConfig(vault, { trashOption: "none" })
    const second = await readTrashConfig(vault)
    expect(second).toBe("local")
  })
})
