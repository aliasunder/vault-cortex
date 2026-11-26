/** A worker thread that builds one 10,000,000-character line, reports
 *  "ready", and scans it with matchLinksInLine when its parent says "go", so
 *  the parent can sample the worker's heap while the scan runs. */
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

/** A sparse line holds one parenthesis, and a dense one holds a parenthesis
 *  in every character after its first four. */
const buildLine = (shape: unknown): string => {
  if (shape === "sparse") {
    const filler = `ab c"d'e<f `
    return `[x](${filler.repeat(Math.ceil(LINE_LENGTH / filler.length))}`.slice(0, LINE_LENGTH)
  }
  if (shape === "dense") return `[x](${"()".repeat(LINE_LENGTH / 2 - 2)}`
  throw new Error(`unknown line shape: ${String(shape)}`)
}

if (!parentPort) throw new Error("the memory worker must run in a worker thread")

const port = parentPort
const builtLine = buildLine(workerData)
// String.repeat builds a rope, which V8 flattens on the first scan; copying
// through a buffer flattens it before the baseline is sampled.
const line = Buffer.from(builtLine, "latin1").toString("latin1")
const parenthesisCount = countParentheses(line)

port.on("message", () => {
  const matches = links.matchLinksInLine(line)
  port.postMessage({ status: "done", matchCount: matches.length })
})
port.postMessage({ status: "ready", parenthesisCount })
