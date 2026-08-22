import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it, onTestFinished } from "vitest"

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
  /** Obsidian config directory the script resolved. */
  configDir: string
}

type GateRunOptions = {
  /** One `ob sync` exit code per attempt; the last entry repeats. */
  syncOutcomes: number[]
  vaultName?: string
  memoryDir?: string
  memoryEnabled?: string
  /** Vault-relative directories to create before running. */
  vaultDirs?: string[]
  /** Vault-relative empty files to create before running (parents created). */
  vaultFiles?: string[]
  /** When false, VAULT_PATH points at a directory that doesn't exist. */
  vaultExists?: boolean
  /** Number of files to record in the device's sync state
   *  (`obsidian-headless/sync/<vaultId>/state.db`, `local_files` table) —
   *  what a prior sync would have left behind. Omit for a fresh device. */
  knownSyncFiles?: number
  /** Number of files to record in a second store
   *  (`obsidian-headless/sync/<otherVaultId>/state.db`) — a device whose
   *  sync root holds more than one vault's state. Omit for one store. */
  secondStoreSyncFiles?: number
  /** When true, writes a state.db that is not a SQLite database. */
  corruptSyncState?: boolean
  /** When true, runs with XDG_CONFIG_HOME pointing at a directory outside
   *  $HOME (single-volume mode) — the sync state must be read from there. */
  xdgConfigHome?: boolean
}

/** Mirror of the sync engine's local_files table, with one row per file. */
const writeSyncState = (stateDbPath: string, knownFiles: number): void => {
  const db = new DatabaseSync(stateDbPath)
  db.exec(
    "CREATE TABLE local_files (path TEXT PRIMARY KEY, data TEXT NOT NULL)",
  )
  const insert = db.prepare("INSERT INTO local_files VALUES (?, ?)")
  for (let fileIndex = 0; fileIndex < knownFiles; fileIndex += 1) {
    insert.run(`note-${fileIndex}.md`, "{}")
  }
  db.close()
}

