import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import { runGetSyncToken } from "../get-sync-token.js"
import {
  createScriptedPrompts,
  fetchApiError,
  fetchSigninSuccess,
} from "../../__tests__/command-stubs.js"

// Creates a temp target dir and registers its removal at creation time, so
// the suite self-cleans even when an assertion throws mid-test.
const makeTempTargetDir = (): string => {
  const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sync-token-"))
  onTestFinished(() => {
    rmSync(targetDir, { recursive: true, force: true })
  })
  return targetDir
}

describe("runGetSyncToken subcommand", () => {
  it("prints the token to stdout when --dir is not set", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      {},
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("my-sync-token"),
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.logs).toEqual(["Your OBSIDIAN_AUTH_TOKEN:"])
    expect(scripted.prints).toEqual(["\n  my-sync-token\n"])
  })

  it("exits 1 when token capture fails", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "wrong-password"])

    const exitCode = await runGetSyncToken(
      {},
      {
        prompts: scripted.prompts,
        fetchFn: fetchApiError("Invalid email or password"),
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual(["Could not capture the auth token."])
  })

  it("writes the token to the .env of a relative --dir and prints its absolute start command", async () => {
    const targetDir = makeTempTargetDir()
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n",
    )
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: relative(process.cwd(), targetDir) },
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("new-sync-token"),
      },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new-sync-token\nVAULT_NAME=MyVault\n",
    )
    expect(scripted.logs).toEqual([
      `Token written to ${join(targetDir, ".env")}\n\n` +
        `Start the server:\n  npx vault-cortex@latest start --dir '${targetDir}'`,
    ])
  })

  it("exits 1 when --dir .env is deleted during the sign-in", async () => {
    const targetDir = makeTempTargetDir()
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\n")
    const signIn = fetchSigninSuccess("new-sync-token")
    const deleteEnvThenSignIn: typeof fetch = async (...fetchArgs) => {
      unlinkSync(envPath)
      return signIn(...fetchArgs)
    }
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      { prompts: scripted.prompts, fetchFn: deleteEnvThenSignIn },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `Could not patch ${envPath} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    ])
    expect(existsSync(envPath)).toBe(false)
  })

  it("exits 1 before the sign-in when --dir .env has no OBSIDIAN_AUTH_TOKEN line", async () => {
    const targetDir = makeTempTargetDir()
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc\n")
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("new-sync-token"),
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `Could not patch ${join(targetDir, ".env")} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    ])
    expect(scripted.asked).toEqual([])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=abc\n")
  })

  it("exits 1 before the sign-in when the --dir path holds a control character", async () => {
    const targetDir = join(makeTempTargetDir(), "notes\r")
    mkdirSync(targetDir)
    const remoteEnv = "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n"
    writeFileSync(join(targetDir, ".env"), remoteEnv)
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("new-sync-token"),
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      "The install folder's path contains a control character, which a terminal cannot show. Choose another folder with --dir.",
    ])
    expect(scripted.asked).toEqual([])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(remoteEnv)
  })

  it("exits 1 before the sign-in when every user can change the --dir folder", async () => {
    const targetDir = makeTempTargetDir()
    const remoteEnv = "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\n"
    writeFileSync(join(targetDir, ".env"), remoteEnv)
    chmodSync(targetDir, 0o777)
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      { prompts: scripted.prompts, fetchFn: fetchSigninSuccess("new-sync-token") },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `Every user on this machine can change ${targetDir}, so the CLI won't use it. Remove other users' write permission from it, or choose another folder with --dir.`,
    ])
    expect(scripted.asked).toEqual([])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(remoteEnv)
  })

  it("exits 1 before the sign-in when --dir .env does not exist", async () => {
    const targetDir = join(makeTempTargetDir(), "nonexistent")
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("new-sync-token"),
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `Could not patch ${join(targetDir, ".env")} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    ])
    expect(scripted.asked).toEqual([])
  })
})
