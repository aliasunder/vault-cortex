import { createDockerRunner } from "./docker.js"
import { runGetSyncToken } from "./get-sync-token.js"
import { runInit } from "./init.js"
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
    runUpgrade: (flags) =>
      runUpgrade(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
    runGetSyncToken: (flags) =>
      runGetSyncToken(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
      }),
  })
  await program.parseAsync()
}
