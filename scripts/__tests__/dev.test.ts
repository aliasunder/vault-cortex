import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

const createTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "vault-cortex-dev-script-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

const writeDockerStub = (directory: string): void => {
  const dockerPath = join(directory, "docker")
  writeFileSync(dockerPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGUMENTS_PATH"\n')
  chmodSync(dockerPath, 0o755)
}

const runDev = ({
  subcommand,
  homeDirectory,
  additionalEnv = {},
}: {
  subcommand: string
  homeDirectory: string
  additionalEnv?: Readonly<Record<string, string>>
}): ReturnType<typeof spawnSync> => {
  const inheritedPath = process.env.PATH

  if (!inheritedPath) {
    throw new Error("PATH is required to run the deployment helper")
  }

  return spawnSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/dev.ts", subcommand],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        HOME: homeDirectory,
        PATH: inheritedPath,
        ...additionalEnv,
      },
    },
  )
}

describe("dev deployment helper", () => {
  it("runs an image build with shell configuration when the external env file is absent", () => {
    const directory = createTempDirectory()
    const dockerArgumentsPath = join(directory, "docker-arguments.txt")
    const inheritedPath = process.env.PATH

    if (!inheritedPath) {
      throw new Error("PATH is required to run the Docker stub")
    }

    writeDockerStub(directory)
    const result = runDev({
      subcommand: "docker:build",
      homeDirectory: directory,
      additionalEnv: {
        DOCKER_ARGUMENTS_PATH: dockerArgumentsPath,
        GHCR_USER: "shell-user",
        PATH: [directory, inheritedPath].join(delimiter),
      },
    })

    expect(result.status).toBe(0)
    expect(readFileSync(dockerArgumentsPath, "utf8")).toBe(
      "build\n--target\nremote\n--platform\nlinux/amd64\n-t\nghcr.io/shell-user/vault-cortex:remote\n.\n",
    )
  })

  it("rejects lightsail deployment when the external env file is missing", () => {
    const directory = createTempDirectory()

    const result = runDev({ subcommand: "lightsail:up", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕ deployment environment file not found at ${join(directory, ".config", "vault-cortex", ".env")}; copy .env.example there and fill in the required values\n`,
    )
  })

  it("rejects lightsail deployment when the external env file is unreadable", () => {
    const directory = createTempDirectory()
    const envPath = join(directory, ".config", "vault-cortex", ".env")
    mkdirSync(envPath, { recursive: true })

    const result = runDev({ subcommand: "lightsail:up", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕ could not read or parse the deployment environment file at ${envPath}\n`,
    )
  })
})
