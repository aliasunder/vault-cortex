/** A worker thread that builds one 10,000,000-character line, reports
 *  "ready", and runs one links operation on it when its parent says "go", so
 *  the parent can sample the worker's heap while the operation runs:
 *  - a "sparse" or "dense" line is scanned with matchLinksInLine;
 *  - an "ampersands" line is decoded with decodeLinkSpellings. */
import { parentPort, workerData } from "node:worker_threads"
import { links } from "../../links.js"

const LINE_LENGTH = 10_000_000

const countParentheses = (text: string): number => {
  // A plain count, so the worker allocates nothing per character.
  let parenthesisCount = 0

  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(" || text[index] === ")") parenthesisCount++
  }
  return parenthesisCount
}

/** A sparse line holds one parenthesis, a dense one holds a parenthesis in
 *  every character after its first four, and an ampersands line holds only
 *  `&`. */
const buildLine = (shape: unknown): string => {
  if (shape === "sparse") {
    const filler = `ab c"d'e<f `
    return `[x](${filler.repeat(Math.ceil(LINE_LENGTH / filler.length))}`.slice(0, LINE_LENGTH)
  }
  if (shape === "dense") return `[x](${"()".repeat(LINE_LENGTH / 2 - 2)}`
  if (shape === "ampersands") return "&".repeat(LINE_LENGTH)
  throw new Error(`unknown line shape: ${String(shape)}`)
}

/** Returns how many matches a scan found, or how many characters a decode
 *  returned. */
const runOperation = (line: string): number => {
  if (workerData === "ampersands") return links.decodeLinkSpellings(line).length
  return links.matchLinksInLine(line).length
}

if (!parentPort) throw new Error("the memory worker must run in a worker thread")

const port = parentPort
const builtLine = buildLine(workerData)
// String.repeat builds a rope, which V8 flattens on the first scan; copying
// through a buffer flattens it before the baseline is sampled.
const line = Buffer.from(builtLine, "latin1").toString("latin1")
const parenthesisCount = countParentheses(line)

port.on("message", () => {
  port.postMessage({ status: "done", resultLength: runOperation(line) })
})
port.postMessage({ status: "ready", parenthesisCount })
