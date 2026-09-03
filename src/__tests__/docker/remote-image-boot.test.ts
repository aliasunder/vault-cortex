/** Remote image boot tests — runs the built `:remote` image end-to-end with
 *  the obsidian-headless CLI replaced by `fixtures/ob`.
 *
 *  Covers the assembled s6 init chain (derive-env → setup-user → check-auth →
 *  login → setup-vault → first-sync → sync → mcp): script ordering, the
 *  `container_environment` files each script writes, the volume layout, and
 *  the safety checks that stop the container. The per-script tests in
 *  `src/vault-mcp/__tests__/` cannot see these cross-script interactions.
 *
 *  Needs Docker; `npm run test:remote-boot` builds the image and runs the
 *  suite (REMOTE_IMAGE points the tests at a different image tag).
 *
 *  One container per describe block: a boot is the expensive resource that
 *  justifies `beforeAll` over const-per-test. Each test then reads its own
 *  state from the container; nothing is mutated between tests. A nested
 *  "after docker restart" block does not boot a second container — it
 *  restarts the one its parent booted (same name, same volumes) and
 *  re-reads the published port, which Docker may reassign. */

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
  FAKE_OBSIDIAN_ACCOUNT,
  FAKE_OBSIDIAN_API_PORT,
  assertImagePresent,
  containerExitCode,
  containerLogs,
  countSyncStateFiles,
  createClient,
  docker,
  dockerOrThrow,
  execInContainer,
  listFilesInContainer,
  pathExistsInContainer,
  publishedPort,
  readContainerFile,
  runContainer,
  seedSyncState,
  seedSyncToken,
  startContainer,
  startFakeObsidianApiInContainer,
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
/** Set below the 30 s test timeout so that a safety check that fails to
 *  stop the container reports via waitForStopped's message (with logs)
 *  rather than a bare timeout. In practice the container halts within
 *  seconds. */
const STOP_DEADLINE_MS = 20_000

/** A first sync that keeps failing takes three attempts with two 10 s
 *  sleeps between them (init-first-sync's MAX_ATTEMPTS=3), so the
 *  failing-sync scenarios get their own, longer budgets. */
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

/** Environment variables every scenario shares. Embeddings stay off so the
 *  boot doesn't download a model; the init chain under test doesn't touch
 *  search ranking. */
const BASE_ENV = {
  OBSIDIAN_AUTH_TOKEN: FAKE_SYNC_TOKEN,
  VAULT_NAME: "ci-vault",
  DEVICE_NAME: "ci-device",
  MCP_AUTH_TOKEN: FAKE_MCP_TOKEN,
  EMBEDDING_ENABLED: "false",
}

/** Every `ob` call that a single boot makes, in order, for BASE_ENV.
 *  Sync-config flags whose env var is unset are skipped, except the folder
 *  and file-type filters, which are always applied so an emptied variable
 *  clears a stored value (an empty argument shows as a trailing space);
 *  SYNC_CONFIGS has a baked-in default. The stub appends "$*" per call. */
