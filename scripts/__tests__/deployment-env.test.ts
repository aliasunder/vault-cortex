import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import { loadDeploymentEnv } from "../deployment-env.js"

const writeEnvFile = (content: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "vault-cortex-deployment-env-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const envFilePath = join(directory, ".env")
  writeFileSync(envFilePath, content)
  return envFilePath
}

describe("loadDeploymentEnv", () => {
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

  it("lets the invoking environment override file values", () => {
    const envFilePath = writeEnvFile("MODE=file\nFILE_ONLY=kept\n")

    const env = loadDeploymentEnv({
      envFilePath,
      parentEnv: { MODE: "shell", SHELL_ONLY: "kept" },
    })

    expect(env).toEqual({
      FILE_ONLY: "kept",
      MODE: "shell",
      SHELL_ONLY: "kept",
    })
  })

  it("rejects a missing external file with setup guidance", () => {
    const missingPath = join(tmpdir(), "vault-cortex-missing-deployment-env", ".env")

    expect(() => loadDeploymentEnv({ envFilePath: missingPath, parentEnv: {} })).toThrow(
      new RegExp(
        `^deployment environment file not found at ${missingPath}; copy \\.env\\.example there and fill in the required values$`,
      ),
    )
  })
})
