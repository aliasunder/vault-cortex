import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

import { instanceVolumeNames, type DockerRunner } from "./docker.js"
import {
  applyOptionalSettings,
  askFreePort,
  describeStrandedPublicUrl,
  portInUseMessage,
  portsOfOtherContainers,
  readOptionalValue,
  suggestFreePort,
  withPublicUrlOverride,
  type PortsInUse,
} from "./optional-settings.js"
import {
  DEFAULT_INSTANCE_NAME,
  DEFAULT_PORT,
  describeInvalidEnvPort,
  describeInvalidInstanceName,
  isValidPort,
  type Mode,
} from "./scaffold.js"
import type { Prompts } from "./prompts.js"

/** The .env values that tell one install on a machine apart from another. */
export type InstanceIdentity = {
  /**
   * Read from the folder's existing .env, without surrounding quotes, when
   * init runs again over it.
   */
  carried: Record<string, string>
  /**
   * Chosen in this run, by flag or prompt. A `http://localhost:<port>`
   * PUBLIC_URL follows a chosen PORT.
   */
  chosen: Record<string, string>
}

export type InstanceIdentityFlags = {
  instanceName?: string
  port?: string
  yes?: boolean
}

type InstanceIdentityResult =
  | {
      kind: "ok"
      identity: InstanceIdentity
      /** Ports other containers publish, which the optional settings' port prompt refuses. */
      portsInUse: PortsInUse
    }
  | { kind: "exit" }

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

const EXAMPLE_INSTANCE_NAME = "work"

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
      placeholder: suggestedName ?? EXAMPLE_INSTANCE_NAME,
    })
  ).trim()
  const invalidReason = describeInvalidInstanceName(answer)

  if (invalidReason) {
    prompts.error(invalidReason)
    return askFreeInstanceName(params, deps)
  }
  if (isInstanceNameInUse({ mode, instanceName: answer }, docker)) {
    prompts.error(`"${answer}" is already in use on this machine — pick another name.`)
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

  if (describeInvalidInstanceName(folderName)) return undefined
  if (isInstanceNameInUse({ mode: params.mode, instanceName: folderName }, docker)) return undefined
  return folderName
}

/** Labels a new remote install's changes in its vault's sync log with the install's name. */
const buildDeviceNameSetting = (mode: Mode, instanceName: string): Record<string, string> => {
  return mode === "remote" ? { DEVICE_NAME: instanceName } : {}
}

const renameOnRerunMessage = (params: { carriedName: string; targetDir: string }): string => {
  const { carriedName, targetDir } = params
  return (
    `--instance-name: the install in ${targetDir} is named "${carriedName}", and init keeps that name.\n` +
    `To rename it, stop it first (npx vault-cortex@latest down --dir "${targetDir}"), then change INSTANCE_NAME in its .env\n` +
    `to a name no other install uses: it starts on new, empty volumes under the new name.`
  )
}

// The message offers no "run init again" fix: once this run writes .env, a
// re-run keeps its name and skips the check.
const nameCheckSkippedMessage = (instanceName: string): string => {
  return (
    `Docker isn't running, so init can't check whether another install on this machine already uses the name "${instanceName}".\n` +
    `If one does, give this install its own INSTANCE_NAME and PORT in its .env before you start it.`
  )
}

type PortSettingResult = { kind: "ok"; settings: Record<string, string> } | { kind: "exit" }

/**
 * Checks the port the install will publish (--port, or the default) against
 * the ports other containers publish: a taken port stops --yes, and is asked
 * again otherwise.
 */
const checkRequestedPort = async (
  params: { flags: InstanceIdentityFlags; portsInUse: PortsInUse },
  prompts: Prompts,
): Promise<PortSettingResult> => {
  const { flags, portsInUse } = params
  const requestedPort = flags.port ?? String(DEFAULT_PORT)
  const portUser = portsInUse.get(Number(requestedPort))

  if (!portUser) return { kind: "ok", settings: flags.port ? { PORT: flags.port } : {} }
  const message = portInUseMessage(requestedPort, portUser)

  if (flags.yes) {
    prompts.error(`${message} Re-run with --port and a free port.`)
    return { kind: "exit" }
  }
  prompts.warn(message)
  const port = await askFreePort(
    { suggestedPort: suggestFreePort(portsInUse), portsInUse },
    prompts,
  )
  return { kind: "ok", settings: { PORT: port } }
}

/**
 * A reused install's .env is in another folder, so its port is asked for
 * rather than assumed to be the default; --yes cannot ask and keeps --port
 * or the default.
 */
