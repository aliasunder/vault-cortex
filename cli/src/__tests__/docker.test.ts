import { describe, expect, it } from "vitest"

import {
  buildDockerLogsArgs,
  buildDockerRunArgs,
  buildObsidianLoginArgs,
  classifyDaemonStatus,
  CONTAINER_NAME,
  healthPollTimeoutMs,
  healthTimeoutMessage,
  LOCAL_IMAGE,
  pollHealth,
  probeHealth,
  REMOTE_IMAGE,
} from "../docker.js"

const okResponse = new Response(null, { status: 200 })
const failResponse = new Response(null, { status: 500 })

describe("buildDockerRunArgs", () => {
  it("produces the correct args for local mode", () => {
    const args = buildDockerRunArgs({
      mode: "local",
      envFilePath: "/home/user/vault-cortex/.env",
      port: 8000,
      vaultPath: "/home/user/MyVault",
    })

    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--env-file",
      "/home/user/vault-cortex/.env",
      "-e",
      "VAULT_PATH=/vault",
      "-e",
      "PORT=8000",
      "-e",
      "HOST=0.0.0.0",
      "-e",
      "INDEX_DB_PATH=/data/index.db",
      "-p",
      "8000:8000",
      "-v",
      "/home/user/MyVault:/vault:rw",
      "-v",
      "vault-cortex_mcp_data:/data",
      "--health-cmd",
      expect.stringContaining("healthz"),
      "--health-interval",
      "15s",
      "--health-timeout",
      "5s",
      "--health-retries",
      "3",
      "--health-start-period",
      "20s",
      LOCAL_IMAGE,
    ])
  })

  it("produces the correct args for remote mode", () => {
    const args = buildDockerRunArgs({
      mode: "remote",
      envFilePath: "/opt/vault-cortex/.env",
      port: 8000,
    })

    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "--restart",
      "unless-stopped",
      "--env-file",
      "/opt/vault-cortex/.env",
      "-e",
      "VAULT_PATH=/vault",
      "-e",
      "PORT=8000",
      "-e",
      "HOST=0.0.0.0",
      "-e",
      "INDEX_DB_PATH=/data/index.db",
      "-p",
      "8000:8000",
      "--hostname",
      CONTAINER_NAME,
      "-v",
      "vault-cortex_vault_data:/vault",
      "-v",
      "vault-cortex_mcp_data:/data",
      "-v",
      "vault-cortex_obsidian_config:/home/obsidian/.config",
      "--health-cmd",
      expect.stringContaining("healthz"),
      "--health-interval",
      "15s",
      "--health-timeout",
      "5s",
      "--health-retries",
      "5",
      "--health-start-period",
      "180s",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=10m",
      "--log-opt",
      "max-file=3",
      REMOTE_IMAGE,
    ])
  })

  it("uses a custom port for the host-side mapping", () => {
    const args = buildDockerRunArgs({
      mode: "local",
      envFilePath: "/tmp/.env",
      port: 9000,
      vaultPath: "/vault",
    })

    expect(args).toContain("-p")
    const portIndex = args.indexOf("-p")
    expect(args[portIndex + 1]).toBe("9000:8000")
  })

  it("overrides VAULT_PATH so the host path does not leak into the container", () => {
    const args = buildDockerRunArgs({
      mode: "local",
      envFilePath: "/tmp/.env",
      port: 8000,
      vaultPath: "/Users/me/My Vault",
    })

    const envOverrideIndex = args.indexOf("VAULT_PATH=/vault")
    expect(envOverrideIndex).toBeGreaterThan(0)
    expect(args[envOverrideIndex - 1]).toBe("-e")
  })

  it("throws when local mode is missing vaultPath", () => {
    expect(() =>
      buildDockerRunArgs({
        mode: "local",
        envFilePath: "/tmp/.env",
        port: 8000,
      }),
    ).toThrow("vaultPath is required for local mode")
  })

  it("uses compose-prefixed volume names for backward compatibility", () => {
    const localArgs = buildDockerRunArgs({
      mode: "local",
      envFilePath: "/tmp/.env",
      port: 8000,
      vaultPath: "/vault",
    })
    expect(localArgs).toContain("vault-cortex_mcp_data:/data")

    const remoteArgs = buildDockerRunArgs({
      mode: "remote",
      envFilePath: "/tmp/.env",
      port: 8000,
    })
    expect(remoteArgs).toContain("vault-cortex_vault_data:/vault")
    expect(remoteArgs).toContain("vault-cortex_mcp_data:/data")
    expect(remoteArgs).toContain(
      "vault-cortex_obsidian_config:/home/obsidian/.config",
    )
  })

  it("includes remote-specific log rotation and longer healthcheck timings", () => {
    const args = buildDockerRunArgs({
      mode: "remote",
      envFilePath: "/tmp/.env",
      port: 8000,
    })

    expect(args).toContain("--log-driver")
    expect(args).toContain("json-file")
    expect(args).toContain("--log-opt")
    expect(args).toContain("max-size=10m")

    const retriesIndex = args.indexOf("--health-retries")
    expect(args[retriesIndex + 1]).toBe("5")
    const startPeriodIndex = args.indexOf("--health-start-period")
    expect(args[startPeriodIndex + 1]).toBe("180s")
  })
})

