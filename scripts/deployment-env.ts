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

  try {
    const fileEnv = parseEnv(readFileSync(envFilePath, "utf8"))
    return { ...fileEnv, ...parentEnv }
  } catch {
    throw new Error(`could not read or parse the deployment environment file at ${envFilePath}`)
  }
}
