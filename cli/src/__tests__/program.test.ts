import { describe, expect, it } from "vitest"

import { buildProgram } from "../program.js"
import type { InitFlags } from "../init.js"

const buildCapturingProgram = () => {
  const calls: InitFlags[] = []
  const program = buildProgram({
    version: "0.0.0-test",
    runInit: async (flags) => {
      calls.push(flags)
      return 0
    },
  })
  // Throw instead of process.exit, and swallow help/error output.
  // Subcommands don't inherit these settings, so apply to each explicitly.
  for (const command of [program, ...program.commands]) {
    command.exitOverride()
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} })
  }
  return { program, calls }
}

describe("buildProgram", () => {
  it("passes all init flags through to runInit", async () => {
    const { program, calls } = buildCapturingProgram()

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

    expect(calls).toEqual([
      { mode: "remote", vaultPath: "/vaults/Mine", dir: "./out", yes: true },
    ])
  })

  it("invokes init with no flags when none are given", async () => {
    const { program, calls } = buildCapturingProgram()

    await program.parseAsync(["init"], { from: "user" })

    expect(calls).toEqual([{}])
  })

  it("rejects unknown options instead of passing them through", async () => {
    const { program, calls } = buildCapturingProgram()

    await expect(
      program.parseAsync(["init", "--bogus"], { from: "user" }),
    ).rejects.toThrow("unknown option '--bogus'")
    expect(calls).toEqual([])
  })

  it("reports the package version via --version", async () => {
    const { program } = buildCapturingProgram()

    await expect(
      program.parseAsync(["--version"], { from: "user" }),
    ).rejects.toThrow("0.0.0-test")
  })
})
