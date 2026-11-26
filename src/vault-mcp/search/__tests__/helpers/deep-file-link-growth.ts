import { createSearchIndex } from "../../search-index.js"
import { logger } from "../../../../logger.js"

type SearchIndex = ReturnType<typeof createSearchIndex>

/** Folders in the deep chain, so each deep file path and each link holds
 *  about 2,000 bytes of "a/" segments. */
const FOLDER_DEPTH = 1_000

const FILE_COUNT = 10

const LINK_COUNT = 125

const RUNS = 3

const DEEP_FOLDER = "a/".repeat(FOLDER_DEPTH)

/** Links that each walk the deep chain and end in a name no file has. */
const NOTE_CONTENT = Array.from({ length: LINK_COUNT }, (_, linkNumber) => {
  return `[[${DEEP_FOLDER}missing${linkNumber}]]`
}).join("\n")

const indexSource = (index: SearchIndex): void => {
  index.upsertNote(
    {
      filePath: "source.md",
      rawContent: NOTE_CONTENT,
      fileStat: { mtimeMs: 1, size: NOTE_CONTENT.length },
      bodyTags: [],
    },
    logger,
  )
}

const createIndexWithFiles = (folder: string): SearchIndex => {
  const index = createSearchIndex(":memory:")
  for (const fileNumber of Array.from({ length: FILE_COUNT }, (_, index) => index)) {
    index.upsertNonMdFile(`${folder}file${fileNumber}.png`, 100)
  }
  return index
}

const countUnresolvedLinks = (index: SearchIndex): number => {
  return index
    .getOutgoingLinks({ path: "source.md", dailyNotesFormat: "YYYY-MM-DD" }, logger)
    .filter((outgoingLink) => !outgoingLink.exists).length
}

const measurements = [
  { label: "shallow", folder: "" },
  { label: "deep", folder: DEEP_FOLDER },
].map(({ label, folder }) => {
  const index = createIndexWithFiles(folder)
  const elapsedRuns = Array.from({ length: RUNS }, () => {
    const start = performance.now()
    indexSource(index)
    return performance.now() - start
  })
  return { label, unresolved: countUnresolvedLinks(index), leastMs: Math.min(...elapsedRuns) }
})

process.stdout.write(JSON.stringify({ measurements }))
