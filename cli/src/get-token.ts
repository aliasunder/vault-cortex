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
 * Runs get-token inside a Docker container with a volume mount that
 * captures the auth token file. The interactive login (email, password,
 * MFA) still shows in the terminal — only the resulting token is
 * captured automatically.
 *
 * Returns the token string on success, undefined on any failure.
 */
export const captureObsidianToken = (deps: {
  docker: DockerRunner
  prompts: Prompts
}): string | undefined => {
  const { docker, prompts } = deps
  const configMountPath = mkdtempSync(join(tmpdir(), "vault-cortex-get-token-"))
  try {
    prompts.log(
      "Handing the terminal to get-token — it will ask for your Obsidian " +
        "account login and print a token at the end.",
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
    if (!existsSync(tokenPath)) return undefined
    const token = readFileSync(tokenPath, "utf8").trim()
    return token || undefined
  } finally {
    rmSync(configMountPath, { recursive: true, force: true })
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
