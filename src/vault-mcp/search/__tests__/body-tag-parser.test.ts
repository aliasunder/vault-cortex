import { setImmediate as setImmediateAsync } from "node:timers/promises"
import { Worker } from "node:worker_threads"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { logger } from "../../../logger.js"
import { createBodyTagParser, type BodyTagParser } from "../body-tag-parser.js"
import { createSearchIndex } from "../search-index.js"
import { withBodyTags } from "./body-tag-test-helpers.js"

// Real workers throughout. The spy lets a test reach the worker the parser
// started, to deliver a crash or a reply at a moment a real worker cannot be
// made to choose
vi.mock("node:worker_threads", { spy: true })

/** The worker the parser started most recently. */
const latestWorker = (): Worker => {
  const startedWorker = vi.mocked(Worker).mock.instances.at(-1)

  if (!startedWorker) throw new Error("the parser started no worker")
  return startedWorker
}

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

  it("keeps a note over-limit when its reply arrives while the worker is stopping", async () => {
    const parser = createTestParser(50)
    const requestLogger = createErrorLogger()
    await warmUp(parser)
    const slowWorker = latestWorker()
    const postedRequestIds: number[] = []
    // The module spy already wraps these methods, so each "Once" override's
    // inner call falls through to the real method
    vi.mocked(slowWorker.postMessage).mockImplementationOnce((request: { requestId: number }) => {
      postedRequestIds.push(request.requestId)
      slowWorker.postMessage(request)
    })
    vi.mocked(slowWorker.terminate).mockImplementationOnce(() => {
      // A reply already on its way when the limit fires
      for (const requestId of postedRequestIds) {
        slowWorker.emit("message", { kind: "parsed", requestId, tags: ["late"] })
      }
      return slowWorker.terminate()
    })

    const slowResult = await parser.parse({ notePath: "slow.md", body: SLOW_BODY }, requestLogger)

    expect(postedRequestIds).toHaveLength(1)
    expect(slowResult).toEqual({ outcome: "over-limit" })
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

  it("settles a note failed and logs it when its worker crashes, without stopping the main thread", async () => {
    const parser = createTestParser(10_000)
    const requestLogger = createErrorLogger()
    await warmUp(parser)

    const crashingParse = parser.parse({ notePath: "slow.md", body: SLOW_BODY }, requestLogger)
    // One turn lets the parser post the note to its ready worker
    await setImmediateAsync()
    const crashedWorker = latestWorker()
    onTestFinished(async () => {
      await crashedWorker.terminate()
    })
    // Emitting "error" with no listener throws here, as Node would on the
    // main thread for a worker that ran out of memory
    crashedWorker.emit("error", new RangeError("out of memory"))
    const crashResult = await crashingParse
    const nextResult = await parser.parse({ notePath: "next.md", body: "#after" }, logger)

    expect(crashResult).toEqual({ outcome: "failed" })
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith(
      "body-tag worker failed while parsing a note; indexed without body tags",
      { path: "slow.md", error: "[RangeError]: out of memory" },
    )
    expect(nextResult).toEqual({ outcome: "parsed", tags: ["after"] })
    expect(latestWorker()).not.toBe(crashedWorker)
  })

  it("settles a note failed and logs it when its worker exits mid-parse, then parses the next note in a fresh worker", async () => {
    const parser = createTestParser(10_000)
    const requestLogger = createErrorLogger()
    await warmUp(parser)

    const exitingParse = parser.parse({ notePath: "slow.md", body: SLOW_BODY }, requestLogger)
    // One turn lets the parser post the note to its ready worker
    await setImmediateAsync()
    const exitedWorker = latestWorker()
    // Stopped from outside the parser, which a terminated worker reports as exit code 1
    await exitedWorker.terminate()
    const exitResult = await exitingParse
    const nextResult = await parser.parse({ notePath: "next.md", body: "#after" }, logger)

    expect(exitResult).toEqual({ outcome: "failed" })
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith(
      "body-tag worker exited while parsing a note; indexed without body tags",
      { path: "slow.md", exitCode: 1 },
    )
    expect(nextResult).toEqual({ outcome: "parsed", tags: ["after"] })
    expect(latestWorker()).not.toBe(exitedWorker)
  })

  it("settles a note unavailable and logs it when its worker fails to start, then starts a fresh worker for the next note", async () => {
    const parser = createTestParser(10_000)
    const requestLogger = createErrorLogger()

    const startingParse = parser.parse({ notePath: "a.md", body: "#alpha" }, requestLogger)
    const failedWorker = latestWorker()
    // A worker whose entry cannot load reports "error" before it is ready
    failedWorker.emit("error", new Error("cannot load the worker entry"))
    const startResult = await startingParse
    const nextResult = await parser.parse({ notePath: "next.md", body: "#after" }, logger)

    expect(startResult).toEqual({ outcome: "unavailable" })
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith(
      "body-tag worker failed to start; note indexed without body tags",
      { path: "a.md", error: "[Error]: cannot load the worker entry" },
    )
    expect(vi.mocked(failedWorker.postMessage)).not.toHaveBeenCalled()
    expect(nextResult).toEqual({ outcome: "parsed", tags: ["after"] })
    expect(latestWorker()).not.toBe(failedWorker)
  })

  it("settles a note unavailable and logs it when the worker cannot be created, then starts one for the next note", async () => {
    const parser = createTestParser(10_000)
    const requestLogger = createErrorLogger()
    // Node throws from the Worker constructor itself when it cannot create the
    // thread, such as under a container's process limit. A function expression,
    // because an arrow function cannot be called with `new`
    vi.mocked(Worker).mockImplementationOnce(function () {
      throw new Error("thread creation failed")
    })

    const failedResult = await parser.parse({ notePath: "a.md", body: "#alpha" }, requestLogger)
    const nextResult = await parser.parse({ notePath: "next.md", body: "#after" }, logger)

    expect(failedResult).toEqual({ outcome: "unavailable" })
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith(
      "body-tag worker failed to start; note indexed without body tags",
      { path: "a.md", error: "[Error]: thread creation failed" },
    )
    expect(nextResult).toEqual({ outcome: "parsed", tags: ["after"] })
  })

  // The warm-up was request 0, so the slow note is request 1
  it.each([
    {
      label: "a reply for another request",
      reply: { kind: "parsed", requestId: 99, tags: ["stale"] },
    },
    {
      label: "a reply whose tags are not all names",
      reply: { kind: "parsed", requestId: 1, tags: ["stale", 7] },
    },
  ])("ignores $label and waits for the note's own reply", async ({ reply }) => {
    const parser = createTestParser(50)
    await warmUp(parser)

    const slowParse = parser.parse({ notePath: "slow.md", body: SLOW_BODY }, createErrorLogger())
    // One turn lets the parser post the note to its ready worker
    await setImmediateAsync()
    latestWorker().emit("message", reply)

    expect(await slowParse).toEqual({ outcome: "over-limit" })
  })

  it("settles a note closed without logging when close() stops its worker during start-up", async () => {
    const parser = createBodyTagParser({ timeoutMs: 10_000 })
    const requestLogger = createErrorLogger()

    const startingParse = parser.parse({ notePath: "a.md", body: "#alpha" }, requestLogger)
    await parser.close()

    expect(await startingParse).toEqual({ outcome: "closed" })
    expect(requestLogger.error).not.toHaveBeenCalled()
  })

  it("posts nothing to a worker that reports ready after close() has stopped it", async () => {
    const parser = createBodyTagParser({ timeoutMs: 10_000 })
    const requestLogger = createErrorLogger()

    const startingParse = parser.parse({ notePath: "a.md", body: "#alpha" }, requestLogger)
    const startingWorker = latestWorker()
    const closing = parser.close()
    // The ready message arrives after terminate() starts but before "exit"
    startingWorker.emit("message", { kind: "ready" })
    await closing

    expect(await startingParse).toEqual({ outcome: "closed" })
    expect(vi.mocked(startingWorker.postMessage)).not.toHaveBeenCalled()
    expect(requestLogger.error).not.toHaveBeenCalled()
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
    // One turn lets the parser post the slow note, so close() stops a worker
    // that is parsing it rather than one the note has not reached yet
    await setImmediateAsync()
    // The warm-up was request 0
    expect(vi.mocked(latestWorker().postMessage)).toHaveBeenLastCalledWith({
      requestId: 1,
      body: SLOW_BODY,
    })
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
