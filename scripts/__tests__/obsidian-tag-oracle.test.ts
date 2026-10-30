import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, onTestFinished } from "vitest"
import { listedTagNames, loadObsidianTagOracle, readOracleInputs } from "../obsidian-tag-oracle.js"

/** A file holding `content` in a temporary folder removed when the test finishes. */
const writeTempFile = async (fileName: string, content: string): Promise<string> => {
  const tempDir = await mkdtemp(join(tmpdir(), "obsidian-tag-oracle-"))
  onTestFinished(() => rm(tempDir, { recursive: true }))
  const filePath = join(tempDir, fileName)
  await writeFile(filePath, content, "utf8")
  return filePath
}

/**
 * A stand-in for the worker bundle, written for these tests: a classic worker
 * script that decodes the note bytes it receives and posts the note text,
 * parsed as JSON, back as its reply. Each test's note text is the reply it
 * wants the oracle to read.
 */
const ECHOING_WORKER_SOURCE = `
self.onmessage = (event) => {
  const noteText = new TextDecoder().decode(event.data.metadataCache)
  self.postMessage(JSON.parse(noteText))
}
`

const loadEchoingOracle = async () => {
  const workerPath = await writeTempFile("echoing-worker.js", ECHOING_WORKER_SOURCE)
  return { workerPath, readTags: loadObsidianTagOracle(workerPath) }
}

describe("loadObsidianTagOracle", () => {
  it("returns the reply's raw tags in the reply's order", async () => {
    const { readTags } = await loadEchoingOracle()

    const rawTags = readTags(JSON.stringify({ tags: [{ tag: "#zeta/" }, { tag: "#älpha" }] }))

    expect(rawTags).toEqual(["#zeta/", "#älpha"])
  })

  it.each([
    { label: "a null reply", reply: null },
    { label: "a reply with no tags field", reply: { links: [] } },
    { label: "a reply whose tags are null", reply: { tags: null } },
  ])("reads $label as no tags", async ({ reply }) => {
    const { readTags } = await loadEchoingOracle()

    expect(readTags(JSON.stringify(reply))).toEqual([])
  })

  it.each([
    { label: "tags that are a falsy non-list", reply: { tags: 0 } },
    { label: "a tag entry without a text tag", reply: { tags: [{ tag: 7 }] } },
  ])("throws on a reply with $label", async ({ reply }) => {
    const { workerPath, readTags } = await loadEchoingOracle()
    const replyText = JSON.stringify(reply)

    expect(() => readTags(replyText)).toThrow(
      new Error(`unexpected reply from ${workerPath}: ${replyText}`),
    )
  })

  it("throws when the bundle installs no message handler", async () => {
    const workerPath = await writeTempFile("silent-worker.js", "self.ready = true\n")

    expect(() => loadObsidianTagOracle(workerPath)).toThrow(
      new Error(`${workerPath} did not install a message handler`),
    )
  })
})

describe("listedTagNames", () => {
  it("removes the hash and one trailing slash, and drops names left empty or made of digits only", () => {
    const rawTags = ["#a/", "#b//", "#/", "#123/", "#123", "#y1984", "#c"]

    expect(listedTagNames(rawTags)).toEqual(["a", "b/", "y1984", "c"])
  })
})

describe("readOracleInputs", () => {
  it("labels each text input by its position and keeps labelled records as written", async () => {
    const inputsPath = await writeTempFile(
      "inputs.json",
      JSON.stringify(["#first", { label: "named", input: "#second" }, "#third"]),
    )

    expect(readOracleInputs(inputsPath)).toEqual([
      { label: "input 1", input: "#first" },
      { label: "named", input: "#second" },
      { label: "input 3", input: "#third" },
    ])
  })

  it("throws when the file does not hold a JSON array", async () => {
    const inputsPath = await writeTempFile("inputs.json", JSON.stringify({ input: "#a" }))

    expect(() => readOracleInputs(inputsPath)).toThrow(
      new Error(`${inputsPath} must hold a JSON array`),
    )
  })

  it("throws naming the position of an entry that is neither text nor a labelled record", async () => {
    const inputsPath = await writeTempFile(
      "inputs.json",
      JSON.stringify(["#a", { label: "no input" }]),
    )

    expect(() => readOracleInputs(inputsPath)).toThrow(
      new Error(`${inputsPath}[1] is neither a string nor { label, input }`),
    )
  })
})
