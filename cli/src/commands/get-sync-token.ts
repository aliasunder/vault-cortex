import { join, resolve } from "node:path"

import { envFile } from "../adapters/env-file.js"
import type { Prompts } from "../adapters/prompts.js"
import { expandTilde } from "../adapters/vault.js"
import { applyOptionalSettings } from "../rules/env-edits.js"
import { parseEnvValues } from "../rules/env-values.js"
import { vaultCortexCommand } from "../rules/messages.js"
import { captureObsidianToken } from "../steps/obsidian-sign-in.js"

export type GetSyncTokenFlags = {
  dir?: string
}

export type GetSyncTokenDeps = {
  prompts: Prompts
  fetchFn: typeof fetch
}

/**
 * Generates an Obsidian Sync token through the Obsidian API. Without --dir it
 * prints the token; with --dir it writes the token to `<dir>/.env`.
 */
export const runGetSyncToken = async (
  flags: GetSyncTokenFlags,
  deps: GetSyncTokenDeps,
): Promise<number> => {
  const { prompts } = deps

  prompts.intro("vault-cortex get-sync-token")

  const token = await captureObsidianToken(deps)

  if (!token) {
    prompts.error("Could not capture the auth token.")
    return 1
  }

  const envFilePath = flags.dir ? join(resolve(expandTilde(flags.dir)), ".env") : undefined

  if (!envFilePath) {
    prompts.log("Your OBSIDIAN_AUTH_TOKEN:")
    prompts.print(`\n  ${token}\n`)
    prompts.outro("Done.")
    return 0
  }

  const envContent = envFile.read(envFilePath)

  // A local-mode .env has no OBSIDIAN_AUTH_TOKEN line, and the token belongs
  // only in a remote install's .env.
  if (!envContent || !parseEnvValues(envContent).has("OBSIDIAN_AUTH_TOKEN")) {
    prompts.error(
      `Could not patch ${envFilePath} — the file is missing or has no ` +
        "OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
    return 1
  }
  envFile.replace(envFilePath, applyOptionalSettings(envContent, { OBSIDIAN_AUTH_TOKEN: token }))
  prompts.log(
    `Token written to ${envFilePath}\n\n` +
      `Start the server:\n  ${vaultCortexCommand("start", flags.dir)}`,
  )
  prompts.outro("Done.")
  return 0
}
