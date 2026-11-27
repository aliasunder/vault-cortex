/** A worker thread that builds one 10,000,000-character line, reports
 *  "ready", and runs one links operation on it when its parent says "go", so
 *  the parent can sample the worker's heap while the operation runs:
 *  - the shapes in DECODED_SHAPES are decoded with decodeLinkSpellings;
 *  - the shapes in EXTRACTED_SHAPES are extracted with extractFromBody;
 *  - the shapes in FOLDED_SHAPES are lowercased with lowercaseLinkName;
 *  - every other shape is scanned with matchLinksInLine. */
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

/** The shapes decoded with decodeLinkSpellings rather than scanned. */
const DECODED_SHAPES: ReadonlySet<unknown> = new Set([
  "ampersands",
  "ampersand-tail",
  "digit-run",
  "long-number",
  "escaped-punctuation",
  "no-break-spaces",
  "percent-runs",
])

/** The shapes whose targets are extracted with extractFromBody. */
const EXTRACTED_SHAPES: ReadonlySet<unknown> = new Set(["dense-links", "code-spans", "templater"])

/** The shapes lowercased with lowercaseLinkName. Their Greek letters need two
 *  bytes each, so the line is flattened through UTF-16 instead of Latin-1. */
const FOLDED_SHAPES: ReadonlySet<unknown> = new Set(["final-sigmas", "capital-greek-words"])

const NO_BREAK_SPACE = String.fromCharCode(0xa0)

/** The line each shape names:
 *  - sparse: one parenthesis;
 *  - dense: a parenthesis in every character after the first four;
 *  - ampersands: only `&`;
 *  - ampersand-tail: one `&amp;` reference before plain text;
 *  - digit-run: one `&#` reference whose digits are leading zeros before 65;
 *  - long-number: one `&#` reference whose digits name no code point;
 *  - escaped-punctuation: only `\&`;
 *  - no-break-spaces: only no-break spaces;
 *  - percent-runs: `%41 ` repeated;
 *  - dense-links: `[](a)` repeated, one markdown link every five characters;
 *  - code-spans: `` `a` `` repeated;
 *  - templater: `<%a%>` repeated;
 *  - final-sigmas: only `ς`;
 *  - capital-greek-words: `ΟΔΟΣ ` repeated, each word lowercasing to end in `ς`. */
const buildLine = (shape: unknown): string => {
  if (shape === "sparse") {
    const filler = `ab c"d'e<f `
    return `[x](${filler.repeat(Math.ceil(LINE_LENGTH / filler.length))}`.slice(0, LINE_LENGTH)
  }
  if (shape === "dense") return `[x](${"()".repeat(LINE_LENGTH / 2 - 2)}`
  if (shape === "ampersands") return "&".repeat(LINE_LENGTH)
  if (shape === "ampersand-tail") {
    return `&amp;${"a b-".repeat(Math.ceil(LINE_LENGTH / 4))}`.slice(0, LINE_LENGTH)
  }
  if (shape === "digit-run") return `&#${"0".repeat(LINE_LENGTH - 5)}65;`
  if (shape === "long-number") return `&#${"1".repeat(LINE_LENGTH - 3)};`
  if (shape === "escaped-punctuation") return "\\&".repeat(LINE_LENGTH / 2)
  if (shape === "no-break-spaces") return NO_BREAK_SPACE.repeat(LINE_LENGTH)
  if (shape === "percent-runs") return "%41 ".repeat(LINE_LENGTH / 4)
  if (shape === "dense-links") return "[](a)".repeat(LINE_LENGTH / 5)
  if (shape === "code-spans") return "`a`".repeat(Math.floor(LINE_LENGTH / 3))
  if (shape === "templater") return "<%a%>".repeat(LINE_LENGTH / 5)
  if (shape === "final-sigmas") return "ς".repeat(LINE_LENGTH)
  if (shape === "capital-greek-words") return "ΟΔΟΣ ".repeat(LINE_LENGTH / 5)
  throw new Error(`unknown line shape: ${String(shape)}`)
}

/** Returns how many matches a scan found, how many characters a decode or a
 *  fold returned, or how many targets an extraction found. */
const runOperation = (line: string): number => {
  if (DECODED_SHAPES.has(workerData)) return links.decodeLinkSpellings(line).length
  if (EXTRACTED_SHAPES.has(workerData)) return links.extractFromBody(line).length
  if (FOLDED_SHAPES.has(workerData)) return links.lowercaseLinkName(line).length
  return links.matchLinksInLine(line).length
}

if (!parentPort) throw new Error("the memory worker must run in a worker thread")

const port = parentPort
const builtLine = buildLine(workerData)
// String.repeat builds a rope, which V8 flattens on the first scan; copying
// through a buffer flattens it before the baseline is sampled.
const flatteningEncoding = FOLDED_SHAPES.has(workerData) ? "utf16le" : "latin1"
const line = Buffer.from(builtLine, flatteningEncoding).toString(flatteningEncoding)
const parenthesisCount = countParentheses(line)

port.on("message", () => {
  port.postMessage({ status: "done", resultLength: runOperation(line) })
})
port.postMessage({ status: "ready", parenthesisCount })
