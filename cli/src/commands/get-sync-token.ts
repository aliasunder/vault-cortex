import { join } from "node:path"

import { envFile } from "../adapters/env-file.js"
import type { Prompts } from "../adapters/prompts.js"
import { applyOptionalSettings } from "../rules/env-edits.js"
import { parseEnvValues } from "../rules/env-values.js"
import { startServerLine } from "../rules/messages.js"
import { describeInstallFolderProblem, resolveTargetDir } from "../steps/deployment.js"
import { captureObsidianToken } from "../steps/obsidian-sign-in.js"

export type GetSyncTokenFlags = {
  dir?: string
}

export type GetSyncTokenDeps = {
  prompts: Prompts
  fetchFn: typeof fetch
}

const TOKEN_CAPTURE_FAILED = "Could not capture the auth token."

/**
 * True for the text of a remote install's .env. A local-mode .env has no
 * OBSIDIAN_AUTH_TOKEN line, and the token belongs only in a remote install's .env.
 */
const holdsTokenLine = (envContent: string | undefined): envContent is string => {
  return envContent !== undefined && parseEnvValues(envContent).has("OBSIDIAN_AUTH_TOKEN")
}

/**
 * Why --dir's .env cannot take the token: it is missing, or it belongs to a
 * local install, which has no OBSIDIAN_AUTH_TOKEN line and never needs one.
 */
const describeMissingTokenLine = (params: {
  envFilePath: string
  envContent: string | undefined
}): string => {
  const { envFilePath, envContent } = params

  if (envContent === undefined) {
    return `Could not patch ${envFilePath} — the file is missing. Run init first.`
  }
  return (
    `Could not patch ${envFilePath} — it holds a local install, which has no ` +
    "OBSIDIAN_AUTH_TOKEN line. --dir writes the token into a remote install's .env."
  )
}

const printSyncToken = async (deps: GetSyncTokenDeps): Promise<number> => {
  const { prompts } = deps
  const token = await captureObsidianToken(deps)

  if (!token) {
    prompts.error(TOKEN_CAPTURE_FAILED)
    return 1
  }
  prompts.log("Your OBSIDIAN_AUTH_TOKEN:")
  prompts.print(`\n  ${token}\n`)
  prompts.outro("Done.")
  return 0
}

/**
 * Signs in and writes the token into targetDir's .env. The folder and its
 * .env are checked before the sign-in, so a refusal does not waste a captured
 * token, and the .env is read again afterwards in case it changed meanwhile.
 */
const writeSyncToken = async (targetDir: string, deps: GetSyncTokenDeps): Promise<number> => {
  const { prompts } = deps
  const envFilePath = join(targetDir, ".env")
  const installFolderProblem = describeInstallFolderProblem(targetDir)

  if (installFolderProblem) {
    prompts.error(installFolderProblem)
    return 1
  }
  const envContentBeforeSignIn = envFile.read(envFilePath)
  const targetDirProblem = holdsTokenLine(envContentBeforeSignIn)
    ? undefined
    : describeMissingTokenLine({ envFilePath, envContent: envContentBeforeSignIn })

  if (targetDirProblem) {
    prompts.error(targetDirProblem)
    return 1
  }
  const token = await captureObsidianToken(deps)

  if (!token) {
    prompts.error(TOKEN_CAPTURE_FAILED)
    return 1
  }
  const envContent = envFile.read(envFilePath)

  if (!holdsTokenLine(envContent)) {
    prompts.error(describeMissingTokenLine({ envFilePath, envContent }))
    return 1
  }
  envFile.replace(envFilePath, applyOptionalSettings(envContent, { OBSIDIAN_AUTH_TOKEN: token }))
  prompts.log(`Token written to ${envFilePath}\n\n${startServerLine(targetDir)}`)
  prompts.outro("Done.")
  return 0
}

/**
 * Generates an Obsidian Sync token through the Obsidian API. Without --dir it
 * prints the token; with --dir it writes the token to `<dir>/.env`.
 */
export const runGetSyncToken = async (
  flags: GetSyncTokenFlags,
  deps: GetSyncTokenDeps,
): Promise<number> => {
  deps.prompts.intro("vault-cortex get-sync-token")

  if (!flags.dir) return printSyncToken(deps)
  return writeSyncToken(resolveTargetDir(flags.dir), deps)
}
