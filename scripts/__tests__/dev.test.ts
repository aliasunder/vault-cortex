import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { parse as parseYaml } from "yaml"

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

/** Writes an executable shell script named `name` into `directory`, which runDev puts first on PATH. */
const writeCommandStub = ({
  directory,
  name,
  script,
}: {
  directory: string
  name: string
  script: string
}): void => {
  const stubPath = join(directory, name)
  writeFileSync(stubPath, `#!/bin/sh\n${script}`)
  chmodSync(stubPath, 0o755)
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

  it("prints the usage line for an unknown subcommand before checking GHCR_USER", () => {
    const directory = createTempDirectory()

    const result = runDev({ subcommand: "docker:bild", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      "Usage: tsx scripts/dev.ts <docker:build|docker:push|docker:publish|lightsail:up>\n",
    )
  })

  it("rejects an image build when neither the external env file nor the shell sets GHCR_USER", () => {
    const directory = createTempDirectory()

    const result = runDev({ subcommand: "docker:build", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("✕  GHCR_USER not set. Set it in ~/.config/vault-cortex/.env\n")
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

  it("rejects lightsail deployment that binds port 8000 off the public address without ORIGIN_URL", () => {
    const directory = createTempDirectory()
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(
      join(deploymentEnvDirectory, ".env"),
      "GHCR_USER=file-user\nPUBLIC_URL=https://mcp.example.com\nBIND_ADDRESS=127.0.0.1\n",
    )

    const result = runDev({ subcommand: "lightsail:up", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      "✕  BIND_ADDRESS=127.0.0.1 takes port 8000 off the instance's public address, but ORIGIN_URL is empty, so API Gateway would call that address. Set ORIGIN_URL, or remove BIND_ADDRESS from ~/.config/vault-cortex/.env\n",
    )
  })

  it("rejects lightsail deployment on the env file's BIND_ADDRESS even when the shell sets 0.0.0.0", () => {
    const directory = createTempDirectory()
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(
      join(deploymentEnvDirectory, ".env"),
      "GHCR_USER=file-user\nPUBLIC_URL=https://mcp.example.com\nBIND_ADDRESS=127.0.0.1\n",
    )
    const workingDirectory = join(directory, "repo")
    mkdirSync(join(workingDirectory, ".sst"), { recursive: true })
    writeFileSync(join(workingDirectory, ".sst", "stage"), "teststage\n")
    // If the bind check read the shell's value, the deployment would pass it
    // and stop at this stubbed instance address lookup instead.
    writeCommandStub({ directory, name: "aws", script: "echo None\n" })

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      workingDirectory,
      additionalEnv: { BIND_ADDRESS: "0.0.0.0" },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      "✕  BIND_ADDRESS=127.0.0.1 takes port 8000 off the instance's public address, but ORIGIN_URL is empty, so API Gateway would call that address. Set ORIGIN_URL, or remove BIND_ADDRESS from ~/.config/vault-cortex/.env\n",
    )
  })

  it.each([
    {
      label: "a loopback BIND_ADDRESS when ORIGIN_URL is set",
      bindLines: "BIND_ADDRESS=127.0.0.1\nORIGIN_URL=https://origin.example.com\n",
    },
    {
      label: "BIND_ADDRESS=0.0.0.0 without ORIGIN_URL",
      bindLines: "BIND_ADDRESS=0.0.0.0\n",
    },
  ])("lets lightsail deployment past the bind check with $label", ({ bindLines }) => {
    const directory = createTempDirectory()
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(
      join(deploymentEnvDirectory, ".env"),
      `GHCR_USER=file-user\nPUBLIC_URL=https://mcp.example.com\n${bindLines}`,
    )
    const workingDirectory = join(directory, "repo")
    mkdirSync(join(workingDirectory, ".sst"), { recursive: true })
    writeFileSync(join(workingDirectory, ".sst", "stage"), "teststage\n")
    // The instance address lookup runs after the bind check, so its failure
    // shows the check let the deployment through; "None" stops it before ssh.
    writeCommandStub({ directory, name: "aws", script: "echo None\n" })

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      workingDirectory,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("✕  Could not resolve vault-cortex-ip-teststage from AWS.\n")
  })

  it("rejects lightsail deployment when the external env file is unreadable", () => {
    const directory = createTempDirectory()
    const deploymentEnvPath = join(directory, ".config", "vault-cortex", ".env")
    mkdirSync(deploymentEnvPath, { recursive: true })

    const result = runDev({ subcommand: "lightsail:up", homeDirectory: directory })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕ could not read the deployment environment file at ${deploymentEnvPath}\n`,
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
    writeFileSync(awsPath, '#!/bin/sh\nprintf "%s" "$AWS_REGION" > "$AWS_REGION_PATH"\necho None\n')
    chmodSync(awsPath, 0o755)

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      workingDirectory,
      additionalEnv: { AWS_REGION_PATH: awsRegionPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("✕  Could not resolve vault-cortex-ip-teststage from AWS.\n")
    expect(readFileSync(awsRegionPath, "utf8")).toBe(expectedRegion)
  })

  it("removes the temporary .env copy when copying it to the instance fails", () => {
    const directory = createTempDirectory()
    const tempDirectory = join(directory, "tmp")
    mkdirSync(tempDirectory)
    const scpArgumentsPath = join(directory, "scp-arguments.txt")
    const sshKeyPath = join(directory, "deploy-key")
    writeFileSync(sshKeyPath, "fake-key\n")
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(
      join(deploymentEnvDirectory, ".env"),
      "GHCR_USER=file-user\nPUBLIC_URL=https://mcp.example.com\n" +
        `LIGHTSAIL_SSH_HOST=instance.example\nLIGHTSAIL_SSH_KEY=${sshKeyPath}\n`,
    )
    const sshPath = join(directory, "ssh")
    writeFileSync(sshPath, "#!/bin/sh\nexit 0\n")
    chmodSync(sshPath, 0o755)
    // Records each copy's arguments and fails only the .env copy.
    const scpPath = join(directory, "scp")
    writeFileSync(
      scpPath,
      '#!/bin/sh\nprintf "%s\\n" "$@" >> "$SCP_ARGUMENTS_PATH"\n' +
        'case "$*" in *:/opt/vault-cortex/.env) exit 1 ;; esac\nexit 0\n',
    )
    chmodSync(scpPath, 0o755)

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      additionalEnv: { SCP_ARGUMENTS_PATH: scpArgumentsPath, TMPDIR: tempDirectory },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("✕ scp .env (with the resolved PUBLIC_URL) to the instance failed\n")
    const envCopyPath = readFileSync(scpArgumentsPath, "utf8")
      .split("\n")
      .find((argument) => argument.startsWith(join(tempDirectory, "vault-cortex-env-")))
    expect(envCopyPath).toMatch(/\/vault-cortex-env-[^/]+\/\.env$/)
    // tsx keeps its own cache in TMPDIR, so only the helper's directories count.
    const isEnvCopyDirectory = (entry: string): boolean => entry.startsWith("vault-cortex-env-")
    expect(readdirSync(tempDirectory).filter(isEnvCopyDirectory)).toEqual([])
  })

  it("stops before touching the instance when the API Gateway lookup fails", () => {
    const directory = createTempDirectory()
    const sshCallsPath = join(directory, "ssh-calls.txt")
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    // Without PUBLIC_URL or CUSTOM_DOMAIN, lightsail:up asks API Gateway for the URL.
    writeFileSync(join(deploymentEnvDirectory, ".env"), "GHCR_USER=file-user\n")
    const workingDirectory = join(directory, "repo")
    mkdirSync(join(workingDirectory, ".sst"), { recursive: true })
    writeFileSync(join(workingDirectory, ".sst", "stage"), "teststage\n")
    writeCommandStub({ directory, name: "aws", script: "exit 1\n" })
    writeCommandStub({ directory, name: "ssh", script: 'echo called >> "$SSH_CALLS_PATH"\n' })

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      workingDirectory,
      additionalEnv: { SSH_CALLS_PATH: sshCallsPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `✕  Command failed: aws apigatewayv2 get-apis --query "sort_by(Items[?starts_with(Name, 'vault-cortex-teststage-VaultCortexApi')], &CreatedDate)[-1].ApiEndpoint" --output text\n`,
    )
    expect(existsSync(sshCallsPath)).toBe(false)
  })

  it("stops before copying files when logging the instance in to GHCR fails", () => {
    const directory = createTempDirectory()
    const loginInputPath = join(directory, "docker-login-input.txt")
    const scpCallsPath = join(directory, "scp-calls.txt")
    const sshKeyPath = join(directory, "deploy-key")
    writeFileSync(sshKeyPath, "fake-key\n")
    const deploymentEnvDirectory = join(directory, ".config", "vault-cortex")
    mkdirSync(deploymentEnvDirectory, { recursive: true })
    writeFileSync(
      join(deploymentEnvDirectory, ".env"),
      "GHCR_USER=file-user\nGHCR_TOKEN=fake-ghcr-token\nPUBLIC_URL=https://mcp.example.com\n" +
        `LIGHTSAIL_SSH_HOST=instance.example\nLIGHTSAIL_SSH_KEY=${sshKeyPath}\n`,
    )
    // Records what the login reads on stdin, then fails only the login.
    writeCommandStub({
      directory,
      name: "ssh",
      script: 'case "$*" in *"docker login"*) cat > "$LOGIN_INPUT_PATH"; exit 1 ;; esac\nexit 0\n',
    })
    writeCommandStub({ directory, name: "scp", script: 'echo called >> "$SCP_CALLS_PATH"\n' })

    const result = runDev({
      subcommand: "lightsail:up",
      homeDirectory: directory,
      additionalEnv: { LOGIN_INPUT_PATH: loginInputPath, SCP_CALLS_PATH: scpCallsPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe("✕ docker login ghcr.io failed on the instance\n")
    expect(readFileSync(loginInputPath, "utf8")).toBe("fake-ghcr-token")
    expect(existsSync(scpCallsPath)).toBe(false)
  })
})

type WorkflowStep = { name?: string; env?: Record<string, string>; run?: string }

const BIND_CHECK_STEP_NAME = "Check BIND_ADDRESS has a tunnel in front"

const readDeploySteps = (workflowFile: string): ReadonlyArray<WorkflowStep> => {
  const workflow: { jobs: { deploy: { steps: WorkflowStep[] } } } = parseYaml(
    readFileSync(new URL(`../../.github/workflows/${workflowFile}`, import.meta.url), "utf8"),
  )
  return workflow.jobs.deploy.steps
}

const findBindCheckStep = (workflowFile: string): WorkflowStep => {
  const bindCheckStep = readDeploySteps(workflowFile).find(
    (step) => step.name === BIND_CHECK_STEP_NAME,
  )

  if (!bindCheckStep) {
    throw new Error(`${workflowFile} has no "${BIND_CHECK_STEP_NAME}" step`)
  }
  return bindCheckStep
}

/** Runs the workflow's bind check under bash -e, as Actions runs a `run:` step. */
const runBindCheck = ({
  workflowFile,
  bindAddress,
  originUrl,
}: {
  workflowFile: string
  bindAddress: string
  originUrl: string
}): { status: number | null; stdout: string } => {
  const bindCheckScript = findBindCheckStep(workflowFile).run

  if (!bindCheckScript) {
    throw new Error(`${workflowFile}'s "${BIND_CHECK_STEP_NAME}" step has no run script`)
  }

  const { status, stdout } = spawnSync("bash", ["-e", "-c", bindCheckScript], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BIND_ADDRESS: bindAddress, ORIGIN_URL: originUrl },
  })
  return { status, stdout }
}

// The deploy workflows repeat lightsail:up's bind check in shell, so each
// copy is run here against the same cases. An unset repo Variable or secret
// reaches the step as an empty string.
describe.each(["deploy.yml", "test_deploy.yml"])("%s bind check", (workflowFile) => {
  it("reads the BIND_ADDRESS Variable and the ORIGIN_URL secret", () => {
    expect(findBindCheckStep(workflowFile).env).toEqual({
      BIND_ADDRESS: "${{ vars.BIND_ADDRESS }}",
      ORIGIN_URL: "${{ secrets.ORIGIN_URL }}",
    })
  })

  it("runs immediately before SST deploy", () => {
    const stepNames = readDeploySteps(workflowFile).map((step) => step.name)

    expect(stepNames.indexOf(BIND_CHECK_STEP_NAME)).toBe(stepNames.indexOf("SST deploy") - 1)
  })

  it.each([
    { label: "BIND_ADDRESS unset", bindAddress: "", originUrl: "" },
    { label: "BIND_ADDRESS=0.0.0.0 without ORIGIN_URL", bindAddress: "0.0.0.0", originUrl: "" },
    {
      label: "a loopback BIND_ADDRESS when ORIGIN_URL is set",
      bindAddress: "127.0.0.1",
      originUrl: "https://origin.example.com",
    },
  ])("passes with $label", ({ bindAddress, originUrl }) => {
    expect(runBindCheck({ workflowFile, bindAddress, originUrl })).toEqual({
      status: 0,
      stdout: "",
    })
  })

  it("fails with a loopback BIND_ADDRESS without ORIGIN_URL", () => {
    expect(runBindCheck({ workflowFile, bindAddress: "127.0.0.1", originUrl: "" })).toEqual({
      status: 1,
      stdout:
        "::error title=BIND_ADDRESS without ORIGIN_URL::BIND_ADDRESS=127.0.0.1 takes port 8000 off the instance's public address, but ORIGIN_URL is empty, so API Gateway would call that address. Set the ORIGIN_URL secret, or delete the BIND_ADDRESS Variable.\n",
    })
  })
})
