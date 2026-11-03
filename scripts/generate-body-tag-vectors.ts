/**
 * Writes the body-tag test vectors from Obsidian's own answers, so the tests
 * compare `parseBodyTags` with Obsidian instead of with itself.
 *
 * Run as `tsx scripts/generate-body-tag-vectors.ts <worker.js> <obsidian-version> [new-inputs.json]`,
 * with the version of the Obsidian app the worker came from (the `<version>` in
 * the `obsidian-<version>.asar` it was extracted from).
 * It reads every input already in the fixture, adds any new `{ label, input }`
 * records (labels must be unique), asks Obsidian's worker for each input's
 * tags (`scripts/obsidian-tag-oracle.ts`), and rewrites the fixture with the
 * expected names and a `source` line naming the Obsidian version and date.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DateTime } from "luxon"
import {
  isLabelledInput,
  type LabelledInput,
  listedTagNames,
  loadObsidianTagOracle,
  readOracleInputs,
} from "./obsidian-tag-oracle.js"

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../src/vault-mcp/obsidian-markdown/__tests__/fixtures/obsidian-body-tag-vectors.json",
    import.meta.url,
  ),
)

type BodyTagVector = { label: string; input: string; expected: string[] }

type BodyTagFixture = { source: string; vectors: BodyTagVector[] }

const readExistingInputs = (): LabelledInput[] => {
  if (!existsSync(FIXTURE_PATH)) return []

  const fixture: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))

  if (typeof fixture !== "object" || fixture === null || !("vectors" in fixture)) {
    throw new Error(`${FIXTURE_PATH} has no vectors array`)
  }
  if (!Array.isArray(fixture.vectors)) throw new Error(`${FIXTURE_PATH} vectors is not an array`)

  return fixture.vectors.map((vector: unknown, index: number) => {
    if (!isLabelledInput(vector))
      throw new Error(`${FIXTURE_PATH} vector ${index} lacks label or input`)
    return { label: vector.label, input: vector.input }
  })
}

const [workerPath, obsidianVersion, newInputsPath] = process.argv.slice(2)

if (!workerPath || !obsidianVersion) {
  console.error(
    "usage: tsx scripts/generate-body-tag-vectors.ts <worker.js> <obsidian-version> [new-inputs.json]",
  )
  process.exit(2)
}

const existingInputs = readExistingInputs()
const newInputs = newInputsPath ? readOracleInputs(newInputsPath) : []
const allInputs = [...existingInputs, ...newInputs]

const labels = allInputs.map((entry) => entry.label)
const duplicateLabels = labels.filter((label, index) => labels.indexOf(label) !== index)

if (duplicateLabels.length > 0) {
  throw new Error(`duplicate labels: ${[...new Set(duplicateLabels)].join(", ")}`)
}

const readObsidianTags = loadObsidianTagOracle(workerPath)
const vectors = allInputs.map(({ label, input }) => ({
  label,
  input,
  expected: listedTagNames(readObsidianTags(input)),
}))

const today = DateTime.now().toISODate()

if (!today) throw new Error("the current date has no ISO form")

const fixture: BodyTagFixture = {
  source: `Obsidian ${obsidianVersion} worker.js via scripts/obsidian-tag-oracle.ts, generated ${today}`,
  vectors,
}

writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${vectors.length} vectors to ${FIXTURE_PATH}`)
