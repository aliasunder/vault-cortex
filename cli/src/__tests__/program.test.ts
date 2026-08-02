import { describe, expect, it } from "vitest"

import { buildProgram } from "../program.js"
import type { ConfigureFlags } from "../configure.js"
import type { GetSyncTokenFlags } from "../get-sync-token.js"
import type { InitFlags } from "../init.js"
import type { DownFlags, LogsFlags, RestartFlags } from "../lifecycle.js"
import type { UpgradeFlags } from "../upgrade.js"

const buildCapturingProgram = () => {
  const initCalls: InitFlags[] = []
  const configureCalls: ConfigureFlags[] = []
  const upgradeCalls: UpgradeFlags[] = []
  const restartCalls: RestartFlags[] = []
  const logsCalls: LogsFlags[] = []
  const downCalls: DownFlags[] = []
  const getSyncTokenCalls: GetSyncTokenFlags[] = []
  const program = buildProgram({
    version: "0.0.0-test",
    runInit: async (flags) => {
      initCalls.push(flags)
      return 0
    },
    runConfigure: async (flags) => {
      configureCalls.push(flags)
      return 0
    },
    runUpgrade: async (flags) => {
      upgradeCalls.push(flags)
      return 0
    },
    runRestart: async (flags) => {
      restartCalls.push(flags)
      return 0
    },
    runLogs: async (flags) => {
      logsCalls.push(flags)
      return 0
    },
    runDown: async (flags) => {
      downCalls.push(flags)
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
  return {
    program,
    initCalls,
    configureCalls,
    upgradeCalls,
    restartCalls,
    logsCalls,
    downCalls,
    getSyncTokenCalls,
  }
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

describe("buildProgram configure", () => {
  it("passes --dir through to runConfigure", async () => {
    const { program, configureCalls } = buildCapturingProgram()

    await program.parseAsync(["configure", "--dir", "/opt/vault-cortex"], {
      from: "user",
    })

    expect(configureCalls).toEqual([{ dir: "/opt/vault-cortex" }])
  })

  it("invokes configure with no flags when none are given", async () => {
    const { program, configureCalls } = buildCapturingProgram()

    await program.parseAsync(["configure"], { from: "user" })

    expect(configureCalls).toEqual([{}])
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

describe("buildProgram restart", () => {
  it("passes --dir through to runRestart", async () => {
    const { program, restartCalls } = buildCapturingProgram()

    await program.parseAsync(["restart", "--dir", "/opt/vault-cortex"], {
      from: "user",
    })

    expect(restartCalls).toEqual([{ dir: "/opt/vault-cortex" }])
  })

  it("invokes restart with no flags when none are given", async () => {
    const { program, restartCalls } = buildCapturingProgram()

    await program.parseAsync(["restart"], { from: "user" })

    expect(restartCalls).toEqual([{}])
  })
})

describe("buildProgram logs", () => {
  it("passes all logs flags through to runLogs", async () => {
    const { program, logsCalls } = buildCapturingProgram()

    await program.parseAsync(
      ["logs", "--dir", "/opt/vault-cortex", "--follow", "--since", "10m"],
      { from: "user" },
    )

    expect(logsCalls).toEqual([
      { dir: "/opt/vault-cortex", follow: true, since: "10m" },
    ])
  })

  it("invokes logs with no flags when none are given", async () => {
    const { program, logsCalls } = buildCapturingProgram()

    await program.parseAsync(["logs"], { from: "user" })

    expect(logsCalls).toEqual([{}])
  })
})

describe("buildProgram down", () => {
  it("passes --dir through to runDown", async () => {
    const { program, downCalls } = buildCapturingProgram()

    await program.parseAsync(["down", "--dir", "/opt/vault-cortex"], {
      from: "user",
    })

    expect(downCalls).toEqual([{ dir: "/opt/vault-cortex" }])
  })

  it("invokes down with no flags when none are given", async () => {
    const { program, downCalls } = buildCapturingProgram()

    await program.parseAsync(["down"], { from: "user" })

    expect(downCalls).toEqual([{}])
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
