import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import { runConfigure } from "../configure.js"
import type { DockerRunParams, DockerRunner } from "../docker.js"
import type { Prompts } from "../prompts.js"

type ScriptedAnswer = string | boolean | string[]

/**
 * A Prompts stub that replays canned answers in order and records what was
 * asked — same shape as the init.test.ts stub.
 */
const createScriptedPrompts = (answers: ScriptedAnswer[]) => {
  const remaining = [...answers]
  const asked: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const logs: string[] = []
  const outros: string[] = []

  const nextAnswer = (message: string): ScriptedAnswer => {
    asked.push(message)
    const answer = remaining.shift()
    if (answer === undefined)
      throw new Error(`No scripted answer for prompt: ${message}`)
    return answer
  }

  const prompts: Prompts = {
    intro: () => {},
    outro: (message) => {
      outros.push(message)
    },
    note: () => {},
    print: () => {},
    log: (message) => {
      logs.push(message)
    },
    warn: (message) => {
      warnings.push(message)
    },
    error: (message) => {
      errors.push(message)
    },
    select: async (message) => String(nextAnswer(message)),
    multiselect: async (message) => {
      const answer = nextAnswer(message)
      if (!Array.isArray(answer)) {
        throw new Error(
          `multiselect needs a string[] scripted answer, got: ${String(answer)}`,
        )
      }
      return answer
    },
    text: async (message, options) => {
      const answer = String(nextAnswer(message))
      // Mirrors @clack/prompts: an empty submission resolves to defaultValue.
      if (answer === "" && options?.defaultValue !== undefined)
        return options.defaultValue
      return answer
    },
    password: async (message) => String(nextAnswer(message)),
    confirm: async (message) => Boolean(nextAnswer(message)),
    spinner: () => ({ start: () => {}, stop: () => {} }),
  }

  return { prompts, asked, errors, warnings, logs, outros }
}

const dockerDown: DockerRunner = {
  isDaemonRunning: () => false,
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  containerExists: () => false,
  streamLogs: async () => 1,
  runObsidianLogin: () => false,
}

/** A ready daemon that records dockerRun calls for start-parameter asserts. */
const createRecordingDocker = () => {
  const dockerRunCalls: DockerRunParams[] = []
  const docker: DockerRunner = {
    isDaemonRunning: () => true,
    dockerRun: (params) => {
      dockerRunCalls.push(params)
      return true
    },
    pullImage: () => true,
    stopAndRemoveContainer: () => true,
    containerExists: () => false,
    streamLogs: async () => 0,
    runObsidianLogin: () => false,
  }
  return { docker, dockerRunCalls }
}

const fetchOk: typeof fetch = async () => new Response(null, { status: 200 })

const fetchNever: typeof fetch = async () => {
  throw new Error("fetch must not be called")
}

// Creates a temp target dir and registers its removal at creation time, so
// the suite self-cleans even when an assertion throws mid-test.
const makeTempTargetDir = (): string => {
  const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-configure-"))
  onTestFinished(() => {
    rmSync(targetDir, { recursive: true, force: true })
  })
  return targetDir
}

const LOCAL_ENV_CONTENT =
  "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\nPUBLIC_URL=http://localhost:8000\nMEMORY_ENABLED=true\nPORT=8000\n"

const writeLocalEnv = (targetDir: string): string => {
  const envFilePath = join(targetDir, ".env")
  writeFileSync(envFilePath, LOCAL_ENV_CONTENT)
  return envFilePath
}

describe("runConfigure preconditions", () => {
  it("exits 1 when no .env exists in the target directory", async () => {
    const targetDir = join(tmpdir(), "vault-cli-configure-missing")
    const scripted = createScriptedPrompts([])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `No .env found in ${targetDir} — run \`npx vault-cortex init\` first.`,
    ])
  })
})

describe("runConfigure with nothing picked", () => {
  it("changes nothing and never offers a restart", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts([[]])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(LOCAL_ENV_CONTENT)
    expect(scripted.logs).toEqual(["No settings selected — nothing changed."])
    expect(scripted.asked).toEqual([
      "Any optional settings to change? (press enter to skip)",
    ])
  })
})

