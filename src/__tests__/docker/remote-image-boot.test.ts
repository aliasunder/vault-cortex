/** Remote image boot tier — runs the built `:remote` image end-to-end with the
 *  obsidian-headless CLI replaced by `fixtures/ob`.
 *
 *  The s6 init chain (derive-env → setup-user → check-auth → login →
 *  setup-vault → first-sync → sync → mcp) was validated by hand against real
 *  Obsidian Sync before it shipped; this tier is the per-PR regression net
 *  for the assembled chain — ordering, published env, volume layout, guards —
 *  that the per-script `sh` specs in `src/vault-mcp/__tests__/` cannot see.
 *
 *  Needs Docker and a prior `docker build --target remote -t
 *  vault-cortex:remote-ci .`; run with `npm run test:remote-boot`
 *  (REMOTE_IMAGE overrides the tag).
 *
 *  One container per describe block: a boot is the expensive resource that
 *  justifies `beforeAll` over const-per-test. Each test then reads its own
 *  state from the container — nothing is mutated between tests, and the
 *  restart block re-derives its handle from the boot it nests under. */

import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { callTool, textContent } from "../integration/test-harness.js"
import {
  assertImagePresent,
  containerLogs,
  createClient,
  docker,
  execInContainer,
  listFilesInContainer,
  pathExistsInContainer,
  publishedPort,
  readContainerFile,
  runContainer,
  waitForHealthz,
  waitForStopped,
} from "./docker-harness.js"
import type { ContainerHandle } from "./docker-harness.js"

const IMAGE = process.env.REMOTE_IMAGE ?? "vault-cortex:remote-ci"

/** Deliberately low-entropy fixtures so secret scanners never flag them. The
 *  Sync token only has to be non-empty (init-check-auth) — the stub ignores
 *  it; the MCP token is what the test client authenticates with. */
const FAKE_SYNC_TOKEN = "fake-obsidian-sync-token-for-ci"
const FAKE_MCP_TOKEN = "fake-mcp-token-for-ci"

const BOOT_DEADLINE_MS = 120_000
const STOP_DEADLINE_MS = 60_000

/** Env every scenario shares. Embeddings stay off so the boot doesn't
 *  download a model; the chain under test doesn't touch search ranking. */
const BASE_ENV = {
  OBSIDIAN_AUTH_TOKEN: FAKE_SYNC_TOKEN,
  VAULT_NAME: "ci-vault",
  DEVICE_NAME: "ci-device",
  MCP_AUTH_TOKEN: FAKE_MCP_TOKEN,
  EMBEDDING_ENABLED: "false",
}

/** Every `ob` call one boot makes, in order, for BASE_ENV (only the
 *  sync-config flags whose env var is set are applied; SYNC_CONFIGS has a
 *  baked-in default). The stub appends "$*" per call. */
const EXPECTED_BOOT_SEQUENCE = [
  "login",
  "sync-setup --vault ci-vault --device-name ci-device",
  "sync-config --device-name ci-device",
  "sync-config --configs core-plugin-data,community-plugin-data",
  "sync",
  "sync --continuous",
]

const callLogOf = (boots: number): string =>
  Array.from({ length: boots }, () => EXPECTED_BOOT_SEQUENCE)
    .flat()
    .map((call) => `${call}\n`)
    .join("")

/** Test-owned copy of what the stub's one-shot sync writes. */
const REMOTE_BOOT_NOTE = `---
tags: [ci, remote-boot]
---

# Remote Boot

Delivered by the stubbed first sync. Links to [[Sync Log]].
`

const OWNERSHIP_LINE = "Ownership IDs changed"

const uniqueName = (scenario: string): string =>
  `remote-boot-${scenario}-${randomBytes(4).toString("hex")}`

const bootedStartedAt = async (name: string): Promise<string> => {
  const result = await docker(["inspect", "-f", "{{.State.StartedAt}}", name])
  return result.stdout.trim()
}

const readSyncedNoteOverMcp = async (port: number): Promise<string> => {
  const client = await createClient(port, FAKE_MCP_TOKEN)
  try {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Projects/Remote Boot.md" },
    })
    return textContent(result)
  } finally {
    await client.close()
  }
}

beforeAll(async () => {
  await assertImagePresent(IMAGE)
})

