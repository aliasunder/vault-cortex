import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
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
 *
 * The script runs check-sync-vault from its own folder, so each run links the
 * real script into a temp folder beside a stub check. The check's own
 * branches are covered in check-sync-vault.test.ts; these tests cover when
 * it runs and what happens on each of its answers.
 */

const SCRIPT_PATH = resolve(__dirname, "../../../rootfs/etc/s6-overlay/scripts/init-setup-vault")

/** Stub `ob`: logs each invocation; `sync-setup` exits with the code the
 *  test configures, `sync-config` fails when its flag matches
 *  `OB_SYNC_CONFIG_FAIL_FLAG`, `sync-config --json` prints
 *  `OB_PICKED_CONFIG`, and every other invocation succeeds. */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
case "$1" in
  sync-setup) exit "$OB_SYNC_SETUP_EXIT" ;;
  sync-config)
    [ "$2" = "$OB_SYNC_CONFIG_FAIL_FLAG" ] && exit 1
    [ "$2" = --json ] && printf '%s' "$OB_PICKED_CONFIG"
    exit 0 ;;
  *) exit 0 ;;
esac
`

/** Stub `s6-setuidgid`: drops the user argument and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
shift
exec "$@"
`

/** Stub check-sync-vault: logs its run in the same call log, then refuses or
 *  prints the vault ID the test configures. */
const VAULT_CHECK_STUB = `#!/bin/sh
echo "check-sync-vault" >> "$OB_CALL_LOG"
if [ "$VAULT_CHECK_REFUSES" = 1 ]; then
  echo "[obsidian-sync] ERROR: stub vault check refused." >&2
  exit 1
fi
printf '%s\\n' "$VAULT_CHECK_VAULT_ID"
`

const REQUESTED_VAULT_ID = "aaa111"

const VAULT_CHECK_CALL = "check-sync-vault"
/** The check after ob sync-setup that the Sync client uses the requested vault. */
const PICKED_VAULT_CALL = "sync-config --json"
const DEFAULT_SYNC_CONFIGS_CALL = "sync-config --configs core-plugin-data,community-plugin-data,app"

/** The folder and attachment filters are applied on every boot, empty meaning
 *  "clear" — the stub logs `"$*"`, so an empty argument shows as a trailing
 *  space. */
const CLEAR_EXCLUDED_FOLDERS_CALL = "sync-config --excluded-folders "
const CLEAR_FILE_TYPES_CALL = "sync-config --file-types "

const PICKED_VAULT_ERROR =
  "[obsidian-sync] ERROR: After ob sync-setup, the Sync client does not use the setup for 'MyVault' in this folder.\n" +
  "[obsidian-sync] Refusing to sync a vault other than VAULT_NAME.\n" +
  "[obsidian-sync] See: https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#another-vaults-sync-setup\n"

type SetupRun = {
  status: number | null
  stdout: string
  stderr: string
  /** Every `ob` invocation (subcommand + args) and vault check run, in the
   *  order the script issued them. */
  calls: string[]
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
  syncMode?: string
  /** When true, `ob sync-setup` fails. */
  syncSetupFails?: boolean
  /** The `ob sync-config` flag whose invocation fails (e.g. `--file-types`). */
  syncConfigFailsFor?: string
  /** When true, the vault check refuses. */
  vaultCheckRefuses?: boolean
  /** The vault ID the vault check prints (default: the requested vault's;
   *  empty when VAULT_NAME names no single vault). */
  vaultCheckVaultId?: string
  /** The vault ID `ob sync-config --json` reports after `ob sync-setup`
   *  (default: the requested vault's). */
  pickedVaultId?: string
  /** Raw `ob sync-config --json` output, replacing the setup for pickedVaultId. */
  pickedConfigOutput?: string
  /** When true, the script runs by a path relative to its own folder. */
  relativeScriptPath?: boolean
}

