import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import type { DockerRunner } from "../docker.js"
import type { Prompts } from "../prompts.js"
import { runUpgrade } from "../upgrade.js"

const createScriptedPrompts = () => {
  const errors: string[] = []
  const logs: string[] = []
  const spinnerMessages: string[] = []

  const prompts: Prompts = {
    intro: () => {},
    outro: () => {},
    note: () => {},
    print: () => {},
    log: (message) => {
      logs.push(message)
    },
    warn: () => {},
    error: (message) => {
      errors.push(message)
    },
    select: async () => "",
    text: async () => "",
    password: async () => "",
    confirm: async () => false,
    spinner: () => ({
      start: (message) => {
        spinnerMessages.push(`start: ${message}`)
      },
      stop: (message) => {
        spinnerMessages.push(`stop: ${message}`)
      },
    }),
  }

  return { prompts, errors, logs, spinnerMessages }
}

const dockerReady: DockerRunner = {
  isDaemonRunning: () => true,
  dockerRun: () => true,
  pullImage: () => true,
  stopAndRemoveContainer: () => true,
  runGetToken: () => false,
}

const dockerDown: DockerRunner = {
  isDaemonRunning: () => false,
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  runGetToken: () => false,
}

const fetchOk: typeof fetch = async () => ({ ok: true }) as Response

const fetchNever: typeof fetch = async () => {
  throw new Error("fetch must not be called")
}

const writeLocalEnv = (targetDir: string): void => {
  writeFileSync(
    join(targetDir, ".env"),
    "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\n",
  )
}

const writeRemoteEnv = (targetDir: string): void => {
  writeFileSync(
    join(targetDir, ".env"),
    "MCP_AUTH_TOKEN=abc123\nOBSIDIAN_AUTH_TOKEN=sync-token\nVAULT_NAME=MyVault\nPUBLIC_URL=https://vault.example.com\n",
  )
}

describe("runUpgrade", () => {
  it("exits 1 when no .env exists in the target directory", async () => {
    const targetDir = join(tmpdir(), "vault-cli-upgrade-missing")
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toContain("No .env found")
    expect(scripted.errors[0]).toContain("npx vault-cortex init")
  })

  it("exits 1 when Docker daemon is not running", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toContain("Docker daemon not running")
  })

  it("exits 1 when local .env has no VAULT_PATH", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc123\n")
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toContain("VAULT_PATH not found")
  })

  it("detects local mode and runs with the vault path from .env", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeLocalEnv(targetDir)
    const dockerRunParams: Parameters<DockerRunner["dockerRun"]>[] = []
    const dockerSpy: DockerRunner = {
      ...dockerReady,
      dockerRun: (params) => {
        dockerRunParams.push([params])
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerSpy, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(dockerRunParams).toHaveLength(1)
    expect(dockerRunParams[0][0].mode).toBe("local")
    expect(dockerRunParams[0][0].vaultPath).toBe("/home/user/MyVault")
  })

  it("detects remote mode and runs without a vault path", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeRemoteEnv(targetDir)
    const dockerRunParams: Parameters<DockerRunner["dockerRun"]>[] = []
    const dockerSpy: DockerRunner = {
      ...dockerReady,
      dockerRun: (params) => {
        dockerRunParams.push([params])
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerSpy, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(dockerRunParams).toHaveLength(1)
    expect(dockerRunParams[0][0].mode).toBe("remote")
    expect(dockerRunParams[0][0].vaultPath).toBeUndefined()
  })

  it("exits 1 when image pull fails", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeLocalEnv(targetDir)
    const dockerPullFails: DockerRunner = {
      ...dockerReady,
      pullImage: () => false,
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerPullFails,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.spinnerMessages).toContain(
      "stop: Image pull failed — see output above.",
    )
  })

  it("exits 1 when docker run fails", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeLocalEnv(targetDir)
    const dockerRunFails: DockerRunner = {
      ...dockerReady,
      dockerRun: () => false,
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerRunFails,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors[0]).toContain("docker run failed")
  })

  it("reports success when the health check passes", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(scripted.spinnerMessages).toContain(
      "stop: Server is up — health check passed.",
    )
  })

  it("reports failure when the health check times out", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeLocalEnv(targetDir)
    const fetchFail: typeof fetch = async () => {
      throw new Error("ECONNREFUSED")
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchFail,
        healthTimeoutMs: 20,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.spinnerMessages).toContain(
      "stop: Server did not respond within 2 minutes — check: docker logs vault-cortex",
    )
  })

  it("uses the PORT from .env for health polling", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/vault\nPORT=9000\n",
    )
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (url) => {
      fetchedUrls.push(String(url))
      return { ok: true } as Response
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    expect(fetchedUrls).toEqual(["http://127.0.0.1:9000/healthz"])
  })
})
