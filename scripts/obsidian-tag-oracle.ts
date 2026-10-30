/**
 * Asks Obsidian's own metadata worker which body tags a note holds, so the
 * body-tag parser can be checked against Obsidian rather than against itself.
 *
 * Obsidian computes each note's tags, links and headings in `worker.js`, a
 * bundle inside the app. This script loads a copy of that bundle as a black
 * box: it feeds a note's text in through the worker's message handler and reads
 * back the tags it reports, in the order and spelling Obsidian reports them
 * (`#tag`, a trailing `/` kept). Nothing from the bundle is copied into this
 * repo; the caller supplies the path to a `worker.js` extracted from an
 * installed Obsidian app (AGENTS.md → "Upgrading remark-parse").
 *
 * Run directly as `tsx scripts/obsidian-tag-oracle.ts <worker.js> <inputs.json>`,
 * it prints, for each input in the file (an array of strings or of
 * `{ label, input }` records), Obsidian's raw tags and the names its Tags view
 * lists for them.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

type WorkerTagEntry = { tag: string }

/** The parts of the worker's reply for one note that this script reads. */
type WorkerReply = { tags?: ReadonlyArray<WorkerTagEntry> } | null

/** The global the bundle installs its message handler on, as a web worker would. */
type WorkerScope = {
  postMessage: (message: unknown) => void
  onmessage?: (event: { data: unknown }) => void
}

const isWorkerTagEntry = (value: unknown): value is WorkerTagEntry => {
  return (
    typeof value === "object" && value !== null && "tag" in value && typeof value.tag === "string"
  )
}

const isWorkerReply = (value: unknown): value is WorkerReply => {
  if (value === null) return true
  if (typeof value !== "object") return false
  if (!("tags" in value) || !value.tags) return true
  return Array.isArray(value.tags) && value.tags.every(isWorkerTagEntry)
}

/**
 * Loads a `worker.js` and returns a function giving Obsidian's raw body tags
 * for a note's full text (properties block included, as Obsidian reads it).
 */
export const loadObsidianTagOracle = (workerPath: string): ((noteText: string) => string[]) => {
  const workerSource = readFileSync(workerPath, "utf8")

  // The handler replies synchronously through postMessage, so a mutable slot
  // that postMessage fills holds the reply to the message just sent.
  let lastReply: unknown = undefined
  const workerScope: WorkerScope = {
    postMessage: (message) => {
      lastReply = message
    },
  }

  // The bundle is a classic worker script that reads `self`. The source is a
  // file the caller extracted from their own Obsidian install, never user input.
  const compileBundle = new Function("self", workerSource)
  compileBundle(workerScope)

  const handleMessage = workerScope.onmessage

  if (typeof handleMessage !== "function") {
    throw new Error(`${workerPath} did not install a message handler`)
  }

  return (noteText) => {
    lastReply = undefined
    const noteBytes = new TextEncoder().encode(noteText).buffer

    // The worker's own message format, not a documented API, so a new
    // Obsidian release can change it
    handleMessage({ data: { metadataCache: noteBytes } })

    if (!isWorkerReply(lastReply)) {
      throw new Error(`unexpected reply from ${workerPath}: ${JSON.stringify(lastReply)}`)
    }
    return (lastReply?.tags ?? []).map((entry) => entry.tag)
  }
}

/** Matches a name made of ASCII digits only. */
const DIGITS_ONLY_RE = /^\d+$/

/**
 * The name Obsidian's Tags view lists for a raw body tag such as `#a/`, or
 * null when it lists none, as measured on Obsidian 1.14.4 with a probe note
 * read through `app.metadataCache.getTags()`:
 * - the `#` and one trailing `/` are removed (`#a/` → `a`, `#b//` → `b/`);
 * - a name left empty or made of digits only is dropped (`#/`, `#123/`).
 * It does not import the production name test, so the scripts never take
 * their expected values from the code under test.
 */
const listedTagName = (rawTag: string): string | null => {
  const withoutHash = rawTag.startsWith("#") ? rawTag.slice(1) : rawTag
  const name = withoutHash.endsWith("/") ? withoutHash.slice(0, -1) : withoutHash

  if (!name || DIGITS_ONLY_RE.test(name)) return null
  return name
}

/** The names Obsidian's Tags view lists for raw body tags, in their order. */
export const listedTagNames = (rawTags: ReadonlyArray<string>): string[] => {
  const listedNames = rawTags.map(listedTagName)
  return listedNames.filter((name) => name !== null)
}

export type LabelledInput = { label: string; input: string }

export const isLabelledInput = (value: unknown): value is LabelledInput => {
  if (typeof value !== "object" || value === null) return false
  if (!("label" in value) || typeof value.label !== "string") return false
  return "input" in value && typeof value.input === "string"
}

/** Reads an inputs file holding an array of strings or of `{ label, input }` records. */
export const readOracleInputs = (inputsPath: string): LabelledInput[] => {
  const parsed: unknown = JSON.parse(readFileSync(inputsPath, "utf8"))

  if (!Array.isArray(parsed)) throw new Error(`${inputsPath} must hold a JSON array`)

  return parsed.map((entry, index) => {
    if (typeof entry === "string") return { label: `input ${index + 1}`, input: entry }
    if (isLabelledInput(entry)) return entry
    throw new Error(`${inputsPath}[${index}] is neither a string nor { label, input }`)
  })
}

// Importing this module must not run the command, so it runs only when this
// file is the entry script.
const entryPath = process.argv[1]
const isMainModule = entryPath ? pathToFileURL(resolve(entryPath)).href === import.meta.url : false

if (isMainModule) {
  const [workerPath, inputsPath] = process.argv.slice(2)

  if (!workerPath || !inputsPath) {
    console.error("usage: tsx scripts/obsidian-tag-oracle.ts <worker.js> <inputs.json>")
    process.exit(2)
  }

  const readObsidianTags = loadObsidianTagOracle(workerPath)
  const results = readOracleInputs(inputsPath).map(({ label, input }) => {
    const rawTags = readObsidianTags(input)
    return { label, input, rawTags, listedNames: listedTagNames(rawTags) }
  })
  console.log(JSON.stringify(results, null, 2))
}
