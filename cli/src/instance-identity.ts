import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

import { instanceVolumeNames, type DockerRunner } from "./docker.js"
import {
  applyOptionalSettings,
  askPort,
  derivePublicUrlOverride,
  isValidPort,
  readOptionalValue,
} from "./optional-settings.js"
import { DEFAULT_INSTANCE_NAME, validateInstanceName, type Mode } from "./scaffold.js"
import type { Prompts } from "./prompts.js"

/** The .env values that tell one install on a machine apart from another. */
export type InstanceIdentity = {
  /** Copied verbatim from the folder's existing .env when init runs again over it. */
  carried: Record<string, string>
  /** Chosen in this run, by flag or prompt. A local PUBLIC_URL follows a chosen PORT. */
  chosen: Record<string, string>
}

export type InstanceIdentityFlags = {
  instanceName?: string
  port?: string
  yes?: boolean
}

type InstanceIdentityResult = { kind: "ok"; identity: InstanceIdentity } | { kind: "exit" }

/**
 * Identity lines an existing install keeps through a re-run of init. A local
 * PUBLIC_URL is the OAuth issuer and follows its port; a remote one is asked
 * again in the same run, so it is not carried.
 */
const CARRIED_SETTINGS: Readonly<Record<Mode, ReadonlyArray<string>>> = {
  local: ["INSTANCE_NAME", "PORT", "PUBLIC_URL"],
  remote: ["INSTANCE_NAME", "PORT", "DEVICE_NAME"],
}

const readCarriedIdentity = (envFilePath: string, mode: Mode): Record<string, string> => {
  const envContent = readFileSync(envFilePath, "utf8")
  const carriedEntries = CARRIED_SETTINGS[mode].flatMap((name) => {
    const currentValue = readOptionalValue(envContent, name)
    return currentValue ? [[name, currentValue] as const] : []
  })
  return Object.fromEntries(carriedEntries)
}

/**
 * Whether another install already uses this name on the machine: its
 * container exists, or one of its volumes does. A leftover volume counts,
 * because a new install with that name would mount the old data.
 */
const isInstanceNameInUse = (
  params: { mode: Mode; instanceName: string },
  docker: DockerRunner,
): boolean => {
  if (docker.containerExists(params.instanceName)) return true
  return instanceVolumeNames(params).some((volumeName) => docker.volumeExists(volumeName))
}

/** Re-prompts until the answer is a valid name no other install on the machine uses. */
const askFreeInstanceName = async (
  params: { mode: Mode; suggestedName: string | undefined },
  deps: { prompts: Prompts; docker: DockerRunner },
): Promise<string> => {
  const { mode, suggestedName } = params
  const { prompts, docker } = deps
  const answer = (
    await prompts.text("Name for this install (lowercase letters, digits, - and _):", {
      defaultValue: suggestedName,
      placeholder: suggestedName ?? "work",
    })
  ).trim()
  const invalidReason = validateInstanceName(answer)

  if (invalidReason) {
    prompts.error(invalidReason)
    return askFreeInstanceName(params, deps)
  }
  if (isInstanceNameInUse({ mode, instanceName: answer }, docker)) {
    prompts.error(`"${answer}" is also in use on this machine — pick another name.`)
    return askFreeInstanceName(params, deps)
  }
  return answer
}

/**
 * The target folder's name, offered as the new install's name when it is a
 * valid name nobody uses yet (a `--dir ./work` install suggests `work`).
 */
const suggestInstanceName = (
  params: { mode: Mode; targetDir: string },
  docker: DockerRunner,
): string | undefined => {
  const folderName = basename(params.targetDir).toLowerCase()

  if (validateInstanceName(folderName)) return undefined
  if (isInstanceNameInUse({ mode: params.mode, instanceName: folderName }, docker)) return undefined
  return folderName
}

const inUseOnYesMessage = (instanceName: string): string => {
  return (
    `An install named "${instanceName}" already exists on this machine (its container or data volumes are here).\n` +
    `Re-run with --instance-name <name> (and --port <port> if ${instanceName}'s port is taken) to give this install its own name,\n` +
    `or with --instance-name ${instanceName} to reuse that install's data for the same vault.`
  )
}

