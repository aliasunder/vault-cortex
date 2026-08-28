import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the remote image's login stage
 * (rootfs/etc/s6-overlay/scripts/init-obsidian-login). The file-token
 * branch is the safety-relevant one: a rejected login must never delete
 * the token on the volume, only re-enter setup mode. Runs the real script
 * under `sh` with stub `ob` and `s6-setuidgid` executables on PATH.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/init-obsidian-login",
)

/** Stub `ob`: logs each invocation; `login` exits with OB_LOGIN_EXIT. */
const OB_STUB = `#!/bin/sh
echo "$*" >> "$OB_CALL_LOG"
[ "$1" = "login" ] && exit "$OB_LOGIN_EXIT"
exit 0
`

/** Stub `s6-setuidgid`: drops the user argument and runs the command. */
const SETUIDGID_STUB = `#!/bin/sh
shift
exec "$@"
`

const TOKEN_FILE_CONTENT = "token-from-setup-page"

type LoginRun = {
  status: number | null
  stdout: string
  stderr: string
  obCalls: string[]
  /** Contents of the token file after the run; undefined when absent. */
  tokenFile: string | undefined
  /** SETUP_MODE and SETUP_REASON as published; undefined when absent. */
  setupMode: string | undefined
  setupReason: string | undefined
}

type LoginRunOptions = {
  setupMode?: boolean
  envToken?: string
  /** Create the token file on the volume before the run. */
  fileToken?: boolean
  loginFails?: boolean
  publicUrl?: string
}

const runLoginScript = (options: LoginRunOptions): LoginRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-obsidian-login-"))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubBinDir = join(tempDir, "bin")
  const homeDir = join(tempDir, "home")
  const containerEnvDir = join(tempDir, "container_environment")
  const tokenFilePath = join(
    homeDir,
    ".config",
    "obsidian-headless",
    "auth_token",
  )
  mkdirSync(stubBinDir)
  mkdirSync(containerEnvDir, { recursive: true })
  if (options.fileToken) {
    mkdirSync(join(homeDir, ".config", "obsidian-headless"), {
      recursive: true,
    })
    writeFileSync(tokenFilePath, TOKEN_FILE_CONTENT)
  }

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
      HOME: homeDir,
      CONTAINER_ENVIRONMENT_DIR: containerEnvDir,
      OB_CALL_LOG: callLogPath,
      OB_LOGIN_EXIT: String(options.loginFails ? 2 : 0),
      ...(options.setupMode ? { SETUP_MODE: "1" } : {}),
      ...(options.envToken === undefined
        ? {}
        : { OBSIDIAN_AUTH_TOKEN: options.envToken }),
      ...(options.publicUrl === undefined
        ? {}
        : { PUBLIC_URL: options.publicUrl }),
    },
  })

  const readPublished = (name: string): string | undefined => {
    const path = join(containerEnvDir, name)
    return existsSync(path) ? readFileSync(path, "utf8") : undefined
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    obCalls: readFileSync(callLogPath, "utf8")
      .split("\n")
      .filter((loggedCall) => loggedCall !== ""),
    tokenFile: existsSync(tokenFilePath)
      ? readFileSync(tokenFilePath, "utf8")
      : undefined,
    setupMode: readPublished("SETUP_MODE"),
    setupReason: readPublished("SETUP_REASON"),
  }
}

describe("init-obsidian-login script", () => {
  it("skips the login entirely in setup mode", () => {
    const run = runLoginScript({ setupMode: true })

    expect(run).toEqual({
      status: 0,
      stdout: "[obsidian-sync] Setup mode — skipping login.\n",
      stderr: "",
      obCalls: [],
      tokenFile: undefined,
      setupMode: undefined,
      setupReason: undefined,
    })
  })

  it("logs in and exits 0 when the Sync client accepts the token", () => {
    const run = runLoginScript({ envToken: "env-token" })

    expect(run).toEqual({
      status: 0,
      stdout:
        "[obsidian-sync] Authenticating with Obsidian...\n[obsidian-sync] Authenticated.\n",
      stderr: "",
      obCalls: ["login"],
      tokenFile: undefined,
      setupMode: undefined,
      setupReason: undefined,
    })
  })

  it("exits 1 with the get-sync-token hint when the env var token is rejected", () => {
    const run = runLoginScript({ envToken: "env-token", loginFails: true })

    expect(run).toEqual({
      status: 1,
      stdout: "[obsidian-sync] Authenticating with Obsidian...\n",
      stderr:
        "[obsidian-sync] ERROR: login was rejected — the auth token may be\n" +
        "[obsidian-sync] stale. Generate a fresh one with get-sync-token.\n",
      obCalls: ["login"],
      tokenFile: undefined,
      setupMode: undefined,
      setupReason: undefined,
    })
  })

  it("re-enters setup mode, keeping the token file, when the file token is rejected", () => {
    const run = runLoginScript({
      fileToken: true,
      loginFails: true,
      publicUrl: "https://vault.example.com",
    })

    expect(run).toEqual({
      status: 0,
      stdout: "[obsidian-sync] Authenticating with Obsidian...\n",
      stderr:
        "[obsidian-sync] WARNING: the saved Obsidian Sync login was rejected — starting in setup mode.\n" +
        "[obsidian-sync] Sign in again at https://vault.example.com/setup, or restart the container to retry the saved login.\n",
      obCalls: ["login"],
      tokenFile: TOKEN_FILE_CONTENT,
      setupMode: "1",
      setupReason: "login-failed",
    })
  })

  it("leaves the token file alone when the file token is accepted", () => {
    const run = runLoginScript({ fileToken: true })

    expect(run).toEqual({
      status: 0,
      stdout:
        "[obsidian-sync] Authenticating with Obsidian...\n[obsidian-sync] Authenticated.\n",
      stderr: "",
      obCalls: ["login"],
      tokenFile: TOKEN_FILE_CONTENT,
      setupMode: undefined,
      setupReason: undefined,
    })
  })
})
