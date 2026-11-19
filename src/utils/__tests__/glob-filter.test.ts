import { Worker } from "node:worker_threads"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { logger } from "../../logger.js"
import { createGlobFilter } from "../glob-filter.js"

// Real workers throughout. The spy lets a test reach the worker a call
// started, make the next worker fail to start, or swap the code it runs
vi.mock("node:worker_threads", { spy: true })

const { Worker: RealWorker } =
  await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads")

const createErrorLogger = () => ({ ...logger, error: vi.fn() })

/** The worker the most recent call started. */
const latestWorker = (): Worker => {
  const startedWorker = vi.mocked(Worker).mock.instances.at(-1)

  if (!startedWorker) throw new Error("no worker was started")
  return startedWorker
}

/** The value a promise rejects with, or null when it resolves. */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

/** Blocks the main thread, so timers and messages that come due meanwhile
 *  wait together for the next turn of the event loop. */
const blockMainThread = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** Resolves on the event loop's next turn, after the work already queued. */
const nextTurn = (): Promise<void> => new Promise((resolveTurn) => setImmediate(resolveTurn))

/** Makes the next call's worker run `source` in place of the glob worker. It
 *  gets the call's own options, so the call's reply port still reaches it. */
const replaceNextWorkerSource = (source: string): void => {
  // A function expression, because an arrow function cannot be called with
  // `new`
  vi.mocked(Worker).mockImplementationOnce(function (_entry, options) {
    return new RealWorker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), options)
  })
}

const VAULT_PATHS = [
  "a.md",
  "Notes/1-day.md",
  "Notes/x.md",
  "Projects/plan.md",
  "Projects/sub/deep.md",
  "readme.txt",
]

/** A glob whose matching against `SLOW_GLOB_PATHS` outlasts these tests'
 *  deadlines. Its one name has no "b", so the glob never matches it. */
const SLOW_GLOB = "**/*a*a*a*a*a*b.md"
const SLOW_GLOB_PATHS = [`${"a".repeat(160)}.md`]

// The tests below run one call at a time, so this limit never makes one wait
const filterPathsByGlob = createGlobFilter({ maxRunningWorkers: 2, maxWaitingCalls: 8 })