/**
 * Decides this install's name and port before init writes .env:
 * - a re-run over an existing .env keeps its name, port and URL (`carried`);
 * - --instance-name and --port set them directly;
 * - a new install whose name is already in use on the machine asks for its own
 *   name and port, or confirms reuse of the existing data for the same vault.
 *   --yes cannot ask, so it exits unless --instance-name settles it.
 * The check needs a running Docker daemon; without one it is skipped.
 */
export const resolveInstanceIdentity = async (
  params: { mode: Mode; targetDir: string; flags: InstanceIdentityFlags },
  deps: { prompts: Prompts; docker: DockerRunner },
): Promise<InstanceIdentityResult> => {
  const { mode, targetDir, flags } = params
  const { prompts, docker } = deps

  const flagNameError = flags.instanceName && validateInstanceName(flags.instanceName)

  if (flagNameError) {
    prompts.error(`--instance-name: ${flagNameError}`)
    return { kind: "exit" }
  }
  if (flags.port && !isValidPort(flags.port)) {
    prompts.error("--port must be a whole number between 1 and 65535.")
    return { kind: "exit" }
  }
  const flagOverrides = {
    ...(flags.instanceName ? { INSTANCE_NAME: flags.instanceName } : {}),
    ...(flags.port ? { PORT: flags.port } : {}),
  }

  const existingEnvPath = join(targetDir, ".env")

  if (existsSync(existingEnvPath)) {
    const carried = readCarriedIdentity(existingEnvPath, mode)
    return { kind: "ok", identity: { carried, chosen: flagOverrides } }
  }

  const requestedName = flags.instanceName ?? DEFAULT_INSTANCE_NAME
  const nameCheckPossible = docker.daemonStatus() === "running"

  if (!nameCheckPossible || !isInstanceNameInUse({ mode, instanceName: requestedName }, docker)) {
    return { kind: "ok", identity: { carried: {}, chosen: flagOverrides } }
  }
  if (flags.instanceName) {
    prompts.log(`Reusing the data of the existing "${requestedName}" install.`)
    return { kind: "ok", identity: { carried: {}, chosen: flagOverrides } }
  }
  if (flags.yes) {
    prompts.error(inUseOnYesMessage(requestedName))
    return { kind: "exit" }
  }

  const choice = await prompts.select(
    `An install named "${requestedName}" already exists on this machine (its container or data volumes are here). What should this install do?`,
    [
      {
        value: "own-name",
        label: "Give this install its own name",
        hint: "a second vault, with its own container, data and port",
      },
      {
        value: "reuse",
        label: "Reuse the existing data — this is the same vault set up again",
        hint: `replaces the "${requestedName}" container`,
      },
    ],
    "own-name",
  )

  if (choice === "reuse") {
    return { kind: "ok", identity: { carried: {}, chosen: flagOverrides } }
  }
  const suggestedName = suggestInstanceName({ mode, targetDir }, docker)
  const instanceName = await askFreeInstanceName({ mode, suggestedName }, deps)
  const port = await askPort(flags.port, prompts)
  // The device name labels this install's changes in Obsidian Sync's history,
  // so a second remote install is told apart from the first there too.
  const chosen = {
    INSTANCE_NAME: instanceName,
    PORT: port,
    ...(mode === "remote" ? { DEVICE_NAME: instanceName } : {}),
  }
  return { kind: "ok", identity: { carried: {}, chosen } }
}

/**
 * Writes the identity into freshly generated .env content, before the
 * optional-settings chooser reads it, so the chooser shows the identity's port
 * as current. Carried values land verbatim; chosen ones go through
 * derivePublicUrlOverride, so a local PUBLIC_URL follows a new port.
 */
export const applyInstanceIdentity = (envContent: string, identity: InstanceIdentity): string => {
  const withCarried = applyOptionalSettings(envContent, identity.carried)
  return applyOptionalSettings(withCarried, derivePublicUrlOverride(withCarried, identity.chosen))
}
