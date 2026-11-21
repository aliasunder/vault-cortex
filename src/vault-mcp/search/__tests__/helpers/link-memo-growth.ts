import { createSearchIndex } from "../../search-index.js"
import { logger } from "../../../../logger.js"

/** Eight times the input, so linear work grows about 8x and a quadratic Map
 *  about 64x. */
const LINK_COUNTS = [250, 2_000]

const RUNS = 3

/** Control characters in each link's folder part. The link text stays within
 *  the link-target limit, while JSON quoting would write each character as six. */
const CONTROL_FOLDER = "\u0001".repeat(4_000)

const indexNote = (
  index: ReturnType<typeof createSearchIndex>,
  filePath: string,
  rawContent: string,
): void => {
  index.upsertNote(
    { filePath, rawContent, fileStat: { mtimeMs: 1, size: rawContent.length }, bodyTags: [] },
    logger,
  )
}

/** Times adding real.md to an index whose source note holds `count` distinct
 *  links named "real", so every one of them re-resolves. */
const timeReResolution = (count: number): number => {
  const index = createSearchIndex(":memory:")
  const linkLines = Array.from({ length: count }, (_, linkNumber) => {
    return `[[${CONTROL_FOLDER}${linkNumber}/real]]`
  })
  indexNote(index, "source.md", linkLines.join("\n"))

  const start = performance.now()
  indexNote(index, "real.md", "# Real")
  return performance.now() - start
}

const measurements = LINK_COUNTS.map((count) => {
  const elapsedRuns = Array.from({ length: RUNS }, () => timeReResolution(count))
  return { count, leastMs: Math.min(...elapsedRuns) }
})

process.stdout.write(JSON.stringify({ measurements }))
