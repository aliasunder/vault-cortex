import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { loadDeploymentEnv } from "../deployment-env.js"

const createTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "vault-cortex-deployment-env-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

const writeEnvFile = (content: string): string => {
  const directory = createTempDirectory()
  const envFilePath = join(directory, ".env")
  writeFileSync(envFilePath, content)
  return envFilePath
}

describe("loadDeploymentEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("parses dotenv quoting, comments, and empty values", () => {
    const envFilePath = writeEnvFile(
      [
        "PLAIN=value",
        "SINGLE_QUOTED='two words'",
        'DOUBLE_QUOTED="three words"',
        "EMPTY=",
        "COMMENTED=value # explanation",
      ].join("\n"),
    )

    const env = loadDeploymentEnv({ envFilePath, parentEnv: {} })

    expect(env).toEqual({
      COMMENTED: "value",
      DOUBLE_QUOTED: "three words",
      EMPTY: "",
      PLAIN: "value",
      SINGLE_QUOTED: "two words",
    })
  })

  it("uses the last file value for duplicate keys", () => {
    const envFilePath = writeEnvFile("MODE=first\nMODE=second\n")

    const env = loadDeploymentEnv({ envFilePath, parentEnv: {} })

    expect(env).toEqual({ MODE: "second" })
  })

  it("lets the invoking environment override file values, including an empty string", () => {
    const envFilePath = writeEnvFile(
      "MODE=file\nFILE_ONLY=kept\nORIGIN_URL=https://tunnel.example.com\nMCP_PORT_CIDRS=none\n",
    )

    const env = loadDeploymentEnv({
      envFilePath,
      parentEnv: {
        MCP_PORT_CIDRS: "0.0.0.0/0",
        MODE: "shell",
        ORIGIN_URL: "",
        SHELL_ONLY: "kept",
      },
    })

    expect(env).toEqual({
      FILE_ONLY: "kept",
      MCP_PORT_CIDRS: "0.0.0.0/0",
      MODE: "shell",
      ORIGIN_URL: "",
      SHELL_ONLY: "kept",
    })
  })

  it("uses the invoking environment when an optional external file is missing", () => {
    const missingPath = join(createTempDirectory(), ".env")
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const env = loadDeploymentEnv({
      envFilePath: missingPath,
      parentEnv: { SHELL_ONLY: "kept" },
      requireFile: false,
    })

    expect(env).toEqual({ SHELL_ONLY: "kept" })
    expect(warnLog).toHaveBeenCalledTimes(0)
  })

  it("merges an existing optional external file under the invoking environment", () => {
    const envFilePath = writeEnvFile("MODE=file\nFILE_ONLY=kept\n")

    const env = loadDeploymentEnv({
      envFilePath,
      parentEnv: { MODE: "shell" },
      requireFile: false,
    })

    expect(env).toEqual({ FILE_ONLY: "kept", MODE: "shell" })
  })

  it("warns and uses the invoking environment when an optional external file is unreadable", () => {
    const envDirectory = createTempDirectory()
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const env = loadDeploymentEnv({
      envFilePath: envDirectory,
      parentEnv: { SHELL_ONLY: "kept" },
      requireFile: false,
    })

    expect(env).toEqual({ SHELL_ONLY: "kept" })
    expect(warnLog).toHaveBeenCalledTimes(1)
    expect(warnLog).toHaveBeenCalledWith(
      `⚠ could not read ${envDirectory}; using shell variables only`,
    )
  })

  it("rejects a missing external file with setup guidance", () => {
    const missingPath = join(createTempDirectory(), ".env")
    const expectedError = new Error(
      `deployment environment file not found at ${missingPath}; copy .env.example there and fill in the required values`,
    )

    expect(() => loadDeploymentEnv({ envFilePath: missingPath, parentEnv: {} })).toThrowError(
      expectedError,
    )
  })

  it("rejects an unreadable external file without leaking its read error", () => {
    const envDirectory = createTempDirectory()
    const expectedError = new Error(
      `could not read the deployment environment file at ${envDirectory}`,
    )

    expect(() => loadDeploymentEnv({ envFilePath: envDirectory, parentEnv: {} })).toThrowError(
      expectedError,
    )
  })
})
