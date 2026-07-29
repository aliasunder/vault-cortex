import { Command } from "commander"

import type { GetSyncTokenFlags } from "./get-sync-token.js"
import type { InitFlags } from "./init.js"
import type { DownFlags, LogsFlags, RestartFlags } from "./lifecycle.js"
import type { UpgradeFlags } from "./upgrade.js"

export type ProgramOptions = {
  version: string
  runInit: (flags: InitFlags) => Promise<number>
  runUpgrade: (flags: UpgradeFlags) => Promise<number>
  runRestart: (flags: RestartFlags) => Promise<number>
  runLogs: (flags: LogsFlags) => Promise<number>
  runDown: (flags: DownFlags) => Promise<number>
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
    .command("restart")
    .description(
      "Re-create the container from .env and verify health (applies .env edits; no image pull)",
    )
    .option(
      "--dir <path>",
      "directory containing .env (default: ./vault-cortex)",
    )
    .action(async (flags: RestartFlags) => {
      process.exitCode = await options.runRestart(flags)
    })

  program
    .command("logs")
    .description("Show container logs")
    .option(
      "--dir <path>",
      "directory containing .env (default: ./vault-cortex)",
    )
    .option("--follow", "stream new log output until interrupted (ctrl-C)")
    .option(
      "--since <time>",
      'only logs newer than this (e.g. "10m", "2h", or a timestamp)',
    )
    .action(async (flags: LogsFlags) => {
      process.exitCode = await options.runLogs(flags)
    })

  program
    .command("down")
    .description(
      "Stop and remove the container — vault data and settings are preserved",
    )
    .option(
      "--dir <path>",
      "directory containing .env (default: ./vault-cortex)",
    )
    .action(async (flags: DownFlags) => {
      process.exitCode = await options.runDown(flags)
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
