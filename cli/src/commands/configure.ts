import type { DockerRunner } from "../adapters/docker.js"
import { envFile } from "../adapters/env-file.js"
import type { Prompts } from "../adapters/prompts.js"
import {
  applyOptionalSettings,
  describeStrandedPublicUrl,
  withPublicUrlOverride,
} from "../rules/env-edits.js"
import { buildSettingsSavedWithoutRuntimeMessage, vaultCortexCommand } from "../rules/messages.js"
import { portsOfOtherContainers } from "../rules/ports.js"
import { containerStart } from "../steps/container-start.js"
import { requireInitializedDir, resolveDeployment } from "../steps/deployment.js"
import { askOptionalSettings } from "../steps/optional-settings.js"

export type ConfigureFlags = {
  dir?: string
}

export type ConfigureDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
}

/**
 * Interactively changes optional settings in an existing deployment's .env,
 * then offers to re-create the container so the new values take effect (the
 * env-file is only read at container creation). The edit succeeds on its own:
 * a stopped daemon or a declined restart still exits 0 with the settings
 * saved and a restart hint printed.
 */
export const runConfigure = async (flags: ConfigureFlags, deps: ConfigureDeps): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro("vault-cortex configure")

  // Editing settings only needs an init'd .env — the full start validation
  // (PORT, VAULT_PATH, PUBLIC_URL) runs later, only when a restart is requested.
  const initialized = requireInitializedDir(flags.dir, prompts)

  if (!initialized) return 1
  const { targetDir, envFilePath, envContent, mode, instanceName } = initialized
  const daemonStatus = docker.daemonStatus()
  const portsInUse = portsOfOtherContainers(
    daemonStatus === "running" ? docker.publishedHostPorts() : [],
    instanceName,
  )
  const pickedOverrides = await askOptionalSettings({ mode, envContent, portsInUse }, prompts)

  if (Object.keys(pickedOverrides).length === 0) {
    // Nothing picked in the chooser and every pick kept both end here. A kept
    // pick has already logged its own "Kept the current value" or "Left unset"
    // line, so this message must not contradict it.
    prompts.log("No changes to apply.")
    prompts.outro("Done.")
    return 0
  }

  // The .env may have been edited while the prompts were open, so it is read
  // again and the new settings apply on top of what it holds now.
  const currentEnvContent = envFile.read(envFilePath) ?? envContent
  const overrides = withPublicUrlOverride({
    overrides: pickedOverrides,
    envContent: currentEnvContent,
  })
  const changedNames = Object.keys(overrides)
  envFile.replace(envFilePath, applyOptionalSettings(currentEnvContent, overrides))
  prompts.log(`Updated ${changedNames.join(", ")} in ${targetDir}/.env.`)

  const publicUrlWarning = describeStrandedPublicUrl({
    envContent: currentEnvContent,
    pickedOverrides,
    appliedOverrides: overrides,
  })

  if (publicUrlWarning) prompts.warn(publicUrlWarning)

  const restartCommand = vaultCortexCommand("restart", targetDir)
  const restartHint = `Apply the new settings with: ${restartCommand}`
  // Asked again: Docker may have stopped or started while the prompts were open.
  const restartDaemonStatus = docker.daemonStatus()

  if (restartDaemonStatus !== "running") {
    // Settings are already saved, so both non-running states degrade to the hint.
    prompts.warn(
      buildSettingsSavedWithoutRuntimeMessage({ daemonStatus: restartDaemonStatus, restartHint }),
    )
    prompts.outro("Done.")
    return 0
  }

  const restartNow = await prompts.confirm(
    "Restart the container now to apply the new settings?",
    true,
  )

  if (!restartNow) {
    prompts.log(restartHint)
    prompts.outro("Done.")
    return 0
  }

  // Resolve from disk after the write so the restart honors the new values
  // (a changed PORT must drive the port mapping and health URL).
  const deployment = resolveDeployment(flags.dir, prompts)

  if (!deployment) {
    // The edit already succeeded — don't let the failed restart read as a
    // failed configure.
    prompts.warn(
      `The restart did not run — your settings are saved. Fix the issue above, then apply them with: ${restartCommand}`,
    )
    return 1
  }
  const exitCode = await containerStart.recreate({ deployment }, { prompts, docker, fetchFn })

  if (exitCode !== 0) return exitCode

  prompts.log("Applied the current .env settings.")
  prompts.outro("Configure complete.")
  return 0
}
