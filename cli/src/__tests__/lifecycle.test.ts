import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import type { DockerLogsParams, DockerRunner } from "../docker.js"
import { runDown, runLogs, runRestart } from "../lifecycle.js"
import {
  createScriptedPrompts,
  dockerDown,
  dockerReady,
  fetchNever,
  fetchOk,
} from "./command-stubs.js"

// Creates a temp target dir and registers its removal at creation time, so
// the suite self-cleans even when an assertion throws mid-test.
const makeTempTargetDir = (prefix: string): string => {
  const targetDir = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => {
    rmSync(targetDir, { recursive: true, force: true })
  })
  return targetDir
}

const writeLocalEnv = (targetDir: string): void => {
  writeFileSync(
    join(targetDir, ".env"),
    "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\nPUBLIC_URL=http://localhost:8000\n",
  )
}

const writeRemoteEnv = (targetDir: string): void => {
  writeFileSync(
    join(targetDir, ".env"),
    "MCP_AUTH_TOKEN=abc123\nOBSIDIAN_AUTH_TOKEN=sync-token\nVAULT_NAME=MyVault\nPUBLIC_URL=https://vault.example.com\n",
  )
}

describe("runDown", () => {
  it("exits 1 when no .env exists in the target directory", async () => {
    const targetDir = join(tmpdir(), "vault-cli-down-missing")
    const scripted = createScriptedPrompts()

    const exitCode = await runDown(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `No .env found in ${targetDir} — run \`npx vault-cortex@latest init\` first.`,
    ])
  })

  it("exits 1 when Docker daemon is not running", async () => {
    const targetDir = makeTempTargetDir("vault-cli-down-")
    writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts()

    const exitCode = await runDown(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime.",
    ])
  })

  it("succeeds without removing anything when no container exists", async () => {
    const targetDir = makeTempTargetDir("vault-cli-down-")
    writeLocalEnv(targetDir)
    const removeCalls: string[] = []
    const dockerNoContainer: DockerRunner = {
      ...dockerReady,
      containerExists: () => false,
      stopAndRemoveContainer: () => {
        removeCalls.push("called")
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runDown(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerNoContainer },
    )

    expect(exitCode).toBe(0)
    expect(removeCalls).toEqual([])
    expect(scripted.logs).toEqual([
      "No vault-cortex container found — nothing to stop.",
    ])
  })

  it("tears down a local .env lacking PUBLIC_URL without rejecting it", async () => {
    const targetDir = makeTempTargetDir("vault-cli-down-")
    // A compose-era .env that upgrade/restart would reject — teardown
    // must still work on it.
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\n",
    )
    const removeCalls: string[] = []
    const dockerWithRemoveSpy: DockerRunner = {
      ...dockerReady,
      stopAndRemoveContainer: () => {
        removeCalls.push("called")
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runDown(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerWithRemoveSpy },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([])
    expect(removeCalls).toEqual(["called"])
  })

  it("removes the container and reports data preservation", async () => {
    const targetDir = makeTempTargetDir("vault-cli-down-")
    writeLocalEnv(targetDir)
    const removeCalls: string[] = []
    const dockerSpy: DockerRunner = {
      ...dockerReady,
      stopAndRemoveContainer: () => {
        removeCalls.push("called")
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runDown(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerSpy },
    )

    expect(exitCode).toBe(0)
    expect(removeCalls).toEqual(["called"])
    expect(scripted.logs).toEqual([
      "Container stopped and removed. Your vault data, search index, and settings are untouched.",
    ])
    expect(scripted.outros).toEqual([
      `Start again with: npx vault-cortex@latest restart --dir "${targetDir}"`,
    ])
  })

  it("exits 1 when the container removal fails", async () => {
    const targetDir = makeTempTargetDir("vault-cli-down-")
    writeLocalEnv(targetDir)
    const dockerRemoveFails: DockerRunner = {
      ...dockerReady,
      stopAndRemoveContainer: () => false,
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runDown(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerRemoveFails },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      "Could not remove the container — check: docker rm -f vault-cortex",
    ])
    expect(scripted.outros).toEqual([])
  })
})

