import { join, resolve } from "node:path"

import type { DockerRunner, Mode } from "../adapters/docker.js"
import { envFile } from "../adapters/env-file.js"
import type { Prompts } from "../adapters/prompts.js"
import { expandTilde } from "../adapters/vault.js"
import {
  detectMode,
  parseEnvValues,
  readEnvInstanceName,
  readEnvPort,
  readEnvPublicUrl,
  readEnvVaultPath,
  type EnvValues,
} from "../rules/env-values.js"
import {
  buildDaemonUnavailableMessage,
  describeEnvFix,
  vaultCortexCommand,
} from "../rules/messages.js"

/** An init'd deployment on disk, reconstructed from its .env file. */
export type Deployment = {
  mode: Mode
  /** The .env's INSTANCE_NAME: the container this deployment owns and its volume prefix. */
  instanceName: string
  targetDir: string
  envFilePath: string
  port: number
  /** Present only in local mode. */
  vaultPath?: string
  publicUrl: string
}

/** Where init puts an install, and where every other command looks for one, without --dir. */
export const DEFAULT_TARGET_DIR = "./vault-cortex"

type InitializedDir = {
  targetDir: string
  envFilePath: string
  /** The .env's values, parsed once for every check that follows. */
  envValues: EnvValues
  mode: Mode
  instanceName: string
}

/**
 * Light gate for commands that use an existing deployment without starting a container:
 * - resolves --dir and confirms an init'd .env exists;
 * - reads INSTANCE_NAME, so an invalid name stops every command before it touches Docker.
 * Full start-readiness validation lives in resolveDeployment.
 */
export const requireInitializedDir = (
  dirFlag: string | undefined,
  prompts: Prompts,
): InitializedDir | undefined => {
  const targetDir = resolve(expandTilde(dirFlag ?? DEFAULT_TARGET_DIR))
  const envFilePath = join(targetDir, ".env")
  const envContent = envFile.read(envFilePath)

  // Only a missing file stops here: an empty .env reads as a local install.
  if (envContent === undefined) {
    prompts.error(`No .env found in ${targetDir} — run \`${vaultCortexCommand("init")}\` first.`)
    return undefined
  }
  const envValues = parseEnvValues(envContent)
  const instanceNameRead = readEnvInstanceName(envValues)

  if (instanceNameRead.kind === "invalid") {
    prompts.error(describeEnvFix({ problem: instanceNameRead.message, targetDir }))
    return undefined
  }
  return {
    targetDir,
    envFilePath,
    envValues,
    mode: detectMode(envValues),
    instanceName: instanceNameRead.instanceName,
  }
}

/** A local PUBLIC_URL is this machine's own address; a remote one is the user's domain. */
const missingPublicUrlFix = (mode: Mode, port: number): string => {
  if (mode === "local") return `Set this line in your .env:\n  PUBLIC_URL=http://localhost:${port}`
  return "Set it to the address your MCP clients reach this server at, for example:\n  PUBLIC_URL=https://vault.example.com"
}

/**
 * Resolves --dir to the on-disk deployment and validates its .env for a
 * container start: mode detection, PORT, VAULT_PATH (local), and PUBLIC_URL.
 * Reports each failure via prompts.error and returns undefined.
 * Shared by init, start, restart, upgrade and configure so their precondition checks can't drift.
 */
export const resolveDeployment = (
  dirFlag: string | undefined,
  prompts: Prompts,
): Deployment | undefined => {
  const initialized = requireInitializedDir(dirFlag, prompts)

  if (!initialized) return undefined
  const { targetDir, envFilePath, envValues, mode, instanceName } = initialized

  const portRead = readEnvPort(envValues)

  if (portRead.kind === "invalid") {
    prompts.error(describeEnvFix({ problem: portRead.message, targetDir }))
    return undefined
  }
  const { port } = portRead
  const vaultPath = mode === "local" ? readEnvVaultPath(envValues) : undefined

  if (mode === "local" && !vaultPath) {
    prompts.error(
      `VAULT_PATH is empty or missing in ${targetDir}/.env — cannot start the container.`,
    )
    return undefined
  }
  const publicUrl = readEnvPublicUrl(envValues)

  if (!publicUrl) {
    prompts.error(
      `PUBLIC_URL is empty or missing in ${targetDir}/.env — the server requires it.\n` +
        missingPublicUrlFix(mode, port),
    )
    return undefined
  }
  return { mode, instanceName, targetDir, envFilePath, port, vaultPath, publicUrl }
}

/**
 * Verifies the container runtime is reachable, reporting the shared error
 * message when it isn't. Callers early-return on false.
 */
export const ensureDaemonRunning = (docker: DockerRunner, prompts: Prompts): boolean => {
  const daemonStatus = docker.daemonStatus()

  if (daemonStatus === "running") return true
  prompts.error(buildDaemonUnavailableMessage({ daemonStatus }))
  return false
}
