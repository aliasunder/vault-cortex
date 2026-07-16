import { Command } from "commander"

import type { GetSyncTokenFlags } from "./get-sync-token.js"
import type { InitFlags } from "./init.js"
import type { UpgradeFlags } from "./upgrade.js"

export type ProgramOptions = {
  version: string
  runInit: (flags: InitFlags) => Promise<number>
  runUpgrade: (flags: UpgradeFlags) => Promise<number>
  runGetSyncToken: (flags: GetSyncTokenFlags) => Promise<number>
}

export const buildProgram = (options: ProgramOptions): Command => {
  const program = new Command()

  program
    .name("vault-cortex")
    .description(
      "Set up a Vault Cortex MCP server for your Obsidian vault.\nRun `vault-cortex init` to get started.",
    )
    .version(options.version)

  program
    .command("init")
    .description("Scaffold .env and optionally start the server")
    .option("--mode <mode>", 'deployment mode: "local" (default) or "remote"')
    .option(
      "--vault-path <path>",
      "absolute path to your Obsidian vault (local mode)",
    )
    .option(
      "--dir <path>",
      "directory to write config files into (default: ./vault-cortex)",
    )
    .option(
      "--yes",
      "non-interactive local setup with defaults; requires --vault-path",
    )
    .action(async (flags: InitFlags) => {
      process.exitCode = await options.runInit(flags)
    })

  program
    .command("upgrade")
    .description(
      "Pull the latest image, re-create the container, and verify health",
    )
    .option(
      "--dir <path>",
      "directory containing .env (default: ./vault-cortex)",
    )
    .action(async (flags: UpgradeFlags) => {
      process.exitCode = await options.runUpgrade(flags)
    })

  program
    .command("get-sync-token")
    .description(
      "Generate an Obsidian Sync auth token via Docker and print it or write it to .env",
    )
    .option(
      "--dir <path>",
      "directory containing .env to update with the token",
    )
    .action(async (flags: GetSyncTokenFlags) => {
      process.exitCode = await options.runGetSyncToken(flags)
    })

  program.action(() => {
    program.help()
  })

  return program
}
