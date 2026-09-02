import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the remote image's vault setup stage
 * (rootfs/etc/s6-overlay/scripts/init-setup-vault). The VAULT_NAME guard
 * is the first line of defense — a container that continues without a vault
 * name reaches the first-sync stage unconfigured — so every branch is
 * exercised here by running the real script under `sh` with stub `ob` and
 * `s6-setuidgid` executables on PATH.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/init-setup-vault",
)

/** Stub `ob`: logs each invocation; `sync-setup` exits with the code the
 *  test configures, `sync-config` fails when its flag matches
 *  `OB_SYNC_CONFIG_FAIL_FLAG`, every other invocation succeeds. */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
case "$1" in
  sync-setup) exit "$OB_SYNC_SETUP_EXIT" ;;
  sync-config) [ "$2" = "$OB_SYNC_CONFIG_FAIL_FLAG" ] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac
`

/** Stub `s6-setuidgid`: drops the user argument and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
shift
exec "$@"
`

const DEFAULT_SYNC_CONFIGS_CALL =
  "sync-config --configs core-plugin-data,community-plugin-data"

/** The folder and attachment filters are applied on every boot, empty meaning
 *  "clear" — the stub logs `"$*"`, so an empty argument shows as a trailing
 *  space. */
const CLEAR_EXCLUDED_FOLDERS_CALL = "sync-config --excluded-folders "
const CLEAR_FILE_TYPES_CALL = "sync-config --file-types "

type SetupRun = {
  status: number | null
  stdout: string
  stderr: string
  /** Every `ob` invocation, as the script issued it (subcommand + args). */
  obCalls: string[]
  vaultPath: string
}

type SetupRunOptions = {
  /** Run with SETUP_MODE=1 published by init-check-auth. */
  setupMode?: boolean
  vaultName?: string
  vaultPassword?: string
  configDirName?: string
  deviceName?: string
  syncConfigs?: string
  syncExcludedFolders?: string
  syncFileTypes?: string
  /** When true, `ob sync-setup` fails. */
  syncSetupFails?: boolean
  /** The `ob sync-config` flag whose invocation fails (e.g. `--file-types`). */
  syncConfigFailsFor?: string
}

const runSetupScript = (options: SetupRunOptions): SetupRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-setup-vault-"))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubBinDir = join(tempDir, "bin")
  const vaultPath = join(tempDir, "vault")
  mkdirSync(stubBinDir)
  mkdirSync(vaultPath)

  writeFileSync(join(stubBinDir, "ob"), OB_STUB, { mode: 0o755 })
  writeFileSync(join(stubBinDir, "s6-setuidgid"), SETUIDGID_STUB, {
    mode: 0o755,
  })

  const callLogPath = join(tempDir, "ob-calls.log")
  writeFileSync(callLogPath, "")

  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      HOME: join(tempDir, "home"),
      VAULT_PATH: vaultPath,
      OB_CALL_LOG: callLogPath,
      OB_SYNC_SETUP_EXIT: String(options.syncSetupFails ? 1 : 0),
      OB_SYNC_CONFIG_FAIL_FLAG: options.syncConfigFailsFor ?? "",
      ...(options.setupMode ? { SETUP_MODE: "1" } : {}),
      ...(options.vaultName === undefined
        ? {}
        : { VAULT_NAME: options.vaultName }),
      ...(options.vaultPassword === undefined
        ? {}
        : { VAULT_PASSWORD: options.vaultPassword }),
      ...(options.configDirName === undefined
        ? {}
        : { CONFIG_DIR_NAME: options.configDirName }),
      ...(options.deviceName === undefined
        ? {}
        : { DEVICE_NAME: options.deviceName }),
      ...(options.syncConfigs === undefined
        ? {}
        : { SYNC_CONFIGS: options.syncConfigs }),
      ...(options.syncExcludedFolders === undefined
        ? {}
        : { SYNC_EXCLUDED_FOLDERS: options.syncExcludedFolders }),
      ...(options.syncFileTypes === undefined
        ? {}
        : { SYNC_FILE_TYPES: options.syncFileTypes }),
    },
  })

  const obCalls = readFileSync(callLogPath, "utf8")
    .split("\n")
    .filter((loggedCall) => loggedCall !== "")
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    obCalls,
    vaultPath,
  }
}