describe("createGlobFilter", () => {
  it.each([
    { label: "a top-level wildcard", glob: "*.md", expected: ["a.md"] },
    {
      label: "a globstar",
      glob: "**/*.md",
      expected: [
        "a.md",
        "Notes/1-day.md",
        "Notes/x.md",
        "Projects/plan.md",
        "Projects/sub/deep.md",
      ],
    },
    { label: "a character class", glob: "Notes/[0-9]*.md", expected: ["Notes/1-day.md"] },
    {
      label: "a brace list",
      glob: "{Notes,Projects}/*.md",
      expected: ["Notes/1-day.md", "Notes/x.md", "Projects/plan.md"],
    },
    { label: "another extension", glob: "**/*.txt", expected: ["readme.txt"] },
    { label: "a glob nothing matches", glob: "Archive/**", expected: [] },
  ])("matches $label as picomatch does", async ({ glob, expected }) => {
    const matches = await filterPathsByGlob({ glob, paths: VAULT_PATHS, timeoutMs: 2_000 }, logger)

    expect(matches).toEqual(expected)
  })

  it("matches an empty path list to an empty list", async () => {
    const matches = await filterPathsByGlob(
      { glob: "**/*.md", paths: [], timeoutMs: 2_000 },
      logger,
    )

    expect(matches).toEqual([])
  })

  it("rejects a glob still matching at the deadline and stops its worker", async () => {
    const rejection = await rejectionOf(
      filterPathsByGlob({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 200 }, logger),
    )

    expect(rejection).toEqual(new Error("glob matching timed out after 200 ms"))
    // A worker's threadId becomes -1 once it has stopped
    expect(latestWorker().threadId).toBe(-1)
  }, 10_000)

  it("matches normally on the call after a timeout", async () => {
    await rejectionOf(
      filterPathsByGlob({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 200 }, logger),
    )

    const matches = await filterPathsByGlob(
      { glob: "Notes/*.md", paths: VAULT_PATHS, timeoutMs: 2_000 },
      logger,
    )

    expect(matches).toEqual(["Notes/1-day.md", "Notes/x.md"])
  }, 10_000)

  it("returns a reply that arrived before the deadline even when the deadline is handled first", async () => {
    const pendingMatches = filterPathsByGlob(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 50 },
      logger,
    )
    // The worker replies and exits while the main thread is blocked. Blocking
    // from an immediate callback means the event loop runs its due timers,
    // the deadline among them, before it handles the reply or the exit
    setImmediate(() => {
      blockMainThread(3_000)
    })

    expect(await pendingMatches).toEqual(["a.md"])
  }, 10_000)

  it("returns the worker's reply even when its exit is handled first", async () => {
    const pendingMatches = filterPathsByGlob(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 },
      logger,
    )
    // The worker replies and exits while the main thread is blocked, and the
    // event loop then handles the exit before the reply. The deadline stays
    // beyond the block, so the exit is the only event that competes
    blockMainThread(3_000)

    expect(await pendingMatches).toEqual(["a.md"])
  }, 10_000)

  it("rejects and logs when the worker exits without replying", async () => {
    const requestLogger = createErrorLogger()
    replaceNextWorkerSource("process.exit(3)")

    const rejection = await rejectionOf(
      filterPathsByGlob({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 2_000 }, requestLogger),
    )

    expect(rejection).toEqual(
      new Error("glob matching failed", { cause: new Error("glob worker exited with code 3") }),
    )
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith("glob matching failed", {
      error: "[Error]: glob worker exited with code 3",
    })
  })

  it("rejects and logs when the worker replies with something other than matched paths", async () => {
    const requestLogger = createErrorLogger()
    replaceNextWorkerSource(
      'import { workerData } from "node:worker_threads"\n' +
        "workerData.replyPort.postMessage({ matches: [1] })",
    )

    const rejection = await rejectionOf(
      filterPathsByGlob({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 2_000 }, requestLogger),
    )

    expect(rejection).toEqual(
      new Error("glob matching failed", {
        cause: new Error("glob worker sent a malformed reply"),
      }),
    )
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith("glob matching failed", {
      error: "[Error]: glob worker sent a malformed reply",
    })
  })

  it("rejects and logs when the worker cannot be created", async () => {
    const requestLogger = createErrorLogger()
    // A function expression, because an arrow function cannot be called with
    // `new`
    vi.mocked(Worker).mockImplementationOnce(function () {
      throw new Error("thread creation failed")
    })

    const rejection = await rejectionOf(
      filterPathsByGlob({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 2_000 }, requestLogger),
    )

    expect(rejection).toEqual(
      new Error("glob matching failed", { cause: new Error("thread creation failed") }),
    )
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith("glob matching failed", {
      error: "[Error]: thread creation failed",
    })
  })

  it("rejects and logs when the worker fails to load, without matching on the main thread", async () => {
    const requestLogger = createErrorLogger()
    replaceNextWorkerSource("throw new Error('load failed')")

    const rejection = await rejectionOf(
      filterPathsByGlob({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 2_000 }, requestLogger),
    )

    expect(rejection).toEqual(
      new Error("glob matching failed", { cause: new Error("load failed") }),
    )
    expect(requestLogger.error).toHaveBeenCalledTimes(1)
    expect(requestLogger.error).toHaveBeenCalledWith("glob matching failed", {
      error: "[Error]: load failed",
    })
  })
})

