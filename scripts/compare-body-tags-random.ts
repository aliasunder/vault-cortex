/**
 * Compares `parseBodyTags` with Obsidian's own parser on generated notes, to
 * find disagreements the stored test vectors do not cover.
 *
 * Run as `tsx scripts/compare-body-tags-random.ts <worker.js> [--documents N] [--seed S] [--repo-markdown]`.
 * - Each document is built from random Markdown and Obsidian syntax fragments
 *   (up to about 4 KB, so length-dependent rules run), split from its
 *   properties block the way indexing splits it, and parsed by both sides.
 * - `--repo-markdown` instead injects `#tag` candidates into this repo's own
 *   Markdown files.
 * - Each disagreement is shrunk to a short input and printed with both answers;
 *   `--out <file>` also writes each distinct one as a `{ label, input }`
 *   record, ready to pass to `scripts/generate-body-tag-vectors.ts`.
 * - It exits 1 when any document disagrees.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { parseBodyTags } from "../src/vault-mcp/obsidian-markdown/body-tags.js"
import { splitPropertiesBlock } from "../src/vault-mcp/obsidian-markdown/frontmatter.js"
import { listedTagNames, loadObsidianTagOracle } from "./obsidian-tag-oracle.js"

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Pieces a generated note is assembled from: tags in every position, and
 *  every construct that hides or reveals a tag. */
const FRAGMENTS: ReadonlyArray<string> = [
  "#tag",
  "#a/b",
  "#a/",
  "#1984",
  "#19-84",
  "#x_y",
  "#café",
  "#Tag",
  "#t",
  "#/",
  "##x",
  "#x#y",
  "text",
  "word",
  "a",
  "foo#bar",
  "(#tag)",
  "x.#y",
  "#tag.",
  "#tag,",
  "#tag)",
  "*",
  "**",
  "_",
  "__",
  "~~",
  "==",
  "*a*",
  "**b**",
  "_c_",
  "__d__",
  "~~e~~",
  "==f==",
  "`",
  "``",
  "`c`",
  "` #x`",
  "``a ` #y``",
  "[",
  "]",
  "[x]",
  "[#x]",
  "[a](b)",
  "[#x](u)",
  "![i](p.png)",
  "[ref]: http://x.com",
  "[[note]]",
  "[[note#h|alias]]",
  "![[embed]]",
  "[[a#b]]",
  "http://x.com/#frag",
  "https://x.com/a#b",
  "www.x.com/#y",
  "<https://x.com/#z>",
  "a@b.co",
  "<div>",
  "</div>",
  "<br>",
  "<span>#x</span>",
  "<!-- #c -->",
  "<p>",
  "$",
  "$$",
  "$x$",
  "$ #m $",
  "$a #b$c",
  "%%",
  "%% #c %%",
  "%%\n#x\n%%",
  "[^1]",
  "[^1]: note #f",
  "^[inline #i]",
  "^block-id",
  "\\#",
  "\\\\#x",
  "&amp;",
  "&#35;x",
  "\\*",
  "- ",
  "* ",
  "1. ",
  "- [ ] ",
  "- [x] ",
  "- [/] ",
  "> ",
  "> [!note] ",
  ">> ",
  "# ",
  "## ",
  "### ",
  "---",
  "***",
  "| a | b |",
  "|---|---|",
  "| #t | x |",
  "```",
  "```js",
  "~~~",
  "    ",
  "\t",
  "  ",
]

/** Joins between fragments, weighted toward spaces and line breaks. */
const SEPARATORS: ReadonlyArray<string> = [
  " ",
  " ",
  " ",
  "",
  "\n",
  "\n",
  "\n\n",
  "\n    ",
  "\n- ",
  "\n> ",
  "\t",
]

/** A small seeded random generator (mulberry32), so a run can be repeated
 *  exactly from its seed. Returns numbers in [0, 1). */
