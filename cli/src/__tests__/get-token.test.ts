import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { captureObsidianToken, runGetToken } from "../get-token.js"
import type { DockerRunner } from "../docker.js"
import type { Prompts } from "../prompts.js"

const createSilentPrompts = () => {
  const errors: string[] = []
  const warnings: string[] = []
  const logs: string[] = []
  const prints: string[] = []
  let introMessage = ""
  let outroMessage = ""

  const prompts: Prompts = {
    intro: (message) => {
      introMessage = message ?? ""
    },
    outro: (message) => {
      outroMessage = message ?? ""
    },
    note: () => {},
    print: (message) => {
      prints.push(message)
    },
    log: (message) => {
      logs.push(message)
    },
    warn: (message) => {
      warnings.push(message)
    },
    error: (message) => {
      errors.push(message)
    },
    select: async () => "",
    text: async () => "",
    password: async () => "",
    confirm: async () => false,
    spinner: () => ({ start: () => {}, stop: () => {} }),
  }

  return { prompts, errors, warnings, logs, prints, introMessage, outroMessage }
}

/**
 * Creates a DockerRunner whose runGetTokenWithMount writes a fake
 * auth_token file into the config mount path, simulating the container's
 * get-token behavior.
 */
const dockerWithToken = (token: string): DockerRunner => ({
  isDaemonRunning: () => true,
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  runGetTokenWithMount: (configMountPath) => {
    const tokenDir = join(configMountPath, "obsidian-headless")
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(join(tokenDir, "auth_token"), token)
    return true
  },
})

const dockerFailsGetToken: DockerRunner = {
  isDaemonRunning: () => true,
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  runGetTokenWithMount: () => false,
}

const dockerDown: DockerRunner = {
  isDaemonRunning: () => false,
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  runGetTokenWithMount: () => false,
}

describe("captureObsidianToken", () => {
  it("returns the token when get-token writes the auth_token file", () => {
    const { prompts } = createSilentPrompts()

    const token = captureObsidianToken({
      docker: dockerWithToken("abc123-sync-token"),
      prompts,
    })

    expect(token).toBe("abc123-sync-token")
  })

  it("trims whitespace from the token file", () => {
    const { prompts } = createSilentPrompts()

    const token = captureObsidianToken({
      docker: dockerWithToken("  token-with-whitespace  \n"),
      prompts,
    })

    expect(token).toBe("token-with-whitespace")
  })

  it("returns undefined when docker run fails", () => {
    const silent = createSilentPrompts()

    const token = captureObsidianToken({
      docker: dockerFailsGetToken,
      prompts: silent.prompts,
    })

    expect(token).toBeUndefined()
    expect(silent.warnings[0]).toBe(
      "get-token did not complete — you can run it later with:\n" +
        "  npx vault-cortex get-token",
    )
  })

  it("returns undefined when the token file is empty", () => {
    const { prompts } = createSilentPrompts()

    const token = captureObsidianToken({
      docker: dockerWithToken(""),
      prompts,
    })

    expect(token).toBeUndefined()
  })

  it("returns undefined when get-token succeeds but writes no token file", () => {
    const { prompts } = createSilentPrompts()
    const dockerSucceedsButNoFile: DockerRunner = {
      ...dockerDown,
      isDaemonRunning: () => true,
      runGetTokenWithMount: () => true,
    }

    const token = captureObsidianToken({
      docker: dockerSucceedsButNoFile,
      prompts,
    })

    expect(token).toBeUndefined()
  })

  it("cleans up the temp directory even on failure", () => {
    const { prompts } = createSilentPrompts()
    const tempDirs: string[] = []
    const dockerTracker: DockerRunner = {
      ...dockerDown,
      isDaemonRunning: () => true,
      runGetTokenWithMount: (configMountPath) => {
        tempDirs.push(configMountPath)
        return false
      },
    }

    captureObsidianToken({ docker: dockerTracker, prompts })

    expect(tempDirs).toHaveLength(1)
    expect(existsSync(tempDirs[0])).toBe(false)
  })

  it("logs the handoff message before running docker", () => {
    const silent = createSilentPrompts()

    captureObsidianToken({
      docker: dockerWithToken("token"),
      prompts: silent.prompts,
    })

    expect(silent.logs[0]).toContain("Handing the terminal to get-token")
  })
})

describe("runGetToken subcommand", () => {
  it("prints the token to stdout when --dir is not set", async () => {
    const silent = createSilentPrompts()

    const exitCode = await runGetToken(
      {},
      { prompts: silent.prompts, docker: dockerWithToken("my-sync-token") },
    )

    expect(exitCode).toBe(0)
    expect(silent.logs).toContain("Your OBSIDIAN_AUTH_TOKEN:")
    expect(silent.prints).toEqual(["\n  my-sync-token\n"])
  })

  it("exits 1 when the docker daemon is not running", async () => {
    const silent = createSilentPrompts()

    const exitCode = await runGetToken(
      {},
      { prompts: silent.prompts, docker: dockerDown },
    )

    expect(exitCode).toBe(1)
    expect(silent.errors[0]).toBe(
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime and try again.",
    )
  })

  it("exits 1 when token capture fails", async () => {
    const silent = createSilentPrompts()

    const exitCode = await runGetToken(
      {},
      { prompts: silent.prompts, docker: dockerFailsGetToken },
    )

    expect(exitCode).toBe(1)
    expect(silent.errors[0]).toBe("Could not capture the auth token.")
  })

  it("writes the token to .env when --dir is set", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-get-token-"))
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n",
    )
    const silent = createSilentPrompts()

    const exitCode = await runGetToken(
      { dir: targetDir },
      { prompts: silent.prompts, docker: dockerWithToken("new-sync-token") },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new-sync-token\nVAULT_NAME=MyVault\n",
    )
    expect(silent.logs).toContain(`Token written to ${join(targetDir, ".env")}`)
  })

  it("exits 1 when --dir .env has no OBSIDIAN_AUTH_TOKEN line", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-get-token-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc\n")
    const silent = createSilentPrompts()

    const exitCode = await runGetToken(
      { dir: targetDir },
      { prompts: silent.prompts, docker: dockerWithToken("new-sync-token") },
    )

    expect(exitCode).toBe(1)
    expect(silent.errors[0]).toContain("no OBSIDIAN_AUTH_TOKEN line")
  })

  it("exits 1 when --dir .env does not exist", async () => {
    const targetDir = join(
      mkdtempSync(join(tmpdir(), "vault-cli-get-token-")),
      "nonexistent",
    )
    const silent = createSilentPrompts()

    const exitCode = await runGetToken(
      { dir: targetDir },
      { prompts: silent.prompts, docker: dockerWithToken("new-sync-token") },
    )

    expect(exitCode).toBe(1)
    expect(silent.errors[0]).toContain("the file is missing")
  })
})
