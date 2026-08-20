import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Behavioral spec for the remote image's boot-time env derivation
 * (rootfs/etc/s6-overlay/scripts/print-derived-env). The script decides
 * where the vault, index, and Obsidian Sync state live and whether
 * PUBLIC_URL can be filled in from a hosting platform's variable, so each
 * branch runs the real script under `sh` with a minimal environment — only
 * PATH plus the case's vars, never the host's process.env, so an "unset"
 * case can't be contaminated by the developer's shell.
 */

const SCRIPT_PATH = resolve(
  __dirname,
  "../../../rootfs/etc/s6-overlay/scripts/print-derived-env",
)

type PrinterRun = {
  status: number | null
  stdout: string
  stderr: string
}

const runPrinter = (env: Record<string, string>): PrinterRun => {
  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("print-derived-env — storage layout", () => {
  it("emits the historical defaults when STORAGE_ROOT is unset", () => {
    const run = runPrinter({})

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("VAULT_PATH=/vault\nINDEX_DB_PATH=/data/index.db\n")
    expect(run.stderr).toBe("")
  })

  it("emits nothing when STORAGE_ROOT is unset and both paths are already set", () => {
    const run = runPrinter({
      VAULT_PATH: "/custom/vault",
      INDEX_DB_PATH: "/custom/index.db",
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe("")
  })

  it("treats an empty path var like an unset one", () => {
    const run = runPrinter({ VAULT_PATH: "", INDEX_DB_PATH: "" })

    expect(run.stdout).toBe("VAULT_PATH=/vault\nINDEX_DB_PATH=/data/index.db\n")
  })

  it("derives vault, index, and config paths under STORAGE_ROOT", () => {
    const run = runPrinter({ STORAGE_ROOT: "/persist" })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      "VAULT_PATH=/persist/vault\nINDEX_DB_PATH=/persist/data/index.db\nXDG_CONFIG_HOME=/persist/config\n",
    )
    expect(run.stderr).toBe("")
  })

  it("strips one trailing slash from STORAGE_ROOT", () => {
    const run = runPrinter({ STORAGE_ROOT: "/persist/" })

    expect(run.stdout).toBe(
      "VAULT_PATH=/persist/vault\nINDEX_DB_PATH=/persist/data/index.db\nXDG_CONFIG_HOME=/persist/config\n",
    )
  })

  it("resolves STORAGE_ROOT=/ to the historical layout", () => {
    const run = runPrinter({ STORAGE_ROOT: "/" })

    expect(run.stdout).toBe(
      "VAULT_PATH=/vault\nINDEX_DB_PATH=/data/index.db\nXDG_CONFIG_HOME=/config\n",
    )
  })

  it("keeps an explicit VAULT_PATH when STORAGE_ROOT is set", () => {
    const run = runPrinter({
      STORAGE_ROOT: "/persist",
      VAULT_PATH: "/persist/custom-vault",
    })

    expect(run.stdout).toBe(
      "INDEX_DB_PATH=/persist/data/index.db\nXDG_CONFIG_HOME=/persist/config\n",
    )
  })

  it("treats an empty STORAGE_ROOT as unset", () => {
    const run = runPrinter({ STORAGE_ROOT: "" })

    expect(run.stdout).toBe("VAULT_PATH=/vault\nINDEX_DB_PATH=/data/index.db\n")
  })

  it("never derives LOG_DIR, even under STORAGE_ROOT", () => {
    const run = runPrinter({ STORAGE_ROOT: "/persist" })

    expect(run.stdout).not.toContain("LOG_DIR=")
  })
})

describe("print-derived-env — PUBLIC_URL", () => {
  it.each([
    ["RENDER_EXTERNAL_URL", "https://x.onrender.com", "https://x.onrender.com"],
    ["RAILWAY_PUBLIC_DOMAIN", "x.up.railway.app", "https://x.up.railway.app"],
    ["FLY_APP_NAME", "my-app", "https://my-app.fly.dev"],
  ])(
    "derives PUBLIC_URL from %s",
    (platformVar, platformValue, expectedUrl) => {
      const run = runPrinter({
        VAULT_PATH: "/vault",
        INDEX_DB_PATH: "/data/index.db",
        [platformVar]: platformValue,
      })

      expect(run.status).toBe(0)
      expect(run.stdout).toBe(`PUBLIC_URL=${expectedUrl}\n`)
      expect(run.stderr).toBe(
        `[vault-cortex] PUBLIC_URL derived from ${platformVar}\n`,
      )
    },
  )

  it("prefers RENDER_EXTERNAL_URL over the Railway and Fly variables", () => {
    const run = runPrinter({
      VAULT_PATH: "/vault",
      INDEX_DB_PATH: "/data/index.db",
      RENDER_EXTERNAL_URL: "https://x.onrender.com",
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      FLY_APP_NAME: "my-app",
    })

    expect(run.stdout).toBe("PUBLIC_URL=https://x.onrender.com\n")
    expect(run.stderr).toBe(
      "[vault-cortex] PUBLIC_URL derived from RENDER_EXTERNAL_URL\n",
    )
  })

  it("prefers RAILWAY_PUBLIC_DOMAIN over FLY_APP_NAME", () => {
    const run = runPrinter({
      VAULT_PATH: "/vault",
      INDEX_DB_PATH: "/data/index.db",
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      FLY_APP_NAME: "my-app",
    })

    expect(run.stdout).toBe("PUBLIC_URL=https://x.up.railway.app\n")
    expect(run.stderr).toBe(
      "[vault-cortex] PUBLIC_URL derived from RAILWAY_PUBLIC_DOMAIN\n",
    )
  })

  it("never overrides an explicit PUBLIC_URL", () => {
    const run = runPrinter({
      VAULT_PATH: "/vault",
      INDEX_DB_PATH: "/data/index.db",
      PUBLIC_URL: "https://vault.example.com",
      RENDER_EXTERNAL_URL: "https://x.onrender.com",
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      FLY_APP_NAME: "my-app",
    })

    expect(run.stdout).toBe("")
    expect(run.stderr).toBe("")
  })

  it("leaves PUBLIC_URL unset when no platform variable is present", () => {
    const run = runPrinter({
      VAULT_PATH: "/vault",
      INDEX_DB_PATH: "/data/index.db",
    })

    expect(run.stdout).toBe("")
    expect(run.stderr).toBe("")
  })

  it("ignores an empty platform variable", () => {
    const run = runPrinter({
      VAULT_PATH: "/vault",
      INDEX_DB_PATH: "/data/index.db",
      RAILWAY_PUBLIC_DOMAIN: "",
      FLY_APP_NAME: "my-app",
    })

    expect(run.stdout).toBe("PUBLIC_URL=https://my-app.fly.dev\n")
    expect(run.stderr).toBe(
      "[vault-cortex] PUBLIC_URL derived from FLY_APP_NAME\n",
    )
  })
})