describe("buildObsidianLoginArgs", () => {
  it("produces the correct args on macOS (no --user flag)", () => {
    const args = buildObsidianLoginArgs({
      configMountPath: "/tmp/vault-cortex-sync-token-abc",
      platform: "darwin",
      uid: 501,
      gid: 20,
    })

    expect(args).toEqual([
      "run",
      "--rm",
      "-it",
      "--entrypoint",
      "ob",
      "-v",
      "/tmp/vault-cortex-sync-token-abc:/home/obsidian/.config",
      REMOTE_IMAGE,
      "login",
    ])
  })

  it("includes --user uid:gid on Linux", () => {
    const args = buildObsidianLoginArgs({
      configMountPath: "/tmp/vault-cortex-sync-token-abc",
      platform: "linux",
      uid: 1000,
      gid: 1000,
    })

    expect(args).toEqual([
      "run",
      "--rm",
      "-it",
      "--entrypoint",
      "ob",
      "-v",
      "/tmp/vault-cortex-sync-token-abc:/home/obsidian/.config",
      "--user",
      "1000:1000",
      REMOTE_IMAGE,
      "login",
    ])
  })

  it("omits --user on Linux when uid/gid are not provided", () => {
    const args = buildObsidianLoginArgs({
      configMountPath: "/tmp/test",
      platform: "linux",
    })

    expect(args).toEqual([
      "run",
      "--rm",
      "-it",
      "--entrypoint",
      "ob",
      "-v",
      "/tmp/test:/home/obsidian/.config",
      REMOTE_IMAGE,
      "login",
    ])
  })
})

describe("healthPollTimeoutMs", () => {
  it("gives remote mode a 4-minute budget for the first-sync gate", () => {
    expect(healthPollTimeoutMs("remote")).toBe(240_000)
  })

  it("keeps the local-mode budget at 2 minutes", () => {
    expect(healthPollTimeoutMs("local")).toBe(120_000)
  })
})

describe("healthTimeoutMessage", () => {
  it("renders the local budget as 2 minutes", () => {
    expect(healthTimeoutMessage("local", 120_000)).toBe(
      "Server did not respond within 2 minutes — check: docker logs vault-cortex",
    )
  })

  it("adds the first-sync hint to the remote 4-minute message", () => {
    expect(healthTimeoutMessage("remote", 240_000)).toBe(
      "Server did not respond within 4 minutes — check: docker logs vault-cortex (a long first sync may still be running — the container keeps starting in the background)",
    )
  })
})

describe("pollHealth", () => {
  it("returns true as soon as the endpoint responds ok", async () => {
    const fetchStub = async (): Promise<Response> => okResponse

    const healthy = await pollHealth(
      { url: "http://127.0.0.1:8000/healthz", timeoutMs: 100, intervalMs: 1 },
      fetchStub,
    )

    expect(healthy).toBe(true)
  })

  it("keeps polling through connection errors until the endpoint comes up", async () => {
    const responses: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => Promise.resolve(failResponse),
      () => Promise.resolve(okResponse),
    ]
    const fetchStub: typeof fetch = () => {
      const nextResponse = responses.shift()
      if (nextResponse === undefined)
        throw new Error("fetch called after success")
      return nextResponse()
    }

    const healthy = await pollHealth(
      {
        url: "http://127.0.0.1:8000/healthz",
        timeoutMs: 1_000,
        intervalMs: 1,
      },
      fetchStub,
    )

    expect(healthy).toBe(true)
    expect(responses).toHaveLength(0)
  })

  it("returns false when the endpoint never responds within the timeout", async () => {
    const fetchStub = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED")
    }

    const healthy = await pollHealth(
      { url: "http://127.0.0.1:8000/healthz", timeoutMs: 20, intervalMs: 1 },
      fetchStub,
    )

    expect(healthy).toBe(false)
  })
})

