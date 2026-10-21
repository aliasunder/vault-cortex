import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { runsAsRoot } from "../../__tests__/runs-as-root.js"

/**
 * Behavioral spec for the remote image's vault check
 * (rootfs/etc/s6-overlay/scripts/check-sync-vault), which stops a boot that
 * would sync a vault other than VAULT_NAME. The real script runs under `sh`
 * with stub `ob` and `s6-setuidgid` executables on PATH. The stub replays
 * the pinned engine's outputs below; the config tree the script validates
 * itself is real files in a temp directory.
 */

const SCRIPT_PATH = resolve(__dirname, "../../../rootfs/etc/s6-overlay/scripts/check-sync-vault")

const GUIDE_URL =
  "https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#another-vaults-sync-setup"

// Engine vectors: captured from obsidian-headless 0.0.14 inside the :remote
// image with hand-written config trees and no token.
// `ob sync-config --json` with no setup for the working folder (none at all,
// or only for another path) prints nothing and exits 3.
const NO_SETUP_EXIT = 3
// A setup without vaultPath that sorts first makes `ob sync-config` throw.
const UNREADABLE_SETUP_EXIT = 1

/** `ob sync-config --json` output for a picked setup, in the engine's field order. */
const pickedConfig = (vaultId: string, vaultName: string): string => {
  return JSON.stringify(
    {
      vaultId,
      vaultName,
      vaultPath: "/vault",
      syncMode: "bidirectional",
      deviceName: "vault-cortex",
      configDir: ".obsidian",
      fileTypes: ["image", "audio", "pdf", "video"],
      configs: [],
      excludedFolders: [],
    },
    null,
    2,
  )
}

/** `ob sync-list-local --json` output: one row per setup, raw stored path. */
const localSetups = (vaultIds: ReadonlyArray<string>): string => {
  return JSON.stringify({
    vaults: vaultIds.map((id) => ({ id, path: "/vault", host: "sync-1.obsidian.md" })),
  })
}

type RemoteVault = { id: string; name: string }

/** `ob sync-list-remote --json` output for the account's owned and shared vaults. */
const remoteVaults = (
  vaults: ReadonlyArray<RemoteVault>,
  sharedVaults: ReadonlyArray<RemoteVault> = [],
): string => {
  return JSON.stringify({
    vaults: vaults.map((vault) => ({ ...vault, region: "us" })),
    shared: sharedVaults.map((vault) => ({ ...vault, region: "us" })),
  })
}

/** Stub `ob`: logs each call and the folder it ran in, and replays the output
 *  and exit code the test sets per verb. */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
pwd >> "$OB_CWD_LOG"
case "$1" in
  sync-list-remote) printf '%s' "$OB_REMOTE_JSON"; exit "$OB_REMOTE_EXIT" ;;
  sync-config) printf '%s' "$OB_CONFIG_JSON"; exit "$OB_CONFIG_EXIT" ;;
  sync-list-local) printf '%s' "$OB_LOCAL_JSON"; exit "$OB_LOCAL_EXIT" ;;
  *) exit 0 ;;
esac
`

/** Stub `s6-setuidgid`: drops the user argument and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
shift
exec "$@"
`

type CheckOptions = {
  vaultName: string
  remoteJson: string
  remoteExit?: number
  configJson?: string
  configExit: number
  localJson?: string
  localExit?: number
  /** When true, VAULT_PATH names a folder that does not exist. */
  vaultPathMissing?: boolean
  /** When true, the sync folder exists but can't be listed (mode 000). */
  syncRootUnreadable?: boolean
  /** When true, the Sync client has not created its sync folder yet. */
  syncRootMissing?: boolean
  /** config.json files to create under the sync folder, keyed by folder name. */
  setupFiles?: Readonly<Record<string, string>>
  /** Folders to create under the sync folder with no config.json in them. */
  foldersWithoutSetup?: ReadonlyArray<string>
  storageRoot?: string
}

type CheckRun = {
  status: number | null
  stdout: string
  stderr: string
  obCalls: string[]
  /** The working folder of each `ob` call, in call order. */
  obCwds: string[]
  vaultPath: string
  syncRoot: string
  /** Every file under the sync folder with its content, read after the run. */
  setupTreeAfter: Record<string, string>
}

const readSetupTree = (syncRoot: string): Record<string, string> => {
  const tree: Record<string, string> = {}
  for (const folderName of readdirSync(syncRoot)) {
    for (const fileName of readdirSync(join(syncRoot, folderName))) {
      tree[`${folderName}/${fileName}`] = readFileSync(join(syncRoot, folderName, fileName), "utf8")
    }
  }
  return tree
}

