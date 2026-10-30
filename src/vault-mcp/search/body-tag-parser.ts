import { extname } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import type { Logger } from "../../logger.js"
import { hasTagCandidate } from "../obsidian-markdown/body-tags.js"
import { describeError } from "../../utils/describe-error.js"

/** How one note's body-tag parse ended. Only "parsed" carries tags; every
 *  other outcome means the note is indexed with no body tags. "unavailable"
 *  means the worker could not start, which says nothing about the note, so a
 *  caller holding the note's earlier tags may keep them. */
export type BodyTagParseResult =
  | { outcome: "parsed"; tags: string[] }
  | { outcome: "no-candidate" }
  | { outcome: "over-limit" }
  | { outcome: "failed" }
  | { outcome: "unavailable" }
  | { outcome: "dropped" }
  | { outcome: "closed" }

export type BodyTagParser = {
  parse: (
    params: { notePath: string; body: string; signal?: AbortSignal | undefined },
    logger: Logger,
  ) => Promise<BodyTagParseResult>
  close: () => Promise<void>
}

/** The server's limit on one note's body-tag parse, before the note is indexed
 *  without body tags. Normal notes parse in about a millisecond, so only a
 *  pathological note reaches it, and each such note delays the notes queued
 *  behind it by at most this. */
export const BODY_TAG_PARSE_TIMEOUT_MS = 2_000

/** The tags a parse result gives the index, which are none unless it parsed. */
export const bodyTagsFromParseResult = (result: BodyTagParseResult): string[] => {
  return result.outcome === "parsed" ? result.tags : []
}

type ParseJob = {
  notePath: string
  body: string
  signal: AbortSignal | undefined
  logger: Logger
  settle: (result: BodyTagParseResult) => void
}

type WorkerReply =
  | { kind: "ready" }
  | { kind: "parsed"; requestId: number; tags: string[] }
  | { kind: "failed"; requestId: number; reason: string }

const isWorkerReply = (message: unknown): message is WorkerReply => {
  if (typeof message !== "object" || message === null || !("kind" in message)) return false
  if (message.kind === "ready") return true
  if (!("requestId" in message) || typeof message.requestId !== "number") return false
  if (message.kind === "failed") return "reason" in message && typeof message.reason === "string"
  if (message.kind !== "parsed") return false
  if (!("tags" in message) || !Array.isArray(message.tags)) return false
  return message.tags.every((tag: unknown) => typeof tag === "string")
}

/**
 * The worker entry beside this module. Compiled `dist` runs `.js` files, while
 * `tsx` (the dev server, the integration harness, scripts) and vitest run the
 * `.ts` sources, so the entry takes this module's own extension. A `.ts` entry
 * needs a TypeScript loader in the worker: under tsx the worker inherits the
 * parent's `--import tsx`, and vitest's config passes the same flag.
 */
