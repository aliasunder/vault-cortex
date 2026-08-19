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

import { loadConfig } from "../config.js"

/**
 * Behavioral spec for the remote image's first-sync gate
 * (rootfs/etc/s6-overlay/scripts/init-first-sync). The script's failure
 * policy is the safety core of the #440 fix — a flipped condition would
 * silently reopen the data-loss window with CI green — so every branch is
 * exercised here by running the real script under `sh` with stub `ob`,
 * `s6-setuidgid`, and `sleep` executables on PATH.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/init-first-sync",
)

/** Stub `ob`: logs each invocation, and for `ob sync` exits with the Nth
 *  line of the outcomes file (last line repeats when calls exceed lines). */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
if [ "$1" != "sync" ]; then exit 0; fi
SYNC_CALL_COUNT=$(grep -c '^sync' "$OB_CALL_LOG")
OUTCOME=$(sed -n "\${SYNC_CALL_COUNT}p" "$OB_SYNC_OUTCOMES")
if [ -z "$OUTCOME" ]; then OUTCOME=$(sed -n '$p' "$OB_SYNC_OUTCOMES"); fi
exit "$OUTCOME"
`

/** Stub `s6-setuidgid`: drops the user argument and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
shift
exec "$@"
`

/** Stub `sleep`: no-op so retry pauses don't slow the suite down. */
const SLEEP_STUB = `#!/bin/sh
exit 0
`

type GateRun = {
  status: number | null
  stdout: string
  stderr: string
  syncCalls: number
  /** Path to the sentinel file for post-run assertions. */
  sentinelPath: string
}

type GateRunOptions = {
  /** One `ob sync` exit code per attempt; the last entry repeats. */
  syncOutcomes: number[]
  vaultName?: string
  memoryDir?: string
  memoryEnabled?: string
  /** Vault-relative directories to create before running. */
  vaultDirs?: string[]
  /** When false, VAULT_PATH points at a directory that doesn't exist. */
  vaultExists?: boolean
  /** When true, pre-creates the .vault-synced sentinel (simulates a prior sync). */
  sentinel?: boolean
}

const runGateScript = (options: GateRunOptions): GateRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-first-sync-"))
  const stubBinDir = join(tempDir, "bin")
  const vaultPath = join(tempDir, "vault")
  const homeDir = join(tempDir, "home")
  const configDir = join(homeDir, ".config")
  const sentinelPath = join(configDir, ".vault-synced")
  mkdirSync(stubBinDir)
  mkdirSync(configDir, { recursive: true })
  if (options.vaultExists ?? true) {
    mkdirSync(vaultPath)
  }
  for (const vaultDir of options.vaultDirs ?? []) {
    mkdirSync(join(vaultPath, vaultDir), { recursive: true })
  }
  if (options.sentinel) {
    writeFileSync(sentinelPath, "")
  }

  writeFileSync(join(stubBinDir, "ob"), OB_STUB, { mode: 0o755 })
  writeFileSync(join(stubBinDir, "s6-setuidgid"), SETUIDGID_STUB, {
    mode: 0o755,
  })
  writeFileSync(join(stubBinDir, "sleep"), SLEEP_STUB, { mode: 0o755 })

  const callLogPath = join(tempDir, "ob-calls.log")
  writeFileSync(callLogPath, "")
  const outcomesPath = join(tempDir, "sync-outcomes")
  writeFileSync(outcomesPath, `${options.syncOutcomes.join("\n")}\n`)

  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      HOME: homeDir,
      VAULT_PATH: vaultPath,
      OB_CALL_LOG: callLogPath,
      OB_SYNC_OUTCOMES: outcomesPath,
      ...(options.vaultName === undefined
        ? {}
        : { VAULT_NAME: options.vaultName }),
      ...(options.memoryDir === undefined
        ? {}
        : { MEMORY_DIR: options.memoryDir }),
      ...(options.memoryEnabled === undefined
        ? {}
        : { MEMORY_ENABLED: options.memoryEnabled }),
    },
  })

  const callLog = readFileSync(callLogPath, "utf8")
  const syncCalls = callLog
    .split("\n")
    .filter((loggedCall) => loggedCall.startsWith("sync")).length
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    syncCalls,
    sentinelPath,
  }
}

