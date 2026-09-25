import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseEnv } from "node:util"

export const DEPLOYMENT_ENV_PATH = join(homedir(), ".config", "vault-cortex", ".env")

type LoadDeploymentEnvParams = {
  envFilePath?: string
  parentEnv?: Readonly<NodeJS.ProcessEnv>
  requireFile?: boolean
}

const readEnvFileOrNull = (envFilePath: string): string | null => {
  try {
    return readFileSync(envFilePath, "utf8")
  } catch {
    // Callers report the file path instead: the raw read error adds nothing
    // a user can act on.
    return null
  }
}

/**
 * Merges the deployment env file with the invoking environment. A variable
 * set in the invoking environment wins over the file, even when it is empty.
 */
export const loadDeploymentEnv = ({
  envFilePath = DEPLOYMENT_ENV_PATH,
  parentEnv = process.env,
  requireFile = true,
}: LoadDeploymentEnvParams = {}): NodeJS.ProcessEnv => {
  if (!existsSync(envFilePath)) {
    if (!requireFile) return { ...parentEnv }

    throw new Error(
      `deployment environment file not found at ${envFilePath}; copy .env.example there and fill in the required values`,
    )
  }

  const fileContent = readEnvFileOrNull(envFilePath)

  if (fileContent === null) {
    // An optional file only supplies defaults, so the invoking environment is
    // still a usable configuration without it.
    if (!requireFile) {
      console.warn(`⚠ could not read ${envFilePath}; using shell variables only`)
      return { ...parentEnv }
    }

    throw new Error(`could not read the deployment environment file at ${envFilePath}`)
  }

  // Shell values override the file so CI and one-off deploys can vary
  // configuration without rewriting the file.
  return { ...parseEnv(fileContent), ...parentEnv }
}