const createRandom = (seed: number): (() => number) => {
  // The generator's state advances on every call
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const scrambled = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((scrambled ^ (scrambled >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <Item>(items: ReadonlyArray<Item>, random: () => number): Item => {
  const item = items[Math.floor(random() * items.length)]

  // A strict check, because "" is a legitimate separator
  if (item === undefined) throw new Error("pick from an empty list")
  return item
}

/** One random note, sometimes opening with a properties block. */
const generateDocument = (random: () => number): string => {
  const pieceCount = 3 + Math.floor(random() * (random() < 0.15 ? 400 : 60))
  const pieces = Array.from({ length: pieceCount }, () => {
    return `${pick(FRAGMENTS, random)}${pick(SEPARATORS, random)}`
  })
  const body = pieces.join("").slice(0, 4_000)
  return random() < 0.1 ? `---\ntags: [p]\n---\n${body}` : body
}

/** This repo's Markdown files, outside dependency and build folders. */
const listRepoMarkdown = (): string[] => {
  const skippedFolders = new Set(["node_modules", ".git", "dist", ".sst", ".claude"])
  const entries = readdirSync(REPO_ROOT, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (path) =>
        !relative(REPO_ROOT, path)
          .split("/")
          .some((part) => skippedFolders.has(part)),
    )
}

/** A repo Markdown file with `#tag` candidates inserted after random spaces. */
const injectTagCandidates = (text: string, random: () => number): string => {
  const prefixWithCandidate = (word: string): string => {
    return random() < 0.05 ? `#t${Math.floor(random() * 9)} ${word}` : word
  }
  return text.split(" ").map(prefixWithCandidate).join(" ")
}

const { values: options, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    documents: { type: "string", default: "10000" },
    seed: { type: "string", default: "1" },
    "repo-markdown": { type: "boolean", default: false },
    out: { type: "string" },
  },
})
const [workerPath] = positionals

if (!workerPath) {
  console.error(
    "usage: tsx scripts/compare-body-tags-random.ts <worker.js> [--documents N] [--seed S] [--repo-markdown] [--out disagreements.json]",
  )
  process.exit(2)
}

const readObsidianTags = loadObsidianTagOracle(workerPath)

/** Our tags for a note, split from its properties block as indexing splits it;
 *  a throw is reported as a tag so it shows up as a disagreement. */
const readOurTags = (noteText: string): string[] => {
  try {
    return parseBodyTags(splitPropertiesBlock(noteText).body)
  } catch (error) {
    return [`THROW ${String(error)}`]
  }
}

const tagsDisagree = (noteText: string): boolean => {
  const obsidianNames = listedTagNames(readObsidianTags(noteText))
  return JSON.stringify(obsidianNames) !== JSON.stringify(readOurTags(noteText))
}

/** Shrinks a disagreeing note: drops lines, then ever-smaller character runs,
 *  keeping each cut that still disagrees. */
const shrinkDisagreement = (noteText: string): string => {
  const dropLines = (text: string): string => {
    const lines = text.split("\n")
    for (const index of lines.keys()) {
      const candidate = lines.toSpliced(index, 1).join("\n")

      if (candidate !== text && tagsDisagree(candidate)) return dropLines(candidate)
    }
    return text
  }
  const dropRuns = (text: string, runLength: number): string => {
    if (runLength < 1) return text

    for (let start = 0; start < text.length; start += runLength) {
      const candidate = text.slice(0, start) + text.slice(start + runLength)

      if (tagsDisagree(candidate)) return dropRuns(candidate, runLength)
    }
    return dropRuns(text, Math.floor(runLength / 2))
  }
  const fewerLines = dropLines(noteText)
  return dropRuns(fewerLines, Math.max(1, Math.floor(fewerLines.length / 4)))
}

const random = createRandom(Number(options.seed))
const documents = options["repo-markdown"]
  ? listRepoMarkdown().map((path) => injectTagCandidates(readFileSync(path, "utf8"), random))
  : Array.from({ length: Number(options.documents) }, () => generateDocument(random))

const disagreements: Array<{ input: string; obsidian: string[]; ours: string[] }> = []
const slowDocuments: Array<{ index: number; milliseconds: number }> = []

for (const [index, document] of documents.entries()) {
  const parseStart = performance.now()
  const ours = readOurTags(document)
  const milliseconds = performance.now() - parseStart

  if (milliseconds > 1_000) slowDocuments.push({ index, milliseconds: Math.round(milliseconds) })

  const obsidian = listedTagNames(readObsidianTags(document))

  if (JSON.stringify(obsidian) === JSON.stringify(ours)) continue

  const shrunk = shrinkDisagreement(document)
  disagreements.push({
    input: shrunk,
    obsidian: listedTagNames(readObsidianTags(shrunk)),
    ours: readOurTags(shrunk),
  })
}

// Each distinct shrunk input once, as records the vector generator takes
if (options.out) {
  const distinctInputs = [...new Set(disagreements.map(({ input }) => input))]
  const records = distinctInputs.map((input, position) => ({
    label: `random comparison, seed ${options.seed}, case ${position + 1}`,
    input,
  }))
  writeFileSync(options.out, `${JSON.stringify(records, null, 2)}\n`)
}

console.log(
  JSON.stringify(
    {
      seed: options.seed,
      documents: documents.length,
      disagreements: disagreements.length,
      slowDocuments,
      examples: disagreements.slice(0, 20),
    },
    null,
    2,
  ),
)
process.exitCode = disagreements.length > 0 ? 1 : 0
