import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
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

const SCRIPT_PATH = resolve(__dirname, "../../../rootfs/etc/s6-overlay/scripts/init-first-sync")

/** Stub `ob`: logs each invocation. `ob sync-config --json` prints the config
 *  file the test wrote, or fails when there is none. `ob sync` exits with the
 *  Nth line of the outcomes file (last line repeats when calls exceed lines).
 *  With OB_SYNC_ERASES_QUEUE_IN set to a state.db path, `ob sync` first
 *  empties that store's queue, as the real client does when it skips a
 *  superseded entry and then fails the newer download. */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
if [ "$1" = "sync-config" ]; then
  [ -f "$OB_SYNC_CONFIG_JSON" ] || exit 1
  cat "$OB_SYNC_CONFIG_JSON"
  exit 0
fi
if [ "$1" != "sync" ]; then exit 0; fi
if [ -n "$OB_SYNC_ERASES_QUEUE_IN" ]; then
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1])
    db.exec("DELETE FROM pending_files")
    db.close()
  ' "$OB_SYNC_ERASES_QUEUE_IN"
fi
SYNC_CALL_COUNT=$(grep -c '^sync$' "$OB_CALL_LOG")
OUTCOME=$(sed -n "\${SYNC_CALL_COUNT}p" "$OB_SYNC_OUTCOMES")
if [ -z "$OUTCOME" ]; then OUTCOME=$(sed -n '$p' "$OB_SYNC_OUTCOMES"); fi
exit "$OUTCOME"
`

/** Stub `s6-setuidgid`: logs the user and command name, drops the user
 *  argument, and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
echo "$1 $2" >> "$SETUIDGID_CALL_LOG"
shift
exec "$@"
`

/** What `ob sync-config --json` prints for the active vault by default. */
const DEFAULT_SYNC_CONFIG = { vaultId: "vault-id", syncMode: "bidirectional" }

/** One row of the engine's server_files or pending_files table: the record
 *  the server pushed, stored as JSON in `data`. */
type SyncRecord = {
  path: string
  uid: number
  folder?: boolean
  deleted?: boolean
}

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
  /** Every `ob` invocation, in order (subcommand + args). */
  obCalls: string[]
  /** Every `s6-setuidgid` invocation as "<user> <command>". */
  setuidgidCalls: string[]
  /** The active store's state.db, for reading what the script wrote. */
  activeStateDbPath: string
}

type GateRunOptions = {
  /** One `ob sync` exit code per attempt; the last entry repeats. */
  syncOutcomes: number[]
  /** Run with SETUP_MODE=1 published by init-check-auth. */
  setupMode?: boolean
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
  /** Number of folder rows to record alongside the files — the engine keeps
   *  a row per folder too, marked `"folder": true`. These must not count. */
  knownSyncFolders?: number
  /** Number of files to record in a second store
   *  (`obsidian-headless/sync/<otherVaultId>/state.db`) — a device whose
   *  sync root holds more than one vault's state. Omit for one store. */
  secondStoreSyncFiles?: number
  /** When true, writes a state.db that is not a SQLite database. */
  corruptSyncState?: boolean
  /** When true, runs with XDG_CONFIG_HOME pointing at a directory outside
   *  $HOME (single-volume mode) — the sync state must be read from there. */
  xdgConfigHome?: boolean
  /** What `ob sync-config --json` prints, as raw text. `null` makes the
   *  command fail. Defaults to DEFAULT_SYNC_CONFIG. */
  syncConfigJson?: string | null
  /** Rows to write to the active store's server_files table. */
  serverRecords?: SyncRecord[]
  /** Rows to write to the active store's pending_files table. */
  pendingRecords?: SyncRecord[]
  /** Paths to write to the active store's local_files table. */
  localPaths?: string[]
  /** Server rows to write to a second, inactive store. */
  inactiveStoreServerRecords?: SyncRecord[]
  /** When true, the active store has only a local_files table. */
  unrecognizedStoreSchema?: boolean
  /** SYNC_MODE as the container environment sets it. */
  syncModeEnv?: string
  /** When true, every `ob sync` empties the active store's queue first. */
  syncErasesQueue?: boolean
}

/** The sync engine's own schema for the three tables the script reads. */
const SYNC_STATE_SCHEMA =
  "CREATE TABLE local_files (path TEXT PRIMARY KEY, data TEXT NOT NULL);" +
  "CREATE TABLE server_files (path TEXT PRIMARY KEY, data TEXT NOT NULL);" +
  "CREATE TABLE pending_files (uid INTEGER PRIMARY KEY, path TEXT, data TEXT NOT NULL);"

