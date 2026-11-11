import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
        `Start the server:\n  npx vault-cortex@latest start --dir "${targetDir}"`,
    ])
  })

  it("exits 1 when --dir .env has no OBSIDIAN_AUTH_TOKEN line", async () => {
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=abc\n")
  })

  it("exits 1 when --dir .env does not exist", async () => {
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
  })
})
