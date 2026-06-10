#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { createDockerRunner } from "./docker.js"
import { runInit } from "./init.js"
import { buildProgram } from "./program.js"
import { createPrompts } from "./prompts.js"

const { version } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string }

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
