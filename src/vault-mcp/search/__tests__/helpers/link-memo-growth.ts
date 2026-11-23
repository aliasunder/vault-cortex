import { createSearchIndex } from "../../search-index.js"
import { logger } from "../../../../logger.js"

type SearchIndex = ReturnType<typeof createSearchIndex>

/** Eight times the input, so linear work grows about 8x and a quadratic Map
 *  about 64x. */
const LINK_COUNTS = [250, 2_000]

const RUNS = 3

/** Control characters in each link's folder part. The link text stays within
 *  the link-target limit, while JSON quoting would write each character as six. */
const CONTROL_FOLDER = "\u0001".repeat(4_000)

const indexNote = (index: SearchIndex, filePath: string, rawContent: string): void => {
  index.upsertNote(
    { filePath, rawContent, fileStat: { mtimeMs: 1, size: rawContent.length }, bodyTags: [] },
    logger,
  )
}

/** An index whose source note holds `count` distinct links named "real". Each
 *  link climbs back out of its folder, so every one of them resolves to
 *  real.md once that note exists. */
const createIndexWithStoredLinks = (count: number): SearchIndex => {
  const index = createSearchIndex(":memory:")
  const linkLines = Array.from({ length: count }, (_, linkNumber) => {
    return `[[${CONTROL_FOLDER}${linkNumber}/../real]]`
  })
  indexNote(index, "source.md", linkLines.join("\n"))
  return index
}

/** Counts the source's unresolved links, which keep their link text as the
 *  target, and lists the paths its other links resolved to. Counting keeps the
 *  output small enough for the parent's output buffer. */
const summarizeSourceTargets = (index: SearchIndex): { unresolved: number; resolved: string[] } => {
  const targets = index
    .getOutgoingLinks({ path: "source.md", dailyNotesFormat: "YYYY-MM-DD" }, logger)
    .map((outgoingLink) => outgoingLink.path)
  const resolved = targets.filter((target) => !target.startsWith(CONTROL_FOLDER))
  return { unresolved: targets.length - resolved.length, resolved }
}

/** Times adding real.md, which re-resolves every stored link named "real". */
const timeAddingRealNote = (index: SearchIndex): number => {
  const start = performance.now()
  indexNote(index, "real.md", "# Real")
  return performance.now() - start
}

const measurements = LINK_COUNTS.map((count) => {
  const checkedIndex = createIndexWithStoredLinks(count)
  const before = summarizeSourceTargets(checkedIndex)
  timeAddingRealNote(checkedIndex)
  const after = summarizeSourceTargets(checkedIndex)

  const elapsedRuns = Array.from({ length: RUNS }, () => {
    return timeAddingRealNote(createIndexWithStoredLinks(count))
  })
  return { count, before, after, leastMs: Math.min(...elapsedRuns) }
})

process.stdout.write(JSON.stringify({ measurements }))
