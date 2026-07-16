import { describe, expect, it } from "vitest"

import { buildProgram } from "../program.js"
import type { GetSyncTokenFlags } from "../get-sync-token.js"
import type { InitFlags } from "../init.js"
import type { UpgradeFlags } from "../upgrade.js"

const buildCapturingProgram = () => {
  const initCalls: InitFlags[] = []
  const upgradeCalls: UpgradeFlags[] = []
  const getSyncTokenCalls: GetSyncTokenFlags[] = []
  const program = buildProgram({
    version: "0.0.0-test",
    runInit: async (flags) => {
      initCalls.push(flags)
      return 0
    },
    runUpgrade: async (flags) => {
      upgradeCalls.push(flags)
      return 0
    },
    runGetSyncToken: async (flags) => {
      getSyncTokenCalls.push(flags)
      return 0
    },
  })
  for (const command of [program, ...program.commands]) {
    command.exitOverride()
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} })
  }
  return { program, initCalls, upgradeCalls, getSyncTokenCalls }
}

describe("buildProgram init", () => {
  it("passes all init flags through to runInit", async () => {
    const { program, initCalls } = buildCapturingProgram()

    await program.parseAsync(
      [
        "init",
        "--mode",
        "remote",
        "--vault-path",
        "/vaults/Mine",
        "--dir",
        "./out",
        "--yes",
      ],
      { from: "user" },
    )

    expect(initCalls).toEqual([
      { mode: "remote", vaultPath: "/vaults/Mine", dir: "./out", yes: true },
    ])
  })

  it("invokes init with no flags when none are given", async () => {
    const { program, initCalls } = buildCapturingProgram()

    await program.parseAsync(["init"], { from: "user" })

    expect(initCalls).toEqual([{}])
  })

  it("rejects unknown options instead of passing them through", async () => {
    const { program, initCalls } = buildCapturingProgram()

    await expect(
      program.parseAsync(["init", "--bogus"], { from: "user" }),
    ).rejects.toThrow("unknown option '--bogus'")
    expect(initCalls).toEqual([])
  })

  it("reports the package version via --version", async () => {
    const { program } = buildCapturingProgram()

    await expect(
      program.parseAsync(["--version"], { from: "user" }),
    ).rejects.toThrow("0.0.0-test")
  })
})

describe("buildProgram upgrade", () => {
  it("passes --dir through to runUpgrade", async () => {
    const { program, upgradeCalls } = buildCapturingProgram()

    await program.parseAsync(["upgrade", "--dir", "/opt/vault-cortex"], {
      from: "user",
    })

    expect(upgradeCalls).toEqual([{ dir: "/opt/vault-cortex" }])
  })

  it("invokes upgrade with no flags when none are given", async () => {
    const { program, upgradeCalls } = buildCapturingProgram()

    await program.parseAsync(["upgrade"], { from: "user" })

    expect(upgradeCalls).toEqual([{}])
  })
})

describe("buildProgram get-sync-token", () => {
  it("passes --dir through to runGetSyncToken", async () => {
    const { program, getSyncTokenCalls } = buildCapturingProgram()

    await program.parseAsync(["get-sync-token", "--dir", "/opt/vault-cortex"], {
      from: "user",
    })

    expect(getSyncTokenCalls).toEqual([{ dir: "/opt/vault-cortex" }])
  })

  it("invokes get-sync-token with no flags when none are given", async () => {
    const { program, getSyncTokenCalls } = buildCapturingProgram()

    await program.parseAsync(["get-sync-token"], { from: "user" })

    expect(getSyncTokenCalls).toEqual([{}])
  })
})
