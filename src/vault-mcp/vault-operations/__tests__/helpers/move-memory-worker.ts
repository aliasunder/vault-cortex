/** A worker thread that writes a throwaway vault holding `Target.md` and one
 *  10,000,000-character backlinking file the index has not read, reports
 *  "ready", and moves `Target.md` when its parent says "go", so the parent can
 *  sample the worker's heap while the move reads, checks and rewrites that
 *  file. The file each shape names ends in BACKLINK, after:
 *  - escaped-punctuation-note: a note of `\&` pairs;
 *  - escaped-punctuation-canvas: a Canvas text card of `\&` pairs, which its
 *    JSON stores as `\\&`. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import { noteMover } from "../../note-mover.js"
import { logger } from "../../../../logger.js"

const FILE_LENGTH = 10_000_000

/** A link to `Target.md` with a percent-escaped letter, so only the decoded
 *  view of the file holds the name and the pre-filter builds every view. */
const BACKLINK = " [x](Tar%67et.md)"

/** The backlinking file each shape names, with its vault path. */
const buildBacklinkingFile = (shape: unknown): { path: string; content: string } => {
  const escapePairs = "\\&".repeat((FILE_LENGTH - BACKLINK.length) / 2)

  if (shape === "escaped-punctuation-note") {
    return { path: "Source.md", content: `${escapePairs}${BACKLINK}\n` }
  }
  if (shape === "escaped-punctuation-canvas") {
    const text = `${escapePairs}${BACKLINK}`
    const textCard = { id: "t1", type: "text", text, x: 0, y: 0, width: 250, height: 60 }
    return { path: "Board.canvas", content: JSON.stringify({ nodes: [textCard], edges: [] }) }
  }
  throw new Error(`unknown file shape: ${String(shape)}`)
}

if (!parentPort) throw new Error("the move memory worker must run in a worker thread")

const port = parentPort
const vaultPath = mkdtempSync(join(tmpdir(), "move-memory-"))
const backlinkingFile = buildBacklinkingFile(workerData)
const isCanvas = backlinkingFile.path.endsWith(".canvas")

writeFileSync(join(vaultPath, "Target.md"), "# Target\n")
writeFileSync(join(vaultPath, backlinkingFile.path), backlinkingFile.content)

port.on("message", async () => {
  try {
    const result = await noteMover.moveNote(
      {
        vaultPath,
        oldPath: "Target.md",
        newPath: "Moved.md",
        protectedPaths: [],
        // An empty list makes the move find the file through its own scan.
        backlinkSources: [],
        allNotePaths: isCanvas ? ["Target.md"] : ["Target.md", backlinkingFile.path],
        allAssetPaths: isCanvas ? [backlinkingFile.path] : [],
        pruneEmptyFolders: false,
        windowsBindMount: false,
      },
      logger,
    )
    port.postMessage({ status: "done", linksUpdated: result.links_updated })
  } finally {
    rmSync(vaultPath, { recursive: true, force: true })
  }
})
// The worker keeps the file's text alive, so the heap it holds when ready
// stays put while the move reads its own copy.
port.postMessage({ status: "ready", fileLength: backlinkingFile.content.length })
