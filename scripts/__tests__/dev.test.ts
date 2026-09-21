import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

describe("dev deployment helper", () => {
  it("runs an image build with shell configuration when the external env file is absent", () => {
    const directory = createTempDirectory()
    const dockerArgumentsPath = join(directory, "docker-arguments.txt")
    const inheritedPath = process.env.PATH

    if (!inheritedPath) {
      throw new Error("PATH is required to run the Docker stub")
    }

    writeDockerStub(directory)
    const result = spawnSync(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/dev.ts", "docker:build"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          DOCKER_ARGUMENTS_PATH: dockerArgumentsPath,
          GHCR_USER: "shell-user",
          HOME: directory,
          PATH: [directory, inheritedPath].join(delimiter),
        },
      },
    )

    expect(result.status).toBe(0)
    expect(readFileSync(dockerArgumentsPath, "utf8")).toBe(
      "build\n--target\nremote\n--platform\nlinux/amd64\n-t\nghcr.io/shell-user/vault-cortex:remote\n.\n",
    )
  })
})
