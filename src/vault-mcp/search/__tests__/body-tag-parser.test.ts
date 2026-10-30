import { describe, expect, it, onTestFinished, vi } from "vitest"
import { logger } from "../../../logger.js"
import { createBodyTagParser, type BodyTagParser } from "../body-tag-parser.js"
import { createSearchIndex } from "../search-index.js"
import { withBodyTags } from "./body-tag-test-helpers.js"

/** A paragraph remark-parse 8 takes seconds on (its emphasis scan is
 *  quadratic in runs of intraword `_`), ending in a tag so the no-candidate
 *  shortcut cannot answer it. */
const SLOW_BODY = `${"a_b ".repeat(16_000)}#slow`

/** Nesting deep enough to overflow the parser's stack inside the worker. */
const THROWING_BODY = `${"> ".repeat(16_384)}#deep`

const createTestParser = (timeoutMs: number): BodyTagParser => {
  const parser = createBodyTagParser({ timeoutMs })
  onTestFinished(() => parser.close())
  return parser
}

const createErrorLogger = () => ({ ...logger, error: vi.fn() })

/** True when a promise has already settled, checked after one turn of the
 *  event loop. */
const hasSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  const stillPending = Symbol("still pending")
  const nextTurn = new Promise<symbol>((resolveTurn) =>
    setImmediate(() => resolveTurn(stillPending)),
  )
  const winner = await Promise.race([promise, nextTurn])
  return winner !== stillPending
}

/** Waits for a worker to start and report ready, so a short limit in the next
 *  request measures parsing, never start-up. */
const warmUp = async (parser: BodyTagParser): Promise<void> => {
  const result = await parser.parse({ notePath: "warm-up.md", body: "#warm" }, logger)
  expect(result).toEqual({ outcome: "parsed", tags: ["warm"] })
}

describe("createBodyTagParser", () => {
  it("returns the tags of a note's body", async () => {
    const parser = createTestParser(2_000)

    const result = await parser.parse({ notePath: "a.md", body: "One #alpha and #beta/x" }, logger)

    expect(result).toEqual({ outcome: "parsed", tags: ["alpha", "beta/x"] })
  })

  it("answers a body with no tag candidate without parsing", async () => {
    const parser = createTestParser(2_000)

    const result = await parser.parse({ notePath: "a.md", body: "# Heading\n\nNo tags." }, logger)

    expect(result).toEqual({ outcome: "no-candidate" })
  })

  it("stops a note that passes the limit, logs it, and parses the next note in a fresh worker", async () => {
    const parser = createTestParser(50)
    const requestLogger = createErrorLogger()
    await warmUp(parser)

    const slowResult = await parser.parse({ notePath: "slow.md", body: SLOW_BODY }, requestLogger)
    const nextResult = await parser.parse({ notePath: "next.md", body: "#after" }, logger)

    expect(slowResult).toEqual({ outcome: "over-limit" })
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith(
      "body-tag parsing passed its time limit; indexed without body tags",
      { path: "slow.md", timeoutMs: 50 },
    )
    expect(nextResult).toEqual({ outcome: "parsed", tags: ["after"] })
  })

  it("gives notes queued behind a slow one their tags, because the limit starts when a note is posted", async () => {
    const parser = createTestParser(300)
    await warmUp(parser)

    const results = await Promise.all([
      parser.parse({ notePath: "slow.md", body: SLOW_BODY }, createErrorLogger()),
      parser.parse({ notePath: "first.md", body: "#first" }, logger),
      parser.parse({ notePath: "second.md", body: "#second" }, logger),
    ])

    expect(results).toEqual([
      { outcome: "over-limit" },
      { outcome: "parsed", tags: ["first"] },
      { outcome: "parsed", tags: ["second"] },
    ])
  })

  it("reports a parser throw inside the worker as a failed note and keeps going", async () => {
    const parser = createTestParser(5_000)
    const requestLogger = createErrorLogger()

    const throwingResult = await parser.parse(
      { notePath: "deep.md", body: THROWING_BODY },
      requestLogger,
    )
    const nextResult = await parser.parse({ notePath: "next.md", body: "#after" }, logger)

    expect(throwingResult).toEqual({ outcome: "failed" })
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith(
      "body-tag parser failed on a note; indexed without body tags",
      { path: "deep.md", error: "[RangeError]: Maximum call stack size exceeded" },
    )
    expect(nextResult).toEqual({ outcome: "parsed", tags: ["after"] })
  })

  it("drops a queued note whose signal aborted before it started", async () => {
    const parser = createTestParser(200)
    await warmUp(parser)
    const abortedRequest = new AbortController()

    const slowParse = parser.parse({ notePath: "slow.md", body: SLOW_BODY }, createErrorLogger())
    const droppedParse = parser.parse(
      { notePath: "dropped.md", body: "#dropped", signal: abortedRequest.signal },
      logger,
    )
    abortedRequest.abort()

    expect(await Promise.all([slowParse, droppedParse])).toEqual([
      { outcome: "over-limit" },
      { outcome: "dropped" },
    ])
  })

  it("settles the active and queued notes as closed and refuses new ones after close()", async () => {
    const parser = createBodyTagParser({ timeoutMs: 10_000 })
    const requestLogger = createErrorLogger()
    await warmUp(parser)

    const activeParse = parser.parse({ notePath: "slow.md", body: SLOW_BODY }, requestLogger)
    const queuedParse = parser.parse({ notePath: "queued.md", body: "#queued" }, logger)
    await parser.close()
    const afterClose = await parser.parse({ notePath: "late.md", body: "#late" }, logger)

    expect(await Promise.all([activeParse, queuedParse])).toEqual([
      { outcome: "closed" },
      { outcome: "closed" },
    ])
    expect(afterClose).toEqual({ outcome: "closed" })
    expect(requestLogger.error).not.toHaveBeenCalled()
  })

  it("keeps the main thread free while a slow note parses", async () => {
    const parser = createTestParser(10_000)
    await warmUp(parser)
    const index = createSearchIndex(":memory:")
    index.upsertNote(
      withBodyTags({
        filePath: "seeded.md",
        rawContent: "Seeded #ready",
        fileStat: { mtimeMs: 1_000, size: 13 },
      }),
      logger,
    )

    // The clock starts before parse() is called, so a parse that ran on the
    // main thread would show up in the first measurement
    const parseCallStart = performance.now()
    const slowParse = parser.parse({ notePath: "slow.md", body: SLOW_BODY }, createErrorLogger())
    const parseCallMs = performance.now() - parseCallStart
    const searchStart = performance.now()
    const searchResults = index.searchByTag({ tag: "ready" }, logger)
    const searchMs = performance.now() - searchStart
    const slowParseSettled = await hasSettled(slowParse)

    expect(parseCallMs).toBeLessThan(100)
    expect(searchMs).toBeLessThan(100)
    expect(searchResults.map((result) => result.path)).toEqual(["seeded.md"])
    expect(slowParseSettled).toBe(false)
  })
})