const askReusedPort = async (
  params: { flags: InstanceIdentityFlags; portsInUse: PortsInUse },
  prompts: Prompts,
): Promise<PortSettingResult> => {
  const { flags, portsInUse } = params

  if (flags.port || flags.yes) return checkRequestedPort(params, prompts)
  const port = await askFreePort(
    { suggestedPort: suggestFreePort(portsInUse), portsInUse },
    prompts,
  )
  return { kind: "ok", settings: { PORT: port } }
}

const nameInUseWithYesFlagMessage = (instanceName: string): string => {
  return (
    `An install named "${instanceName}" already exists on this machine (its container or data volumes are here).\n` +
    `Re-run with --instance-name <name> (and --port <port> if ${instanceName}'s port is taken) to give this install its own name,\n` +
    `or with --instance-name ${instanceName} (and --port <port> unless that install uses ${DEFAULT_PORT}) to reuse its data for the same vault.`
  )
}

/**
 * Decides this install's name and port before init writes .env:
 * - a re-run over an existing .env keeps its name and port, plus a local
 *   PUBLIC_URL or a remote DEVICE_NAME (`carried`), and exits when the name
 *   or port is invalid (--port replaces the port) or --instance-name gives a
 *   different name;
 * - --instance-name and --port set them directly;
 * - a new install whose name is already in use on the machine asks for its own
 *   name and port, or confirms reuse of the existing data for the same vault.
 *   --yes cannot ask, so it exits unless --instance-name settles it;
 * - a new install's port, and a re-run's --port, must not be one another
 *   container publishes.
 * The checks need a running Docker daemon; without one a new install's are
 * skipped with a warning, and a re-run's --port is not checked.
 */
