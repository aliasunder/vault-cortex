/**
 * Runs the pinned Sync client's own sync engine for one-shot sync scenarios
 * and prints one JSON line per scenario: what `_sync()` did and what the
 * engine logged.
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
 * A stand-in replaces the server. Its `pull` returns the file's bytes, or
 * nothing to fail the download, and its `push` records the call, so nothing
 * reaches Obsidian.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
  newServerFiles: ServerRecord[]
  adapter: { watch: (handler: unknown) => Promise<void>; stopWatch: () => void }
  stateStore: {
    setServerFile: (record: ServerRecord) => void
    addPendingFile: (record: ServerRecord) => void
    getPendingFiles: () => ServerRecord[]
    setVersion: (version: number) => void
  }
}

type SyncEngineConstructor = new (options: unknown) => SyncEngine

const isSyncEngineConstructor = (value: unknown): value is SyncEngineConstructor => {
  return typeof value === "function"
}

const loadSyncEngine = (cliPath: string): SyncEngineConstructor => {
  const bundleSource = readFileSync(cliPath, "utf8").replace(SHEBANG_LINE, "")
  const exportingSource = bundleSource.replace(BUNDLE_ENTRY_CALL, "module.exports={Engine:is};")

  if (exportingSource === bundleSource) {
    throw new Error(`no closing x.parse() call in ${cliPath}`)
  }

  const bundleModule: { exports: { Engine?: unknown } } = { exports: {} }
  // The source is the pinned vendor bundle read from the image, never input.
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
  /** Queue the never-downloaded file first, as init-first-sync does. */
  queued: boolean
  downloadFails: boolean
  /** The attachment types the filter allows; the file is a CSV. */
  fileTypes: string[]
}

const SCENARIOS: Scenario[] = [
  { label: "not queued", queued: false, downloadFails: false, fileTypes: ["unsupported"] },
  { label: "queued", queued: true, downloadFails: false, fileTypes: ["unsupported"] },
  {
    label: "queued, download fails",
    queued: true,
    downloadFails: true,
    fileTypes: ["unsupported"],
  },
  { label: "queued, excluded by the filter", queued: true, downloadFails: false, fileTypes: [] },
]

/** A file the server lists that this device never downloaded. A new object
 *  per scenario, because the engine marks the record deleted in place when
 *  it pushes the deletion. */
const neverDownloadedRecord = (): ServerRecord => {
  return {
    path: "Archive/old.csv",
    uid: 11,
    folder: false,
    deleted: false,
    hash: "old-hash",
    size: 3,
    ctime: 1,
    mtime: 1,
  }
}

const runScenario = async ({
  cliPath,
  scenario,
}: {
  cliPath: string
  scenario: Scenario
}): Promise<{ label: string; outcome: string; events: string[] }> => {
  const scenarioRoot = mkdtempSync(join(tmpdir(), "sync-engine-oracle-"))
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
      syncMode: "",
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

  const neverDownloaded = neverDownloadedRecord()
  engine.stateStore.setServerFile(neverDownloaded)
  engine.serverFiles[neverDownloaded.path] = neverDownloaded
  if (scenario.queued) {
    engine.stateStore.addPendingFile(neverDownloaded)
    engine.newServerFiles = engine.stateStore.getPendingFiles()
  }
  engine.stateStore.setVersion(neverDownloaded.uid)
  engine.initial = false

  const fakeServer: FakeServer = {
    pull: async () => (scenario.downloadFails ? null : new TextEncoder().encode("old")),
    push: async (path, ...details) => {
      events.push(`push ${path} ${JSON.stringify(details)}`)
    },
  }
  engine.getServer = async () => fakeServer

  // The engine's startup scan: list the vault so the deletion scan sees
  // which files exist locally.
  await engine.adapter.watch(engine.onChange.bind(engine))
  engine.ready = true
  const outcome = await describeSyncOutcome(engine)
  engine.adapter.stopWatch()
  return { label: scenario.label, outcome, events }
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
