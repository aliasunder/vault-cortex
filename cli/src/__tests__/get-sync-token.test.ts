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

import { captureObsidianToken, runGetSyncToken } from "../get-sync-token.js"
import type { DockerRunner } from "../docker.js"
import {
  createScriptedPrompts,
  dockerDaemonOnly,
  dockerDown,
} from "./command-stubs.js"

/**
 * Destination sentence passed to captureObsidianToken in direct-call tests —
 * production callers supply their own flow-specific sentence (stored in
 * .env / printed / written to a path).
 */
const TOKEN_DESTINATION_MESSAGE = "The token is captured automatically."

/**
 * Creates a DockerRunner whose runObsidianLogin writes a fake
 * auth_token file into the config mount path, simulating the
 * containerized login writing the token file.
 */
const dockerWithToken = (token: string): DockerRunner => ({
  ...dockerDaemonOnly,
  runObsidianLogin: (configMountPath) => {
    const tokenDir = join(configMountPath, "obsidian-headless")
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(join(tokenDir, "auth_token"), token)
    return true
  },
})

describe("captureObsidianToken", () => {
  it("returns the token when the login writes the auth_token file", () => {
    const { prompts } = createScriptedPrompts()

    const token = captureObsidianToken(
      {
        docker: dockerWithToken("abc123-sync-token"),
        prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(token).toBe("abc123-sync-token")
  })

  it("trims whitespace from the token file", () => {
    const { prompts } = createScriptedPrompts()

    const token = captureObsidianToken(
      {
        docker: dockerWithToken("  token-with-whitespace  \n"),
        prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(token).toBe("token-with-whitespace")
  })

  it("returns undefined when docker run fails", () => {
    const scripted = createScriptedPrompts()

    const token = captureObsidianToken(
      {
        docker: dockerDaemonOnly,
        prompts: scripted.prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "The Obsidian login did not complete — you can run it later with:\n" +
        "  npx vault-cortex get-sync-token",
    )
  })

  it("returns undefined and warns when the token file is empty", () => {
    const scripted = createScriptedPrompts()

    const token = captureObsidianToken(
      {
        docker: dockerWithToken(""),
        prompts: scripted.prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "The Obsidian login finished, but no token was captured — the " +
        "token file was missing, empty, or unreadable. You can retry with:\n" +
        "  npx vault-cortex get-sync-token",
    )
  })

  it("returns undefined and warns when the login succeeds but writes no token file", () => {
    const scripted = createScriptedPrompts()
    const dockerSucceedsButNoFile: DockerRunner = {
      ...dockerDaemonOnly,
      runObsidianLogin: () => true,
    }

    const token = captureObsidianToken(
      {
        docker: dockerSucceedsButNoFile,
        prompts: scripted.prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "The Obsidian login finished, but no token was captured — the " +
        "token file was missing, empty, or unreadable. You can retry with:\n" +
        "  npx vault-cortex get-sync-token",
    )
  })

  it("treats a docker runner throw as a failed run and returns undefined", () => {
    const scripted = createScriptedPrompts()
    const dockerThrows: DockerRunner = {
      ...dockerDaemonOnly,
      runObsidianLogin: () => {
        throw new Error("spawn docker ENOENT")
      },
    }

    const token = captureObsidianToken(
      {
        docker: dockerThrows,
        prompts: scripted.prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(token).toBeUndefined()
    expect(scripted.warnings).toEqual([
      "Docker run failed — spawn docker ENOENT",
      "The Obsidian login did not complete — you can run it later with:\n" +
        "  npx vault-cortex get-sync-token",
    ])
  })

  it("cleans up the temp directory even on failure", () => {
    const { prompts } = createScriptedPrompts()
    const tempDirs: string[] = []
    const dockerTracker: DockerRunner = {
      ...dockerDaemonOnly,
      runObsidianLogin: (configMountPath) => {
        tempDirs.push(configMountPath)
        return false
      },
    }

    captureObsidianToken(
      { docker: dockerTracker, prompts },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(tempDirs).toHaveLength(1)
    expect(existsSync(tempDirs[0])).toBe(false)
  })

  it("logs the handoff message before running docker", () => {
    const scripted = createScriptedPrompts()

    captureObsidianToken(
      {
        docker: dockerWithToken("token"),
        prompts: scripted.prompts,
      },
      TOKEN_DESTINATION_MESSAGE,
    )

    expect(scripted.logs[0]).toBe(
      "Handing the terminal to the Obsidian login — it will ask for your " +
        "account email, password, and MFA code. The token is captured automatically.",
    )
  })
})

describe("runGetSyncToken subcommand", () => {
  it("prints the token to stdout when --dir is not set", async () => {
    const scripted = createScriptedPrompts()

    const exitCode = await runGetSyncToken(
      {},
      { prompts: scripted.prompts, docker: dockerWithToken("my-sync-token") },
    )

    expect(exitCode).toBe(0)
    expect(scripted.logs[0]).toBe(
      "Handing the terminal to the Obsidian login — it will ask for your " +
        "account email, password, and MFA code. The token is captured " +
        "automatically and printed at the end.",
    )
    expect(scripted.logs).toContain("Your OBSIDIAN_AUTH_TOKEN:")
    expect(scripted.prints).toEqual(["\n  my-sync-token\n"])
  })

  it("exits 1 when the docker daemon is not running", async () => {
    const scripted = createScriptedPrompts()

    const exitCode = await runGetSyncToken(
      {},
      { prompts: scripted.prompts, docker: dockerDown },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toBe(
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime and try again.",
    )
  })

  it("exits 1 when token capture fails", async () => {
    const scripted = createScriptedPrompts()

    const exitCode = await runGetSyncToken(
      {},
      { prompts: scripted.prompts, docker: dockerDaemonOnly },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toBe("Could not capture the auth token.")
  })

  it("writes the token to .env when --dir is set", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sync-token-"))
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n",
    )
    const scripted = createScriptedPrompts()

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerWithToken("new-sync-token") },
    )

    expect(exitCode).toBe(0)
    expect(scripted.logs[0]).toBe(
      "Handing the terminal to the Obsidian login — it will ask for your " +
        "account email, password, and MFA code. The token is captured " +
        `automatically and written to ${join(targetDir, ".env")}.`,
    )
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new-sync-token\nVAULT_NAME=MyVault\n",
    )
    expect(scripted.logs).toContain(
      `Token written to ${join(targetDir, ".env")}`,
    )
  })

  it("exits 1 when --dir .env has no OBSIDIAN_AUTH_TOKEN line", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sync-token-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc\n")
    const scripted = createScriptedPrompts()

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerWithToken("new-sync-token") },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toBe(
      `Could not patch ${join(targetDir, ".env")} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
  })

  it("exits 1 when --dir .env does not exist", async () => {
    const targetDir = join(
      mkdtempSync(join(tmpdir(), "vault-cli-sync-token-")),
      "nonexistent",
    )
    const scripted = createScriptedPrompts()

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerWithToken("new-sync-token") },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toBe(
      `Could not patch ${join(targetDir, ".env")} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
  })
})