const EXPECTED_BOOT_SEQUENCE = [
  "login",
  "sync-setup --vault ci-vault --device-name ci-device",
  "sync-config --device-name ci-device",
  "sync-config --excluded-folders ",
  "sync-config --file-types ",
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
  // Memory off keeps the vault listing exact: with memory enabled, the
  // server would also bootstrap the About Me/ templates. The single-volume
  // scenario covers the bootstrap path.
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

  it("invokes the Sync client in the documented order: login, sync-setup, sync-config ×4, sync, sync --continuous", async () => {
    const callLog = await readContainerFile({
      name,
      path: "/home/obsidian/.config/ob-calls.log",
    })
    expect(callLog).toBe(callLogOf(1))
  })

  it("records the two synced notes in the sync state under /home/obsidian/.config", async () => {
    expect(
      await countSyncStateFiles({ name, configDir: "/home/obsidian/.config" }),
    ).toBe(2)
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
      // `modified` is the boot-time mtime and `score` is an RRF float — every
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

  it("writes the ownership record and the sync state under /persist/config", async () => {
    const appliedIds = await readContainerFile({
      name,
      path: "/persist/config/.applied-ids",
    })
    const knownSyncFiles = await countSyncStateFiles({
      name,
      configDir: "/persist/config",
    })
    expect({ appliedIds, knownSyncFiles }).toEqual({
      appliedIds: "1000:1000\n",
      knownSyncFiles: 2,
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
    // Existence alone holds in either order. The stub lists the vault's
    // top-level entries just before its one-shot sync delivers anything;
    // an empty listing proves the memory folder was not there yet.
    const entriesBeforeFirstSync = await readContainerFile({
      name,
      path: "/persist/config/pre-sync-entries.log",
    })
    expect(entriesBeforeFirstSync).toBe("")
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

    it("keeps the sync state and the synced notes", async () => {
      const knownSyncFiles = await countSyncStateFiles({
        name,
        configDir: "/persist/config",
      })
      const syncedNotes = (
        await listFilesInContainer({ name, directory: "/persist/vault" })
      ).filter((path) => !path.startsWith("/persist/vault/About Me/"))
      expect({ knownSyncFiles, syncedNotes }).toEqual({
        knownSyncFiles: 2,
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
          "sync-config --excluded-folders ",
          "sync-config --file-types ",
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

    it("records no synced files", async () => {
      expect(
        await countSyncStateFiles({
          name,
          configDir: "/home/obsidian/.config",
        }),
      ).toBe(0)
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

describe("remote image boot — empty remote vault with the memory layer disabled", () => {
  // Nothing ever lands in the vault: the stub delivers no notes and memory
  // is off, so no About Me/ templates are bootstrapped either. The device
  // must stay bootable across restarts — its sync state records no files,
  // so an empty vault is not a wiped one.
  const name = uniqueName("empty-vault")
  const env = {
    ...BASE_ENV,
    MEMORY_ENABLED: "false",
    PUBLIC_URL: "http://localhost:8000",
    OB_STUB_SYNC_EMPTY: "1",
  }
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

  it("completes the first sync with an empty vault and records no files", async () => {
    expect(await containerLogs(name)).toContain(
      "[obsidian-sync] First sync complete.",
    )
    expect(await listFilesInContainer({ name, directory: "/vault" })).toEqual(
      [],
    )
    expect(
      await countSyncStateFiles({ name, configDir: "/home/obsidian/.config" }),
    ).toBe(0)
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

    it("syncs again instead of stopping on the empty-vault guard", async () => {
      const logsSinceRestart = await containerLogs(name, restartedAt)
      expect(logsSinceRestart).toContain("[obsidian-sync] First sync complete.")
      expect(logsSinceRestart).not.toContain(
        "The vault is empty but this device has previously synced.",
      )
    })
  })
})

describe("remote image boot — vault wiped after files arrived while the container ran", () => {
  // The sync state records files that arrived while the container ran, so
  // if the vault volume is emptied afterward, the next boot must stop
  // before the engine can push those files as deletions.
  const name = uniqueName("wiped-while-running")
  const env = {
    ...BASE_ENV,
    MEMORY_ENABLED: "false",
    PUBLIC_URL: "http://localhost:8000",
    OB_STUB_SYNC_EMPTY: "1",
  }
  let handle: ContainerHandle | undefined
  let restartedAt = ""

  beforeAll(async () => {
    handle = await runContainer({
      name,
      image: IMAGE,
      env,
      volumes: [],
      publishPort: true,
    })
    const port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
    // What continuous sync would do: deliver a note and record it in the
    // sync state. The exec runs as the `obsidian` user, which is the user
    // the stub normally runs as.
    await dockerOrThrow([
      "exec",
      "--user",
      "obsidian",
      "--env",
      "HOME=/home/obsidian",
      name,
      "sh",
      "-c",
      'printf "# Arrived later\n" > "/vault/Arrived Later.md" && ob sync-record "Arrived Later.md"',
    ])
    // The wipe: the vault volume emptied while device state is kept.
    await execInContainer(name, ["rm", "-f", "/vault/Arrived Later.md"])
    const beforeRestart = await bootedStartedAt(name)
    await docker(["restart", name])
    restartedAt = await bootedStartedAt(name)
    if (restartedAt === beforeRestart) {
      throw new Error("docker restart did not produce a new StartedAt")
    }
    await waitForStopped({ name, deadlineMs: STOP_DEADLINE_MS })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("stops on the next boot before any sync attempt", async () => {
    // Only the restarted boot's logs: the first boot ran a sync on purpose,
    // so "no sync attempt" can only be asserted after the restart.
    const logsSinceRestart = await containerLogs(name, restartedAt)
    expect(logsSinceRestart).toContain(
      "[obsidian-sync] ERROR: The vault is empty but this device has previously synced.",
    )
    expect(logsSinceRestart).toContain(
      "s6-rc: warning: unable to start service init-first-sync: command exited 1",
    )
    expect(logsSinceRestart).not.toContain("First sync (attempt")
  })
})

describe("remote image boot — notes deleted by hand while the container ran", () => {
  // The engine drops a file's row from the sync state when the file is
  // deleted locally, so a vault emptied on purpose while the device runs
  // leaves an empty record. The next boot must read that as "nothing to
  // push" and start normally, not as a wipe.
  const name = uniqueName("emptied-by-hand")
  const env = {
    ...BASE_ENV,
    MEMORY_ENABLED: "false",
    PUBLIC_URL: "http://localhost:8000",
    OB_STUB_SYNC_EMPTY: "1",
  }
  let handle: ContainerHandle | undefined
  let restartedAt = ""

  beforeAll(async () => {
    handle = await runContainer({
      name,
      image: IMAGE,
      env,
      volumes: [],
      publishPort: true,
    })
    const port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
    // A note arrives through continuous sync, then the user deletes it;
    // the engine records the arrival and then forgets the row.
    await dockerOrThrow([
      "exec",
      "--user",
      "obsidian",
      "--env",
      "HOME=/home/obsidian",
      name,
      "sh",
      "-c",
      'printf "# Arrived later\n" > "/vault/Arrived Later.md" && ob sync-record "Arrived Later.md" && rm "/vault/Arrived Later.md" && ob sync-forget "Arrived Later.md"',
    ])
    const beforeRestart = await bootedStartedAt(name)
    await docker(["restart", name])
    restartedAt = await bootedStartedAt(name)
    if (restartedAt === beforeRestart) {
      throw new Error("docker restart did not produce a new StartedAt")
    }
    const restartedPort = await publishedPort(name)
    await waitForHealthz({
      name,
      port: restartedPort,
      deadlineMs: BOOT_DEADLINE_MS,
    })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("boots again after the restart without the deletion-storm guard firing", async () => {
    const logsSinceRestart = await containerLogs(name, restartedAt)
    expect(logsSinceRestart).toContain("[obsidian-sync] First sync complete.")
    expect(logsSinceRestart).not.toContain(
      "The vault is empty but this device has previously synced.",
    )
  })

  it("records no files once the deleted note's row is gone", async () => {
    const knownFiles = await countSyncStateFiles({
      name,
      configDir: "/home/obsidian/.config",
    })
    expect(knownFiles).toBe(0)
  })
})

describe("remote image boot — remote vault holding only synced .obsidian/ settings", () => {
  // Settings are synced but there are no notes and memory is off. The
  // settings are recorded in the sync state, so on restart the guard must
  // read them as content too, or the device locks itself out.
  const name = uniqueName("config-only")
  const env = {
    ...BASE_ENV,
    MEMORY_ENABLED: "false",
    PUBLIC_URL: "http://localhost:8000",
    OB_STUB_SYNC_CONFIG_ONLY: "1",
  }
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

  it("records the synced settings file in the sync state", async () => {
    expect(await listFilesInContainer({ name, directory: "/vault" })).toEqual([
      "/vault/.obsidian/appearance.json",
    ])
    expect(
      await countSyncStateFiles({ name, configDir: "/home/obsidian/.config" }),
    ).toBe(1)
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

    it("reads the synced settings as content and syncs again", async () => {
      const logsSinceRestart = await containerLogs(name, restartedAt)
      expect(logsSinceRestart).toContain("[obsidian-sync] First sync complete.")
      expect(logsSinceRestart).not.toContain(
        "The vault is empty but this device has previously synced.",
      )
    })
  })
})

describe("remote image boot — safety checks in the init chain stop the container", () => {
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

  it("refuses to start without VAULT_NAME before registering the vault", async () => {
    const { VAULT_NAME: _omitted, ...envWithoutVaultName } = BASE_ENV
    const logs = await logsAfterGuardStops({
      scenario: "missing-vault-name",
      env: envWithoutVaultName,
    })
    expect(logs).toContain("[obsidian-sync] ERROR: VAULT_NAME is not set.")
    expect(logs).toContain(
      "s6-rc: warning: unable to start service init-setup-vault: command exited 1",
    )
    // init-setup-vault runs after login, so the guard fires with the
    // device authenticated but never registered against a vault.
    expect(logs).toContain("[obsidian-sync] Authenticated.")
    expect(logs).not.toContain("First sync (attempt")
  })

  it("refuses to sync an empty vault when the device's sync state records files", async () => {
    // A kept config volume (sync state recording files) with a wiped vault
    // volume would have the sync engine push every recorded file as a
    // deletion. Seed the state the way a synced device carries it, then
    // boot against an empty anonymous /vault.
    const configVolume = `${uniqueName("synced-config")}-volume`
    await seedSyncState({
      image: IMAGE,
      volume: configVolume,
      mountPath: "/home/obsidian/.config",
      knownFiles: 3,
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

/** Where the Sync client keeps its token in the single-volume layout. */
const SYNC_TOKEN_FILE = "/persist/config/obsidian-headless/auth_token"

/** Setup-mode scenarios run single-volume with a named volume, so the token
 *  the /setup page writes lands under /persist/config and survives the
 *  container's own restart. */
const setupModeEnv = (): Record<string, string> => {
  const { OBSIDIAN_AUTH_TOKEN: _omitted, ...envWithoutToken } = BASE_ENV
  return {
    ...envWithoutToken,
    STORAGE_ROOT: "/persist",
    RAILWAY_PUBLIC_DOMAIN: "ci.example.test",
    OBSIDIAN_API_URL: `http://127.0.0.1:${FAKE_OBSIDIAN_API_PORT}`,
  }
}

const postSetupForm = (
  port: number,
  fields: Record<string, string>,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  })

describe("remote image boot — setup mode (no Sync token anywhere)", () => {
  const name = uniqueName("setup-mode")
  const volume = `${name}-persist`
  let handle: ContainerHandle | undefined
  let port = 0

  beforeAll(async () => {
    handle = await runContainer({
      name,
      image: IMAGE,
      env: setupModeEnv(),
      volumes: [`${volume}:/persist`],
      publishPort: true,
    })
    port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("answers /healthz with the setup marker instead of the full server's body", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(await response.json()).toEqual({ ok: true, mode: "setup" })
  })

  it("answers every other path 503 with the derived setup URL", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: "setup required",
      setup_url: "https://ci.example.test/setup",
    })
  })

  it("publishes SETUP_MODE and skips every init step without calling the Sync client", async () => {
    const setupMode = await readContainerFile({
      name,
      path: "/run/s6/container_environment/SETUP_MODE",
    })
    const obCallsLogged = await pathExistsInContainer({
      name,
      path: "/persist/config/ob-calls.log",
    })
    const logs = await containerLogs(name)
    expect({ setupMode, obCallsLogged }).toEqual({
      setupMode: "1",
      obCallsLogged: false,
    })
    expect(logs).toContain(
      "[vault-cortex] No Obsidian Sync token yet — starting in setup mode.",
    )
    expect(logs).toContain(
      "[vault-cortex] Sign in at https://ci.example.test/setup — you will need your MCP_AUTH_TOKEN.",
    )
    expect(logs).toContain("[obsidian-sync] Setup mode — skipping login.")
    expect(logs).toContain("[obsidian-sync] Setup mode — skipping vault setup.")
    expect(logs).toContain(
      "[obsidian-sync] Setup mode — skipping the first sync.",
    )
  })

  it("keeps svc-obsidian-sync up (idle) so the setup page can be served", async () => {
    const status = await execInContainer(name, [
      "/command/s6-svstat",
      "-o",
      "up",
      "/run/service/svc-obsidian-sync",
    ])
    expect(status.stdout.trim()).toBe("true")
  })

  it("serves the sign-in page and rejects a wrong MCP token without contacting Obsidian", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/setup`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain("<h1>Connect Obsidian Sync</h1>")
    // RAILWAY_PUBLIC_DOMAIN is a container env var, so the hint proves the
    // s6 longrun hands the platform variable to the setup server.
    expect(html).toContain(
      "value from the service's Variables tab on Railway — it proves this is your server.",
    )

    const rejected = await postSetupForm(port, {
      token: "not-the-token",
      email: FAKE_OBSIDIAN_ACCOUNT.email,
      password: FAKE_OBSIDIAN_ACCOUNT.password,
    })
    expect(rejected.status).toBe(401)
    expect(await rejected.text()).toContain(
      "That MCP token does not match this server.",
    )
  })

  describe("after signing in on /setup", () => {
    let restartedPort = 0

    beforeAll(async () => {
      await startFakeObsidianApiInContainer({
        name,
        vaultName: BASE_ENV.VAULT_NAME,
      })
      const response = await postSetupForm(port, {
        token: FAKE_MCP_TOKEN,
        email: FAKE_OBSIDIAN_ACCOUNT.email,
        password: FAKE_OBSIDIAN_ACCOUNT.password,
      })
      const html = await response.text()
      if (!html.includes("<h1>Setup complete</h1>")) {
        throw new Error(`setup did not complete:\n${html}`)
      }
      // The setup server exits, the finish script halts the container.
      await waitForStopped({ name, deadlineMs: STOP_DEADLINE_MS })
    }, 60_000)

    it("stops the container with exit code 1 after announcing the restart", async () => {
      const exitCode = await containerExitCode(name)
      const logs = await containerLogs(name)
      expect(exitCode).toBe(1)
      expect(logs).toContain(
        "[vault-cortex] Setup complete — restarting the container to start Obsidian Sync.",
      )
    })

    describe("on the next boot", () => {
      beforeAll(async () => {
        await startContainer(name)
        restartedPort = await publishedPort(name)
        await waitForHealthz({
          name,
          port: restartedPort,
          deadlineMs: BOOT_DEADLINE_MS,
        })
      })

      it("finds the token on the volume, mode 600, and runs the full Sync sequence", async () => {
        const token = await readContainerFile({ name, path: SYNC_TOKEN_FILE })
        const mode = await execInContainer(name, [
          "stat",
          "-c",
          "%a",
          SYNC_TOKEN_FILE,
        ])
        const callLog = await readContainerFile({
          name,
          path: "/persist/config/ob-calls.log",
        })
        const logs = await containerLogs(name)
        expect({ token, mode: mode.stdout.trim(), callLog }).toEqual({
          token: FAKE_OBSIDIAN_ACCOUNT.token,
          mode: "600",
          callLog: callLogOf(1),
        })
        expect(logs).toContain(
          "[obsidian-sync] Auth token found on the volume.",
        )
      })

      it("answers /healthz as the full server and serves the synced note over MCP", async () => {
        const response = await fetch(
          `http://127.0.0.1:${restartedPort}/healthz`,
        )
        expect(await response.json()).toEqual({ ok: true })
        expect(await readSyncedNoteOverMcp(restartedPort)).toBe(
          REMOTE_BOOT_NOTE,
        )
      })

      it("answers /setup with the already-configured page and refuses a second sign-in", async () => {
        const page = await fetch(`http://127.0.0.1:${restartedPort}/setup`)
        const post = await postSetupForm(restartedPort, {
          token: FAKE_MCP_TOKEN,
          email: FAKE_OBSIDIAN_ACCOUNT.email,
          password: FAKE_OBSIDIAN_ACCOUNT.password,
        })
        expect(page.status).toBe(200)
        expect(await page.text()).toContain("<h1>Already set up</h1>")
        expect(post.status).toBe(404)
      })
    })
  })
})

describe("remote image boot — token file on the volume rejected by the Sync client", () => {
  // The device signed in through /setup on an earlier boot; now `ob login`
  // rejects the stored token. The boot must keep the file and land in
  // setup mode with the notice — never delete the token or crash-loop.
  const name = uniqueName("stale-file-token")
  const volume = `${name}-persist`
  let handle: ContainerHandle | undefined
  let port = 0

  beforeAll(async () => {
    await seedSyncToken({
      image: IMAGE,
      volume,
      mountPath: "/persist",
      configDir: "/persist/config",
      token: "fake-stale-sync-token",
    })
    handle = await runContainer({
      name,
      image: IMAGE,
      env: { ...setupModeEnv(), OB_STUB_LOGIN_FAIL: "1" },
      volumes: [`${volume}:/persist`],
      publishPort: true,
    })
    port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("tries the login once, then boots into setup mode with the reason published", async () => {
    const callLog = await readContainerFile({
      name,
      path: "/persist/config/ob-calls.log",
    })
    const setupReason = await readContainerFile({
      name,
      path: "/run/s6/container_environment/SETUP_REASON",
    })
    const health = await (
      await fetch(`http://127.0.0.1:${port}/healthz`)
    ).json()
    const logs = await containerLogs(name)
    expect({ callLog, setupReason, health }).toEqual({
      callLog: "login\n",
      setupReason: "login-failed",
      health: { ok: true, mode: "setup" },
    })
    expect(logs).toContain("[obsidian-sync] Auth token found on the volume.")
    expect(logs).toContain(
      "[obsidian-sync] WARNING: the saved Obsidian Sync login was rejected — starting in setup mode.",
    )
  })

  it("keeps the rejected token file and tells the user on the sign-in page", async () => {
    const token = await readContainerFile({ name, path: SYNC_TOKEN_FILE })
    const html = await (await fetch(`http://127.0.0.1:${port}/setup`)).text()
    expect(token).toBe("fake-stale-sync-token")
    expect(html).toContain("Your saved Obsidian login stopped working")
  })

  it("restarts the setup server, not the container, when it dies before a sign-in", async () => {
    // Killed, the way a crash looks to s6. The rejected token on the volume
    // must not read as a completed sign-in: the finish script leaves the
    // container up and s6 brings the page back.
    await execInContainer(name, [
      "/command/s6-svc",
      "-k",
      "/run/service/svc-vault-mcp",
    ])
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
    const health = await (
      await fetch(`http://127.0.0.1:${port}/healthz`)
    ).json()
    const logs = await containerLogs(name)
    expect(health).toEqual({ ok: true, mode: "setup" })
    expect(logs).not.toContain("[vault-cortex] Setup complete")
  })
})

describe("remote image boot — env var token wins over a token file on the volume", () => {
  const name = uniqueName("env-over-file")
  const volume = `${name}-persist`
  let handle: ContainerHandle | undefined

  beforeAll(async () => {
    await seedSyncToken({
      image: IMAGE,
      volume,
      mountPath: "/persist",
      configDir: "/persist/config",
      token: "fake-file-token",
    })
    handle = await runContainer({
      name,
      image: IMAGE,
      env: {
        ...BASE_ENV,
        STORAGE_ROOT: "/persist",
        RAILWAY_PUBLIC_DOMAIN: "ci.example.test",
      },
      volumes: [`${volume}:/persist`],
      publishPort: true,
    })
    const port = await publishedPort(name)
    await waitForHealthz({ name, port, deadlineMs: BOOT_DEADLINE_MS })
  })

  afterAll(async () => {
    await handle?.cleanup()
  })

  it("boots normally on the env var without entering setup mode", async () => {
    const setupModePublished = await pathExistsInContainer({
      name,
      path: "/run/s6/container_environment/SETUP_MODE",
    })
    const callLog = await readContainerFile({
      name,
      path: "/persist/config/ob-calls.log",
    })
    const logs = await containerLogs(name)
    expect({ setupModePublished, callLog }).toEqual({
      setupModePublished: false,
      callLog: callLogOf(1),
    })
    expect(logs).toContain("[obsidian-sync] Auth token present.")
  })
})
