import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { DockerRunner } from "./docker.js"
import type { Prompts } from "./prompts.js"
import { patchEnvObsidianToken } from "./scaffold.js"
import { expandTilde } from "./vault.js"

export type GetSyncTokenFlags = {
  dir?: string
}

export type GetSyncTokenDeps = {
  prompts: Prompts
  docker: DockerRunner
}

/** Message from an unknown throw — Error instances keep their message. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Creates the temp dir the container's config mount writes into.
 * Returns undefined (after warning) when creation fails.
 */
const makeTempMountDir = (prompts: Prompts): string | undefined => {
  try {
    return mkdtempSync(join(tmpdir(), "vault-cortex-sync-token-"))
  } catch (error) {
    prompts.warn(
      `Could not create a temp directory for token capture — ${describeError(error)}`,
    )
    return undefined
  }
}

/**
 * Runs the interactive Obsidian login container. A throw from the Docker
 * runner is reported and treated the same as a non-zero exit.
 */
const runLoginContainer = (
  configMountPath: string,
  deps: GetSyncTokenDeps,
): boolean => {
  const { docker, prompts } = deps
  try {
    return docker.runObsidianLogin(configMountPath)
  } catch (error) {
    prompts.warn(`Docker run failed — ${describeError(error)}`)
    return false
  }
}

/**
 * Reads the captured token file from the config mount. Returns undefined
 * when the file is missing, empty, or unreadable — the caller treats all
 * three as "no token captured".
 */
const readCapturedTokenFile = (configMountPath: string): string | undefined => {
  const tokenPath = join(configMountPath, "obsidian-headless", "auth_token")
  try {
    if (!existsSync(tokenPath)) return undefined
    const token = readFileSync(tokenPath, "utf8").trim()
    return token || undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort removal of the temp mount dir. Failing to remove it (e.g.
 * root-owned files left by the container) must not turn a successful
 * capture into a failure, so it warns instead of throwing.
 */
const removeTempMountDir = (
  configMountPath: string,
  prompts: Prompts,
): void => {
  try {
    rmSync(configMountPath, { recursive: true, force: true })
  } catch (error) {
    prompts.warn(
      `Could not remove temp directory ${configMountPath} — ${describeError(error)}`,
    )
  }
}

/**
 * Runs the Obsidian login (`ob login`) inside a Docker container with a
 * volume mount that captures the auth token file. The interactive login
 * (email, password, MFA) shows in the terminal, but the resulting token is
 * read from the mounted config dir — never printed, so it stays out of
 * terminal scrollback.
 *
 * tokenDestinationMessage finishes the handoff message by telling the user
 * where the captured token ends up — the destination differs per flow
 * (init stores it in the generated .env; the subcommand prints it, or
 * writes it to an existing .env with --dir).
 *
 * Returns the token string on success, undefined on any failure — each
 * fallible operation is wrapped individually by the helpers above, so no
 * catch-all is needed here. The bare try/finally only scopes the temp dir
 * (acquire → release); it has no catch and swallows nothing.
 */
export const captureObsidianToken = (
  deps: GetSyncTokenDeps,
  tokenDestinationMessage: string,
): string | undefined => {
  const { prompts } = deps
  const configMountPath = makeTempMountDir(prompts)
  if (!configMountPath) return undefined

  try {
    prompts.log(
      "Handing the terminal to the Obsidian login — it will ask for your " +
        `account email, password, and MFA code. ${tokenDestinationMessage}`,
    )
    const loginSucceeded = runLoginContainer(configMountPath, deps)
    if (!loginSucceeded) {
      prompts.warn(
        "The Obsidian login did not complete — you can run it later with:\n" +
          "  npx vault-cortex get-sync-token",
      )
      return undefined
    }
    const token = readCapturedTokenFile(configMountPath)
    if (!token) {
      prompts.warn(
        "The Obsidian login finished, but no token was captured — the " +
          "token file was missing, empty, or unreadable. You can retry with:\n" +
          "  npx vault-cortex get-sync-token",
      )
      return undefined
    }
    return token
  } finally {
    removeTempMountDir(configMountPath, prompts)
  }
}

/**
 * Subcommand entry: generate an Obsidian Sync token via Docker.
 * Without --dir, prints the token to stdout.
 * With --dir, writes it directly to `<dir>/.env`.
 */
export const runGetSyncToken = async (
  flags: GetSyncTokenFlags,
  deps: GetSyncTokenDeps,
): Promise<number> => {
  const { prompts, docker } = deps

  if (!docker.isDaemonRunning()) {
    prompts.error(
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime and try again.",
    )
    return 1
  }

  prompts.intro("vault-cortex get-sync-token")

  // Resolve the destination up front so the login handoff message can tell
  // the user where the token will end up.
  const envFilePath = flags.dir
    ? join(resolve(expandTilde(flags.dir)), ".env")
    : undefined
  const tokenDestinationMessage = envFilePath
    ? `The token is captured automatically and written to ${envFilePath}.`
    : "The token is captured automatically and printed at the end."

  const token = captureObsidianToken(
    { docker, prompts },
    tokenDestinationMessage,
  )
  if (!token) {
    prompts.error("Could not capture the auth token.")
    return 1
  }

  if (!envFilePath) {
    prompts.log("Your OBSIDIAN_AUTH_TOKEN:")
    prompts.print(`\n  ${token}\n`)
    prompts.outro("Done.")
    return 0
  }

  const patched = patchEnvObsidianToken(envFilePath, token)
  if (!patched) {
    prompts.error(
      `Could not patch ${envFilePath} — the file is missing or has no ` +
        "OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
    return 1
  }
  prompts.log(`Token written to ${envFilePath}`)
  prompts.outro("Done.")
  return 0
}