/** Mirror of the sync engine's store. local_files gets one row per known
 *  file and one per folder, each row's data carrying the engine's `folder`
 *  flag, plus a row per listed path. */
const writeSyncState = ({
  stateDbPath,
  knownFiles = 0,
  knownFolders = 0,
  localPaths = [],
  serverRecords = [],
  pendingRecords = [],
  schema = SYNC_STATE_SCHEMA,
}: {
  stateDbPath: string
  knownFiles?: number
  knownFolders?: number
  localPaths?: string[]
  serverRecords?: SyncRecord[]
  pendingRecords?: SyncRecord[]
  schema?: string
}): void => {
  mkdirSync(dirname(stateDbPath), { recursive: true })
  const db = new DatabaseSync(stateDbPath)
  db.exec(schema)
  const insertLocal = db.prepare("INSERT INTO local_files VALUES (?, ?)")
  for (let fileIndex = 0; fileIndex < knownFiles; fileIndex += 1) {
    insertLocal.run(`note-${fileIndex}.md`, JSON.stringify({ folder: false }))
  }
  for (let folderIndex = 0; folderIndex < knownFolders; folderIndex += 1) {
    insertLocal.run(`folder-${folderIndex}`, JSON.stringify({ folder: true }))
  }
  for (const localPath of localPaths) {
    insertLocal.run(localPath, JSON.stringify({ path: localPath, folder: false }))
  }
  for (const serverRecord of serverRecords) {
    db.prepare("INSERT INTO server_files VALUES (?, ?)").run(
      serverRecord.path,
      JSON.stringify(serverRecord),
    )
  }
  for (const pendingRecord of pendingRecords) {
    db.prepare("INSERT INTO pending_files VALUES (?, ?, ?)").run(
      pendingRecord.uid,
      pendingRecord.path,
      JSON.stringify(pendingRecord),
    )
  }
  db.close()
}

/** The pending_files rows of a store, in the engine's own order (by uid). */
const readPendingRows = (stateDbPath: string): { uid: number; path: string; data: string }[] => {
  const db = new DatabaseSync(stateDbPath, { readOnly: true })
  const rows = db.prepare("SELECT uid, path, data FROM pending_files ORDER BY uid").all()
  db.close()
  return rows.map((row) => ({
    uid: Number(row.uid),
    path: String(row.path),
    data: String(row.data),
  }))
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
  const activeStateDbPath = join(syncStateDir, "state.db")
  // knownSyncFiles: 0 is a real case (a store that records nothing), so it
  // needs the explicit undefined check.
  const activeStoreSeeded =
    options.knownSyncFiles !== undefined ||
    Boolean(options.serverRecords || options.pendingRecords || options.localPaths) ||
    Boolean(options.unrecognizedStoreSchema)

  if (activeStoreSeeded) {
    writeSyncState({
      stateDbPath: activeStateDbPath,
      knownFiles: options.knownSyncFiles ?? 0,
      knownFolders: options.knownSyncFolders ?? 0,
      localPaths: options.localPaths ?? [],
      serverRecords: options.serverRecords ?? [],
      pendingRecords: options.pendingRecords ?? [],
      ...(options.unrecognizedStoreSchema
        ? { schema: "CREATE TABLE local_files (path TEXT PRIMARY KEY, data TEXT NOT NULL);" }
        : {}),
    })
  }
  if (options.inactiveStoreServerRecords) {
    writeSyncState({
      stateDbPath: join(dirname(syncStateDir), "vault-id-inactive", "state.db"),
      serverRecords: options.inactiveStoreServerRecords,
    })
  }
  if (options.secondStoreSyncFiles !== undefined) {
    // Despite the "second" in its name, the glob lists this store first:
    // "vault-id-second/state.db" sorts before "vault-id/state.db" because
    // "-" < "/". The two-store specs cover both positions.
    const secondStoreDir = join(dirname(syncStateDir), "vault-id-second")
    mkdirSync(secondStoreDir, { recursive: true })
    writeSyncState({
      stateDbPath: join(secondStoreDir, "state.db"),
      knownFiles: options.secondStoreSyncFiles,
    })
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
  const setuidgidCallLogPath = join(tempDir, "setuidgid-calls.log")
  writeFileSync(setuidgidCallLogPath, "")
  const outcomesPath = join(tempDir, "sync-outcomes")
  writeFileSync(outcomesPath, `${options.syncOutcomes.join("\n")}\n`)
  const syncConfigJsonPath = join(tempDir, "sync-config.json")
  const syncConfigJson =
    options.syncConfigJson === undefined
      ? JSON.stringify(DEFAULT_SYNC_CONFIG)
      : options.syncConfigJson

  if (syncConfigJson !== null) {
    writeFileSync(syncConfigJsonPath, syncConfigJson)
  }

  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      HOME: homeDir,
      VAULT_PATH: vaultPath,
      OB_CALL_LOG: callLogPath,
      OB_SYNC_OUTCOMES: outcomesPath,
      OB_SYNC_CONFIG_JSON: syncConfigJsonPath,
      SETUIDGID_CALL_LOG: setuidgidCallLogPath,
      ...(options.setupMode ? { SETUP_MODE: "1" } : {}),
      ...(options.vaultName === undefined ? {} : { VAULT_NAME: options.vaultName }),
      ...(options.memoryDir === undefined ? {} : { MEMORY_DIR: options.memoryDir }),
      ...(options.memoryEnabled === undefined ? {} : { MEMORY_ENABLED: options.memoryEnabled }),
      ...(options.xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigDir } : {}),
      ...(options.syncModeEnv ? { SYNC_MODE: options.syncModeEnv } : {}),
      ...(options.syncErasesQueue ? { OB_SYNC_ERASES_QUEUE_IN: activeStateDbPath } : {}),
    },
  })

  const readLoggedCalls = (logPath: string): string[] => {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((loggedCall) => loggedCall !== "")
  }
  const obCalls = readLoggedCalls(callLogPath)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    syncCalls: obCalls.filter((obCall) => obCall === "sync").length,
    configDir,
    obCalls,
    setuidgidCalls: readLoggedCalls(setuidgidCallLogPath),
    activeStateDbPath,
  }
}

