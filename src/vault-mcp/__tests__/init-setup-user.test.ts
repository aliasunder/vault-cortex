import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Behavioral spec for the remote image's ownership step
 * (rootfs/etc/s6-overlay/scripts/init-setup-user): which directories it
 * creates, where it records the applied PUID:PGID, and what it chowns. The
 * real script runs under `sh` with stub `id`, `usermod`, `groupmod`, and
 * `chown` executables that log their arguments instead of touching the
 * host, so the directory layout — including its relocation under
 * XDG_CONFIG_HOME / INDEX_DB_PATH in single-volume mode — is asserted on
 * real paths.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/init-setup-user",
)

/** Stub `id`: reports the image-baked UID/GID (1000) for -u and -g. */
const ID_STUB = `#!/bin/sh
echo 1000
`

/** Stub for usermod/groupmod/chown: appends "<command> <args>" to the log. */
const LOGGING_STUB = `#!/bin/sh
echo "$(basename "$0") $*" >> "$STUB_CALL_LOG"
`

type SetupUserRun = {
  status: number | null
  stdout: string
  stderr: string
  /** Every usermod/groupmod/chown invocation, one "<command> <args>" per line. */
  calls: string[]
  tempDir: string
  homeDir: string
  vaultPath: string
  dataDir: string
}

type SetupUserRunOptions = {
  puid?: string
  pgid?: string
  /** Relative to the temp dir; the script receives its parent as the
   *  index directory to create and chown. */
  indexDbPath?: string
  /** When true, XDG_CONFIG_HOME points at <tmp>/persist/config. */
  xdgConfigHome?: boolean
  /** Pre-recorded "<uid>:<gid>" in .applied-ids (simulates a prior boot). */
  appliedIds?: string
}

const runSetupUser = (options: SetupUserRunOptions): SetupUserRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-setup-user-"))
  const stubBinDir = join(tempDir, "bin")
  const homeDir = join(tempDir, "home")
  const vaultPath = join(tempDir, "vault")
  const indexDbPath = join(tempDir, options.indexDbPath ?? "data/index.db")
  const dataDir = resolve(indexDbPath, "..")
  const xdgConfigDir = join(tempDir, "persist", "config")
  const configDir = options.xdgConfigHome
    ? xdgConfigDir
    : join(homeDir, ".config")
  mkdirSync(stubBinDir)
  mkdirSync(homeDir)
  if (options.appliedIds !== undefined) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, ".applied-ids"), `${options.appliedIds}\n`)
  }

  writeFileSync(join(stubBinDir, "id"), ID_STUB, { mode: 0o755 })
  for (const stubName of ["usermod", "groupmod", "chown"]) {
    writeFileSync(join(stubBinDir, stubName), LOGGING_STUB, { mode: 0o755 })
  }
  const callLogPath = join(tempDir, "stub-calls.log")
  writeFileSync(callLogPath, "")

  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      HOME: homeDir,
      VAULT_PATH: vaultPath,
      INDEX_DB_PATH: indexDbPath,
      STUB_CALL_LOG: callLogPath,
      ...(options.puid === undefined ? {} : { PUID: options.puid }),
      ...(options.pgid === undefined ? {} : { PGID: options.pgid }),
      ...(options.xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigDir } : {}),
    },
  })

  const calls = readFileSync(callLogPath, "utf8")
    .split("\n")
    .filter((loggedCall) => loggedCall.length > 0)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    tempDir,
    homeDir,
    vaultPath,
    dataDir,
  }
}

describe("init-setup-user ownership script", () => {
  it("creates the vault, index, and $HOME/.config directories and records the IDs there on first boot", () => {
    const run = runSetupUser({})
    const legacyConfigDir = join(run.homeDir, ".config")

    expect(run.status).toBe(0)
    expect(existsSync(run.vaultPath)).toBe(true)
    expect(existsSync(run.dataDir)).toBe(true)
    expect(readFileSync(join(legacyConfigDir, ".applied-ids"), "utf8")).toBe(
      "1000:1000\n",
    )
    expect(run.calls).toEqual([
      `chown -R 1000:1000 /home/obsidian ${run.vaultPath} ${run.dataDir} ${legacyConfigDir}`,
      `chown 1000:1000 ${join(legacyConfigDir, ".applied-ids")}`,
    ])
    expect(run.stdout).toContain("Running as UID=1000 GID=1000")
  })

  it("relocates the config directory and the IDs record under XDG_CONFIG_HOME", () => {
    const run = runSetupUser({ xdgConfigHome: true })
    const xdgConfigDir = resolve(run.homeDir, "..", "persist", "config")

    expect(run.status).toBe(0)
    expect(readFileSync(join(xdgConfigDir, ".applied-ids"), "utf8")).toBe(
      "1000:1000\n",
    )
    expect(existsSync(join(run.homeDir, ".config", ".applied-ids"))).toBe(false)
    expect(run.calls).toEqual([
      `chown -R 1000:1000 /home/obsidian ${run.vaultPath} ${run.dataDir} ${xdgConfigDir}`,
      `chown 1000:1000 ${join(xdgConfigDir, ".applied-ids")}`,
    ])
  })

  it("derives the index directory from INDEX_DB_PATH's parent", () => {
    const run = runSetupUser({ indexDbPath: "persist/data/index.db" })

    expect(run.status).toBe(0)
    expect(existsSync(join(run.tempDir, "persist", "data"))).toBe(true)
  })

  it("skips the recursive chown when the recorded IDs already match", () => {
    const run = runSetupUser({ appliedIds: "1000:1000" })
    const legacyConfigDir = join(run.homeDir, ".config")

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([
      `chown 1000:1000 /home/obsidian ${run.vaultPath} ${run.dataDir} ${legacyConfigDir}`,
    ])
    expect(run.stdout).not.toContain("fixing ownership recursively")
  })

  it("remaps the group and re-records the IDs after a PGID change", () => {
    const run = runSetupUser({ pgid: "1002", appliedIds: "1000:1000" })
    const legacyConfigDir = join(run.homeDir, ".config")

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([
      "groupmod -o -g 1002 obsidian",
      `chown -R 1000:1002 /home/obsidian ${run.vaultPath} ${run.dataDir} ${legacyConfigDir}`,
      `chown 1000:1002 ${join(legacyConfigDir, ".applied-ids")}`,
    ])
    expect(readFileSync(join(legacyConfigDir, ".applied-ids"), "utf8")).toBe(
      "1000:1002\n",
    )
  })

  it("remaps the user and re-records the IDs after a PUID change", () => {
    const run = runSetupUser({ puid: "1001", appliedIds: "1000:1000" })
    const legacyConfigDir = join(run.homeDir, ".config")

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([
      "usermod -o -u 1001 obsidian",
      `chown -R 1001:1000 /home/obsidian ${run.vaultPath} ${run.dataDir} ${legacyConfigDir}`,
      `chown 1001:1000 ${join(legacyConfigDir, ".applied-ids")}`,
    ])
    expect(readFileSync(join(legacyConfigDir, ".applied-ids"), "utf8")).toBe(
      "1001:1000\n",
    )
    expect(run.stdout).toContain(
      "Ownership IDs changed (1000:1000 → 1001:1000)",
    )
  })
})
