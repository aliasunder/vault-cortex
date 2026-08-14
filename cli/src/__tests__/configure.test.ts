import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import { runConfigure } from "../configure.js"
import {
  healthTimeoutMessage,
  type DockerRunParams,
  type DockerRunner,
} from "../docker.js"
import {
  createScriptedPrompts,
  dockerDown,
  dockerNotInstalled,
  dockerReady,
  fetchNever,
  fetchOk,
} from "./command-stubs.js"

/** A ready daemon that records dockerRun calls for start-parameter asserts. */
const createRecordingDocker = () => {
  const dockerRunCalls: DockerRunParams[] = []
  const docker: DockerRunner = {
    ...dockerReady,
    containerExists: () => false,
    dockerRun: (params) => {
      dockerRunCalls.push(params)
      return true
    },
  }
  return { docker, dockerRunCalls }
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
      `No .env found in ${targetDir} — run \`npx vault-cortex@latest init\` first.`,
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
    expect(scripted.logs).toEqual(["No changes to apply."])
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
      `Container runtime not running — settings saved.\nApply the new settings with: npx vault-cortex@latest restart --dir "${targetDir}"`,
    ])
    expect(scripted.asked).toEqual([
      "Any optional settings to change? (press enter to skip)",
      "Enable the memory layer (About Me/ folder + memory tools)?",
    ])
  })

  it("saves the changes and names the missing runtime when Docker is not installed", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts([
      ["MEMORY_ENABLED"],
      false, // disable the memory layer
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerNotInstalled,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(
      LOCAL_ENV_CONTENT.replace("MEMORY_ENABLED=true", "MEMORY_ENABLED=false"),
    )
    expect(scripted.warnings).toEqual([
      `No container runtime found — settings saved.\nApply the new settings with: npx vault-cortex@latest restart --dir "${targetDir}"`,
    ])
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
      `Apply the new settings with: npx vault-cortex@latest restart --dir "${targetDir}"`,
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
    // The derived PUBLIC_URL follows the port and is reported as changed.
    expect(readFileSync(envFilePath, "utf8").split("\n")).toContain(
      "PUBLIC_URL=http://localhost:9100",
    )
    expect(scripted.logs).toEqual([
      `Updated PORT, PUBLIC_URL in ${targetDir}/.env.`,
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

  it("replaces an active daily notes folder with a new value", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = join(targetDir, ".env")
    const envWithDailyNotes = `${LOCAL_ENV_CONTENT}DAILY_NOTES_FOLDER=Journal\n`
    writeFileSync(envFilePath, envWithDailyNotes)
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "Planner"])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(
      `${LOCAL_ENV_CONTENT}DAILY_NOTES_FOLDER=Planner\n`,
    )
    expect(scripted.logs).toEqual([
      `Updated DAILY_NOTES_FOLDER in ${targetDir}/.env.`,
    ])
  })

  it("uncomments the template's daily notes folder line on a typed value", async () => {
    // The generated .env carries the var as a commented template line — the
    // chooser's value must land by uncommenting it, not by appending a
    // duplicate.
    const targetDir = makeTempTargetDir()
    const envFilePath = join(targetDir, ".env")
    writeFileSync(
      envFilePath,
      `${LOCAL_ENV_CONTENT}\n# DAILY_NOTES_FOLDER=Journal\n# DAILY_NOTES_FORMAT=YYYY-MM-DD\n`,
    )
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "Planner"])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(
      `${LOCAL_ENV_CONTENT}\nDAILY_NOTES_FOLDER=Planner\n# DAILY_NOTES_FORMAT=YYYY-MM-DD\n`,
    )
  })

  it("treats a picked-then-blanked daily notes setting as no changes to apply", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = writeLocalEnv(targetDir)
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], ""])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(LOCAL_ENV_CONTENT)
    expect(scripted.logs).toEqual([
      "Left unset — the server reads this setting from your vault's own config.",
      "No changes to apply.",
    ])
  })

  it("neither claims an update nor offers a restart when a set daily notes folder is blank-kept", async () => {
    // A blank submit on a set value keeps it — configure must not log
    // "Updated ..." or offer a restart for a byte-identical file.
    const targetDir = makeTempTargetDir()
    const envFilePath = join(targetDir, ".env")
    const envWithDailyNotes = `${LOCAL_ENV_CONTENT}DAILY_NOTES_FOLDER=Journal\n`
    writeFileSync(envFilePath, envWithDailyNotes)
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], ""])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(readFileSync(envFilePath, "utf8")).toBe(envWithDailyNotes)
    expect(scripted.logs).toEqual([
      "Kept the current value (Journal).",
      "No changes to apply.",
    ])
    expect(scripted.warnings).toEqual([])
  })

  it("keeps the saved change and exits 1 when the .env cannot start a container", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = join(targetDir, ".env")
    // Passes the light init'd-dir gate (detectMode sees a local .env) but
    // fails resolveDeployment's start validation: no PUBLIC_URL.
    writeFileSync(
      envFilePath,
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\nMEMORY_ENABLED=true\n",
    )
    const { docker, dockerRunCalls } = createRecordingDocker()
    const scripted = createScriptedPrompts([
      ["MEMORY_ENABLED"],
      false, // disable the memory layer
      true, // restart now
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `PUBLIC_URL not found in ${targetDir}/.env — the server requires it.\n` +
        `Add this line to your .env:\n  PUBLIC_URL=http://localhost:8000`,
    ])
    expect(dockerRunCalls).toEqual([])
    // The settings edit itself succeeded before the restart failed — and the
    // user is told so, with the way to apply once the .env issue is fixed.
    expect(readFileSync(envFilePath, "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\nMEMORY_ENABLED=false\n",
    )
    expect(scripted.warnings).toEqual([
      `The restart did not run — your settings are saved. Fix the issue above, then apply them with: npx vault-cortex@latest restart --dir "${targetDir}"`,
    ])
  })

  it("warns when a PORT change leaves a custom PUBLIC_URL untouched", async () => {
    const targetDir = makeTempTargetDir()
    const envFilePath = join(targetDir, ".env")
    writeFileSync(
      envFilePath,
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/home/user/MyVault\nPUBLIC_URL=https://vault.example.com\nPORT=8000\n",
    )
    const scripted = createScriptedPrompts([
      ["PORT"],
      "9100", // new host port
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      { prompts: scripted.prompts, docker: dockerDown, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    const envLines = readFileSync(envFilePath, "utf8").split("\n")
    expect(envLines).toContain("PORT=9100")
    // A custom PUBLIC_URL is the user's own — never rewritten, only flagged.
    expect(envLines).toContain("PUBLIC_URL=https://vault.example.com")
    expect(scripted.warnings).toEqual([
      "PORT changed — make sure PUBLIC_URL (https://vault.example.com) still reaches the server.",
      `Container runtime not running — settings saved.\nApply the new settings with: npx vault-cortex@latest restart --dir "${targetDir}"`,
    ])
  })

  it("exits 1 when the restarted container never becomes healthy", async () => {
    const targetDir = makeTempTargetDir()
    writeLocalEnv(targetDir)
    const { docker } = createRecordingDocker()
    const fetchFail: typeof fetch = async () =>
      new Response(null, { status: 500 })
    const scripted = createScriptedPrompts([
      ["MEMORY_ENABLED"],
      false, // disable the memory layer
      true, // restart now
    ])

    const exitCode = await runConfigure(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker,
        fetchFn: fetchFail,
        healthTimeoutMs: 0,
      },
    )

    expect(exitCode).toBe(1)
    // Pins the exit to the health check, not an earlier bail-out — the
    // container started (spinner ran) and the poll timed out.
    expect(scripted.spinnerMessages).toEqual([
      "start: Waiting for the server to come up",
      `stop: ${healthTimeoutMessage(0)}`,
    ])
  })

  it("propagates a failed container start as exit 1", async () => {
    const targetDir = makeTempTargetDir()
    writeLocalEnv(targetDir)
    const dockerRunFails: DockerRunner = {
      ...dockerReady,
      containerExists: () => false,
      dockerRun: () => false,
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
