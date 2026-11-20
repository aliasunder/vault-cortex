import { createDockerRunner } from "./adapters/docker.js"
import { createPrompts } from "./adapters/prompts.js"
import { runConfigure } from "./commands/configure.js"
import { runGetSyncToken } from "./commands/get-sync-token.js"
import { runInit } from "./commands/init.js"
import { runDown, runLogs, runRestart, runStart } from "./commands/lifecycle.js"
import { runUpgrade } from "./commands/upgrade.js"
import { buildProgram } from "./program.js"

export const run = async (version: string): Promise<void> => {
  const program = buildProgram({
    version,
    runInit: (flags) =>
      runInit(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
    runConfigure: (flags) =>
      runConfigure(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
    runUpgrade: (flags) =>
      runUpgrade(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
    runStart: (flags) =>
      runStart(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
    runRestart: (flags) =>
      runRestart(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
    runLogs: (flags) =>
      runLogs(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
      }),
    runDown: (flags) =>
      runDown(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
      }),
    runGetSyncToken: (flags) =>
      runGetSyncToken(flags, {
        prompts: createPrompts(),
        fetchFn: fetch,
      }),
  })
  await program.parseAsync()
}
