import { readFileSync, writeFileSync } from "node:fs"

import {
  recreateContainer,
  requireInitializedDir,
  resolveDeployment,
} from "./lifecycle.js"
import {
  applyOptionalSettings,
  askOptionalSettings,
} from "./optional-settings.js"
import type { DockerRunner } from "./docker.js"
import type { Prompts } from "./prompts.js"

export type ConfigureFlags = {
  dir?: string
}

export type ConfigureDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
  /** Override the health-check timeout for testing. */
  healthTimeoutMs?: number
}

/**
 * Interactively changes optional settings in an existing deployment's .env,
 * then offers to re-create the container so the new values take effect (the
 * env-file is only read at container creation). The edit succeeds on its own:
 * a stopped daemon or a declined restart still exits 0 with the settings
 * saved and a restart hint printed.
 */
export const runConfigure = async (
  flags: ConfigureFlags,
  deps: ConfigureDeps,
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  prompts.intro("vault-cortex configure")

  // Editing settings only needs an init'd .env — the full start validation
  // (VAULT_PATH, PUBLIC_URL) runs later, only when a restart is requested.
  const initialized = requireInitializedDir(flags.dir, prompts)
  if (!initialized) return 1
  const { targetDir, envFilePath, mode } = initialized

  const envContent = readFileSync(envFilePath, "utf8")
  const overrides = await askOptionalSettings({ mode, envContent }, prompts)
  const changedNames = Object.keys(overrides)
  if (changedNames.length === 0) {
    prompts.log("No settings selected — nothing changed.")
    prompts.outro("Done.")
    return 0
  }

  writeFileSync(envFilePath, applyOptionalSettings(envContent, overrides))
  prompts.log(`Updated ${changedNames.join(", ")} in ${targetDir}/.env.`)

  const restartHint = `Apply the new settings with: npx vault-cortex restart --dir "${targetDir}"`
  if (!docker.isDaemonRunning()) {
    prompts.warn(
      `Container runtime not running — settings saved.\n${restartHint}`,
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
  if (!deployment) return 1
  const exitCode = await recreateContainer(
    { deployment, healthTimeoutMs: deps.healthTimeoutMs },
    { prompts, docker, fetchFn },
  )
  if (exitCode !== 0) return exitCode

  prompts.log("Applied the current .env settings.")
  prompts.outro("Configure complete.")
  return 0
}
