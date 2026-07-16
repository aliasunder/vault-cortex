import { describe, expect, it } from "vitest"

import {
  buildDockerRunArgs,
  buildGetTokenArgs,
  CONTAINER_NAME,
  LOCAL_IMAGE,
  pollHealth,
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
      "60s",
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
    expect(args[startPeriodIndex + 1]).toBe("60s")
  })
})

describe("buildGetTokenArgs", () => {
  it("produces the correct args on macOS (no --user flag)", () => {
    const args = buildGetTokenArgs({
      configMountPath: "/tmp/vault-cortex-get-token-abc",
      platform: "darwin",
      uid: 501,
      gid: 20,
    })

    expect(args).toEqual([
      "run",
      "--rm",
      "-it",
      "--entrypoint",
      "get-token",
      "-v",
      "/tmp/vault-cortex-get-token-abc:/home/obsidian/.config",
      REMOTE_IMAGE,
    ])
  })

  it("includes --user uid:gid on Linux", () => {
    const args = buildGetTokenArgs({
      configMountPath: "/tmp/vault-cortex-get-token-abc",
      platform: "linux",
      uid: 1000,
      gid: 1000,
    })

    expect(args).toEqual([
      "run",
      "--rm",
      "-it",
      "--entrypoint",
      "get-token",
      "-v",
      "/tmp/vault-cortex-get-token-abc:/home/obsidian/.config",
      "--user",
      "1000:1000",
      REMOTE_IMAGE,
    ])
  })

  it("omits --user on Linux when uid/gid are not provided", () => {
    const args = buildGetTokenArgs({
      configMountPath: "/tmp/test",
      platform: "linux",
    })

    expect(args).toEqual([
      "run",
      "--rm",
      "-it",
      "--entrypoint",
      "get-token",
      "-v",
      "/tmp/test:/home/obsidian/.config",
      REMOTE_IMAGE,
    ])
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