describe("buildDockerLogsArgs", () => {
  it("targets the container with no flags by default", () => {
    expect(buildDockerLogsArgs({ follow: false })).toEqual([
      "logs",
      CONTAINER_NAME,
    ])
  })

  it("adds --follow when requested", () => {
    expect(buildDockerLogsArgs({ follow: true })).toEqual([
      "logs",
      "--follow",
      CONTAINER_NAME,
    ])
  })

  it("adds --since with its value when provided", () => {
    expect(buildDockerLogsArgs({ follow: false, since: "10m" })).toEqual([
      "logs",
      "--since",
      "10m",
      CONTAINER_NAME,
    ])
  })

  it("combines --follow and --since in flag order", () => {
    expect(buildDockerLogsArgs({ follow: true, since: "2h" })).toEqual([
      "logs",
      "--follow",
      "--since",
      "2h",
      CONTAINER_NAME,
    ])
  })
})

describe("classifyDaemonStatus", () => {
  it("classifies a zero exit as running", () => {
    expect(classifyDaemonStatus({ status: 0 })).toBe("running")
  })

  it("classifies a non-zero exit as not-running", () => {
    expect(classifyDaemonStatus({ status: 1 })).toBe("not-running")
  })

  it("classifies a missing docker binary (ENOENT) as not-installed", () => {
    const spawnError = Object.assign(new Error("spawn docker ENOENT"), {
      code: "ENOENT",
    })

    expect(classifyDaemonStatus({ status: null, error: spawnError })).toBe(
      "not-installed",
    )
  })

  it("classifies a spawn timeout as not-running, not not-installed", () => {
    // A timeout also yields status null — only the ENOENT code may mean
    // "not installed"; a wedged daemon must get start guidance, not install.
    const spawnError = Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
      code: "ETIMEDOUT",
    })

    expect(classifyDaemonStatus({ status: null, error: spawnError })).toBe(
      "not-running",
    )
  })
})

describe("probeHealth", () => {
  it("returns true when the endpoint responds ok", async () => {
    const probeResult = await probeHealth(
      { url: "http://example.test/healthz" },
      async () => okResponse,
    )

    expect(probeResult).toBe(true)
  })

  it("returns false on a non-2xx response", async () => {
    const probeResult = await probeHealth(
      { url: "http://example.test/healthz" },
      async () => failResponse,
    )

    expect(probeResult).toBe(false)
  })

  it("returns false when the fetch throws", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED")
    }

    const probeResult = await probeHealth(
      { url: "http://example.test/healthz" },
      failingFetch,
    )

    expect(probeResult).toBe(false)
  })

  it("passes an abort signal so a black-holed request cannot hang", async () => {
    const seenSignals: (AbortSignal | null | undefined)[] = []
    const recordingFetch: typeof fetch = async (_input, init) => {
      seenSignals.push(init?.signal)
      return okResponse
    }

    await probeHealth({ url: "http://example.test/healthz" }, recordingFetch)

    expect(seenSignals).toHaveLength(1)
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
  })
})

describe("pollHealth deadline accuracy", () => {
  it("never sleeps past the deadline after a failed attempt", async () => {
    // timeoutMs 30 with intervalMs 1000: an uncapped pause would resolve
    // after ~1s; the deadline-capped pause resolves in well under 500ms.
    // Real timers with a generous margin — no scheduling internals mocked.
    const startedAt = Date.now()
    const healthy = await pollHealth(
      { url: "http://example.test/healthz", timeoutMs: 30, intervalMs: 1000 },
      async () => failResponse,
    )
    const elapsedMs = Date.now() - startedAt

    expect(healthy).toBe(false)
    expect(elapsedMs).toBeLessThan(500)
  })
})
