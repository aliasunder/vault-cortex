import { createDockerRunner } from "./docker.js"
import { runGetToken } from "./get-token.js"
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
    runGetToken: (flags) =>
      runGetToken(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
      }),
  })
  await program.parseAsync()
}
