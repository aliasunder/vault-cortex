import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { DockerRunner } from "./docker.js"
import type { Prompts } from "./prompts.js"
import { patchEnvObsidianToken } from "./scaffold.js"
import { expandTilde } from "./vault.js"

export type GetTokenFlags = {
  dir?: string
}

export type GetTokenDeps = {
  prompts: Prompts
  docker: DockerRunner
}

/**
 * Runs the Obsidian login (`ob login`) inside a Docker container with a
 * volume mount that captures the auth token file. The interactive login
 * (email, password, MFA) shows in the terminal, but the resulting token is
 * read from the mounted config dir — never printed, so it stays out of
 * terminal scrollback.
 *
 * Returns the token string on success, undefined on any failure.
 */
export const captureObsidianToken = (
  deps: GetTokenDeps,
): string | undefined => {
  const { docker, prompts } = deps
  // let: assigned inside the try so the finally can clean up the temp dir on
  // every path, while staying undefined when mkdtemp itself is what threw.
  let configMountPath: string | undefined
  try {
    configMountPath = mkdtempSync(join(tmpdir(), "vault-cortex-get-token-"))
    prompts.log(
      "Handing the terminal to the Obsidian login — it will ask for your " +
        "account email, password, and MFA code. The token is captured " +
        "automatically, so there's nothing to copy.",
    )
    const succeeded = docker.runGetTokenWithMount(configMountPath)
    if (!succeeded) {
      prompts.warn(
        "get-token did not complete — you can run it later with:\n" +
          "  npx vault-cortex get-token",
      )
      return undefined
    }
    const tokenPath = join(configMountPath, "obsidian-headless", "auth_token")
    const token = existsSync(tokenPath)
      ? readFileSync(tokenPath, "utf8").trim()
      : ""
    if (!token) {
      prompts.warn(
        "get-token completed but no token was captured — the token file " +
          "was missing or empty. You can retry with:\n" +
          "  npx vault-cortex get-token",
      )
      return undefined
    }
    return token
  } catch (error) {
    prompts.warn(
      `Token capture failed — ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  } finally {
    // Best-effort cleanup: failing to remove the temp dir (e.g. root-owned
    // files left by the container) must not turn a successful capture into
    // a failure, so it only warns.
    if (configMountPath) {
      try {
        rmSync(configMountPath, { recursive: true, force: true })
      } catch {
        prompts.warn(`Could not remove temp directory: ${configMountPath}`)
      }
    }
  }
}

/**
 * Subcommand entry: generate an Obsidian Sync token via Docker.
 * Without --dir, prints the token to stdout.
 * With --dir, writes it directly to `<dir>/.env`.
 */
export const runGetToken = async (
  flags: GetTokenFlags,
  deps: GetTokenDeps,
): Promise<number> => {
  const { prompts, docker } = deps

  if (!docker.isDaemonRunning()) {
    prompts.error(
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime and try again.",
    )
    return 1
  }

  prompts.intro("vault-cortex get-token")

  const token = captureObsidianToken({ docker, prompts })
  if (!token) {
    prompts.error("Could not capture the auth token.")
    return 1
  }

  if (!flags.dir) {
    prompts.log("Your OBSIDIAN_AUTH_TOKEN:")
    prompts.print(`\n  ${token}\n`)
    prompts.outro("Done.")
    return 0
  }

  const targetDir = resolve(expandTilde(flags.dir))
  const envFilePath = join(targetDir, ".env")
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