describe("remote image boot — three-volume layout (anonymous /vault, /data, /home/obsidian/.config)", () => {
  const name = uniqueName("three-volume")
  // Memory off keeps the vault listing exact: with it on, the server would
  // also bootstrap the About Me/ templates. The single-volume scenario
  // covers the bootstrap path.
  const env = {
    ...BASE_ENV,
    MEMORY_ENABLED: "false",
    PUBLIC_URL: "http://localhost:8000",
  }

  // Assigned once the container is up — the beforeAll boot is the one place
  // these are written; every test only reads them.
  let handle: ContainerHandle | undefined
  let port = 0

  beforeAll(async () => {
    handle = await runContainer({
      name,
      image: IMAGE,
      env,
      volumes: [],
      publishPort: true,
    })
    port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("publishes VAULT_PATH and INDEX_DB_PATH to container_environment without a trailing newline", async () => {
    const vaultPath = await readContainerFile(
      name,
      "/run/s6/container_environment/VAULT_PATH",
    )
    const indexDbPath = await readContainerFile(
      name,
      "/run/s6/container_environment/INDEX_DB_PATH",
    )
    expect({ vaultPath, indexDbPath }).toEqual({
      vaultPath: "/vault",
      indexDbPath: "/data/index.db",
    })
  })

  it("does not publish LOG_DIR or XDG_CONFIG_HOME when STORAGE_ROOT is unset", async () => {
    const logDirPublished = await pathExistsInContainer(
      name,
      "/run/s6/container_environment/LOG_DIR",
    )
    const xdgPublished = await pathExistsInContainer(
      name,
      "/run/s6/container_environment/XDG_CONFIG_HOME",
    )
    expect({ logDirPublished, xdgPublished }).toEqual({
      logDirPublished: false,
      xdgPublished: false,
    })
  })

  it("records the applied ownership IDs as 1000:1000 in the default config dir", async () => {
    const appliedIds = await readContainerFile(
      name,
      "/home/obsidian/.config/.applied-ids",
    )
    expect(appliedIds).toBe("1000:1000\n")
  })

  it("invokes the Sync client in the documented order: login, sync-setup, sync-config ×2, sync, sync --continuous", async () => {
    const callLog = await readContainerFile(
      name,
      "/home/obsidian/.config/ob-calls.log",
    )
    expect(callLog).toBe(callLogOf(1))
  })

  it("writes the first-sync sentinel to /home/obsidian/.config/.vault-synced", async () => {
    expect(
      await pathExistsInContainer(name, "/home/obsidian/.config/.vault-synced"),
    ).toBe(true)
  })

  it("creates the search index at /data/index.db", async () => {
    expect(await pathExistsInContainer(name, "/data/index.db")).toBe(true)
  })

  it("keeps `ob sync --continuous` supervised as svc-obsidian-sync", async () => {
    const status = await execInContainer(name, [
      "/command/s6-svstat",
      "-o",
      "up",
      "/run/service/svc-obsidian-sync",
    ])
    expect(status.stdout.trim()).toBe("true")
  })

  it("runs the MCP server as the obsidian user (UID 1000)", async () => {
    const pidResult = await execInContainer(name, [
      "/command/s6-svstat",
      "-o",
      "pid",
      "/run/service/svc-vault-mcp",
    ])
    const pid = pidResult.stdout.trim()
    const owner = await execInContainer(name, [
      "stat",
      "-c",
      "%u",
      `/proc/${pid}`,
    ])
    expect(owner.stdout.trim()).toBe("1000")
  })

  it("serves a note delivered by the first sync over MCP", async () => {
    expect(await readSyncedNoteOverMcp(port)).toBe(REMOTE_BOOT_NOTE)
  })

  it("indexes the first-sync notes before reporting healthy", async () => {
    const client = await createClient(port, FAKE_MCP_TOKEN)
    try {
      const result = await callTool({
        client,
        name: "vault_search",
        args: { query: "stubbed first sync" },
      })
      const searchResponse: unknown = JSON.parse(textContent(result))
      expect(searchResponse).toMatchObject({
        total: 1,
        search_mode: "fts",
        results: [{ path: "Projects/Remote Boot.md", title: "Remote Boot" }],
      })
    } finally {
      await client.close()
    }
  })

  it("leaves the vault containing exactly the first-sync notes when memory is disabled", async () => {
    expect(await listFilesInContainer(name, "/vault")).toEqual([
      "/vault/Projects/Remote Boot.md",
      "/vault/Sync Log.md",
    ])
  })
})

describe("remote image boot — single-volume layout (STORAGE_ROOT=/persist)", () => {
  const name = uniqueName("single-volume")
  const volume = `${name}-persist`
  const env = {
    ...BASE_ENV,
    STORAGE_ROOT: "/persist",
    RAILWAY_PUBLIC_DOMAIN: "ci.example.test",
  }

  // Assigned once the container is up — the beforeAll boot is the one place
  // these are written; every test only reads them.
  let handle: ContainerHandle | undefined
  let port = 0

  beforeAll(async () => {
    handle = await runContainer({
      name,
      image: IMAGE,
      env,
      volumes: [`${volume}:/persist`],
      publishPort: true,
    })
    port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("derives VAULT_PATH, INDEX_DB_PATH, LOG_DIR, XDG_CONFIG_HOME and PUBLIC_URL under /persist", async () => {
    const published = Object.fromEntries(
      await Promise.all(
        [
          "VAULT_PATH",
          "INDEX_DB_PATH",
          "LOG_DIR",
          "XDG_CONFIG_HOME",
          "PUBLIC_URL",
        ].map(async (variable) => [
          variable,
          await readContainerFile(
            name,
            `/run/s6/container_environment/${variable}`,
          ),
        ]),
      ),
    )
    expect(published).toEqual({
      VAULT_PATH: "/persist/vault",
      INDEX_DB_PATH: "/persist/data/index.db",
      LOG_DIR: "/persist/data/logs",
      XDG_CONFIG_HOME: "/persist/config",
      PUBLIC_URL: "https://ci.example.test",
    })
  })

  it("advertises the PUBLIC_URL derived from RAILWAY_PUBLIC_DOMAIN to MCP clients", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
    )
    const metadata: unknown = await response.json()
    expect(metadata).toMatchObject({
      resource: "https://ci.example.test/mcp",
      authorization_servers: ["https://ci.example.test/"],
    })
  })

  it("writes the ownership record and first-sync sentinel under /persist/config", async () => {
    const appliedIds = await readContainerFile(
      name,
      "/persist/config/.applied-ids",
    )
    const sentinelPresent = await pathExistsInContainer(
      name,
      "/persist/config/.vault-synced",
    )
    expect({ appliedIds, sentinelPresent }).toEqual({
      appliedIds: "1000:1000\n",
      sentinelPresent: true,
    })
  })

  it("creates the search index and log directory under /persist/data", async () => {
    const indexPresent = await pathExistsInContainer(
      name,
      "/persist/data/index.db",
    )
    const logsDir = await execInContainer(name, [
      "test",
      "-d",
      "/persist/data/logs",
    ])
    expect({ indexPresent, logsDirExit: logsDir.code }).toEqual({
      indexPresent: true,
      logsDirExit: 0,
    })
  })

  it("bootstraps the memory folder into the derived vault path after the first sync", async () => {
    const memoryDir = await execInContainer(name, [
      "test",
      "-d",
      "/persist/vault/About Me",
    ])
    const syncedNotePresent = await pathExistsInContainer(
      name,
      "/persist/vault/Projects/Remote Boot.md",
    )
    expect({ memoryDirExit: memoryDir.code, syncedNotePresent }).toEqual({
      memoryDirExit: 0,
      syncedNotePresent: true,
    })
  })

  it("writes nothing into the legacy /vault, /data and /home/obsidian/.config paths", async () => {
    const legacyEntries = await execInContainer(name, [
      "find",
      "/vault",
      "/data",
      "/home/obsidian/.config",
      "-mindepth",
      "1",
    ])
    expect(legacyEntries.stdout).toBe("")
  })

  describe("after docker restart", () => {
    let restartedAt = ""

    beforeAll(async () => {
      const beforeRestart = await bootedStartedAt(name)
      await docker(["restart", name])
      restartedAt = await bootedStartedAt(name)
      if (restartedAt === beforeRestart) {
        throw new Error("docker restart did not produce a new StartedAt")
      }
      port = await publishedPort(name)
      await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
    })

    it("becomes healthy again without re-fixing ownership", async () => {
      const logsSinceRestart = await containerLogs(name, restartedAt)
      expect(logsSinceRestart).toContain("[obsidian-sync] First sync complete.")
      expect(logsSinceRestart).not.toContain(OWNERSHIP_LINE)
    })

    it("keeps the ownership record unchanged", async () => {
      expect(
        await readContainerFile(name, "/persist/config/.applied-ids"),
      ).toBe("1000:1000\n")
    })

    it("runs the full Sync sequence again, appending to the first boot's log", async () => {
      expect(
        await readContainerFile(name, "/persist/config/ob-calls.log"),
      ).toBe(callLogOf(2))
    })

    it("keeps the first-sync sentinel and the synced notes", async () => {
      const sentinelPresent = await pathExistsInContainer(
        name,
        "/persist/config/.vault-synced",
      )
      const syncedNotes = (
        await listFilesInContainer(name, "/persist/vault")
      ).filter((path) => !path.startsWith("/persist/vault/About Me/"))
      expect({ sentinelPresent, syncedNotes }).toEqual({
        sentinelPresent: true,
        syncedNotes: [
          "/persist/vault/Projects/Remote Boot.md",
          "/persist/vault/Sync Log.md",
        ],
      })
    })

    it("still serves the synced note over MCP", async () => {
      expect(await readSyncedNoteOverMcp(port)).toBe(REMOTE_BOOT_NOTE)
    })
  })
})

describe("remote image boot — init-chain guards stop the container", () => {
  const bootExpectingStop = async (
    scenario: string,
    env: Record<string, string>,
  ): Promise<{ name: string; logs: string; cleanup: () => Promise<void> }> => {
    const name = uniqueName(scenario)
    const handle = await runContainer({
      name,
      image: IMAGE,
      env,
      volumes: [],
      publishPort: false,
    })
    await waitForStopped({ name, deadlineMs: STOP_DEADLINE_MS })
    return { name, logs: await containerLogs(name), cleanup: handle.cleanup }
  }

  it("refuses STORAGE_ROOT=/ with the init-derive-env error", async () => {
    const { logs, cleanup } = await bootExpectingStop("storage-root-slash", {
      ...BASE_ENV,
      STORAGE_ROOT: "/",
    })
    try {
      expect(logs).toContain(
        "[vault-cortex] ERROR: STORAGE_ROOT must be an absolute path to a directory inside a persistent mount (e.g. /persist), not '/'.",
      )
      expect(logs).toContain(
        "s6-rc: warning: unable to start service init-derive-env: command exited 1",
      )
    } finally {
      await cleanup()
    }
  })

  it("refuses a relative INDEX_DB_PATH with the init-setup-user error", async () => {
    const { logs, cleanup } = await bootExpectingStop("relative-index-db", {
      ...BASE_ENV,
      INDEX_DB_PATH: "relative/index.db",
    })
    try {
      expect(logs).toContain(
        "[obsidian-sync] ERROR: INDEX_DB_PATH must be an absolute path with at least one directory component (got 'relative/index.db').",
      )
      expect(logs).toContain(
        "s6-rc: warning: unable to start service init-setup-user: command exited 1",
      )
    } finally {
      await cleanup()
    }
  })

  it("refuses to start without OBSIDIAN_AUTH_TOKEN before ever calling the Sync client", async () => {
    const { OBSIDIAN_AUTH_TOKEN: _omitted, ...envWithoutToken } = BASE_ENV
    const { logs, cleanup } = await bootExpectingStop(
      "missing-token",
      envWithoutToken,
    )
    try {
      expect(logs).toContain(
        "[obsidian-sync] ERROR: OBSIDIAN_AUTH_TOKEN is empty or unset.",
      )
      expect(logs).toContain(
        "s6-rc: warning: unable to start service init-check-auth: command exited 1",
      )
      // A stopped container can't `exec`, so the call log is out of reach;
      // init-obsidian-login logs "Authenticated." only after `ob login`
      // returns, so its absence proves the gate fired before the stub ran.
      expect(logs).not.toContain("[obsidian-sync] Authenticated.")
    } finally {
      await cleanup()
    }
  })
})