describe("runLogs", () => {
  it("exits 1 when no .env exists in the target directory", async () => {
    const targetDir = join(tmpdir(), "vault-cli-logs-missing")
    const scripted = createScriptedPrompts()

    const exitCode = await runLogs(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `No .env found in ${targetDir} — run \`npx vault-cortex@latest init\` first.`,
    ])
  })

  it("exits 1 when Docker daemon is not running", async () => {
    const targetDir = makeTempTargetDir("vault-cli-logs-")
    writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts()

    const exitCode = await runLogs(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime.",
    ])
  })

  it("exits 1 with a restart hint when no container exists", async () => {
    const targetDir = makeTempTargetDir("vault-cli-logs-")
    writeLocalEnv(targetDir)
    const streamCalls: DockerLogsParams[] = []
    const dockerNoContainer: DockerRunner = {
      ...dockerReady,
      containerExists: () => false,
      streamLogs: async (params) => {
        streamCalls.push(params)
        return 0
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runLogs(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerNoContainer },
    )

    expect(exitCode).toBe(1)
    expect(streamCalls).toEqual([])
    expect(scripted.errors).toEqual([
      "No vault-cortex container — start it with `npx vault-cortex@latest restart`.",
    ])
  })

  it("passes --follow and --since through to the log stream", async () => {
    const targetDir = makeTempTargetDir("vault-cli-logs-")
    writeLocalEnv(targetDir)
    const streamCalls: DockerLogsParams[] = []
    const dockerSpy: DockerRunner = {
      ...dockerReady,
      streamLogs: async (params) => {
        streamCalls.push(params)
        return 0
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runLogs(
      { dir: targetDir, follow: true, since: "10m" },
      { prompts: scripted.prompts, docker: dockerSpy },
    )

    expect(exitCode).toBe(0)
    expect(streamCalls).toEqual([{ follow: true, since: "10m" }])
  })

  it("defaults to a non-following stream with no since bound", async () => {
    const targetDir = makeTempTargetDir("vault-cli-logs-")
    writeLocalEnv(targetDir)
    const streamCalls: DockerLogsParams[] = []
    const dockerSpy: DockerRunner = {
      ...dockerReady,
      streamLogs: async (params) => {
        streamCalls.push(params)
        return 0
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runLogs(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerSpy },
    )

    expect(exitCode).toBe(0)
    expect(streamCalls).toEqual([{ follow: false, since: undefined }])
  })

  it("passes the stream's exit code through as its own", async () => {
    const targetDir = makeTempTargetDir("vault-cli-logs-")
    writeLocalEnv(targetDir)
    const dockerInterrupted: DockerRunner = {
      ...dockerReady,
      streamLogs: async () => 130,
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runLogs(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerInterrupted },
    )

    expect(exitCode).toBe(130)
  })
})

describe("runRestart", () => {
  it("exits 1 when no .env exists in the target directory", async () => {
    const targetDir = join(tmpdir(), "vault-cli-restart-missing")
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `No .env found in ${targetDir} — run \`npx vault-cortex@latest init\` first.`,
    ])
  })

  it("exits 1 when local .env has no VAULT_PATH", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc123\n")
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `VAULT_PATH is empty or missing in ${targetDir}/.env — cannot start the container.`,
    ])
  })

  it("exits 1 when local .env has no PUBLIC_URL", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\n",
    )
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerReady, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `PUBLIC_URL not found in ${targetDir}/.env — the server requires it.\n` +
        "Add this line to your .env:\n  PUBLIC_URL=http://localhost:8000",
    ])
  })

  it("exits 1 when Docker daemon is not running", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime.",
    ])
  })

  it("never pulls an image", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeLocalEnv(targetDir)
    const pullCalls: string[] = []
    const dockerPullSpy: DockerRunner = {
      ...dockerReady,
      pullImage: (image) => {
        pullCalls.push(image)
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerPullSpy, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(pullCalls).toEqual([])
  })

  it("re-creates a local container with the vault path from .env", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
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

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerSpy, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(dockerRunParams).toEqual([
      [
        {
          mode: "local",
          envFilePath: join(targetDir, ".env"),
          port: 8000,
          vaultPath: "/home/user/MyVault",
        },
      ],
    ])
    expect(scripted.logs).toEqual([
      "Starting container...",
      "Applied the current .env settings.",
    ])
    expect(scripted.outros).toEqual(["Restart complete."])
  })

  it("re-creates a remote container without a vault path", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
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

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerSpy, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(dockerRunParams).toEqual([
      [
        {
          mode: "remote",
          envFilePath: join(targetDir, ".env"),
          port: 8000,
          vaultPath: undefined,
        },
      ],
    ])
  })

  it("exits 1 when docker run fails", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeLocalEnv(targetDir)
    const dockerRunFails: DockerRunner = {
      ...dockerReady,
      dockerRun: () => false,
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerRunFails,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual(["docker run failed — see output above."])
  })

  it("exits 1 without starting when an existing container cannot be removed", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeLocalEnv(targetDir)
    const runCalls: string[] = []
    const dockerRemoveFails: DockerRunner = {
      ...dockerReady,
      stopAndRemoveContainer: () => false,
      dockerRun: () => {
        runCalls.push("called")
        return true
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerRemoveFails,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(runCalls).toEqual([])
    expect(scripted.errors).toEqual([
      "Could not remove the existing container — check: docker rm -f vault-cortex",
    ])
  })

  it("proceeds past a failed removal probe when no container exists", async () => {
    // Engines < 23 exit non-zero from `docker rm -f` on a missing container —
    // a first-start restart must not treat that as a removal failure.
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeLocalEnv(targetDir)
    const removeCalls: string[] = []
    const dockerFirstStart: DockerRunner = {
      ...dockerReady,
      containerExists: () => false,
      stopAndRemoveContainer: () => {
        removeCalls.push("called")
        return false
      },
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerFirstStart, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(removeCalls).toEqual([])
    expect(scripted.errors).toEqual([])
  })

  it("reports failure when the health check times out", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeLocalEnv(targetDir)
    const fetchFail: typeof fetch = async () => {
      throw new Error("ECONNREFUSED")
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchFail,
        healthTimeoutMs: 20,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.spinnerMessages).toEqual([
      "start: Waiting for the server to come up",
      "stop: Server did not respond within 2 minutes — check: docker logs vault-cortex",
    ])
  })

  it("uses the PORT from .env for health polling", async () => {
    const targetDir = makeTempTargetDir("vault-cli-restart-")
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/vault\nPORT=9000\nPUBLIC_URL=http://localhost:9000\n",
    )
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (url) => {
      fetchedUrls.push(String(url))
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runRestart(
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
