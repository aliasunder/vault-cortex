/**
 * Shows what the image's real Sync engine does with the two cases
 * init-first-sync handles before the first sync: a file the server lists but
 * this device never downloaded (the queue step), and a downloaded file edited
 * here and then queued again in pull-only (the drop step). The other
 * remote-boot tests replace the Sync CLI with a stub, so this script is the
 * only check against the engine itself.
 *
 * For each scenario in SCENARIOS below, it runs one sync pass (the engine's
 * `_sync()` method) and prints one JSON line. The scenarios vary the sync
 * mode, the local copy, what is queued, and whether the download fails or the
 * filter excludes the file. Each line gives:
 * - how the pass ended, and the engine's log lines, including any deletion it
 *   pushed;
 * - whether the file is still queued and recorded locally afterwards;
 * - the file's contents on disk, and the stored hash of the server version it
 *   last synced from (`synchash`), each null when absent.
 *
 * The remote-boot tests under "the image's Sync engine, run on the files
 * init-first-sync queues or drops" check every line exactly.
 *
 * Runs inside the `:remote` image (`node sync-engine-oracle.ts <cli.js>`),
 * so the engine under test is the exact one the image ships. The bundle has
 * no exports, so it is compiled with its closing CLI call (`x.parse();`)
 * replaced by an export of the engine class (`is`). Both names are minified
 * identifiers of obsidian-headless 0.0.14 — AGENTS.md → "Upgrading
 * obsidian-headless" lists them for re-checking on a bump.
 *
 * The bundle resolves its config root from HOME and XDG_CONFIG_HOME once, as
 * it loads, so each scenario points both at a fresh temp directory and then
 * loads its own copy. Nothing is written under the real home directory.
 *
 * A stand-in replaces the server. Its `pull` returns the requested version's
 * bytes, or nothing to fail the download, and its `push` records the call, so
 * nothing reaches Obsidian.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** The bundle's closing CLI call, which starts the command-line parser. */
const BUNDLE_ENTRY_CALL = /x\.parse\(\);\s*$/

/** A shebang line at the top of the bundle, which `new Function` rejects. */
const SHEBANG_LINE = /^#!.*\n/

type ServerRecord = {
  path: string
  uid: number
  folder: boolean
  deleted: boolean
  hash: string
  size: number
  ctime: number
  mtime: number
}

/** A version of the file on the server, and the text its download serves. */
type ServedVersion = {
  record: ServerRecord
  contents: string
}

/** The engine's record of a local file (a local_files row). */
type LocalRecord = {
  path: string
  previouspath: string
  ctime: number
  mtime: number
  size: number
  folder: boolean
  hash: string
  synchash: string
  synctime: number
}

type FakeServer = {
  pull: (uid: number) => Promise<Uint8Array | null>
  push: (path: string, ...details: unknown[]) => Promise<void>
}

/** The engine members the scenarios read or replace. */
type SyncEngine = {
  log: (message: string, path?: string) => void
  getServer: () => Promise<FakeServer>
  onChange: (...change: unknown[]) => void
  _sync: () => Promise<boolean>
  ready: boolean
  initial: boolean
  serverFiles: Record<string, ServerRecord>
  localFiles: Record<string, LocalRecord>
  newServerFiles: ServerRecord[]
  adapter: { watch: (handler: unknown) => Promise<void>; stopWatch: () => void }
  stateStore: {
    setServerFile: (record: ServerRecord) => void
    setLocalFile: (record: LocalRecord) => void
    addPendingFile: (record: ServerRecord) => void
    getPendingFiles: () => ServerRecord[]
    setVersion: (version: number) => void
    /** The store's better-sqlite3 connection; `name` is the file path. */
    db: { name: string }
  }
}

type SyncEngineConstructor = new (options: unknown) => SyncEngine

const isSyncEngineConstructor = (value: unknown): value is SyncEngineConstructor => {
  return typeof value === "function"
}

const loadSyncEngine = (cliPath: string): SyncEngineConstructor => {
  const bundleSource = readFileSync(cliPath, "utf8").replace(SHEBANG_LINE, "")
  // `is` is the engine class's minified name in the bundle.
  const exportingSource = bundleSource.replace(BUNDLE_ENTRY_CALL, "module.exports={Engine:is};")

  if (exportingSource === bundleSource) {
    throw new Error(`no closing x.parse() call in ${cliPath}`)
  }

  const bundleModule: { exports: { Engine?: unknown } } = { exports: {} }
  // Simulates a CJS module scope (require, module, exports, __filename,
  // __dirname). The source is the pinned vendor bundle, never user input.
  const compileBundle = new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    exportingSource,
  )
  compileBundle(
    createRequire(cliPath),
    bundleModule,
    bundleModule.exports,
    cliPath,
    dirname(cliPath),
  )

  const { Engine } = bundleModule.exports

  if (!isSyncEngineConstructor(Engine)) {
    throw new Error(`the bundle's engine class (is) is missing from ${cliPath}`)
  }
  return Engine
}

