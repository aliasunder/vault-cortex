import { extname } from "node:path"
import { fileURLToPath } from "node:url"
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"
import type { MessagePort } from "node:worker_threads"
import type { Logger } from "../logger.js"
import { describeError } from "./describe-error.js"

/**
 * The worker entry beside this module. Compiled `dist` runs `.js` files, while
 * `tsx` and vitest run the `.ts` sources, so the entry takes this module's own
 * extension; under tsx the worker inherits the parent's `--import tsx`.
 */
const WORKER_ENTRY = new URL(
  `./glob-filter-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
)

type GlobFilterOutcome =
  | Readonly<{ kind: "matched"; matches: string[] }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "failed"; cause: unknown }>

const isGlobReply = (message: unknown): message is { matches: string[] } => {
  if (typeof message !== "object" || message === null) return false
  if (!("matches" in message) || !Array.isArray(message.matches)) return false
  return message.matches.every((match: unknown) => typeof match === "string")
}

const outcomeFromReply = (message: unknown): GlobFilterOutcome => {
  if (isGlobReply(message)) return { kind: "matched", matches: message.matches }
  return { kind: "failed", cause: new Error("glob worker sent a malformed reply") }
}

/** Resolves with the first of the worker's reply, its error, its exit and the
 *  deadline. A reply already queued on the port wins over any of the others,
 *  so a match that finished just before the deadline is never reported as a
 *  timeout. */
const waitForOutcome = (params: {
  worker: Worker
  replyPort: MessagePort
  timeoutMs: number
}): Promise<GlobFilterOutcome> => {
  const { worker, replyPort, timeoutMs } = params

  return new Promise((resolveOutcome) => {
    // Set once, by whichever event comes first; later events find it set
    let settled = false

    const settle = (outcome: GlobFilterOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      replyPort.off("message", handleReply)
      worker.off("exit", handleExit)

      const queuedReply = receiveMessageOnPort(replyPort)
      resolveOutcome(queuedReply ? outcomeFromReply(queuedReply.message) : outcome)
    }

    const handleReply = (message: unknown): void => {
      settle(outcomeFromReply(message))
    }
    const handleExit = (exitCode: number): void => {
      settle({ kind: "failed", cause: new Error(`glob worker exited with code ${exitCode}`) })
    }
    // A worker that dies on an uncaught error emits "error" before "exit"; with
    // no listener, Node rethrows it on the main thread and the server exits, so
    // this listener stays attached for the worker's whole life
    const handleError = (error: Error): void => {
      settle({ kind: "failed", cause: error })
    }
    const deadlineTimer = setTimeout(() => {
      settle({ kind: "timed-out" })
    }, timeoutMs)

    replyPort.on("message", handleReply)
    worker.on("error", handleError)
    worker.once("exit", handleExit)
  })
}

type WorkerStart =
  Readonly<{ started: true; worker: Worker }> | Readonly<{ started: false; cause: unknown }>

const startGlobWorker = (workerData: {
  glob: string
  paths: readonly string[]
  replyPort: MessagePort
}): WorkerStart => {
  // The Worker constructor itself throws when Node cannot create the thread
  try {
    const worker = new Worker(WORKER_ENTRY, { workerData, transferList: [workerData.replyPort] })
    return { started: true, worker }
  } catch (error) {
    return { started: false, cause: error }
  }
}

const matchInWorker = async (params: {
  glob: string
  paths: readonly string[]
  timeoutMs: number
}): Promise<GlobFilterOutcome> => {
  const { glob, paths, timeoutMs } = params
  const { port1: replyPort, port2: workerReplyPort } = new MessageChannel()
  const workerStart = startGlobWorker({ glob, paths, replyPort: workerReplyPort })

  if (!workerStart.started) {
    replyPort.close()
    return { kind: "failed", cause: workerStart.cause }
  }

  const { worker } = workerStart
  // An idle worker never keeps the process alive; a call in flight still
  // does, through its deadline timer
  worker.unref()

  try {
    return await waitForOutcome({ worker, replyPort, timeoutMs })
  } finally {
    replyPort.close()
    await worker.terminate()
  }
}

/**
 * The paths `glob` matches, by picomatch, computed in a worker thread so a
 * glob that matches slowly never blocks the main thread.
 * - The deadline counts from the worker's start, start-up included. Past
 *   `timeoutMs`, the worker is terminated and the call rejects with
 *   `glob matching timed out after <timeoutMs> ms`.
 * - A worker that fails to start, errors, exits early or replies malformed
 *   rejects with `glob matching failed`, the original error as its `cause`,
 *   and logs an error. The glob never falls back to the main thread.
 */
export const filterPathsByGlob = async (
  params: { glob: string; paths: readonly string[]; timeoutMs: number },
  logger: Logger,
): Promise<string[]> => {
  const { glob, paths, timeoutMs } = params
  const outcome = await matchInWorker({ glob, paths, timeoutMs })

  switch (outcome.kind) {
    case "matched":
      return outcome.matches
    case "timed-out":
      throw new Error(`glob matching timed out after ${timeoutMs} ms`)
    case "failed":
      logger.error("glob matching failed", { error: describeError(outcome.cause) })
      throw new Error("glob matching failed", { cause: outcome.cause })
  }
}