describe("init-setup-vault script", () => {
  it("skips vault setup in setup mode, before the VAULT_NAME guard", () => {
    // No vaultName: without setup mode this run exits 1, so the exit 0
    // proves the guard ran first.
    const run = runSetupScript({ setupMode: true })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      "[obsidian-sync] Setup mode — skipping vault setup.\n",
    )
    expect(run.stderr).toBe("")
    expect(run.obCalls).toEqual([])
  })

  it("refuses to start when VAULT_NAME is unset", () => {
    const run = runSetupScript({})

    expect(run.status).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: VAULT_NAME is not set.\n" +
        "[obsidian-sync] Set VAULT_NAME to your exact Obsidian vault name (case-sensitive) in .env (or -e VAULT_NAME=...) and restart.\n",
    )
    expect(run.obCalls).toEqual([])
  })

  it("refuses to start when VAULT_NAME is empty", () => {
    const run = runSetupScript({ vaultName: "" })

    expect(run.status).toBe(1)
    expect(run.obCalls).toEqual([])
  })

  it("configures sync for the named vault", () => {
    const run = runSetupScript({ vaultName: "MyVault" })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      `[obsidian-sync] Configuring sync for vault: 'MyVault' → ${run.vaultPath}\n`,
    )
    expect(run.stderr).toBe("")
    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("exits 1 with the credential hint when ob sync-setup fails", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncSetupFails: true })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: ob sync-setup failed.\n" +
        "[obsidian-sync] Check OBSIDIAN_AUTH_TOKEN and VAULT_NAME are correct.\n" +
        "[obsidian-sync] If your vault uses end-to-end encryption, set VAULT_PASSWORD.\n",
    )
    expect(run.obCalls).toEqual(["sync-setup --vault MyVault"])
  })

  it("registers the first device under DEVICE_NAME", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      deviceName: "vault cortex box",
    })

    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault --device-name vault cortex box",
      "sync-config --device-name vault cortex box",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("warns and keeps going when a filter's sync-config call fails", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      syncFileTypes: "image,pdf",
      syncConfigFailsFor: "--file-types",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe(
      "[obsidian-sync] WARNING: ob sync-config --file-types 'image,pdf' failed — continuing without it.\n",
    )
    // The call after the failed one still runs.
    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      "sync-config --file-types image,pdf",
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("passes SYNC_EXCLUDED_FOLDERS and SYNC_FILE_TYPES to sync-config", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      syncExcludedFolders: "Daily Notes,Private",
      syncFileTypes: "image,pdf",
    })

    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
      "sync-config --excluded-folders Daily Notes,Private",
      "sync-config --file-types image,pdf",
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("clears a stored folder or file-type filter when its variable is empty", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      syncExcludedFolders: "",
      syncFileTypes: "",
    })

    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("clears config-category sync when SYNC_CONFIGS is none", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncConfigs: "none" })

    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      "sync-config --configs ",
    ])
  })

  it("passes VAULT_PASSWORD to sync-setup", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      vaultPassword: "s3cret",
    })

    expect(run.status).toBe(0)
    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault --password s3cret",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("passes CONFIG_DIR_NAME to sync-setup", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      configDirName: ".obsidian-custom",
    })

    expect(run.status).toBe(0)
    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault --config-dir .obsidian-custom",
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("suppresses the VAULT_PASSWORD hint when the variable is already set", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      vaultPassword: "s3cret",
      syncSetupFails: true,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: ob sync-setup failed.\n" +
        "[obsidian-sync] Check OBSIDIAN_AUTH_TOKEN and VAULT_NAME are correct.\n",
    )
  })
})