type Scenario = {
  label: string
  /** The value the CLI hands the engine (`bidirectional` when unset). */
  syncMode: "bidirectional" | "pull-only" | "mirror-remote"
  /** The version the server lists (server_files). A factory, because the
   *  engine marks the record deleted in place when it pushes a deletion. */
  listed: () => ServedVersion
  /** The version queued before the pass (pending_files), as init-first-sync
   *  or a filter change queues it; absent when nothing is queued. */
  queued?: () => ServedVersion
  /** The local copy's contents, edited here since it synced from the listed
   *  version; absent when this device never downloaded the file. */
  localEdit?: string
  downloadFails: boolean
  /** The attachment types the filter allows; the file is a CSV. */
  fileTypes: string[]
}

/** The engine's own record hash: the SHA-256 hex of the file's bytes. */
const sha256Hex = (contents: string): string => {
  return createHash("sha256").update(contents).digest("hex")
}

/** A file the server lists that this device never downloaded. */
const neverDownloaded = (): ServedVersion => {
  return {
    record: {
      path: "Archive/old.csv",
      uid: 11,
      folder: false,
      deleted: false,
      hash: "old-hash",
      size: 3,
      ctime: 1,
      mtime: 1,
    },
    contents: "old",
  }
}

/** The version of Data/table.csv that this device last synced, when it has
 *  a local copy. */
const syncedTable = (): ServedVersion => {
  const contents = "server text\n"
  return {
    record: {
      path: "Data/table.csv",
      uid: 21,
      folder: false,
      deleted: false,
      hash: sha256Hex(contents),
      size: contents.length,
      ctime: 1,
      mtime: 1,
    },
    contents,
  }
}

/** A newer version of Data/table.csv that another device uploaded. */
const updatedTable = (): ServedVersion => {
  const contents = "updated text\n"
  return {
    record: {
      path: "Data/table.csv",
      uid: 22,
      folder: false,
      deleted: false,
      hash: sha256Hex(contents),
      size: contents.length,
      ctime: 2,
      mtime: 2,
    },
    contents,
  }
}

/** The local copy's text in the scenarios with a server edit. */
const SERVER_EDIT = "edited on the server\n"