describe("runConfigure with picked settings", () => {
  it("saves the changes and prints the restart hint when the daemon is down", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts([
      ["MEMORY_ENABLED"],
      false, // disable the memory layer
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(
      LOCAL_ENV_CONTENT.replace("MEMORY_ENABLED=true", "MEMORY_ENABLED=false"),
    )
    expect(scripted.logs).toEqual([
      `Updated MEMORY_ENABLED in ${targetDir}/.env.`,
    ])
    expect(scripted.warnings).toEqual([
      `Container runtime not running — settings saved.\nApply the new settings with: npx vault-cortex restart --dir "${targetDir}"`,
    ])
    expect(scripted.asked).not.toContain(
      "Restart the container now to apply the new settings?",
    )
  })

  it("saves the changes and prints the restart hint when the restart is declined", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = writeLocalEnv(targetDir)
    const { docker, dockerRunCalls } = createRecordingDocker()
    const scripted = createScriptedPrompts([
      ["MEMORY_ENABLED"],
      false, // disable the memory layer
      false, // decline the restart
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(
      LOCAL_ENV_CONTENT.replace("MEMORY_ENABLED=true", "MEMORY_ENABLED=false"),
    )
    expect(dockerRunCalls).toEqual([])
    expect(scripted.logs).toEqual([
      `Updated MEMORY_ENABLED in ${targetDir}/.env.`,
      `Apply the new settings with: npx vault-cortex restart --dir "${targetDir}"`,
    ])
    expect(scripted.outros).toEqual(["Done."])
  })

  it("re-creates the container on the new PORT when the restart is accepted", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = writeLocalEnv(targetDir)
    const { docker, dockerRunCalls } = createRecordingDocker()
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (url) => {
      fetchedUrls.push(String(url))
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      ["PORT"],
      "9100", // new host port
      true, // restart now
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker, fetchFn: fetchRecorder },
    )

    expect(exitCode).toBe(0)
    // The restart resolves the deployment from the .env written moments
    // before, so the new port drives both the port mapping and health URL.
    expect(dockerRunCalls).toEqual([
      {
        mode: "local",
        envFilePath,
        port: 9100,
        vaultPath: "/home/user/MyVault",
      },
    ])
    expect(fetchedUrls).toEqual(["http://127.0.0.1:9100/healthz"])
    expect(scripted.logs).toEqual([
      "Updated PORT in " + targetDir + "/.env.",
      "Starting container...",
      "Applied the current .env settings.",
    ])
    expect(scripted.outros).toEqual(["Configure complete."])
  })

  it("appends SYNC_MODE on a remote .env that predates the setting", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = join(targetDir, ".env")
    writeFileSync(
      envFilePath,
      "MCP_AUTH_TOKEN=abc123\nOBSIDIAN_AUTH_TOKEN=sync-token\nVAULT_NAME=MyVault\nPUBLIC_URL=https://vault.example.com\n",
    )
    const scripted = createScriptedPrompts([["SYNC_MODE"], "pull-only"])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc123\nOBSIDIAN_AUTH_TOKEN=sync-token\nVAULT_NAME=MyVault\nPUBLIC_URL=https://vault.example.com\n\nSYNC_MODE=pull-only\n",
    )
  })

  it("propagates a failed container start as exit 1", async () => {
    const targetDir = makeTempTargetDir()
    writeLocalEnv(targetDir)
    const dockerRunFails: DockerRunner = {
      isDaemonRunning: () => true,
      dockerRun: () => false,
      pullImage: () => true,
      stopAndRemoveContainer: () => true,
      containerExists: () => false,
      streamLogs: async () => 0,
      runObsidianLogin: () => false,
    }
    const scripted = createScriptedPrompts([
      ["MEMORY_ENABLED"],
      false, // disable the memory layer
      true, // restart now
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerRunFails, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual(["docker run failed — see output above."])
  })
})
