import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { runSst } from "../run-sst.js"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("node:module", { spy: true })

/** The script SST's package.json names as its `sst` command. */
const resolveExpectedSstLauncherPath = (): string => {
  const packageJsonPath = findPackageJSON("sst", import.meta.url)

  if (!packageJsonPath) throw new Error("the sst package is not installed")

  const packageJson: { bin: { sst: string } } = JSON.parse(readFileSync(packageJsonPath, "utf8"))

  return join(dirname(packageJsonPath), packageJson.bin.sst)
}

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
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [resolveExpectedSstLauncherPath(), "deploy", "--stage", "test"],
      { env: { WRAPPER_SECRET: "fake-secret", ...process.env }, stdio: "inherit" },
    )
  })

  it("reports a fixed error without spawning when the sst package is missing", () => {
    const envFilePath = writeEnvFile("WRAPPER_SETTING=value\n")
    vi.mocked(findPackageJSON).mockImplementationOnce(() => {
      throw Object.assign(new Error("Cannot find package 'sst'"), { code: "ERR_MODULE_NOT_FOUND" })
    })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const exitCode = runSst({ args: ["deploy"], envFilePath })

    expect(exitCode).toBe(1)
    expect(spawnSync).toHaveBeenCalledTimes(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledWith("✕ Could not start the local SST CLI.")
  })

  it("reports a fixed error without spawning when the sst package.json names no sst command", () => {
    const envFilePath = writeEnvFile("WRAPPER_SETTING=value\n")
    const packageDirectory = mkdtempSync(join(tmpdir(), "vault-cortex-broken-sst-"))
    onTestFinished(() => rmSync(packageDirectory, { recursive: true, force: true }))
    const packageJsonPath = join(packageDirectory, "package.json")
    writeFileSync(packageJsonPath, '{ "name": "sst", "bin": {} }\n')
    vi.mocked(findPackageJSON).mockReturnValueOnce(packageJsonPath)
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const exitCode = runSst({ args: ["deploy"], envFilePath })

    expect(exitCode).toBe(1)
    expect(spawnSync).toHaveBeenCalledTimes(0)
    expect(findPackageJSON).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledWith("✕ Could not start the local SST CLI.")
  })

  it("does not spawn SST when the external file is missing", () => {
    const missingDirectory = mkdtempSync(join(tmpdir(), "vault-cortex-missing-run-sst-"))
    onTestFinished(() => rmSync(missingDirectory, { recursive: true, force: true }))
    const missingPath = join(missingDirectory, ".env")
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

  it("returns one when SST exits without a status", () => {
    const envFilePath = writeEnvFile("WRAPPER_SETTING=value\n")
    vi.mocked(spawnSync).mockReturnValue({ ...successfulSpawn, status: null })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const exitCode = runSst({ args: ["deploy"], envFilePath })

    expect(exitCode).toBe(1)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledTimes(0)
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

  it("reports a fixed error when starting SST throws", () => {
    const envFilePath = writeEnvFile("WRAPPER_SETTING=value\n")
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("spawn sst EACCES")
    })

    const exitCode = runSst({ args: ["deploy"], envFilePath })

    expect(exitCode).toBe(1)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledWith("✕ Could not start the local SST CLI.")
  })
})

type EntryScriptExit = { code: number | null; signal: NodeJS.Signals | null }

type EntryScriptRun = {
  homeDirectory: string
  /** Resolves once the SST stub has printed "ready", so it is running. */
  sstStarted: Promise<void>
  exited: Promise<EntryScriptExit>
  processGroupId: number
}

/**
 * Starts run-sst.ts as `npm run sst` does, leading its own process group so a
 * group signal reaches the wrapper, SST's launcher, and the stub together, as
 * Ctrl-C does. The real launcher runs; SST_BIN_PATH, its own override for the
 * platform binary, points it at the stub.
 */
const startEntryScript = async ({
  args,
  sstStubBody,
}: {
  args: readonly string[]
  sstStubBody: string
}): Promise<EntryScriptRun> => {
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  const inheritedPath = process.env.PATH

  if (!inheritedPath) {
    throw new Error("PATH is required for the commands the SST stub runs")
  }

  const homeDirectory = mkdtempSync(join(tmpdir(), "vault-cortex-run-sst-entry-"))
  onTestFinished(() => rmSync(homeDirectory, { recursive: true, force: true }))
  const sstStubPath = join(homeDirectory, "sst-stub")
  writeFileSync(sstStubPath, `#!/bin/sh\n${sstStubBody}`)
  chmodSync(sstStubPath, 0o755)
  const deploymentEnvDirectory = join(homeDirectory, ".config", "vault-cortex")
  mkdirSync(deploymentEnvDirectory, { recursive: true })
  writeFileSync(
    join(deploymentEnvDirectory, ".env"),
    `SST_ARGUMENTS_PATH=${join(homeDirectory, "sst-arguments.txt")}\n` +
      `SST_SHUTDOWN_PATH=${join(homeDirectory, "sst-shutdown.txt")}\n`,
  )

  const wrapper = spawn(process.execPath, ["--import", "tsx", "scripts/run-sst.ts", ...args], {
    cwd: process.cwd(),
    detached: true,
    env: { HOME: homeDirectory, PATH: inheritedPath, SST_BIN_PATH: sstStubPath },
    stdio: ["ignore", "pipe", "inherit"],
  })
  const processGroupId = wrapper.pid

  if (!processGroupId) {
    throw new Error("the run-sst entry script did not start")
  }

  const exited = new Promise<EntryScriptExit>((resolveExit) => {
    wrapper.once("exit", (code, signal) => resolveExit({ code, signal }))
  })
  onTestFinished(async () => {
    const stillRunning = wrapper.exitCode === null && wrapper.signalCode === null

    if (stillRunning) process.kill(-processGroupId, "SIGKILL")
    await exited
  })
  const sstStarted = new Promise<void>((resolveStarted) => {
    wrapper.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolveStarted()
    })
  })

  return { homeDirectory, sstStarted, exited, processGroupId }
}

describe("run-sst entry script", () => {
  it("passes its arguments and the external env file through SST's launcher", async () => {
    const entryScript = await startEntryScript({
      args: ["deploy", "--stage", "test"],
      sstStubBody: 'printf "%s\\n" "$@" > "$SST_ARGUMENTS_PATH"\n',
    })

    const exit = await entryScript.exited

    expect(exit).toEqual({ code: 0, signal: null })
    expect(readFileSync(join(entryScript.homeDirectory, "sst-arguments.txt"), "utf8")).toBe(
      "deploy\n--stage\ntest\n",
    )
  })

  it("stays running through Ctrl-C until SST finishes shutting down", async () => {
    // The stub models SST's graceful shutdown. On SIGINT it takes a moment,
    // records that it finished, then exits 3. The stub stands in for SST's
    // platform binary, so SST's launcher (bin/sst.mjs) sits between it and the
    // wrapper and exits 1 for any non-zero exit. runSst passes that 1 through.
    const entryScript = await startEntryScript({
      args: ["dev"],
      sstStubBody:
        "trap 'sleep 0.3; echo finished > \"$SST_SHUTDOWN_PATH\"; exit 3' INT\n" +
        "echo ready\nwhile :; do sleep 0.05; done\n",
    })
    await entryScript.sstStarted

    process.kill(-entryScript.processGroupId, "SIGINT")
    const exit = await entryScript.exited

    expect(exit).toEqual({ code: 1, signal: null })
    expect(readFileSync(join(entryScript.homeDirectory, "sst-shutdown.txt"), "utf8")).toBe(
      "finished\n",
    )
  })
})