const SCENARIOS: Scenario[] = [
  {
    label: "not queued",
    syncMode: "bidirectional",
    listed: neverDownloaded,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "queued",
    syncMode: "bidirectional",
    listed: neverDownloaded,
    queued: neverDownloaded,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "queued, download fails",
    syncMode: "bidirectional",
    listed: neverDownloaded,
    queued: neverDownloaded,
    downloadFails: true,
    fileTypes: ["unsupported"],
  },
  {
    label: "queued, excluded by the filter",
    syncMode: "bidirectional",
    listed: neverDownloaded,
    queued: neverDownloaded,
    downloadFails: false,
    fileTypes: [],
  },
  // init-first-sync lets these two modes continue past a failed first sync
  // with files still queued, because neither runs the deletion scan — with
  // or without a queued file.
  {
    label: "queued, pull-only",
    syncMode: "pull-only",
    listed: neverDownloaded,
    queued: neverDownloaded,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "queued, mirror-remote",
    syncMode: "mirror-remote",
    listed: neverDownloaded,
    queued: neverDownloaded,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "not queued, pull-only",
    syncMode: "pull-only",
    listed: neverDownloaded,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "not queued, mirror-remote",
    syncMode: "mirror-remote",
    listed: neverDownloaded,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  // The drop step's premise in pull-only. A download stores the record's
  // hash as synchash, and a local edit leaves it, so a queued row with that
  // hash brings back the synced version over the edit, while a real update
  // carries a new hash.
  {
    label: "downloaded, pull-only",
    syncMode: "pull-only",
    listed: syncedTable,
    queued: syncedTable,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "edited, synced version queued, pull-only",
    syncMode: "pull-only",
    listed: syncedTable,
    queued: syncedTable,
    localEdit: SERVER_EDIT,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "edited, not queued, pull-only",
    syncMode: "pull-only",
    listed: syncedTable,
    localEdit: SERVER_EDIT,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
  {
    label: "edited, update queued, pull-only",
    syncMode: "pull-only",
    listed: syncedTable,
    queued: updatedTable,
    localEdit: SERVER_EDIT,
    downloadFails: false,
    fileTypes: ["unsupported"],
  },
]

const runScenario = async ({
  cliPath,
  scenario,
}: {
  cliPath: string
  scenario: Scenario
}): Promise<{
  label: string
  outcome: string
  events: string[]
  stillQueued: boolean
  recordedLocally: boolean
  contents: string | null
  synchash: string | null
}> => {
  const scenarioRoot = mkdtempSync(join(tmpdir(), "sync-engine-oracle-"))
  // Scenarios run sequentially (the top-level loop awaits each), so global mutation is safe.
  process.env.HOME = scenarioRoot
  process.env.XDG_CONFIG_HOME = join(scenarioRoot, "config")
  const SyncEngine = loadSyncEngine(cliPath)
  const vaultPath = join(scenarioRoot, "vault")
  mkdirSync(join(vaultPath, "Notes"), { recursive: true })
  writeFileSync(join(vaultPath, "Notes", "kept.md"), "kept")

  const engine = new SyncEngine({
    config: {
      vaultId: "oracle-vault",
      vaultPath,
      host: "sync.invalid",
      syncMode: scenario.syncMode,
      allowTypes: scenario.fileTypes,
    },
    token: "fake-token",
    continuous: false,
    encryption: {},
  })
  const events: string[] = []
  engine.log = (message, path) => {
    events.push(path ? `${message} ${path}` : message)
  }

  const listed = scenario.listed()
  const queued = scenario.queued?.()
  const { path } = listed.record
  // setServerFile persists to SQLite; serverFiles is the in-memory map
  // _sync() reads during the deletion scan. Both must be populated.
  engine.stateStore.setServerFile(listed.record)
  engine.serverFiles[path] = listed.record
  if (queued) {
    engine.stateStore.addPendingFile(queued.record)
    engine.newServerFiles = engine.stateStore.getPendingFiles()
  }
  if (scenario.localEdit) {
    writeLocalEdit({ engine, vaultPath, listed, localEdit: scenario.localEdit })
  }
  // The "version" is the sync cursor — setting it to the newest uid tells
  // the engine it has already seen this point in the server's history.
  engine.stateStore.setVersion(Math.max(listed.record.uid, queued?.record.uid ?? 0))
  engine.initial = false

  const servedContents = new Map(
    [listed, queued]
      .filter((version) => version !== undefined)
      .map((version) => [version.record.uid, version.contents]),
  )
  const fakeServer: FakeServer = {
    pull: async (uid) => {
      const contents = servedContents.get(uid)
      return scenario.downloadFails || contents === undefined
        ? null
        : new TextEncoder().encode(contents)
    },
    push: async (pushedPath, ...details) => {
      events.push(`push ${pushedPath} ${JSON.stringify(details)}`)
    },
  }
  engine.getServer = async () => fakeServer

  // The engine lists the vault at startup so the deletion scan sees which
  // files exist locally.
  await engine.adapter.watch(engine.onChange.bind(engine))
  engine.ready = true
  const outcome = await describeSyncOutcome(engine)
  engine.adapter.stopWatch()
  // The next boot's queue step and refusal read this stored state, so a
  // download that logs success without recording the file would loop. Read
  // from the file: some runs (pull-only) close the engine's own connection.
  const { stillQueued, recordedLocally, synchash } = readStoredState({
    stateDbPath: engine.stateStore.db.name,
    path,
  })
  const filePath = join(vaultPath, path)
  const contents = existsSync(filePath) ? readFileSync(filePath, "utf8") : null
  return {
    label: scenario.label,
    outcome,
    events,
    stillQueued,
    recordedLocally,
    contents,
    synchash,
  }
}

/** Writes an edited local copy of a file this device downloaded, with the
 *  local record the download left: synchash is the listed version's hash.
 *  The record's mtime differs from the file's, so the engine re-hashes the
 *  file as it would after an edit. */
const writeLocalEdit = ({
  engine,
  vaultPath,
  listed,
  localEdit,
}: {
  engine: SyncEngine
  vaultPath: string
  listed: ServedVersion
  localEdit: string
}): void => {
  const { path, hash, size, ctime, mtime } = listed.record
  mkdirSync(dirname(join(vaultPath, path)), { recursive: true })
  writeFileSync(join(vaultPath, path), localEdit)
  const localRecord: LocalRecord = {
    path,
    previouspath: "",
    ctime,
    mtime,
    size,
    folder: false,
    hash,
    synchash: hash,
    synctime: 1,
  }
  // Both the stored table and the in-memory map, as for the server record.
  engine.stateStore.setLocalFile(localRecord)
  engine.localFiles[path] = localRecord
}

const readStoredState = ({
  stateDbPath,
  path,
}: {
  stateDbPath: string
  path: string
}): { stillQueued: boolean; recordedLocally: boolean; synchash: string | null } => {
  const db = new DatabaseSync(stateDbPath, { readOnly: true })
  const queuedRow = db.prepare("SELECT 1 FROM pending_files WHERE path = ?").get(path)
  const localRow = db
    .prepare("SELECT json_extract(data, '$.synchash') AS synchash FROM local_files WHERE path = ?")
    .get(path)
  db.close()
  const synchash = typeof localRow?.synchash === "string" ? localRow.synchash : null
  return { stillQueued: Boolean(queuedRow), recordedLocally: Boolean(localRow), synchash }
}

const describeSyncOutcome = async (engine: SyncEngine): Promise<string> => {
  try {
    return `returned ${String(await engine._sync())}`
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`
  }
}

const cliPath = process.argv[2]

if (!cliPath) {
  throw new Error("usage: node sync-engine-oracle.ts <path to obsidian-headless cli.js>")
}

for (const scenario of SCENARIOS) {
  process.stdout.write(`${JSON.stringify(await runScenario({ cliPath, scenario }))}\n`)
}

// The engine leaves timers running after `_sync()`, which would keep the
// process alive for about a minute.
process.exit(0)