const runSetupScript = (options: SetupRunOptions): SetupRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-setup-vault-"))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubBinDir = join(tempDir, "bin")
  const scriptsDir = join(tempDir, "scripts")
  const vaultPath = join(tempDir, "vault")
  mkdirSync(stubBinDir)
  mkdirSync(scriptsDir)
  mkdirSync(vaultPath)

  writeFileSync(join(stubBinDir, "ob"), OB_STUB, { mode: 0o755 })
  writeFileSync(join(stubBinDir, "s6-setuidgid"), SETUIDGID_STUB, {
    mode: 0o755,
  })
  symlinkSync(SCRIPT_PATH, join(scriptsDir, "init-setup-vault"))
  writeFileSync(join(scriptsDir, "check-sync-vault"), VAULT_CHECK_STUB)

  const callLogPath = join(tempDir, "calls.log")
  writeFileSync(callLogPath, "")

  const pickedConfig = JSON.stringify({
    vaultId: options.pickedVaultId ?? REQUESTED_VAULT_ID,
    syncMode: "bidirectional",
  })
  const scriptArgument = options.relativeScriptPath
    ? "./init-setup-vault"
    : join(scriptsDir, "init-setup-vault")

  const result = spawnSync("sh", [scriptArgument], {
    encoding: "utf8",
    cwd: scriptsDir,
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      HOME: join(tempDir, "home"),
      VAULT_PATH: vaultPath,
      OB_CALL_LOG: callLogPath,
      OB_SYNC_SETUP_EXIT: String(options.syncSetupFails ? 1 : 0),
      OB_SYNC_CONFIG_FAIL_FLAG: options.syncConfigFailsFor ?? "",
      OB_PICKED_CONFIG: options.pickedConfigOutput ?? pickedConfig,
      VAULT_CHECK_REFUSES: options.vaultCheckRefuses ? "1" : "0",
      VAULT_CHECK_VAULT_ID: options.vaultCheckVaultId ?? REQUESTED_VAULT_ID,
      ...(options.setupMode ? { SETUP_MODE: "1" } : {}),
      ...(options.vaultName === undefined ? {} : { VAULT_NAME: options.vaultName }),
      ...(options.vaultPassword === undefined ? {} : { VAULT_PASSWORD: options.vaultPassword }),
      ...(options.configDirName === undefined ? {} : { CONFIG_DIR_NAME: options.configDirName }),
      ...(options.deviceName === undefined ? {} : { DEVICE_NAME: options.deviceName }),
      ...(options.syncConfigs === undefined ? {} : { SYNC_CONFIGS: options.syncConfigs }),
      ...(options.syncExcludedFolders === undefined
        ? {}
        : { SYNC_EXCLUDED_FOLDERS: options.syncExcludedFolders }),
      ...(options.syncFileTypes === undefined ? {} : { SYNC_FILE_TYPES: options.syncFileTypes }),
      ...(options.syncMode === undefined ? {} : { SYNC_MODE: options.syncMode }),
    },
  })

  const calls = readFileSync(callLogPath, "utf8")
    .split("\n")
    .filter((loggedCall) => loggedCall !== "")
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    vaultPath,
  }
}