export const resolveInstanceIdentity = async (
  params: { mode: Mode; targetDir: string; flags: InstanceIdentityFlags },
  deps: { prompts: Prompts; docker: DockerRunner },
): Promise<InstanceIdentityResult> => {
  const { mode, targetDir, flags } = params
  const { prompts, docker } = deps

  // Compared with undefined so an empty flag is an error: an empty
  // --instance-name would skip the default name's in-use check, and an empty
  // --port would silently become the default port.
  const flagNameError =
    flags.instanceName === undefined ? undefined : describeInvalidInstanceName(flags.instanceName)

  if (flagNameError) {
    prompts.error(`--instance-name: ${flagNameError}`)
    return { kind: "exit" }
  }
  if (flags.port !== undefined && !isValidPort(flags.port)) {
    prompts.error("--port must be a whole number between 1 and 65535.")
    return { kind: "exit" }
  }
  const flagOverrides = {
    ...(flags.instanceName ? { INSTANCE_NAME: flags.instanceName } : {}),
    ...(flags.port ? { PORT: flags.port } : {}),
  }

  const existingEnvPath = join(targetDir, ".env")

  // An existing .env makes this folder an install already, and its own
  // container and volumes would always count as in use, so a re-run skips the check.
  if (existsSync(existingEnvPath)) {
    const carried = readCarriedIdentity(existingEnvPath, mode)
    const carriedName = carried.INSTANCE_NAME || DEFAULT_INSTANCE_NAME
    const carriedNameError = describeInvalidInstanceName(carriedName)

    // An invalid kept name gets the error every other command gives it before
    // init asks anything more, since the re-run would carry it into the new .env.
    if (carriedNameError) {
      prompts.error(`INSTANCE_NAME ${carriedNameError} Fix it in ${targetDir}/.env.`)
      return { kind: "exit" }
    }
    // The same holds for a kept port, unless --port replaces it.
    const carriedPortError =
      carried.PORT && !isValidPort(carried.PORT) ? describeInvalidEnvPort(carried.PORT) : undefined

    if (carriedPortError && !flags.port) {
      prompts.error(`${carriedPortError} Fix it in ${targetDir}/.env.`)
      return { kind: "exit" }
    }
    // Renaming here would leave the old container running and could point
    // the folder at another install's volumes, so the name stays.
    if (flags.instanceName && flags.instanceName !== carriedName) {
      prompts.error(renameOnRerunMessage({ carriedName, targetDir }))
      return { kind: "exit" }
    }
    const daemonRunning = docker.daemonStatus() === "running"
    const portsInUse = portsOfOtherContainers(
      daemonRunning ? docker.publishedHostPorts() : new Map<number, string>(),
      carriedName,
    )
    // A kept port is the install's own; only a new --port can collide.
    const portSetting: PortSettingResult = flags.port
      ? await checkRequestedPort({ flags, portsInUse }, prompts)
      : { kind: "ok", settings: {} }

    if (portSetting.kind === "exit") return { kind: "exit" }
    const chosen = { ...flagOverrides, ...portSetting.settings }
    return { kind: "ok", identity: { carried, chosen }, portsInUse }
  }

  const requestedName = flags.instanceName ?? DEFAULT_INSTANCE_NAME
  const daemonRunning = docker.daemonStatus() === "running"

  // Without Docker the check can't see another install's container or
  // volumes, and a shared name would only surface when start replaces them.
  if (!daemonRunning) prompts.warn(nameCheckSkippedMessage(requestedName))
  const requestedNameInUse =
    daemonRunning && isInstanceNameInUse({ mode, instanceName: requestedName }, docker)
  const portsInUse: PortsInUse = daemonRunning ? docker.publishedHostPorts() : new Map()
  // A new folder's .env starts from the template's device name, so a name
  // given by --instance-name sets it too, whether the name is new or reused.
  const flagSettings = {
    ...flagOverrides,
    ...(flags.instanceName ? buildDeviceNameSetting(mode, flags.instanceName) : {}),
  }

  // A name not in use, or one Docker could not check, starts a new install.
  if (!requestedNameInUse) {
    const portSetting = await checkRequestedPort({ flags, portsInUse }, prompts)

    if (portSetting.kind === "exit") return { kind: "exit" }
    const chosen = { ...flagSettings, ...portSetting.settings }
    return { kind: "ok", identity: { carried: {}, chosen }, portsInUse }
  }
  const portsOutsideReusedInstall = portsOfOtherContainers(portsInUse, requestedName)

  if (flags.instanceName) {
    prompts.log(`Reusing the data of the existing "${requestedName}" install.`)
    const reusedPort = await askReusedPort(
      { flags, portsInUse: portsOutsideReusedInstall },
      prompts,
    )

    if (reusedPort.kind === "exit") return { kind: "exit" }
    const chosen = { ...flagSettings, ...reusedPort.settings }
    return { kind: "ok", identity: { carried: {}, chosen }, portsInUse: portsOutsideReusedInstall }
  }
  if (flags.yes) {
    prompts.error(nameInUseWithYesFlagMessage(requestedName))
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
    const reusedPort = await askReusedPort(
      { flags, portsInUse: portsOutsideReusedInstall },
      prompts,
    )

    if (reusedPort.kind === "exit") return { kind: "exit" }
    const chosen = { ...flagOverrides, ...reusedPort.settings }
    return { kind: "ok", identity: { carried: {}, chosen }, portsInUse: portsOutsideReusedInstall }
  }
  const suggestedName = suggestInstanceName({ mode, targetDir }, docker)
  const instanceName = await askFreeInstanceName({ mode, suggestedName }, deps)
  const suggestedPort = flags.port ?? suggestFreePort(portsInUse)
  const port = await askFreePort({ suggestedPort, portsInUse }, prompts)
  const chosen = {
    INSTANCE_NAME: instanceName,
    PORT: port,
    ...buildDeviceNameSetting(mode, instanceName),
  }
  return { kind: "ok", identity: { carried: {}, chosen }, portsInUse }
}

/**
 * Writes the identity into freshly generated .env content, before the
 * optional-settings chooser reads it, so the chooser shows the identity's port
 * as current. A `http://localhost:<port>` PUBLIC_URL follows a carried or a
 * chosen port; a carried PUBLIC_URL is the user's own and lands verbatim.
 */
export const applyInstanceIdentity = (envContent: string, identity: InstanceIdentity): string => {
  const carriedSettings = identity.carried.PUBLIC_URL
    ? identity.carried
    : withPublicUrlOverride({ overrides: identity.carried, envContent })
  const withCarried = applyOptionalSettings(envContent, carriedSettings)
  const chosenSettings = withPublicUrlOverride({
    overrides: identity.chosen,
    envContent: withCarried,
  })
  return applyOptionalSettings(withCarried, chosenSettings)
}

/**
 * Warns when --port changes a re-run's port but its carried PUBLIC_URL stays:
 * applyInstanceIdentity moves only a `http://localhost:<port>` URL, never a
 * custom one. Returns undefined when there is nothing to warn about.
 */
export const describeStrandedCarriedPublicUrl = (
  envContent: string,
  identity: InstanceIdentity,
): string | undefined => {
  if (!identity.carried.PUBLIC_URL) return undefined
  const withCarried = applyOptionalSettings(envContent, identity.carried)

  return describeStrandedPublicUrl({
    envContent: withCarried,
    pickedOverrides: identity.chosen,
    appliedOverrides: withPublicUrlOverride({
      overrides: identity.chosen,
      envContent: withCarried,
    }),
  })
}
