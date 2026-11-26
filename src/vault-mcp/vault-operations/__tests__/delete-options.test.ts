import { describe, it, expect, onTestFinished, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logger } from "../../../logger.js"
import { loadConfig } from "../../config.js"
import { resolveDeleteOptions } from "../delete-options.js"

describe("resolveDeleteOptions", () => {
  const recordTrashEntry = vi.fn()
  const deleteTrashEntry = vi.fn()
  const search = { recordTrashEntry, deleteTrashEntry }

  /** A vault whose app.json holds the given Deleted files setting, or none. */
  const createVaultWithTrashOption = async (trashOption?: string): Promise<string> => {
    const vaultPath = await mkdtemp(join(tmpdir(), "delete-options-"))
    onTestFinished(() => rm(vaultPath, { recursive: true, force: true }))

    if (trashOption) {
      await mkdir(join(vaultPath, ".obsidian"))
      await writeFile(join(vaultPath, ".obsidian", "app.json"), JSON.stringify({ trashOption }))
    }
    return vaultPath
  }

  it('records "system" moves for the retention sweep and clears stale rows', async () => {
    const vaultPath = await createVaultWithTrashOption()

    const options = await resolveDeleteOptions(
      { config: loadConfig({}), vaultPath, search },
      logger,
    )

    expect(options).toEqual({
      protectedPaths: ["About Me", "Daily Notes"],
      trashOption: "system",
      recordTrashEntry,
      clearStaleTrashEntry: deleteTrashEntry,
    })
  })

  it('records nothing for "local" moves, which Obsidian keeps forever', async () => {
    const vaultPath = await createVaultWithTrashOption("local")

    const options = await resolveDeleteOptions(
      { config: loadConfig({}), vaultPath, search },
      logger,
    )

    expect(options).toEqual({
      protectedPaths: ["About Me", "Daily Notes"],
      trashOption: "local",
      recordTrashEntry: undefined,
      clearStaleTrashEntry: deleteTrashEntry,
    })
  })

  it("deletes for good under Obsidian Sync without reading the trash setting", async () => {
    // The setting says "local", and Sync must still win
    const vaultPath = await createVaultWithTrashOption("local")

    const options = await resolveDeleteOptions(
      {
        config: loadConfig({ OBSIDIAN_SYNC: "true", PROTECTED_PATHS: "Private" }),
        vaultPath,
        search,
      },
      logger,
    )

    expect(options).toEqual({
      protectedPaths: ["Private"],
      trashOption: "none",
      recordTrashEntry: undefined,
      clearStaleTrashEntry: deleteTrashEntry,
    })
  })
})