const WORKER_ENTRY = new URL(
  `./body-tag-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
)

/**
 * Runs `parseBodyTags` in one worker thread, one note at a time, so a note
 * that parses slowly never blocks the main thread. remark-parse 8, like
 * Obsidian's own parser, slows quadratically on long paragraphs full of `_`,
 * `[` or `=`, so no input size bounds its time; `timeoutMs` does.
 * - A body with no tag candidate resolves "no-candidate" without the worker.
 * - A note's limit starts when it is posted to a worker that reported ready, so
 *   queue wait and worker start-up never count against it.
 * - Past the limit, the worker is terminated and the note resolves
 *   "over-limit"; a parser throw, a worker crash or a worker exit resolves
 *   "failed". Each logs an error naming the note. After an over-limit note, a
 *   crash or an exit, the next note gets a fresh worker; after a parser throw,
 *   the worker is still healthy and stays in place.
 * - A worker that fails to start resolves the note "unavailable" and logs an
 *   error; the next note tries a fresh worker.
 * - A queued note whose signal aborted resolves "dropped" without parsing.
 * - `close()` resolves every pending note "closed" and starts no new worker.
 */
export const createBodyTagParser = (params: { timeoutMs: number }): BodyTagParser => {
  const { timeoutMs } = params

  // Mutable because the queue drains one job at a time across async events:
  // the worker is replaced after a timeout or exit, the active job changes as
  // each job finishes, and close() turns the parser off for good.
  const queue: ParseJob[] = []
  let worker: Worker | null = null
  let workerReady: Promise<Worker> | null = null
  let draining = false
  let nextRequestId = 0
  let closed = false

  /** Starts a worker and resolves once it reports ready, or rejects when it
   *  fails to load. The worker is unref'd, so an idle one never keeps a
   *  process alive; a job in flight still does, through its limit timer. */
  const startWorker = (): Promise<Worker> => {
    const startingWorker = new Worker(WORKER_ENTRY)
    startingWorker.unref()
    worker = startingWorker

    return new Promise((resolveReady, rejectReady) => {
      const handleReadyMessage = (message: unknown): void => {
        if (!isWorkerReply(message) || message.kind !== "ready") return

        startingWorker.off("message", handleReadyMessage)
        startingWorker.off("error", rejectReady)
        startingWorker.off("exit", handleEarlyExit)
        resolveReady(startingWorker)
      }
      const handleEarlyExit = (exitCode: number): void => {
        rejectReady(new Error(`worker exited with code ${exitCode} before it was ready`))
      }

      startingWorker.on("message", handleReadyMessage)
      startingWorker.once("error", rejectReady)
      startingWorker.once("exit", handleEarlyExit)
    })
  }

  /** Drops the current worker so the next job starts a fresh one. */
  const discardWorker = async (): Promise<void> => {
    const discardedWorker = worker
    worker = null
    workerReady = null

    if (discardedWorker) await discardedWorker.terminate()
  }

  /** The ready worker, starting one when there is none; null when it fails to
   *  start, which is a fault in the build or the host, not in the note. `job`
   *  names the note the failure is logged against. */
  const getReadyWorker = async (job: ParseJob): Promise<Worker | null> => {
    // Inside the try, because the Worker constructor itself throws when Node
    // cannot create the thread
    try {
      workerReady ??= startWorker()
      return await workerReady
    } catch (error) {
      await discardWorker()

      // close() terminates a starting worker, which is not a failure to log
      if (closed) return null
      job.logger.error("body-tag worker failed to start; note indexed without body tags", {
        path: job.notePath,
        error: describeError(error),
      })
      return null
    }
  }

  /** Posts one job to the worker and resolves with its outcome, which the
   *  reply, the limit timer or a worker exit decides, whichever comes first. */
  const parseInWorker = (job: ParseJob, readyWorker: Worker): Promise<BodyTagParseResult> => {
    const requestId = nextRequestId++

    return new Promise((resolveOutcome) => {
      const finish = (result: BodyTagParseResult): void => {
        clearTimeout(limitTimer)
        readyWorker.off("message", handleReply)
        readyWorker.off("exit", handleExit)
        readyWorker.off("error", handleWorkerError)
        resolveOutcome(result)
      }

      // A worker that dies on an uncaught error, such as running out of
      // memory, emits "error" before "exit"; with no listener, Node rethrows
      // it on the main thread and the server exits. The worker is already
      // stopping, so it is dropped without terminate()
      const handleWorkerError = (error: Error): void => {
        worker = null
        workerReady = null
        job.logger.error("body-tag worker failed while parsing a note; indexed without body tags", {
          path: job.notePath,
          error: describeError(error),
        })
        finish({ outcome: "failed" })
      }

      const handleReply = (message: unknown): void => {
        if (!isWorkerReply(message) || message.kind === "ready") return
        if (message.requestId !== requestId) return

        if (message.kind === "parsed") {
          finish({ outcome: "parsed", tags: message.tags })
          return
        }
        job.logger.error("body-tag parser failed on a note; indexed without body tags", {
          path: job.notePath,
          error: message.reason,
        })
        finish({ outcome: "failed" })
      }

      // close() terminates the worker mid-job, which is not a failure to log
      const handleExit = (exitCode: number): void => {
        worker = null
        workerReady = null

        if (closed) {
          finish({ outcome: "closed" })
          return
        }
        job.logger.error("body-tag worker exited while parsing a note; indexed without body tags", {
          path: job.notePath,
          exitCode,
        })
        finish({ outcome: "failed" })
      }

      const handleTimeout = async (): Promise<void> => {
        // A reply landing while the worker stops must not settle the job
        // "parsed". handleWorkerError stays attached, for the crash its
        // comment describes
        readyWorker.off("message", handleReply)
        readyWorker.off("exit", handleExit)
        job.logger.error("body-tag parsing passed its time limit; indexed without body tags", {
          path: job.notePath,
          timeoutMs,
        })

        // The outcome waits for the old worker to stop, so the next job never
        // overlaps it
        try {
          await discardWorker()
        } finally {
          finish({ outcome: "over-limit" })
        }
      }

      readyWorker.on("message", handleReply)
      readyWorker.once("exit", handleExit)
      readyWorker.once("error", handleWorkerError)

      // setTimeout ignores the returned promise; handleTimeout settles the job
      // in its finally block, so it has no failure left to report
      const limitTimer = setTimeout(() => void handleTimeout(), timeoutMs)
      readyWorker.postMessage({ requestId, body: job.body })
    })
  }

  /** Runs queued jobs one at a time until the queue is empty or the parser
   *  closes. It never rejects: every failure settles its job as an outcome. */
  const drainQueue = async (): Promise<void> => {
    if (draining) return

    draining = true

    while (!closed) {
      // shift() takes from the array parse() and close() also use, in place
      const job = queue.shift()

      if (!job) break
      if (job.signal?.aborted) {
        job.settle({ outcome: "dropped" })
        continue
      }

      const readyWorker = await getReadyWorker(job)

      // close() during start-up already terminated the worker, ready or not
      if (closed) {
        job.settle({ outcome: "closed" })
        break
      }
      if (!readyWorker) {
        job.settle({ outcome: "unavailable" })
        continue
      }
      job.settle(await parseInWorker(job, readyWorker))
    }
    draining = false
  }

  const parse: BodyTagParser["parse"] = (params, logger) => {
    const { notePath, body, signal } = params

    if (closed) return Promise.resolve({ outcome: "closed" })
    if (!hasTagCandidate(body)) return Promise.resolve({ outcome: "no-candidate" })

    return new Promise((settle) => {
      queue.push({ notePath, body, signal, logger, settle })
      // Detached on purpose: parse() resolves through the job's settle, and
      // drainQueue never rejects
      void drainQueue()
    })
  }

  const close: BodyTagParser["close"] = async () => {
    closed = true

    // Empties the shared queue in place, so a running drainQueue sees no more jobs
    const pendingJobs = queue.splice(0)
    for (const job of pendingJobs) job.settle({ outcome: "closed" })
    await discardWorker()
  }

  return { parse, close }
}