describe("createGlobFilter's worker limit", () => {
  it("starts a waiting call's worker only after the running one ends", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 1 })
    vi.mocked(Worker).mockClear()

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 300 }, logger),
    )
    const waitingMatches = filterOneAtATime(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 },
      logger,
    )
    await nextTurn()

    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(1)
    expect(await runningRejection).toEqual(new Error("glob matching timed out after 300 ms"))
    expect(await waitingMatches).toEqual(["a.md"])
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2)
  }, 10_000)

  it("rejects a call still waiting at its deadline without starting its worker, and keeps the slot free for later calls", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 1 })
    vi.mocked(Worker).mockClear()

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 1_000 }, logger),
    )
    const waitingRejection = await rejectionOf(
      filterOneAtATime({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 100 }, logger),
    )

    expect(waitingRejection).toEqual(new Error("glob matching timed out after 100 ms"))
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(1)

    await runningRejection
    const laterMatches = await filterOneAtATime(
      { glob: "Notes/*.md", paths: VAULT_PATHS, timeoutMs: 2_000 },
      logger,
    )

    expect(laterMatches).toEqual(["Notes/1-day.md", "Notes/x.md"])
  }, 10_000)

  it("rejects a call at once when the waiting limit is full, and later calls still run", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 1 })
    vi.mocked(Worker).mockClear()

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 500 }, logger),
    )
    const waitingMatches = filterOneAtATime(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 },
      logger,
    )
    // Settles before the running call reaches its 500 ms deadline
    const turnedAwayRejection = await rejectionOf(
      filterOneAtATime({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 }, logger),
    )

    expect(turnedAwayRejection).toEqual(new Error("glob matching timed out after 5000 ms"))
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(1)
    expect(await runningRejection).toEqual(new Error("glob matching timed out after 500 ms"))
    expect(await waitingMatches).toEqual(["a.md"])

    const laterMatches = await filterOneAtATime(
      { glob: "Notes/*.md", paths: VAULT_PATHS, timeoutMs: 2_000 },
      logger,
    )

    expect(laterMatches).toEqual(["Notes/1-day.md", "Notes/x.md"])
  }, 10_000)

  it("frees the slot when a worker cannot be created", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 1 })
    // A function expression, because an arrow function cannot be called with
    // `new`
    vi.mocked(Worker).mockImplementationOnce(function () {
      throw new Error("thread creation failed")
    })

    const creationRejection = await rejectionOf(
      filterOneAtATime({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 2_000 }, createErrorLogger()),
    )
    const laterMatches = await filterOneAtATime(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 2_000 },
      logger,
    )

    expect(creationRejection).toEqual(
      new Error("glob matching failed", { cause: new Error("thread creation failed") }),
    )
    expect(laterMatches).toEqual(["a.md"])
  })

  it("hands a freed worker to the oldest waiting call first", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 2 })
    // One worker runs at a time, so the waiting calls finish in the order they got it
    const finishOrder: string[] = []
    const recordFinish = async (
      callLabel: string,
      pendingMatches: Promise<string[]>,
    ): Promise<string[]> => {
      const matches = await pendingMatches
      finishOrder.push(callLabel)
      return matches
    }

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 300 }, logger),
    )
    const olderWaitingMatches = recordFinish(
      "older waiting call",
      filterOneAtATime({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 }, logger),
    )
    const newerWaitingMatches = recordFinish(
      "newer waiting call",
      filterOneAtATime({ glob: "Notes/*.md", paths: VAULT_PATHS, timeoutMs: 5_000 }, logger),
    )

    expect(await runningRejection).toEqual(new Error("glob matching timed out after 300 ms"))
    expect(await Promise.all([olderWaitingMatches, newerWaitingMatches])).toEqual([
      ["a.md"],
      ["Notes/1-day.md", "Notes/x.md"],
    ])
    expect(finishOrder).toEqual(["older waiting call", "newer waiting call"])
  }, 10_000)

  it("keeps the limit after handing a freed worker to a waiting call", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 1 })
    vi.mocked(Worker).mockClear()

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 300 }, logger),
    )
    const handedOverRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 1_500 }, logger),
    )
    expect(await runningRejection).toEqual(new Error("glob matching timed out after 300 ms"))

    const laterMatches = filterOneAtATime(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 },
      logger,
    )
    await nextTurn()

    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2)
    expect(await handedOverRejection).toEqual(new Error("glob matching timed out after 1500 ms"))
    expect(await laterMatches).toEqual(["a.md"])
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(3)
  }, 10_000)

  it("removes only the call that stopped waiting from the queue", async () => {
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 2 })
    vi.mocked(Worker).mockClear()

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 1_000 }, logger),
    )
    const stillWaitingMatches = filterOneAtATime(
      { glob: "*.md", paths: VAULT_PATHS, timeoutMs: 5_000 },
      logger,
    )
    const stoppedWaitingRejection = await rejectionOf(
      filterOneAtATime({ glob: "*.md", paths: VAULT_PATHS, timeoutMs: 100 }, logger),
    )
    await nextTurn()

    expect(stoppedWaitingRejection).toEqual(new Error("glob matching timed out after 100 ms"))
    // Leaving the queue gives no slot away, so the call still waiting has not started
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(1)
    expect(await runningRejection).toEqual(new Error("glob matching timed out after 1000 ms"))
    expect(await stillWaitingMatches).toEqual(["a.md"])
  }, 10_000)

  it("counts a waiting call's deadline from the call's start, not from its worker's start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const filterOneAtATime = createGlobFilter({ maxRunningWorkers: 1, maxWaitingCalls: 1 })
    vi.mocked(Worker).mockClear()

    const runningRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 1_000 }, logger),
    )
    const waitingRejection = rejectionOf(
      filterOneAtATime({ glob: SLOW_GLOB, paths: SLOW_GLOB_PATHS, timeoutMs: 1_500 }, logger),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await runningRejection).toEqual(new Error("glob matching timed out after 1000 ms"))
    await nextTurn()

    // The waiting call's worker starts 1,000 ms into the call's 1,500 ms deadline
    expect(vi.mocked(Worker)).toHaveBeenCalledTimes(2)
    const waitingCallTerminate = vi.spyOn(latestWorker(), "terminate")

    await vi.advanceTimersByTimeAsync(500)

    expect(waitingCallTerminate).toHaveBeenCalledTimes(1)
    expect(await waitingRejection).toEqual(new Error("glob matching timed out after 1500 ms"))
  }, 10_000)
})
