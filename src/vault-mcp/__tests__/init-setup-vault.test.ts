import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Behavioral spec for the remote image's vault setup stage
 * (rootfs/etc/s6-overlay/scripts/init-setup-vault). The VAULT_NAME
 * decision is the first line of defense for a fresh volume — a container
 * that continues without a saved setup reaches the first-sync stage
 * unconfigured — so every branch is exercised here by running the real
 * script under `sh` with stub `ob` and `s6-setuidgid` executables on PATH.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/init-setup-vault",
)

/** Stub `ob`: logs each invocation; `sync-status` and `sync-setup` exit
 *  with the codes the test configures, every other subcommand succeeds. */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
case "$1" in
  sync-status) exit "$OB_SYNC_STATUS_EXIT" ;;
  sync-setup) exit "$OB_SYNC_SETUP_EXIT" ;;
  *) exit 0 ;;
esac
`

/** Stub `s6-setuidgid`: drops the user argument and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
shift
exec "$@"
`

/** Exit code of the pinned obsidian-headless `ob sync-status` when no setup
 *  is saved for the working directory (`process.exit(3)` in its cli.js; 2 is
 *  a saved-but-incomplete setup, 0 a usable one). */
const OB_NO_SAVED_SETUP_EXIT = 3

const DEFAULT_SYNC_CONFIGS_CALL =
  "sync-config --configs core-plugin-data,community-plugin-data"

type SetupRun = {
  status: number | null
  stdout: string
  stderr: string
  /** Every `ob` invocation, as the script issued it (subcommand + args). */
  obCalls: string[]
  vaultPath: string
}

type SetupRunOptions = {
  vaultName?: string
  vaultPassword?: string
  configDirName?: string
  deviceName?: string
  syncConfigs?: string
  /** When true, `ob sync-status` reports a saved setup for the vault path. */
  savedSetup?: boolean
  /** Override the `ob sync-status` exit code directly (takes precedence over `savedSetup`). */
  syncStatusExit?: number
  /** When true, `ob sync-setup` fails. */
  syncSetupFails?: boolean
}

const runSetupScript = (options: SetupRunOptions): SetupRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-setup-vault-"))
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
      OB_SYNC_STATUS_EXIT: String(
        options.syncStatusExit ??
          (options.savedSetup ? 0 : OB_NO_SAVED_SETUP_EXIT),
      ),
      OB_SYNC_SETUP_EXIT: String(options.syncSetupFails ? 1 : 0),
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
  it("refuses to start when VAULT_NAME is unset and no sync setup is saved", () => {
    const run = runSetupScript({ savedSetup: false })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      `[obsidian-sync] ERROR: VAULT_NAME is not set and no saved sync setup exists for ${run.vaultPath}.\n` +
        "[obsidian-sync] Set VAULT_NAME to your exact Obsidian vault name (case-sensitive) in .env (or -e VAULT_NAME=...) and restart.\n",
    )
    expect(run.obCalls).toEqual(["sync-status"])
  })

  it("reuses the saved sync setup when VAULT_NAME is unset", () => {
    const run = runSetupScript({ savedSetup: true })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      `[obsidian-sync] VAULT_NAME is not set — reusing the saved sync setup for ${run.vaultPath}.\n`,
    )
    expect(run.stderr).toBe("")
    expect(run.obCalls).toEqual(["sync-status", DEFAULT_SYNC_CONFIGS_CALL])
  })

  it("does not probe for a saved setup when VAULT_NAME is set", () => {
    const run = runSetupScript({ vaultName: "MyVault", savedSetup: false })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      `[obsidian-sync] Configuring sync for vault: 'MyVault' → ${run.vaultPath}\n`,
    )
    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
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
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("clears config-category sync when SYNC_CONFIGS is none", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncConfigs: "none" })

    expect(run.obCalls).toEqual([
      "sync-setup --vault MyVault",
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

  it("treats any non-zero sync-status exit as a missing setup", () => {
    const run = runSetupScript({ syncStatusExit: 2 })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      `[obsidian-sync] ERROR: VAULT_NAME is not set and no saved sync setup exists for ${run.vaultPath}.\n` +
        "[obsidian-sync] Set VAULT_NAME to your exact Obsidian vault name (case-sensitive) in .env (or -e VAULT_NAME=...) and restart.\n",
    )
    expect(run.obCalls).toEqual(["sync-status"])
  })
})
