/**
 * Runs an SST command with ~/.config/vault-cortex/.env merged into its
 * environment. package.json starts this file with `node --import tsx`, not
 * the tsx CLI, so the wrapper stays a single Node process whose SIGINT
 * listener (below) decides when it exits.
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"

import { DEPLOYMENT_ENV_PATH, loadDeploymentEnv } from "./deployment-env.js"

type RunSstParams = {
  args: readonly string[]
  envFilePath?: string
}

const SST_START_FAILURE_MESSAGE = "✕ Could not start the local SST CLI."

const sstPackageJsonSchema = z.object({ bin: z.object({ sst: z.string() }) })

const readJsonOrNull = (filePath: string): unknown => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    // The caller treats a missing or malformed package.json as a broken SST
    // install and reports that SST could not start.
    return null
  }
}

/**
 * Returns the Node script that SST's package.json declares as its `sst`
 * command. Running that script with this Node binary needs no shell, so it
 * works on Windows, where npm's `sst` shim is a .cmd file that Node cannot
 * start without one.
 */
const findSstPackageJsonOrNull = (): string | null => {
  try {
    // Resolves the package directory directly, because SST's exports map
    // hides bin/ from require.resolve.
    return findPackageJSON("sst", import.meta.url) ?? null
  } catch {
    // findPackageJSON throws ERR_MODULE_NOT_FOUND when sst isn't installed;
    // the caller reports that SST could not start.
    return null
  }
}

const resolveSstLauncherPath = (): string | null => {
  const packageJsonPath = findSstPackageJsonOrNull()

  if (!packageJsonPath) return null

  const packageJson = readJsonOrNull(packageJsonPath)
  const parsedPackageJson = sstPackageJsonSchema.safeParse(packageJson)

  if (!parsedPackageJson.success) return null

  return resolve(dirname(packageJsonPath), parsedPackageJson.data.bin.sst)
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

  const sstLauncherPath = resolveSstLauncherPath()

  if (!sstLauncherPath) {
    console.error(SST_START_FAILURE_MESSAGE)
    return 1
  }

  try {
    const result = spawnSync(process.execPath, [sstLauncherPath, ...args], {
      env,
      stdio: "inherit",
    })

    // spawnSync reports a process that never started in result.error
    // instead of throwing.
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