const runGateScript = (options: GateRunOptions): GateRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-first-sync-"))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubBinDir = join(tempDir, "bin")
  const vaultPath = join(tempDir, "vault")
  const homeDir = join(tempDir, "home")
  const legacyConfigDir = join(homeDir, ".config")
  const xdgConfigDir = join(tempDir, "persist", "config")
  const configDir = options.xdgConfigHome ? xdgConfigDir : legacyConfigDir
  const syncStateDir = join(configDir, "obsidian-headless", "sync", "vault-id")
  mkdirSync(stubBinDir)
  mkdirSync(legacyConfigDir, { recursive: true })
  mkdirSync(xdgConfigDir, { recursive: true })
  if (options.vaultExists ?? true) {
    mkdirSync(vaultPath)
  }
  for (const vaultDir of options.vaultDirs ?? []) {
    mkdirSync(join(vaultPath, vaultDir), { recursive: true })
  }
  for (const vaultFile of options.vaultFiles ?? []) {
    mkdirSync(dirname(join(vaultPath, vaultFile)), { recursive: true })
    writeFileSync(join(vaultPath, vaultFile), "")
  }
  if (options.knownSyncFiles !== undefined) {
    mkdirSync(syncStateDir, { recursive: true })
    writeSyncState(join(syncStateDir, "state.db"), options.knownSyncFiles)
  }
  if (options.secondStoreSyncFiles !== undefined) {
    // Despite the "second" in its name, the glob lists this store first:
    // "vault-id-second/state.db" sorts before "vault-id/state.db" because
    // "-" < "/". The two-store specs cover both positions.
    const secondStoreDir = join(dirname(syncStateDir), "vault-id-second")
    mkdirSync(secondStoreDir, { recursive: true })
    writeSyncState(
      join(secondStoreDir, "state.db"),
      options.secondStoreSyncFiles,
    )
  }
  if (options.corruptSyncState) {
    mkdirSync(syncStateDir, { recursive: true })
    writeFileSync(join(syncStateDir, "state.db"), "not a database")
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
      ...(options.xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigDir } : {}),
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
    configDir,
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

  it("retries three times and refuses when VAULT_NAME is unset and the memory folder is absent", () => {
    const run = runGateScript({ syncOutcomes: [1] })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(3)
    expect(run.stderr).toBe(
      "[obsidian-sync] First sync failed — retrying in 10s...\n" +
        "[obsidian-sync] First sync failed — retrying in 10s...\n" +
        "[obsidian-sync] ERROR: First sync failed and the memory folder ('About Me') has not synced yet.\n" +
        "[obsidian-sync] Refusing to start: the MCP server would create memory template files\n" +
        "[obsidian-sync] that sync could push over your real notes once it recovers.\n" +
        "[obsidian-sync] Check network and credentials — the container's restart policy retries.\n",
    )
  })

  it("retries three times and continues when VAULT_NAME is unset but the memory folder is present", () => {
    const run = runGateScript({ syncOutcomes: [1], vaultDirs: ["About Me"] })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(3)
    expect(run.stderr).toBe(
      "[obsidian-sync] First sync failed — retrying in 10s...\n" +
        "[obsidian-sync] First sync failed — retrying in 10s...\n" +
        "[obsidian-sync] WARNING: First sync did not complete — starting services anyway.\n" +
        "[obsidian-sync] Continuous sync will keep retrying; check network/credentials if this persists.\n",
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

  // -- Sync-state vault guard (recorded local files + vault without content) --

  it("refuses to sync when the vault is empty but the device recorded synced files", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
    expect(run.stderr).toContain(
      "If you emptied the vault on purpose, this stop is expected.",
    )
    expect(run.stderr).toContain(
      "Re-register the device as below. A fresh device downloads the empty vault without deleting anything.",
    )
    expect(run.stderr).toContain(
      "To start fresh: remove the Obsidian config directory (",
    )
    expect(run.stderr).toContain(
      " — the obsidian_config volume under Compose, or the config directory under STORAGE_ROOT) to re-register the device.",
    )
  })

  it("refuses when the vault holds only the Sync client's own .obsidian/.sync.lock and a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultDirs: [".obsidian/.sync.lock"],
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("refuses when the vault has only a non-Obsidian dotfile and a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultFiles: [".trash"],
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("allows sync when the vault holds only synced Obsidian config and a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultFiles: [".obsidian/app.json"],
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("allows sync when the vault holds a hidden non-lock entry under .obsidian/ and a prior sync completed", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultFiles: [".obsidian/.hidden-plugin-data"],
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("allows sync when the vault has a note inside a folder and a prior sync completed", () => {
    // The note sits in a subfolder with nothing at the vault root — a
    // common layout, so the content check must look below the top level.
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultFiles: ["About Me/Principles.md"],
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("refuses when only empty folders remain and a prior sync completed", () => {
    // A wipe that deleted the files but kept the folder tree must still
    // read as an empty vault — directories alone are not content.
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultDirs: ["Projects", "About Me"],
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("refuses when a dotfile inside a folder is the only file and a prior sync completed", () => {
    // Sync never delivers dotfiles outside .obsidian/, so a leftover
    // Projects/.hidden-note.md is not evidence that the vault's files
    // are still here.
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      vaultFiles: ["Projects/.hidden-note.md"],
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("allows sync on a fresh device with an empty vault (no sync state)", () => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test" })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("allows sync on a device whose sync state records zero files when the vault is empty", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 0,
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  // The guard reads every store under the sync root, not just the first or
  // last match — a device that has registered more than one vault keeps a
  // store per vault, and rows in any of them mean files were delivered.
  it("refuses to sync when only the last of two stores records files and the vault is empty", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 0,
      secondStoreSyncFiles: 2,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("refuses to sync when only the first of two stores records files and the vault is empty", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 2,
      secondStoreSyncFiles: 0,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
  })

  it("allows sync when two stores both record zero files and the vault is empty", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 0,
      secondStoreSyncFiles: 0,
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("refuses to sync when the sync state exists but cannot be read", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      corruptSyncState: true,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      `ERROR: Could not read this device's sync state under ${join(run.configDir, "obsidian-headless", "sync")}.`,
    )
  })

  // -- XDG_CONFIG_HOME relocation (single-volume mode) ---------------------

  it("stops when the vault is empty and the sync state sits under XDG_CONFIG_HOME", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 3,
      xdgConfigHome: true,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain(
      "ERROR: The vault is empty but this device has previously synced.",
    )
    expect(run.stderr).toContain(
      `remove the Obsidian config directory (${run.configDir} —`,
    )
  })

  it("fires the guard regardless of VAULT_NAME", () => {
    const run = runGateScript({ syncOutcomes: [0], knownSyncFiles: 3 })

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