describe("init-first-sync gate script", () => {
  it("exits 0 after a single attempt when the first sync succeeds", () => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test" })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("retries and succeeds when a later attempt completes", () => {
    const run = runGateScript({ syncOutcomes: [1, 0], vaultName: "Test" })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(2)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("refuses to start when sync fails and the memory folder has not synced", () => {
    const run = runGateScript({ syncOutcomes: [1], vaultName: "Test" })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(3)
    expect(run.stderr).toContain(
      "ERROR: First sync failed and the memory folder ('About Me') has not synced yet.",
    )
    expect(run.stderr).toContain("Refusing to start")
  })

  it("refuses on a content-warm vault whose memory folder has not synced", () => {
    // Pins fatality to the memory folder specifically — a regression to a
    // vault-warmth check (any visible content ⇒ warn-and-continue) would
    // reopen the #440 window on partially synced volumes.
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["Projects"],
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain("Refusing to start")
  })

  it("still refuses when only hidden entries arrived before the failure", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: [".obsidian"],
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain("Refusing to start")
  })

  it("warns and continues when sync fails but the memory folder is present", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(3)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  it("warns and continues when sync fails and the memory layer is disabled", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "false",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  it("warns and continues when the memory layer is disabled via the 0 spelling", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "0",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  it("treats MEMORY_ENABLED case-insensitively, matching config.ts asBool", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "FALSE",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  it("exits 1 without syncing when VAULT_PATH does not exist", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      vaultExists: false,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: Failed to change directory to VAULT_PATH=",
    )
  })

  it("makes a single tolerated attempt when VAULT_NAME is unset", () => {
    const run = runGateScript({ syncOutcomes: [1] })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  it("keys the fatality check on a custom MEMORY_DIR", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryDir: "Memory Files",
      vaultDirs: ["Memory Files"],
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  it("trims MEMORY_DIR whitespace, matching config.ts normalization", () => {
    // config.ts trims MEMORY_DIR before applying the default; the script
    // must check the same normalized folder name or the two sides would
    // disagree about which folder protects a degraded start.
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryDir: " About Me ",
      vaultDirs: ["About Me"],
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain(
      "WARNING: First sync did not complete — starting services anyway.",
    )
  })

  // -- Sync-state vault guard (empty vault + prior-sync sentinel) ----------

  it("refuses to sync when the vault is empty but a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      sentinel: true,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
    expect(run.stderr).toContain("remove the obsidian_config volume")
  })

  it("refuses when the vault has only hidden entries and a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      sentinel: true,
      vaultDirs: [".obsidian"],
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("allows sync when the vault has visible files and a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      sentinel: true,
      vaultDirs: ["About Me"],
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("allows sync on a fresh device with an empty vault (no sentinel)", () => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test" })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("writes the sentinel file after a successful sync", () => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test" })

    expect(run.status).toBe(0)
    expect(existsSync(run.sentinelPath)).toBe(true)
  })

  it("does not write the sentinel file when sync fails", () => {
    const run = runGateScript({ syncOutcomes: [1], vaultName: "Test" })

    expect(run.status).toBe(1)
    expect(existsSync(run.sentinelPath)).toBe(false)
  })

  it("fires the guard regardless of VAULT_NAME", () => {
    const run = runGateScript({ syncOutcomes: [0], sentinel: true })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  // -- Drift guard -----------------------------------------------------------

  it("matches the server's config defaults for the memory layer", () => {
    // Drift guard: the script hardcodes fallbacks for MEMORY_DIR and
    // MEMORY_ENABLED that must mirror config.ts. The folder default is
    // proven behaviorally — a folder named after the server's default
    // suppresses fatality — and the enabled default is pinned directly.
    const serverDefaults = loadConfig({})
    expect(serverDefaults.memoryEnabled).toBe(true)

    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: [serverDefaults.memoryDir],
    })

    expect(run.status).toBe(0)
  })
})
