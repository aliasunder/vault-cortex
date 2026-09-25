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

/** PATH starts with homeDirectory, so a Docker stub written there replaces the real docker. */
const runDev = ({
  subcommand,
  homeDirectory,
  additionalEnv = {},
  workingDirectory = process.cwd(),
}: {
  subcommand: string
  homeDirectory: string
  additionalEnv?: Readonly<Record<string, string>>
  workingDirectory?: string
}): ReturnType<typeof spawnSync> => {
  const inheritedPath = process.env.PATH

  if (!inheritedPath) {
    throw new Error("PATH is required to run the deployment helper")
  }

  return spawnSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/dev.ts"), subcommand],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      env: {
        HOME: homeDirectory,
        PATH: [homeDirectory, inheritedPath].join(delimiter),
        ...additionalEnv,
      },
    },
  )
}

describe("dev deployment helper", () => {
  it("runs an image build with shell configuration when the external env file is absent", () => {
    const directory = createTempDirectory()
    const dockerArgumentsPath = join(directory, "docker-arguments.txt")

    writeDockerStub(directory)
    const result = runDev({
      subcommand: "docker:build",
      homeDirectory: directory,
      additionalEnv: {
        DOCKER_ARGUMENTS_PATH: dockerArgumentsPath,
        GHCR_USER: "shell-user",
      },
    })

    expect(result.status).toBe(0)
    expect(readFileSync(dockerArgumentsPath, "utf8")).toBe(
      "build\n--target\nremote\n--platform\nlinux/amd64\n-t\nghcr.io/shell-user/vault-cortex:remote\n.\n",
    )
  })

  it("runs an image build with GHCR_USER from the external env file", () => {
    const directory = createTempDirectory()
    const dockerArgumentsPath = join(directory, "docker-arguments.txt")
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(join(deploymentEnvDirectory, ".env"), "GHCR_USER=file-user\n")

    writeDockerStub(directory)
    const result = runDev({
      subcommand: "docker:build",
      homeDirectory: directory,
      additionalEnv: { DOCKER_ARGUMENTS_PATH: dockerArgumentsPath },
    })

    expect(result.status).toBe(0)
    expect(readFileSync(dockerArgumentsPath, "utf8")).toBe(
      "build\n--target\nremote\n--platform\nlinux/amd64\n-t\nghcr.io/file-user/vault-cortex:remote\n.\n",
    )
  })

  it("rejects an image build when neither the external env file nor the shell sets GHCR_USER", () => {
    const directory = createTempDirectory()
    const deploymentEnvPath = join(directory, ".config", "vault-cortex", ".env")

    const result = runDev({ subcommand: "docker:build", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕  GHCR_USER not set. Set it in ${deploymentEnvPath} or in the shell.\n`,
    )
  })

  it("rejects lightsail deployment when the external env file is missing", () => {
    const directory = createTempDirectory()
    const deploymentEnvPath = join(directory, ".config", "vault-cortex", ".env")

    const result = runDev({ subcommand: "lightsail:up", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕ deployment environment file not found at ${deploymentEnvPath}; copy .env.example there and fill in the required values\n`,
    )
  })

  it("rejects lightsail deployment when the external env file is unreadable", () => {
    const directory = createTempDirectory()
    const deploymentEnvPath = join(directory, ".config", "vault-cortex", ".env")
    mkdirSync(deploymentEnvPath, { recursive: true })

    const result = runDev({ subcommand: "lightsail:up", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕ could not read or parse the deployment environment file at ${deploymentEnvPath}\n`,
    )
  })

  it.each([
    {
      label: "us-east-1 when AWS_REGION is unset",
      fileRegionLine: "",
      expectedRegion: "us-east-1",
    },
    {
      label: "AWS_REGION from the external env file",
      fileRegionLine: "AWS_REGION=eu-west-2\n",
      expectedRegion: "eu-west-2",
    },
  ])("looks up the instance address in $label", ({ fileRegionLine, expectedRegion }) => {
    const directory = createTempDirectory()
    const awsRegionPath = join(directory, "aws-region.txt")
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(
      join(deploymentEnvDirectory, ".env"),
      `GHCR_USER=file-user\nPUBLIC_URL=https://mcp.example.com\n${fileRegionLine}`,
    )
    const workingDirectory = join(directory, "repo")
    mkdirSync(join(workingDirectory, ".sst"), { recursive: true })
    writeFileSync(join(workingDirectory, ".sst", "stage"), "teststage\n")
    // An empty lookup result ("None") stops the helper before it runs ssh.
    const awsPath = join(directory, "aws")
    writeFileSync(
      awsPath,
      '#!/bin/sh\nprintf "%s %s" "$AWS_REGION" "$AWS_DEFAULT_REGION" > "$AWS_REGION_PATH"\necho None\n',
    )
    chmodSync(awsPath, 0o755)

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      workingDirectory,
      additionalEnv: { AWS_REGION_PATH: awsRegionPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("✕  Could not resolve vault-cortex-ip-teststage from AWS.\n")
    // AWS CLI v2 reads AWS_REGION; v1 reads only AWS_DEFAULT_REGION.
    expect(readFileSync(awsRegionPath, "utf8")).toBe(`${expectedRegion} ${expectedRegion}`)
  })
})