describe("init-setup-vault script", () => {
  it("skips vault setup in setup mode, before the VAULT_NAME guard", () => {
    // Without setup mode, a run with no vaultName exits 1, so the exit 0
    // proves the guard ran first.
    const run = runSetupScript({ setupMode: true })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("[obsidian-sync] Setup mode — skipping vault setup.\n")
    expect(run.stderr).toBe("")
    expect(run.calls).toEqual([])
  })

  it("refuses to start when VAULT_NAME is unset", () => {
    const run = runSetupScript({})

    expect(run.status).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: VAULT_NAME is not set.\n" +
        "[obsidian-sync] Set VAULT_NAME to your exact Obsidian vault name (case-sensitive) in .env (or -e VAULT_NAME=...) and restart.\n",
    )
    expect(run.calls).toEqual([])
  })

  it("refuses to start when VAULT_NAME is empty", () => {
    const run = runSetupScript({ vaultName: "" })

    expect(run.status).toBe(1)
    expect(run.calls).toEqual([])
  })

  it("configures sync for the named vault", () => {
    const run = runSetupScript({ vaultName: "MyVault" })

    expect(run.status).toBe(0)
    // The vault ID the check prints is captured, so it never reaches the log.
    expect(run.stdout).toBe(
      `[obsidian-sync] Configuring sync for vault: 'MyVault' → ${run.vaultPath}\n`,
    )
    expect(run.stderr).toBe("")
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("stops before ob sync-setup when the vault check refuses", () => {
    const run = runSetupScript({ vaultName: "MyVault", vaultCheckRefuses: true })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe("[obsidian-sync] ERROR: stub vault check refused.\n")
    expect(run.calls).toEqual([VAULT_CHECK_CALL])
  })

  it("stops before any sync-config write when the Sync client uses another vault after ob sync-setup", () => {
    const run = runSetupScript({ vaultName: "MyVault", pickedVaultId: "bbb222" })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(PICKED_VAULT_ERROR)
    expect(run.calls).toEqual([VAULT_CHECK_CALL, "sync-setup --vault MyVault", PICKED_VAULT_CALL])
  })

  it("stops before any sync-config write when ob sync-config --json fails after ob sync-setup", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncConfigFailsFor: "--json" })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(PICKED_VAULT_ERROR)
    expect(run.calls).toEqual([VAULT_CHECK_CALL, "sync-setup --vault MyVault", PICKED_VAULT_CALL])
  })

  it("stops before any sync-config write when ob sync-config --json prints no JSON after ob sync-setup", () => {
    const run = runSetupScript({ vaultName: "MyVault", pickedConfigOutput: "Fetching vaults..." })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(PICKED_VAULT_ERROR)
    expect(run.calls).toEqual([VAULT_CHECK_CALL, "sync-setup --vault MyVault", PICKED_VAULT_CALL])
  })

  it("finds the vault check beside itself when started by a relative path", () => {
    const run = runSetupScript({ vaultName: "MyVault", relativeScriptPath: true })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.calls.slice(0, 2)).toEqual([VAULT_CHECK_CALL, "sync-setup --vault MyVault"])
  })

  it("stops after ob sync-setup when the vault check named no vault", () => {
    // ob sync-setup fails when VAULT_NAME names no single vault; if it ever
    // succeeds anyway, the setup it wrote can't be checked, so the boot stops.
    const run = runSetupScript({ vaultName: "MyVault", vaultCheckVaultId: "" })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(PICKED_VAULT_ERROR)
    expect(run.calls).toEqual([VAULT_CHECK_CALL, "sync-setup --vault MyVault"])
  })

  it("exits 1 with the credential hint when ob sync-setup fails", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncSetupFails: true })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: ob sync-setup failed.\n" +
        "[obsidian-sync] Check OBSIDIAN_AUTH_TOKEN and VAULT_NAME are correct.\n" +
        "[obsidian-sync] If your vault uses end-to-end encryption, set VAULT_PASSWORD.\n",
    )
    expect(run.calls).toEqual([VAULT_CHECK_CALL, "sync-setup --vault MyVault"])
  })

  it("registers the first device under DEVICE_NAME", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      deviceName: "vault cortex box",
    })

    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault --device-name vault cortex box",
      PICKED_VAULT_CALL,
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
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      "sync-config --file-types image,pdf",
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("applies SYNC_MODE after the filters", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncMode: "pull-only" })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      "sync-config --mode pull-only",
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("refuses to start when the SYNC_MODE sync-config call fails", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      syncMode: "pull-onyl",
      syncConfigFailsFor: "--mode",
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: ob sync-config --mode 'pull-onyl' failed.\n" +
        "[obsidian-sync] Refusing to start: syncing in a different mode than SYNC_MODE requests could upload changes you chose not to send.\n" +
        "[obsidian-sync] Set SYNC_MODE to bidirectional, pull-only, or mirror-remote and restart.\n",
    )
    // Nothing after the failed mode call runs.
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      "sync-config --mode pull-onyl",
    ])
  })

  it("passes SYNC_EXCLUDED_FOLDERS and SYNC_FILE_TYPES to sync-config", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      syncExcludedFolders: "Daily Notes,Private",
      syncFileTypes: "image,pdf",
    })

    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
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

    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it.each<{ label: string; options: SetupRunOptions }>([
    { label: "unset", options: { vaultName: "MyVault" } },
    { label: "empty", options: { vaultName: "MyVault", syncConfigs: "" } },
  ])("syncs the default settings categories when SYNC_CONFIGS is $label", ({ options }) => {
    const run = runSetupScript(options)

    expect(run.status).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      DEFAULT_SYNC_CONFIGS_CALL,
    ])
  })

  it("passes a custom SYNC_CONFIGS list to sync-config in place of the default", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncConfigs: "app,hotkey" })

    expect(run.status).toBe(0)
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      "sync-config --configs app,hotkey",
    ])
  })

  it("clears config-category sync when SYNC_CONFIGS is none", () => {
    const run = runSetupScript({ vaultName: "MyVault", syncConfigs: "none" })

    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
      CLEAR_EXCLUDED_FOLDERS_CALL,
      CLEAR_FILE_TYPES_CALL,
      "sync-config --configs ",
    ])
  })

  it("warns and keeps going when the SYNC_CONFIGS=none clear call fails", () => {
    const run = runSetupScript({
      vaultName: "MyVault",
      syncConfigs: "none",
      syncConfigFailsFor: "--configs",
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe(
      "[obsidian-sync] WARNING: ob sync-config --configs '' failed — continuing without it.\n",
    )
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault",
      PICKED_VAULT_CALL,
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
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault --password s3cret",
      PICKED_VAULT_CALL,
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
    expect(run.calls).toEqual([
      VAULT_CHECK_CALL,
      "sync-setup --vault MyVault --config-dir .obsidian-custom",
      PICKED_VAULT_CALL,
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
