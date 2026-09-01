import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import type { Logger } from "../../../logger.js"
import { syncTokenStore } from "../sync-token-store.js"

const recordingLogger = (): Logger & { infoCalls: unknown[][] } => {
  const infoCalls: unknown[][] = []
  const logger: Logger & { infoCalls: unknown[][] } = {
    infoCalls,
    debug: vi.fn(),
    info: (message, data) => {
      infoCalls.push([message, data])
    },
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  }
  return logger
}

const tempTokenPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sync-token-store-"))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return join(dir, "config", "obsidian-headless", "auth_token")
}

const permissionBits = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777

describe("syncTokenStore.writeSyncToken", () => {
  it("writes the token as the Sync client would: directory 0700, file 0600", async () => {
    const tokenFilePath = await tempTokenPath()
    const logger = recordingLogger()

    await syncTokenStore.writeSyncToken(
      { tokenFilePath, token: "tok-1" },
      logger,
    )

    expect(await readFile(tokenFilePath, "utf8")).toBe("tok-1")
    expect(await permissionBits(tokenFilePath)).toBe(0o600)
    expect(await permissionBits(join(tokenFilePath, ".."))).toBe(0o700)
    expect(logger.infoCalls).toEqual([
      ["sync_token_written", { path: tokenFilePath }],
    ])
  })

  it("replaces an existing token and leaves no staging file behind", async () => {
    const tokenFilePath = await tempTokenPath()
    const logger = recordingLogger()
    await syncTokenStore.writeSyncToken({ tokenFilePath, token: "old" }, logger)

    await syncTokenStore.writeSyncToken({ tokenFilePath, token: "new" }, logger)

    expect(await readFile(tokenFilePath, "utf8")).toBe("new")
    expect(await readdir(join(tokenFilePath, ".."))).toEqual(["auth_token"])
  })

  it("tightens a pre-existing token directory to 0700", async () => {
    const tokenFilePath = await tempTokenPath()
    await mkdir(join(tokenFilePath, ".."), { recursive: true, mode: 0o755 })

    await syncTokenStore.writeSyncToken(
      { tokenFilePath, token: "tok-1" },
      recordingLogger(),
    )

    expect(await permissionBits(join(tokenFilePath, ".."))).toBe(0o700)
  })

  it("tightens a leftover staging file's mode before it becomes the token", async () => {
    const tokenFilePath = await tempTokenPath()
    await syncTokenStore.writeSyncToken(
      { tokenFilePath, token: "seed" },
      recordingLogger(),
    )
    await writeFile(`${tokenFilePath}.tmp`, "stale", { mode: 0o644 })

    await syncTokenStore.writeSyncToken(
      { tokenFilePath, token: "fresh" },
      recordingLogger(),
    )

    expect(await readFile(tokenFilePath, "utf8")).toBe("fresh")
    expect(await permissionBits(tokenFilePath)).toBe(0o600)
  })
})
