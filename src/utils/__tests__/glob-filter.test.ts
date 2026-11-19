import { Worker } from "node:worker_threads"
import { describe, expect, it, vi } from "vitest"
import { logger } from "../../logger.js"
import { filterPathsByGlob } from "../glob-filter.js"

// Real workers throughout. The spy lets a test reach the worker a call
// started, or make the next worker fail to start or to load
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

describe("filterPathsByGlob", () => {
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
    // The worker replies while the main thread is blocked, so the deadline
    // timer and the reply both wait, and the timer runs first
    blockMainThread(3_000)

    expect(await pendingMatches).toEqual(["a.md"])
  }, 10_000)

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
    vi.mocked(Worker).mockImplementationOnce(function (_entry, options) {
      return new RealWorker(new URL("data:text/javascript,throw new Error('load failed')"), options)
    })

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
