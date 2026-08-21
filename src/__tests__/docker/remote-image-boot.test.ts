/** Remote image boot tier — runs the built `:remote` image end-to-end with the
 *  obsidian-headless CLI replaced by `fixtures/ob`.
 *
 *  Covers the assembled s6 init chain (derive-env → setup-user → check-auth →
 *  login → setup-vault → first-sync → sync → mcp) — ordering, published env,
 *  volume layout, guards — which the per-script `sh` specs in
 *  `src/vault-mcp/__tests__/` cannot see.
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
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest"
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
  seedVolumeFile,
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
/** Under the 30 s test timeout, so a guard that fails to stop the container
 *  fails on waitForStopped's own message (with logs) rather than a bare
 *  timeout. A real guard failure halts the container within seconds. */
const STOP_DEADLINE_MS = 20_000

/** A first sync that keeps failing takes three attempts with two 10 s
 *  sleeps between them (init-first-sync's MAX_ATTEMPTS=3 when VAULT_NAME is
 *  set), so those scenarios get their own, longer budgets. */
const FAILING_SYNC_TEST_TIMEOUT_MS = 120_000
const FAILING_SYNC_STOP_DEADLINE_MS = 90_000

/** init-first-sync's progress, retry, and outcome lines all name the step —
 *  "First sync (attempt …)", "First sync failed …", "First sync did not
 *  complete …" — which is what lets a test read the whole run back in
 *  order from the merged container logs. */
const isFirstSyncLine = (line: string): boolean => line.includes("First sync")

