import { runConfigure } from "./configure.js"
import { createDockerRunner } from "./docker.js"
import { runGetSyncToken } from "./get-sync-token.js"
import { runInit } from "./init.js"
import { runDown, runLogs, runRestart, runStart } from "./lifecycle.js"
import { buildProgram } from "./program.js"
import { createPrompts } from "./prompts.js"
import { runUpgrade } from "./upgrade.js"

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
        docker: createDockerRunner(),
      }),
  })
  await program.parseAsync()
}
