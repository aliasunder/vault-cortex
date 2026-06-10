import { Command } from "commander"

import type { InitFlags } from "./init.js"

export type ProgramOptions = {
  version: string
  runInit: (flags: InitFlags) => Promise<number>
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
    .description(
      "Scaffold docker-compose.yml + .env and optionally start the server",
    )
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

  // Bare `npx vault-cortex` shows help instead of a "missing command" error.
  program.action(() => {
    program.help()
  })

  return program
}
