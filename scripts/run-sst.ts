import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { DEPLOYMENT_ENV_PATH, loadDeploymentEnv } from "./deployment-env.js"

type RunSstParams = {
  args: readonly string[]
  envFilePath?: string
}

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
    const result = spawnSync("sst", [...args], { env, stdio: "inherit" })

    if (result.error) {
      console.error("✕ Could not start the local SST CLI.")
      return 1
    }

    return result.status ?? 1
  } catch {
    console.error("✕ Could not start the local SST CLI.")
    return 1
  }
}

const entryPath = process.argv[1]
const isMainModule = entryPath ? pathToFileURL(resolve(entryPath)).href === import.meta.url : false

if (isMainModule) {
  // Ctrl-C already reaches SST through the terminal's process group. Handling
  // it here keeps the wrapper, and npm above it, running until SST shuts down.
  process.on("SIGINT", () => undefined)
  process.exitCode = runSst({ args: process.argv.slice(2) })
}