/** Log lines init-first-sync emits across a fully failing run. */
const FIRST_SYNC_ATTEMPT_LINES = [
  "[obsidian-sync] First sync (attempt 1/3) — waiting for completion before starting services...",
  "[obsidian-sync] First sync failed — retrying in 10s...",
  "[obsidian-sync] First sync (attempt 2/3) — waiting for completion before starting services...",
  "[obsidian-sync] First sync failed — retrying in 10s...",
  "[obsidian-sync] First sync (attempt 3/3) — waiting for completion before starting services...",
]

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
    const vaultPath = await readContainerFile({
      name,
      path: "/run/s6/container_environment/VAULT_PATH",
    })
    const indexDbPath = await readContainerFile({
      name,
      path: "/run/s6/container_environment/INDEX_DB_PATH",
    })
    expect({ vaultPath, indexDbPath }).toEqual({
      vaultPath: "/vault",
      indexDbPath: "/data/index.db",
    })
  })

  it("does not publish LOG_DIR or XDG_CONFIG_HOME when STORAGE_ROOT is unset", async () => {
    const logDirPublished = await pathExistsInContainer({
      name,
      path: "/run/s6/container_environment/LOG_DIR",
    })
    const xdgPublished = await pathExistsInContainer({
      name,
      path: "/run/s6/container_environment/XDG_CONFIG_HOME",
    })
    expect({ logDirPublished, xdgPublished }).toEqual({
      logDirPublished: false,
      xdgPublished: false,
    })
  })

  it("records the applied ownership IDs as 1000:1000 in the default config dir", async () => {
    const appliedIds = await readContainerFile({
      name,
      path: "/home/obsidian/.config/.applied-ids",
    })
    expect(appliedIds).toBe("1000:1000\n")
  })

  it("invokes the Sync client in the documented order: login, sync-setup, sync-config ×2, sync, sync --continuous", async () => {
    const callLog = await readContainerFile({
      name,
      path: "/home/obsidian/.config/ob-calls.log",
    })
    expect(callLog).toBe(callLogOf(1))
  })

  it("writes the first-sync sentinel to /home/obsidian/.config/.vault-synced", async () => {
    expect(
      await pathExistsInContainer({
        name,
        path: "/home/obsidian/.config/.vault-synced",
      }),
    ).toBe(true)
  })

  it("creates the search index at /data/index.db", async () => {
    expect(await pathExistsInContainer({ name, path: "/data/index.db" })).toBe(
      true,
    )
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
      // `modified` is the boot-time mtime and `score` an RRF float — every
      // other field of the response is fixed by the fixture, so pin those.
      const isSearchResponse = (
        value: unknown,
      ): value is { results: Record<string, unknown>[] } =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray(Reflect.get(value, "results"))
      if (!isSearchResponse(searchResponse)) {
        throw new Error(
          `unexpected vault_search response: ${textContent(result)}`,
        )
      }
      const deterministicResults = searchResponse.results.map(
        ({ modified: _modified, score: _score, ...fixedFields }) => fixedFields,
      )
      expect({ ...searchResponse, results: deterministicResults }).toEqual({
        total: 1,
        search_mode: "fts",
        reranked: false,
        results: [
          {
            path: "Projects/Remote Boot.md",
            title: "Remote Boot",
            folder: "Projects",
            kind: "note",
            type: null,
            tags: ["ci", "remote-boot"],
            bytes: 108,
            snippet:
              "\n# Remote Boot\n\nDelivered by the stubbed first sync. Links to [[Sync Log]].\n",
          },
        ],
      })
    } finally {
      await client.close()
    }
  })

  it("leaves the vault containing exactly the first-sync notes when memory is disabled", async () => {
    expect(await listFilesInContainer({ name, directory: "/vault" })).toEqual([
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
          await readContainerFile({
            name,
            path: `/run/s6/container_environment/${variable}`,
          }),
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
    expect(metadata).toEqual({
      resource: "https://ci.example.test/mcp",
      authorization_servers: ["https://ci.example.test/"],
      scopes_supported: ["vault"],
      resource_documentation: "https://github.com/aliasunder/vault-cortex",
    })
  })

  it("writes the ownership record and first-sync sentinel under /persist/config", async () => {
    const appliedIds = await readContainerFile({
      name,
      path: "/persist/config/.applied-ids",
    })
    const sentinelPresent = await pathExistsInContainer({
      name,
      path: "/persist/config/.vault-synced",
    })
    expect({ appliedIds, sentinelPresent }).toEqual({
      appliedIds: "1000:1000\n",
      sentinelPresent: true,
    })
  })

  it("creates the search index and log directory under /persist/data", async () => {
    const indexPresent = await pathExistsInContainer({
      name,
      path: "/persist/data/index.db",
    })
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
    const syncedNotePresent = await pathExistsInContainer({
      name,
      path: "/persist/vault/Projects/Remote Boot.md",
    })
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
    // Assert both exit code and stdout: code 0 proves all three
    // directories exist (find errors on a missing path), stdout ""
    // proves they're empty. Without the code check, a missing directory
    // would coincidentally pass (find errors to stderr, stdout stays "").
    expect({ code: legacyEntries.code, stdout: legacyEntries.stdout }).toEqual({
      code: 0,
      stdout: "",
    })
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
        await readContainerFile({ name, path: "/persist/config/.applied-ids" }),
      ).toBe("1000:1000\n")
    })

    it("runs the full Sync sequence again, appending to the first boot's log", async () => {
      expect(
        await readContainerFile({ name, path: "/persist/config/ob-calls.log" }),
      ).toBe(callLogOf(2))
    })

    it("keeps the first-sync sentinel and the synced notes", async () => {
      const sentinelPresent = await pathExistsInContainer({
        name,
        path: "/persist/config/.vault-synced",
      })
      const syncedNotes = (
        await listFilesInContainer({ name, directory: "/persist/vault" })
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

describe("remote image boot — first sync keeps failing (OB_STUB_SYNC_FAIL=1)", () => {
  describe("with the memory layer enabled and no memory folder synced", () => {
    it(
      "retries three times, then refuses to start so the server cannot bootstrap templates over unsynced notes",
      async () => {
        const name = uniqueName("failing-sync-memory-on")
        const handle = await runContainer({
          name,
          image: IMAGE,
          env: { ...BASE_ENV, OB_STUB_SYNC_FAIL: "1" },
          volumes: [],
          publishPort: false,
        })
        onTestFinished(handle.cleanup)
        await waitForStopped({
          name,
          deadlineMs: FAILING_SYNC_STOP_DEADLINE_MS,
        })
        const logs = await containerLogs(name)
        const attemptLines = logs.split("\n").filter(isFirstSyncLine)
        expect(attemptLines).toEqual([
          ...FIRST_SYNC_ATTEMPT_LINES,
          "[obsidian-sync] ERROR: First sync failed and the memory folder ('About Me') has not synced yet.",
        ])
        expect(logs).toContain(
          "s6-rc: warning: unable to start service init-first-sync: command exited 1",
        )
      },
      FAILING_SYNC_TEST_TIMEOUT_MS,
    )
  })

  describe("with the memory layer disabled", () => {
    const name = uniqueName("failing-sync-memory-off")
    const env = {
      ...BASE_ENV,
      OB_STUB_SYNC_FAIL: "1",
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

    it("retries three times, warns, and starts the services anyway", async () => {
      const logs = await containerLogs(name)
      const attemptLines = logs.split("\n").filter(isFirstSyncLine)
      expect(attemptLines).toEqual([
        ...FIRST_SYNC_ATTEMPT_LINES,
        "[obsidian-sync] WARNING: First sync did not complete — starting services anyway.",
      ])
    })

    it("calls `ob sync` once per attempt before handing over to continuous sync", async () => {
      const callLog = await readContainerFile({
        name,
        path: "/home/obsidian/.config/ob-calls.log",
      })
      expect(callLog).toBe(
        [
          "login",
          "sync-setup --vault ci-vault --device-name ci-device",
          "sync-config --device-name ci-device",
          "sync-config --configs core-plugin-data,community-plugin-data",
          "sync",
          "sync",
          "sync",
          "sync --continuous",
        ]
          .map((call) => `${call}\n`)
          .join(""),
      )
    })

    it("does not write the first-sync sentinel", async () => {
      expect(
        await pathExistsInContainer({
          name,
          path: "/home/obsidian/.config/.vault-synced",
        }),
      ).toBe(false)
    })

    it("serves an empty vault over MCP rather than refusing requests", async () => {
      const client = await createClient(port, FAKE_MCP_TOKEN)
      try {
        const result = await callTool({
          client,
          name: "vault_list_notes",
          args: {},
        })
        expect(JSON.parse(textContent(result))).toEqual([])
      } finally {
        await client.close()
      }
    })
  })
})

describe("remote image boot — init-chain guards stop the container", () => {
  /** Boot with the given env, register cleanup for the current test before
   *  anything can throw, and return the logs once the container has stopped
   *  on its own. */
  const logsAfterGuardStops = async ({
    scenario,
    env,
    volumes = [],
  }: {
    scenario: string
    env: Record<string, string>
    volumes?: string[]
  }): Promise<string> => {
    const name = uniqueName(scenario)
    const handle = await runContainer({
      name,
      image: IMAGE,
      env,
      volumes,
      publishPort: false,
    })
    onTestFinished(handle.cleanup)
    await waitForStopped({ name, deadlineMs: STOP_DEADLINE_MS })
    return containerLogs(name)
  }

  it("refuses STORAGE_ROOT=/ with the init-derive-env error", async () => {
    const logs = await logsAfterGuardStops({
      scenario: "storage-root-slash",
      env: { ...BASE_ENV, STORAGE_ROOT: "/" },
    })
    expect(logs).toContain(
      "[vault-cortex] ERROR: STORAGE_ROOT must be an absolute path to a directory inside a persistent mount (e.g. /persist), not '/'.",
    )
    expect(logs).toContain(
      "s6-rc: warning: unable to start service init-derive-env: command exited 1",
    )
  })

  it("refuses a relative INDEX_DB_PATH with the init-setup-user error", async () => {
    const logs = await logsAfterGuardStops({
      scenario: "relative-index-db",
      env: { ...BASE_ENV, INDEX_DB_PATH: "relative/index.db" },
    })
    expect(logs).toContain(
      "[obsidian-sync] ERROR: INDEX_DB_PATH must be an absolute path with at least one directory component (got 'relative/index.db').",
    )
    expect(logs).toContain(
      "s6-rc: warning: unable to start service init-setup-user: command exited 1",
    )
  })

  it("refuses to start without OBSIDIAN_AUTH_TOKEN before ever calling the Sync client", async () => {
    const { OBSIDIAN_AUTH_TOKEN: _omitted, ...envWithoutToken } = BASE_ENV
    const logs = await logsAfterGuardStops({
      scenario: "missing-token",
      env: envWithoutToken,
    })
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
  })

  it("refuses to sync an empty vault when a previous sync's sentinel is present", async () => {
    // The #440 data-loss guard: a kept config volume (device state + sentinel)
    // with a wiped vault volume would have the sync engine push every
    // previously-synced file as a deletion. Seed the sentinel the way a prior
    // boot would leave it, then boot against an empty anonymous /vault.
    const configVolume = `${uniqueName("synced-config")}-volume`
    await seedVolumeFile({
      image: IMAGE,
      volume: configVolume,
      mountPath: "/home/obsidian/.config",
      file: ".vault-synced",
    })
    const logs = await logsAfterGuardStops({
      scenario: "empty-vault-after-sync",
      env: BASE_ENV,
      volumes: [`${configVolume}:/home/obsidian/.config`],
    })
    expect(logs).toContain(
      "[obsidian-sync] ERROR: The vault is empty but this device has previously synced.",
    )
    expect(logs).toContain(
      "s6-rc: warning: unable to start service init-first-sync: command exited 1",
    )
    // The guard sits before the first `ob sync`; the stub logs nothing
    // itself, but init-first-sync announces each attempt, so no attempt
    // line proves no sync was ever started.
    expect(logs).not.toContain("First sync (attempt")
  })
})