const runCheck = (options: CheckOptions): CheckRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "check-sync-vault-"))
  const stubBinDir = join(tempDir, "bin")
  const vaultPath = join(tempDir, "vault")
  const homeDir = join(tempDir, "home")
  const syncRoot = join(homeDir, ".config", "obsidian-headless", "sync")
  onTestFinished(() => {
    // A mode-000 sync folder blocks the removal, so its mode comes back first.
    if (options.syncRootUnreadable) chmodSync(syncRoot, 0o755)
    rmSync(tempDir, { recursive: true, force: true })
  })
  mkdirSync(stubBinDir)
  if (!options.vaultPathMissing) mkdirSync(vaultPath)
  if (!options.syncRootMissing) mkdirSync(syncRoot, { recursive: true })
  writeFileSync(join(stubBinDir, "ob"), OB_STUB, { mode: 0o755 })
  writeFileSync(join(stubBinDir, "s6-setuidgid"), SETUIDGID_STUB, { mode: 0o755 })

  for (const [folderName, content] of Object.entries(options.setupFiles ?? {})) {
    mkdirSync(join(syncRoot, folderName))
    writeFileSync(join(syncRoot, folderName, "config.json"), content)
  }
  for (const folderName of options.foldersWithoutSetup ?? []) {
    mkdirSync(join(syncRoot, folderName))
  }

  const callLogPath = join(tempDir, "ob-calls.log")
  const cwdLogPath = join(tempDir, "ob-cwds.log")
  writeFileSync(callLogPath, "")
  writeFileSync(cwdLogPath, "")

  if (options.syncRootUnreadable) chmodSync(syncRoot, 0o000)

  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      HOME: homeDir,
      VAULT_PATH: vaultPath,
      VAULT_NAME: options.vaultName,
      OB_CALL_LOG: callLogPath,
      OB_REMOTE_JSON: options.remoteJson,
      OB_REMOTE_EXIT: String(options.remoteExit ?? 0),
      OB_CONFIG_JSON: options.configJson ?? "",
      OB_CONFIG_EXIT: String(options.configExit),
      OB_LOCAL_JSON: options.localJson ?? localSetups([]),
      OB_LOCAL_EXIT: String(options.localExit ?? 0),
      OB_CWD_LOG: cwdLogPath,
      ...(options.storageRoot ? { STORAGE_ROOT: options.storageRoot } : {}),
    },
  })

  // Readable again, so setupTreeAfter can show the run wrote nothing.
  if (options.syncRootUnreadable) chmodSync(syncRoot, 0o755)

  const readLogLines = (logPath: string): string[] => {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((loggedLine) => loggedLine !== "")
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    obCalls: readLogLines(callLogPath),
    obCwds: readLogLines(cwdLogPath),
    vaultPath,
    syncRoot,
    setupTreeAfter: options.syncRootMissing ? {} : readSetupTree(syncRoot),
  }
}

const VAULT_A = { id: "aaa111", name: "Personal" }
const VAULT_B = { id: "bbb222", name: "Work" }
const setupFile = (vault: { id: string; name: string }): string => {
  return JSON.stringify({ vaultId: vault.id, vaultName: vault.name, vaultPath: "/vault" })
}