describe("init-first-sync gate script", () => {
  it("skips the first sync in setup mode, before the vault directory check", () => {
    // With no vault directory and no setup mode, the cd fails and the
    // script exits 1, so the exit 0 proves the guard ran first.
    const run = runGateScript({
      syncOutcomes: [0],
      setupMode: true,
      vaultExists: false,
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(0)
    expect(run.stdout).toBe("[obsidian-sync] Setup mode — skipping the first sync.\n")
    expect(run.stderr).toBe("")
  })

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
    expect(run.stderr).toContain("WARNING: First sync did not complete — starting services anyway.")
  })

  it("warns and continues when sync fails and the memory layer is disabled", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "false",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain("WARNING: First sync did not complete — starting services anyway.")
  })

  it("warns and continues when the memory layer is disabled via the 0 spelling", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "0",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain("WARNING: First sync did not complete — starting services anyway.")
  })

  it("treats MEMORY_ENABLED case-insensitively, matching config.ts asBool", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "FALSE",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain("WARNING: First sync did not complete — starting services anyway.")
  })

  it("exits 1 without syncing when VAULT_PATH does not exist", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      vaultExists: false,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain("ERROR: Failed to change directory to VAULT_PATH=")
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
    expect(run.stderr).toContain("WARNING: First sync did not complete — starting services anyway.")
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
    expect(run.stderr).toContain("WARNING: First sync did not complete — starting services anyway.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
    expect(run.stderr).toContain("If you emptied the vault on purpose, this stop is expected.")
    expect(run.stderr).toContain(
      "Re-register the device as below. A fresh device downloads the empty vault without deleting anything.",
    )
    expect(run.stderr).toContain("To start fresh: remove the Obsidian config directory (")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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

  it("allows sync when the record holds only folder rows and the vault is empty", () => {
    // Notes deleted by hand while the container ran: the engine dropped
    // their rows, but the rows for the (now empty) folders stay. Those
    // are not files the engine would push as deletions.
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 0,
      knownSyncFolders: 4,
    })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.stdout).toContain("[obsidian-sync] First sync complete.")
  })

  it("refuses to sync when file rows sit beside folder rows and the vault is empty", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 2,
      knownSyncFolders: 4,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
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
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
    expect(run.stderr).toContain(`remove the Obsidian config directory (${run.configDir} —`)
  })

  it("fires the guard regardless of VAULT_NAME", () => {
    const run = runGateScript({ syncOutcomes: [0], knownSyncFiles: 3 })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toContain("ERROR: The vault is empty but this device has previously synced.")
  })

  // -- Never-downloaded files (queued before each attempt) --------------------

  const FAILED_ATTEMPT_RETRIES =
    "[obsidian-sync] First sync failed — retrying in 10s...\n" +
    "[obsidian-sync] First sync failed — retrying in 10s...\n"

  const WARN_AND_CONTINUE =
    "[obsidian-sync] WARNING: First sync did not complete — starting services anyway.\n" +
    "[obsidian-sync] Continuous sync will keep retrying; check network/credentials if this persists.\n"

  it("queues a file the server lists that this device never downloaded", () => {
    const neverDownloaded = { path: "Archive/old.md", uid: 11, folder: false, deleted: false }
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      vaultFiles: ["Notes/kept.md"],
      serverRecords: [neverDownloaded, { path: "Notes/kept.md", uid: 12 }],
      localPaths: ["Notes/kept.md"],
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      "[obsidian-sync] Queued 1 file(s) this device has not downloaded yet.\n" +
        "[obsidian-sync] First sync (attempt 1/3) — waiting for completion before starting services...\n" +
        "[obsidian-sync] First sync complete.\n",
    )
    // Byte-identical to the server row, under the server's uid — the row the
    // Sync client itself writes when a filter change queues a file.
    expect(readPendingRows(run.activeStateDbPath)).toEqual([
      { uid: 11, path: "Archive/old.md", data: JSON.stringify(neverDownloaded) },
    ])
  })

  it("leaves server files that are recorded locally or deleted on the server unqueued", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      vaultFiles: ["Notes/kept.md"],
      serverRecords: [
        { path: "Notes/kept.md", uid: 12 },
        { path: "Gone.md", uid: 13, deleted: true },
      ],
      localPaths: ["Notes/kept.md"],
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      "[obsidian-sync] First sync (attempt 1/3) — waiting for completion before starting services...\n" +
        "[obsidian-sync] First sync complete.\n",
    )
    expect(readPendingRows(run.activeStateDbPath)).toEqual([])
  })

  it("keeps an entry already queued for the path, which may be a newer version", () => {
    const newerVersion = { path: "Archive/old.md", uid: 20 }
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      knownSyncFiles: 1,
      vaultFiles: ["note-0.md"],
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
      pendingRecords: [newerVersion],
    })

    expect(run.status).toBe(0)
    expect(readPendingRows(run.activeStateDbPath)).toEqual([
      { uid: 20, path: "Archive/old.md", data: JSON.stringify(newerVersion) },
    ])
  })

  it("queues before every attempt and once more after the last one, as the Sync user", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      serverRecords: [{ path: "About Me/Principles.md", uid: 11 }],
      syncConfigJson: JSON.stringify({ vaultId: "vault-id", syncMode: "pull-only" }),
    })

    expect(run.obCalls).toEqual(["sync-config --json", "sync", "sync", "sync"])
    // The config read, then a queue step and a sync per attempt, then the
    // final queue step and the count, all as the Sync user.
    expect(run.setuidgidCalls).toEqual([
      "obsidian ob",
      "obsidian node",
      "obsidian ob",
      "obsidian node",
      "obsidian ob",
      "obsidian node",
      "obsidian ob",
      "obsidian node",
      "obsidian node",
    ])
  })

  it("skips queueing on a device that has never synced (no store yet)", () => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test" })

    expect(run.status).toBe(0)
    expect(run.syncCalls).toBe(1)
    expect(run.setuidgidCalls).toEqual(["obsidian ob", "obsidian ob"])
  })

  it("queues nothing from another vault's store", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      localPaths: [],
      inactiveStoreServerRecords: [{ path: "Other.md", uid: 11 }],
    })

    expect(run.status).toBe(0)
    expect(readPendingRows(run.activeStateDbPath)).toEqual([])
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + WARN_AND_CONTINUE)
  })

  it("refuses to sync when the Sync settings can't be read", () => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test", syncConfigJson: null })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: Could not read this vault's Sync settings (ob sync-config --json failed).\n",
    )
  })

  it.each([
    { label: "output that isn't JSON", syncConfigJson: "not json" },
    {
      label: "a config without a vault ID",
      syncConfigJson: JSON.stringify({ syncMode: "bidirectional" }),
    },
    {
      label: "a config without a sync mode",
      syncConfigJson: JSON.stringify({ vaultId: "vault-id" }),
    },
  ])("refuses to sync on $label", ({ syncConfigJson }) => {
    const run = runGateScript({ syncOutcomes: [0], vaultName: "Test", syncConfigJson })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: This vault's Sync settings have no vault ID or sync mode.\n",
    )
  })

  it("refuses to sync when the store's table layout is not the Sync client's", () => {
    const run = runGateScript({
      syncOutcomes: [0],
      vaultName: "Test",
      unrecognizedStoreSchema: true,
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(0)
    expect(run.stderr).toBe(
      "pending_files has no uid, path, data column\n" +
        `[obsidian-sync] ERROR: Could not queue the files this device has not downloaded yet (${run.activeStateDbPath}).\n` +
        "[obsidian-sync] Refusing to sync: without that step, a sync could delete those files from Obsidian Sync and your other devices.\n",
    )
  })

  // -- Refusal before two-way continuous sync ---------------------------------

  const QUEUED_DOWNLOADS_REFUSAL =
    "[obsidian-sync] ERROR: First sync failed with 1 file(s) still waiting to download.\n" +
    "[obsidian-sync] Refusing to start two-way sync: it could delete those files from Obsidian Sync and your other devices.\n" +
    "[obsidian-sync] The count may include files excluded by SYNC_FILE_TYPES, SYNC_EXCLUDED_FOLDERS, or SYNC_CONFIGS — those are dropped from the queue during a successful sync.\n" +
    "[obsidian-sync] Check the network and the log above for a file that keeps failing to download — the container's restart policy retries.\n"

  it("refuses two-way sync when every attempt failed with downloads still queued", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
    })

    expect(run.status).toBe(1)
    expect(run.syncCalls).toBe(3)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + QUEUED_DOWNLOADS_REFUSAL)
  })

  it("refuses regardless of the memory layer", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      memoryEnabled: "false",
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + QUEUED_DOWNLOADS_REFUSAL)
  })

  it("counts a queued file even when a stale local record names it", () => {
    // A local record can outlive its file when the client's startup scan
    // fails, and the client would still delete the file remotely later.
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultFiles: ["About Me/Principles.md"],
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
      pendingRecords: [{ path: "Archive/old.md", uid: 11 }],
      localPaths: ["Archive/old.md"],
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + QUEUED_DOWNLOADS_REFUSAL)
  })

  it("re-queues after the last attempt, so an entry the client erased still counts", () => {
    // Every failed attempt leaves the queue empty, so only the queue step
    // after the last attempt can bring the count back to 1.
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
      syncErasesQueue: true,
    })

    expect(readPendingRows(run.activeStateDbPath).map((row) => row.path)).toEqual([
      "Archive/old.md",
    ])
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + QUEUED_DOWNLOADS_REFUSAL)
  })

  it.each([
    { label: "pull-only", syncMode: "pull-only" },
    { label: "mirror-remote", syncMode: "mirror-remote" },
  ])("warns and continues in $label mode, which never pushes deletions", ({ syncMode }) => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
      syncConfigJson: JSON.stringify({ vaultId: "vault-id", syncMode }),
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + WARN_AND_CONTINUE)
  })

  it("takes the sync mode from the Sync client's settings, not SYNC_MODE", () => {
    // SYNC_MODE says pull-only, but the stored mode is what the client runs.
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      serverRecords: [{ path: "Archive/old.md", uid: 11 }],
      syncModeEnv: "pull-only",
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + QUEUED_DOWNLOADS_REFUSAL)
  })

  it("does not count a queued file the server lists as deleted", () => {
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      serverRecords: [{ path: "Gone.md", uid: 13, deleted: true }],
      pendingRecords: [{ path: "Gone.md", uid: 13, deleted: true }],
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + WARN_AND_CONTINUE)
  })

  it("does not count a queued push the server has no record of yet", () => {
    // A normal incoming push is queued before its server row exists, and the
    // deletion scan only reads server rows.
    const run = runGateScript({
      syncOutcomes: [1],
      vaultName: "Test",
      vaultDirs: ["About Me"],
      localPaths: [],
      pendingRecords: [{ path: "Incoming.md", uid: 30 }],
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe(FAILED_ATTEMPT_RETRIES + WARN_AND_CONTINUE)
  })

  // -- Drift guard -----------------------------------------------------------

  it("matches the server's config defaults for the memory layer", () => {
    // The script hardcodes fallbacks for MEMORY_DIR and MEMORY_ENABLED
    // that must mirror config.ts, so this guards against drift. The folder default is
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
