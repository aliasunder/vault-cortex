/**
 * Runs an SST command with ~/.config/vault-cortex/.env merged into its
 * environment. package.json starts this file with `node --import tsx`, not
 * the tsx CLI, so the wrapper stays a single Node process whose SIGINT
 * listener (below) decides when it exits.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { DEPLOYMENT_ENV_PATH, loadDeploymentEnv } from "./deployment-env.js"

type RunSstParams = {
  args: readonly string[]
  envFilePath?: string
}

const SST_START_FAILURE_MESSAGE = "✕ Could not start the local SST CLI."

const loadSstEnv = (envFilePath: string): NodeJS.ProcessEnv | null => {
  try {
    return loadDeploymentEnv({ envFilePath })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "could not load the deployment environment"
    console.error(`✕ ${message}`)
    return null
  }
}

export const runSst = ({ args, envFilePath = DEPLOYMENT_ENV_PATH }: RunSstParams): number => {
  const env = loadSstEnv(envFilePath)

  if (!env) return 1

  try {
    // A bare "sst" resolves to the repo's own SST install because npm puts
    // node_modules/.bin on PATH for package.json scripts.
    const result = spawnSync("sst", args, { env, stdio: "inherit" })

    // spawnSync reports a process that never started (no `sst` on PATH, for
    // example) in result.error instead of throwing.
    if (result.error) {
      console.error(SST_START_FAILURE_MESSAGE)
      return 1
    }

    // status is null when a signal ended SST; report that as a failure.
    return result.status ?? 1
  } catch {
    // spawnSync throws, rather than returning an error, for arguments it
    // rejects before starting a process.
    console.error(SST_START_FAILURE_MESSAGE)
    return 1
  }
}

// Importing runSst must not start SST, so the command runs only when this
// file is the entry script: argv[1] then resolves to this module's URL.
const entryPath = process.argv[1]
const isMainModule = entryPath ? pathToFileURL(resolve(entryPath)).href === import.meta.url : false

if (isMainModule) {
  // Ctrl-C already reaches SST through the terminal's process group. Handling
  // it here keeps the wrapper, and npm above it, running until SST shuts down.
  process.on("SIGINT", () => undefined)
  process.exitCode = runSst({ args: process.argv.slice(2) })
}
