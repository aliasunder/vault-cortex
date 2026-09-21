import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { runSst } from "../run-sst.js"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

const writeEnvFile = (content: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "vault-cortex-run-sst-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const envFilePath = join(directory, ".env")
  writeFileSync(envFilePath, content)
  return envFilePath
}

const successfulSpawn = {
  pid: 1,
  output: [null, Buffer.alloc(0), Buffer.alloc(0)],
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  status: 0,
  signal: null,
}

describe("runSst", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("forwards SST arguments while keeping file values in the child environment", () => {
    const envFilePath = writeEnvFile("WRAPPER_SECRET=fake-secret\n")
    vi.mocked(spawnSync).mockReturnValue(successfulSpawn)

    const exitCode = runSst({ args: ["deploy", "--stage", "test"], envFilePath })

    expect(exitCode).toBe(0)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(spawnSync).toHaveBeenCalledWith("sst", ["deploy", "--stage", "test"], {
      env: { WRAPPER_SECRET: "fake-secret", ...process.env },
      stdio: "inherit",
    })
  })

  it("does not spawn SST when the external file is missing", () => {
    const missingPath = join(tmpdir(), "vault-cortex-missing-run-sst", ".env")
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const exitCode = runSst({ args: ["deploy"], envFilePath: missingPath })

    expect(exitCode).toBe(1)
    expect(spawnSync).toHaveBeenCalledTimes(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledWith(
      `✕ deployment environment file not found at ${missingPath}; copy .env.example there and fill in the required values`,
    )
  })

  it("returns the SST exit status", () => {
    const envFilePath = writeEnvFile("WRAPPER_SETTING=value\n")
    vi.mocked(spawnSync).mockReturnValue({ ...successfulSpawn, status: 7 })

    const exitCode = runSst({ args: ["remove"], envFilePath })

    expect(exitCode).toBe(7)
  })

  it("reports a fixed error when the SST process cannot start", () => {
    const envFilePath = writeEnvFile("WRAPPER_SETTING=value\n")
    const spawnError = new Error("spawn sst ENOENT")
    vi.mocked(spawnSync).mockReturnValue({ ...successfulSpawn, status: null, error: spawnError })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const exitCode = runSst({ args: ["deploy"], envFilePath })

    expect(exitCode).toBe(1)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledWith("✕ Could not start the local SST CLI.")
  })
})
