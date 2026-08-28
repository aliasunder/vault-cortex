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
 * Behavioral spec for the remote image's token gate
 * (rootfs/etc/s6-overlay/scripts/init-check-auth): env var, then the Sync
 * client's token file, then setup mode. Runs the real script under `sh`
 * with the container-environment directory pointed at a temp dir.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/init-check-auth",
)

type GateRun = {
  status: number | null
  stdout: string
  stderr: string
  /** Contents of the published SETUP_MODE file, or undefined when absent. */
  setupModePublished: string | undefined
  setupReasonPublished: boolean
}

type GateRunOptions = {
  envToken?: string
  /** Contents of the token file; "" writes an empty file. Omit for none. */
  fileToken?: string
  /** Put the token file under XDG_CONFIG_HOME instead of $HOME/.config. */
  xdgConfigHome?: boolean
  publicUrl?: string
  port?: string
  /** Pre-seed SETUP_MODE=1 and SETUP_REASON in the container environment,
   *  as s6-overlay does when a deployment's settings carry them. */
  outsideSetupMode?: boolean
}

const runGateScript = (options: GateRunOptions): GateRun => {
  const tempDir = mkdtempSync(join(tmpdir(), "init-check-auth-"))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const homeDir = join(tempDir, "home")
  const xdgConfigDir = join(tempDir, "persist", "config")
  const configDir = options.xdgConfigHome
    ? xdgConfigDir
    : join(homeDir, ".config")
  const containerEnvDir = join(tempDir, "container_environment")
  mkdirSync(containerEnvDir, { recursive: true })
  if (options.outsideSetupMode) {
    writeFileSync(join(containerEnvDir, "SETUP_MODE"), "1")
    writeFileSync(join(containerEnvDir, "SETUP_REASON"), "login-failed")
  }

  if (options.fileToken !== undefined) {
    const tokenDir = join(configDir, "obsidian-headless")
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(join(tokenDir, "auth_token"), options.fileToken)
  }

  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: homeDir,
      CONTAINER_ENVIRONMENT_DIR: containerEnvDir,
      ...(options.envToken === undefined
        ? {}
        : { OBSIDIAN_AUTH_TOKEN: options.envToken }),
      ...(options.xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigDir } : {}),
      ...(options.publicUrl === undefined
        ? {}
        : { PUBLIC_URL: options.publicUrl }),
      ...(options.port === undefined ? {} : { PORT: options.port }),
    },
  })

  const setupModePath = join(containerEnvDir, "SETUP_MODE")
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    setupModePublished: existsSync(setupModePath)
      ? readFileSync(setupModePath, "utf8")
      : undefined,
    setupReasonPublished: existsSync(join(containerEnvDir, "SETUP_REASON")),
  }
}

describe("init-check-auth script", () => {
  it("accepts the env var token without publishing setup mode", () => {
    const run = runGateScript({ envToken: "env-token" })

    expect(run).toEqual({
      status: 0,
      stdout: "[obsidian-sync] Auth token present.\n",
      stderr: "",
      setupModePublished: undefined,
      setupReasonPublished: false,
    })
  })

  it("treats a whitespace-only env var token as no token", () => {
    const run = runGateScript({
      envToken: " \t",
      publicUrl: "https://v.example",
    })

    expect(run).toEqual({
      status: 0,
      stdout:
        "[vault-cortex] No Obsidian Sync token yet — starting in setup mode.\n[vault-cortex] Sign in at https://v.example/setup — you will need your MCP_AUTH_TOKEN.\n",
      stderr: "",
      setupModePublished: "1",
      setupReasonPublished: false,
    })
  })

  it("accepts a token file under $HOME/.config without publishing setup mode", () => {
    const run = runGateScript({ fileToken: "file-token" })

    expect(run).toEqual({
      status: 0,
      stdout: "[obsidian-sync] Auth token found on the volume.\n",
      stderr: "",
      setupModePublished: undefined,
      setupReasonPublished: false,
    })
  })

  it("accepts a token file under XDG_CONFIG_HOME (single-volume layout)", () => {
    const run = runGateScript({ fileToken: "file-token", xdgConfigHome: true })

    expect(run).toEqual({
      status: 0,
      stdout: "[obsidian-sync] Auth token found on the volume.\n",
      stderr: "",
      setupModePublished: undefined,
      setupReasonPublished: false,
    })
  })

  it("reports the env var when both the env var and the file are present", () => {
    const run = runGateScript({
      envToken: "env-token",
      fileToken: "file-token",
    })

    expect(run.stdout).toBe("[obsidian-sync] Auth token present.\n")
  })

  it("publishes SETUP_MODE=1 (no trailing newline) and the setup URL when there is no token", () => {
    const run = runGateScript({ publicUrl: "https://vault.example.com" })

    expect(run).toEqual({
      status: 0,
      stdout:
        "[vault-cortex] No Obsidian Sync token yet — starting in setup mode.\n" +
        "[vault-cortex] Sign in at https://vault.example.com/setup — you will need your MCP_AUTH_TOKEN.\n",
      stderr: "",
      setupModePublished: "1",
      setupReasonPublished: false,
    })
  })

  it("treats an empty token file as no token", () => {
    const run = runGateScript({ fileToken: "", publicUrl: "https://v.example" })

    expect(run).toEqual({
      status: 0,
      stdout:
        "[vault-cortex] No Obsidian Sync token yet — starting in setup mode.\n" +
        "[vault-cortex] Sign in at https://v.example/setup — you will need your MCP_AUTH_TOKEN.\n",
      stderr: "",
      setupModePublished: "1",
      setupReasonPublished: false,
    })
  })

  it("ignores SETUP_MODE and SETUP_REASON arriving from the outside environment", () => {
    const run = runGateScript({
      fileToken: "file-token",
      outsideSetupMode: true,
    })

    expect(run).toEqual({
      status: 0,
      stdout: "[obsidian-sync] Auth token found on the volume.\n",
      stderr: "",
      setupModePublished: undefined,
      setupReasonPublished: false,
    })
  })

  it("names a placeholder host with the configured port when PUBLIC_URL is unset", () => {
    const run = runGateScript({ port: "9000" })

    expect(run.stdout).toBe(
      "[vault-cortex] No Obsidian Sync token yet — starting in setup mode.\n" +
        "[vault-cortex] Sign in at http://<your-server>:9000/setup — you will need your MCP_AUTH_TOKEN.\n",
    )
  })
})
