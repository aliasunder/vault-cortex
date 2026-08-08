import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import type { DockerRunner } from "../docker.js"
import { runUpgrade } from "../upgrade.js"
import {
  createScriptedPrompts,
  dockerDown,
  dockerReady,
  fetchNever,
  fetchOk,
} from "./command-stubs.js"

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
    expect(scripted.errors[0]).toContain("npx vault-cortex@latest init")
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
    expect(scripted.errors[0]).toContain("Container runtime not running")
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
    expect(scripted.errors[0]).toContain("VAULT_PATH is empty or missing")
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

  it("probes the public URL after a remote upgrade", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeRemoteEnv(targetDir)
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (input) => {
      fetchedUrls.push(String(input))
      return new Response(null, { status: 200 })
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
    // Order proves the probe ran after the container health poll.
    expect(fetchedUrls).toEqual([
      "http://127.0.0.1:8000/healthz",
      "https://vault.example.com/healthz",
    ])
  })

  it("keeps a successful remote upgrade at exit 0 when the public URL does not answer", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-upgrade-"))
    writeRemoteEnv(targetDir)
    const fetchedUrls: string[] = []
    // Localhost (the container check) answers; the public URL is unreachable
    // — the state every remote deployment is in before HTTPS is set up.
    const fetchPublicUrlDown: typeof fetch = async (input) => {
      const url = String(input)
      fetchedUrls.push(url)
      if (url.includes("127.0.0.1")) return new Response(null, { status: 200 })
      throw new Error("ECONNREFUSED")
    }
    const scripted = createScriptedPrompts()

    const exitCode = await runUpgrade(
      { dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchPublicUrlDown,
      },
    )

    // Exit 0 with the probe provably fired — informational, never a gate.
    expect(exitCode).toBe(0)
    expect(fetchedUrls).toContain("https://vault.example.com/healthz")
    expect(scripted.warnings).toEqual([
      "The server is up, but its public URL didn't answer from this machine.\n" +
        "That's expected until HTTPS (or direct port) access is set up — and\n" +
        "some networks keep a server from reaching its own public address even\n" +
        "when other devices can. Once access is set up, check from any device:\n" +
        "  curl https://vault.example.com/healthz",
    ])
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
      "MCP_AUTH_TOKEN=abc123\nVAULT_PATH=/vault\nPORT=9000\nPUBLIC_URL=http://localhost:9000\n",
    )
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (url) => {
      fetchedUrls.push(String(url))
      return new Response(null, { status: 200 })
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
