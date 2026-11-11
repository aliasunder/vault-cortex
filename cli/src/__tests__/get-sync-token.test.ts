import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { runGetSyncToken } from "../get-sync-token.js"
import { createScriptedPrompts, fetchApiError, fetchSigninSuccess } from "./command-stubs.js"

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
    expect(scripted.logs).toContain("Your OBSIDIAN_AUTH_TOKEN:")
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
    expect(scripted.errors[0]).toBe("Could not capture the auth token.")
  })

  it("writes the token to .env when --dir is set", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sync-token-"))
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=old-token\nVAULT_NAME=MyVault\n",
    )
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("new-sync-token"),
      },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\nOBSIDIAN_AUTH_TOKEN=new-sync-token\nVAULT_NAME=MyVault\n",
    )
    const startHint = scripted.logs.find((log) => log.includes("Token written to"))
    expect(startHint).toContain(`Token written to ${join(targetDir, ".env")}`)
    expect(startHint).toContain(`npx vault-cortex start --dir "${targetDir}"`)
  })

  it("exits 1 when --dir .env has no OBSIDIAN_AUTH_TOKEN line", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-sync-token-"))
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
    expect(scripted.errors[0]).toBe(
      `Could not patch ${join(targetDir, ".env")} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
  })

  it("exits 1 when --dir .env does not exist", async () => {
    const targetDir = join(mkdtempSync(join(tmpdir(), "vault-cli-sync-token-")), "nonexistent")
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const exitCode = await runGetSyncToken(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        fetchFn: fetchSigninSuccess("new-sync-token"),
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toBe(
      `Could not patch ${join(targetDir, ".env")} — the file is missing ` +
        "or has no OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
  })
})
