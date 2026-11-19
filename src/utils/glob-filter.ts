import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"
import type { MessagePort } from "node:worker_threads"
import type { Logger } from "../logger.js"
import { describeError } from "./describe-error.js"
import { siblingModuleUrl } from "./sibling-module-url.js"

const WORKER_ENTRY = siblingModuleUrl({ name: "glob-filter-worker", besideModule: import.meta.url })

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

/** Resolves with the outcome of the worker's reply, its error, its exit or the
 *  deadline, whichever comes first; a reply already queued on the port wins
 *  over the others. */
const waitForOutcome = async (params: {
  worker: Worker
  replyReceivingPort: MessagePort
  timeoutMs: number
}): Promise<GlobFilterOutcome> => {
  const { worker, replyReceivingPort, timeoutMs } = params

  const replied = new Promise<GlobFilterOutcome>((resolveReply) => {
    replyReceivingPort.once("message", (message: unknown) => {
      resolveReply(outcomeFromReply(message))
    })
  })
  const workerEnded = new Promise<GlobFilterOutcome>((resolveEnd) => {
    // A worker that dies on an uncaught error emits "error" before "exit"; with
    // no listener, Node rethrows it on the main thread and the server exits, so
    // this listener stays attached for the worker's whole life
    worker.on("error", (error) => {
      resolveEnd({ kind: "failed", cause: error })
    })
    worker.once("exit", (exitCode) => {
      resolveEnd({ kind: "failed", cause: new Error(`glob worker exited with code ${exitCode}`) })
    })
  })
  const { promise: deadlinePassed, resolve: passDeadline } =
    Promise.withResolvers<GlobFilterOutcome>()
  const deadlineTimer = setTimeout(() => {
    passDeadline({ kind: "timed-out" })
  }, timeoutMs)

  const firstOutcome = await Promise.race([replied, workerEnded, deadlinePassed])
  clearTimeout(deadlineTimer)

  // A reply is still queued when another event was handled first:
  // - the worker exits right after posting its one reply
  // - the deadline comes due while the reply is in flight
  const queuedReply = receiveMessageOnPort(replyReceivingPort)
  return queuedReply ? outcomeFromReply(queuedReply.message) : firstOutcome
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
  const { port1: replyReceivingPort, port2: replySendingPort } = new MessageChannel()
  const workerStart = startGlobWorker({ glob, paths, replyPort: replySendingPort })

  if (!workerStart.started) {
    replyReceivingPort.close()
    return { kind: "failed", cause: workerStart.cause }
  }

  const { worker } = workerStart
  // The worker never holds the process open on its own; the deadline timer
  // does that while the call waits
  worker.unref()

  try {
    return await waitForOutcome({ worker, replyReceivingPort, timeoutMs })
  } finally {
    replyReceivingPort.close()
    await worker.terminate()
  }
}

/**
 * The paths `glob` matches, by picomatch, computed in a worker thread so a
 * glob that matches slowly never blocks the main thread.
 * - The `timeoutMs` deadline counts from the worker's start, start-up
 *   included. Past it, the worker is terminated and the call rejects with
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
      // The caller's glob caused it, not a fault in the worker, so logging it
      // is left to the caller
      throw new Error(`glob matching timed out after ${timeoutMs} ms`)
    case "failed":
      logger.error("glob matching failed", { error: describeError(outcome.cause) })
      throw new Error("glob matching failed", { cause: outcome.cause })
  }
}
