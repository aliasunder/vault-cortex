import { createDockerRunner } from "./docker.js"
import { runInit } from "./init.js"
import { buildProgram } from "./program.js"
import { createPrompts } from "./prompts.js"

export const run = async (version: string): Promise<void> => {
  const program = buildProgram({
    version,
    runInit: (flags) =>
      runInit(flags, {
        prompts: createPrompts(),
        docker: createDockerRunner(),
        fetchFn: fetch,
      }),
  })
  await program.parseAsync()
}