describe("check-sync-vault", () => {
  it("continues on a first boot, when no setup exists for the vault folder", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configExit: NO_SETUP_EXIT,
    })

    expect(run.status).toBe(0)
    // stdout carries only the requested vault's ID, for init-setup-vault.
    expect(run.stdout).toBe("bbb222\n")
    expect(run.stderr).toBe(
      "[obsidian-sync] Vault check: continue — no Sync setup for this folder yet.\n",
    )
    expect(run.obCalls).toEqual(["sync-list-remote --json", "sync-config --json"])
  })

  it("continues on a first boot, before the Sync client has created its sync folder", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configExit: NO_SETUP_EXIT,
      syncRootMissing: true,
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("bbb222\n")
    expect(run.stderr).toBe(
      "[obsidian-sync] Vault check: continue — no Sync setup for this folder yet.\n",
    )
  })

  it("continues on a reboot, when the engine already syncs the requested vault", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configJson: pickedConfig(VAULT_B.id, VAULT_B.name),
      configExit: 0,
      localJson: localSetups([VAULT_B.id]),
      setupFiles: { [VAULT_B.id]: setupFile(VAULT_B) },
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("bbb222\n")
    expect(run.stderr).toBe("[obsidian-sync] Vault check: continue — set up for 'Work' (bbb222).\n")
  })

  it("matches VAULT_NAME as a vault ID before matching it as a name", () => {
    const vaultNamedLikeAnId = { id: "ccc333", name: "bbb222" }
    const run = runCheck({
      vaultName: "bbb222",
      remoteJson: remoteVaults([VAULT_B, vaultNamedLikeAnId]),
      configJson: pickedConfig(VAULT_B.id, VAULT_B.name),
      configExit: 0,
      localJson: localSetups([VAULT_B.id]),
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("bbb222\n")
    expect(run.stderr).toBe(
      "[obsidian-sync] Vault check: continue — set up for 'bbb222' (bbb222).\n",
    )
  })

  it("refuses a second vault on a volume set up for another vault still in the account", () => {
    const setupFiles = { [VAULT_A.id]: setupFile(VAULT_A) }
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configJson: pickedConfig(VAULT_A.id, VAULT_A.name),
      configExit: 0,
      setupFiles,
    })

    expect(run.status).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      [
        "[obsidian-sync] ERROR: This install is set up to sync a different vault than VAULT_NAME.",
        "[obsidian-sync] VAULT_NAME is 'Work' (bbb222), but its Sync setup is for 'Personal' (aaa111).",
        "[obsidian-sync] Syncing now would merge the two vaults' notes. Nothing was changed. To fix it:",
        "[obsidian-sync]   - If VAULT_NAME is a mistake, set it back and restart.",
        "[obsidian-sync]   - To sync 'Work' as well, run it as a separate install with its own INSTANCE_NAME.",
        "[obsidian-sync]   - To switch this install to 'Work' on purpose, remove this install's vault_data and obsidian_config volumes together.",
        "[obsidian-sync]     Removing only the Sync config would upload the old vault's notes into the new one.",
        `[obsidian-sync] See: ${GUIDE_URL}`,
        "",
      ].join("\n"),
    )
    // The check only reads: the existing setup is byte-for-byte unchanged.
    expect(run.setupTreeAfter).toEqual({ [`${VAULT_A.id}/config.json`]: setupFiles[VAULT_A.id] })
    expect(run.obCalls).toEqual(["sync-list-remote --json", "sync-config --json"])
  })

  it("names a setup whose vault is gone from the account and offers removing only its folder", () => {
    const deletedVault = { id: "ddd444", name: "Old Work" }
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B]),
      configJson: pickedConfig(deletedVault.id, deletedVault.name),
      configExit: 0,
      setupFiles: { [deletedVault.id]: setupFile(deletedVault) },
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      [
        "[obsidian-sync] ERROR: This install is set up to sync a different vault than VAULT_NAME.",
        "[obsidian-sync] VAULT_NAME is 'Work' (bbb222), but its Sync setup is for 'Old Work' (ddd444), which is no longer in your account.",
        "[obsidian-sync] Syncing now would merge the two vaults' notes. Nothing was changed. To fix it:",
        "[obsidian-sync]   - If VAULT_NAME is a mistake, set it back and restart.",
        "[obsidian-sync]   - To sync 'Work' as well, run it as a separate install with its own INSTANCE_NAME.",
        "[obsidian-sync]   - If you re-created this same vault in Obsidian and the notes here are its notes,",
        `[obsidian-sync]     remove only the old setup folder: ${run.syncRoot}/ddd444`,
        "[obsidian-sync]   - To switch this install to 'Work' on purpose, remove this install's vault_data and obsidian_config volumes together.",
        "[obsidian-sync]     Removing only the Sync config would upload the old vault's notes into the new one.",
        `[obsidian-sync] See: ${GUIDE_URL}`,
        "",
      ].join("\n"),
    )
  })

  it("words the fixes for the single-volume hosted layout under STORAGE_ROOT", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configJson: pickedConfig(VAULT_A.id, VAULT_A.name),
      configExit: 0,
      storageRoot: "/persist",
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      [
        "[obsidian-sync] ERROR: This install is set up to sync a different vault than VAULT_NAME.",
        "[obsidian-sync] VAULT_NAME is 'Work' (bbb222), but its Sync setup is for 'Personal' (aaa111).",
        "[obsidian-sync] Syncing now would merge the two vaults' notes. Nothing was changed. To fix it:",
        "[obsidian-sync]   - If VAULT_NAME is a mistake, set it back and restart.",
        "[obsidian-sync]   - To sync 'Work' as well, run it as a separate service.",
        "[obsidian-sync]   - To switch this install to 'Work' on purpose, remove /persist/vault and /persist/config together.",
        "[obsidian-sync]     Removing only the Sync config would upload the old vault's notes into the new one.",
        `[obsidian-sync] See: ${GUIDE_URL}`,
        "",
      ].join("\n"),
    )
  })

  it("names a picked vault that is shared with the account by its current name", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B], [VAULT_A]),
      configJson: pickedConfig(VAULT_A.id, "Old name"),
      configExit: 0,
    })

    expect(run.status).toBe(1)
    expect(run.stderr.split("\n")[1]).toBe(
      "[obsidian-sync] VAULT_NAME is 'Work' (bbb222), but its Sync setup is for 'Personal' (aaa111).",
    )
  })

  it("matches VAULT_NAME against vaults shared with the account", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_A], [VAULT_B]),
      configExit: NO_SETUP_EXIT,
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("bbb222\n")
  })

  it("runs every ob call inside the vault folder", () => {
    const run = runCheck({
      vaultName: "Personal",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configJson: pickedConfig(VAULT_A.id, VAULT_A.name),
      configExit: 0,
      localJson: localSetups([VAULT_A.id]),
    })

    expect(run.status).toBe(0)
    expect(run.obCalls).toEqual([
      "sync-list-remote --json",
      "sync-config --json",
      "sync-list-local --json",
    ])
    expect(run.obCwds).toEqual([run.vaultPath, run.vaultPath, run.vaultPath])
  })

  it("stops before any ob call when VAULT_PATH can't be entered", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B]),
      configExit: NO_SETUP_EXIT,
      vaultPathMissing: true,
    })

    expect(run.status).toBe(1)
    // The shell prints its own cd error first, worded differently per shell.
    expect(run.stderr.trimEnd().split("\n").at(-1)).toBe(
      `[obsidian-sync] ERROR: Failed to change directory to VAULT_PATH='${run.vaultPath}'.`,
    )
    expect(run.obCalls).toEqual([])
  })

  it("continues with a warning when a dormant setup for another vault sits beside the picked one", () => {
    const run = runCheck({
      vaultName: "Personal",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configJson: pickedConfig(VAULT_A.id, VAULT_A.name),
      configExit: 0,
      localJson: localSetups([VAULT_A.id, VAULT_B.id]),
    })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe(
      "[obsidian-sync] WARNING: This install also holds Sync setups for other vaults: bbb222\n" +
        `[obsidian-sync] They are not used now. Remove each one's folder under ${run.syncRoot} so it can't be picked later.\n` +
        "[obsidian-sync] Vault check: continue — set up for 'Personal' (aaa111).\n",
    )
    expect(run.stdout).toBe("aaa111\n")
  })

  it("continues without the warning when the local setups can't be listed", () => {
    const run = runCheck({
      vaultName: "Personal",
      remoteJson: remoteVaults([VAULT_A, VAULT_B]),
      configJson: pickedConfig(VAULT_A.id, VAULT_A.name),
      configExit: 0,
      localJson: "",
      localExit: 1,
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("aaa111\n")
    // Only the outcome is pinned: node's parse error for the empty listing
    // reaches stderr before this line.
    expect(run.stderr.trimEnd().split("\n").at(-1)).toBe(
      "[obsidian-sync] Vault check: continue — set up for 'Personal' (aaa111).",
    )
    expect(run.stderr).not.toContain("WARNING")
  })

  it("stops when the account's vault list can't be read", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: "",
      remoteExit: 1,
      configExit: NO_SETUP_EXIT,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: Could not list the vaults in your Obsidian account.\n" +
        "[obsidian-sync] Check OBSIDIAN_AUTH_TOKEN and the network, then restart.\n",
    )
    expect(run.obCalls).toEqual(["sync-list-remote --json"])
  })

  it("stops when the account's vault list is not JSON", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: "Fetching vaults...",
      configJson: pickedConfig(VAULT_A.id, VAULT_A.name),
      configExit: 0,
      setupFiles: { [VAULT_A.id]: setupFile(VAULT_A) },
    })

    expect(run.status).toBe(1)
    expect(run.stdout).toBe("")
    // node's own parse error comes first.
    expect(run.stderr.trimEnd().split("\n").slice(-2)).toEqual([
      "[obsidian-sync] ERROR: Could not read the list of vaults in your Obsidian account.",
      "[obsidian-sync] Refusing to sync without knowing which vault VAULT_NAME names.",
    ])
    expect(run.obCalls).toEqual(["sync-list-remote --json"])
  })

  it.each([
    { label: "no vault", vaults: [VAULT_A] },
    { label: "several vaults", vaults: [{ ...VAULT_A, name: "Work" }, VAULT_B] },
  ])("leaves the error to ob sync-setup when VAULT_NAME matches $label", ({ vaults }) => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults(vaults),
      configExit: NO_SETUP_EXIT,
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(
      "[obsidian-sync] Vault check: 'Work' does not name exactly one vault — ob sync-setup reports it.\n",
    )
    expect(run.obCalls).toEqual(["sync-list-remote --json"])
  })

  it.each([
    { label: "an unparseable file", content: "{not json" },
    { label: "null", content: "null" },
    { label: "false", content: "false" },
    { label: "an empty string", content: '""' },
    { label: "an object without vaultId", content: '{"vaultPath":"/vault"}' },
    { label: "an empty vaultId", content: '{"vaultId":"","vaultPath":"/vault"}' },
    { label: "an object without vaultPath", content: '{"vaultId":"eee555"}' },
  ])("stops on a setup file holding $label, before asking the engine", ({ content }) => {
    const setupFiles = { [VAULT_B.id]: setupFile(VAULT_B), eee555: content }
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B]),
      configJson: pickedConfig(VAULT_B.id, VAULT_B.name),
      configExit: 0,
      setupFiles,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      [
        "[obsidian-sync] ERROR: A Sync setup file here is not a valid setup, and Obsidian Sync would ignore it:",
        `[obsidian-sync]   ${run.syncRoot}/eee555/config.json`,
        "[obsidian-sync] Refusing to sync, because it may belong to another vault whose notes are in this folder.",
        `[obsidian-sync] See: ${GUIDE_URL}`,
        "",
      ].join("\n"),
    )
    expect(run.obCalls).toEqual(["sync-list-remote --json"])
    expect(run.setupTreeAfter).toEqual({
      [`${VAULT_B.id}/config.json`]: setupFiles[VAULT_B.id],
      "eee555/config.json": content,
    })
  })

  it("ignores a setup folder without config.json, as the engine does", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B]),
      configExit: NO_SETUP_EXIT,
      foldersWithoutSetup: ["leftover"],
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("bbb222\n")
    expect(run.obCalls).toEqual(["sync-list-remote --json", "sync-config --json"])
  })

  it.skipIf(runsAsRoot)(
    "stops when the sync folder can't be listed, before asking the engine",
    () => {
      const run = runCheck({
        vaultName: "Work",
        remoteJson: remoteVaults([VAULT_B]),
        configExit: NO_SETUP_EXIT,
        syncRootUnreadable: true,
      })

      expect(run.status).toBe(1)
      // node's own error for the failed listing comes first.
      expect(run.stderr.trimEnd().split("\n").slice(-2)).toEqual([
        `[obsidian-sync] ERROR: Could not read the Sync setups under ${run.syncRoot}.`,
        "[obsidian-sync] Refusing to sync without knowing which vault this install is set up for.",
      ])
      expect(run.obCalls).toEqual(["sync-list-remote --json"])
    },
  )

  it("stops when the engine can't read its own setup", () => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B]),
      configExit: UNREADABLE_SETUP_EXIT,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: The Sync client could not read its own setup (ob sync-config exited 1).\n" +
        "[obsidian-sync] Refusing to sync without knowing which vault this install is set up for.\n" +
        `[obsidian-sync] See: ${GUIDE_URL}\n`,
    )
  })

  it.each([
    { label: "output that is not JSON", configJson: "Fetching vaults..." },
    { label: "JSON without a vault ID", configJson: '{"vaultName":"Work"}' },
  ])("stops when the engine's setup answer is $label", ({ configJson }) => {
    const run = runCheck({
      vaultName: "Work",
      remoteJson: remoteVaults([VAULT_B]),
      configJson,
      configExit: 0,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "[obsidian-sync] ERROR: The Sync client could not read its own setup (ob sync-config printed no vault ID).\n" +
        "[obsidian-sync] Refusing to sync without knowing which vault this install is set up for.\n" +
        `[obsidian-sync] See: ${GUIDE_URL}\n`,
    )
  })

  it("stops when VAULT_NAME is not set", () => {
    const run = runCheck({ vaultName: "", remoteJson: remoteVaults([]), configExit: NO_SETUP_EXIT })

    expect(run.status).toBe(1)
    expect(run.stderr).toBe("[obsidian-sync] ERROR: VAULT_NAME is not set.\n")
    expect(run.obCalls).toEqual([])
  })
})
