import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"
import type { MessagePort } from "node:worker_threads"
import type { Logger } from "../logger.js"
import { describeError } from "./describe-error.js"
import { siblingModuleUrl } from "./sibling-module-url.js"

const WORKER_ENTRY = siblingModuleUrl({ name: "glob-filter-worker", besideModule: import.meta.url })

type GlobFilterOutcome =
  | Readonly<{ kind: "matched"; matches: string[] }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "turned-away" }>
  | Readonly<{ kind: "failed"; cause: unknown }>

type DeadlinePassed = Promise<Readonly<{ kind: "timed-out" }>>

type GlobFilter = (
  params: { glob: string; paths: readonly string[]; timeoutMs: number },
  logger: Logger,
) => Promise<string[]>

type SlotRequest =
  | Readonly<{
      admitted: true
      taken: Promise<Readonly<{ kind: "slot-taken" }>>
      /** Gives the caller's place back: leaves the queue while still waiting, or frees the slot it holds. */
      release: () => void
    }>
  | Readonly<{ admitted: false }>

/**
 * At most `maxRunningWorkers` slots are held at once:
 * - A caller over that limit waits, and a freed slot goes to the oldest
 *   waiting caller.
 * - At most `maxWaitingCalls` callers wait; a caller beyond them is not admitted.
 */
const createWorkerSlots = (params: { maxRunningWorkers: number; maxWaitingCalls: number }) => {
  const { maxRunningWorkers, maxWaitingCalls } = params
  // Holds each waiting caller's grant, oldest first, and is mutated in place
  // because callers join it and leave it at any time
  const waitingGrants: Array<() => void> = []
  // Counts the slots held now, and changes as callers take and release them
  let heldSlots = 0

  const freeSlot = (): void => {
    const nextGrant = waitingGrants.shift()

    // The slot passes straight to the next caller, so the held count stays the same
    if (nextGrant) {
      nextGrant()
      return
    }
    heldSlots -= 1
  }

  const request = (): SlotRequest => {
    if (heldSlots < maxRunningWorkers) {
      heldSlots += 1
      return { admitted: true, taken: Promise.resolve({ kind: "slot-taken" }), release: freeSlot }
    }

    if (waitingGrants.length >= maxWaitingCalls) return { admitted: false }

    const { promise: taken, resolve: resolveTaken } =
      Promise.withResolvers<Readonly<{ kind: "slot-taken" }>>()
    const grant = (): void => {
      resolveTaken({ kind: "slot-taken" })
    }
    waitingGrants.push(grant)

    const release = (): void => {
      const waitingIndex = waitingGrants.indexOf(grant)

      // Not waiting any more means the slot was already handed to this caller
      if (waitingIndex === -1) {
        freeSlot()
        return
      }
      waitingGrants.splice(waitingIndex, 1)
    }
    return { admitted: true, taken, release }
  }

  return { request }
}

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
  deadlinePassed: DeadlinePassed
}): Promise<GlobFilterOutcome> => {
  const { worker, replyReceivingPort, deadlinePassed } = params

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

  const firstOutcome = await Promise.race([replied, workerEnded, deadlinePassed])

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
  deadlinePassed: DeadlinePassed
}): Promise<GlobFilterOutcome> => {
  const { glob, paths, deadlinePassed } = params
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
    return await waitForOutcome({ worker, replyReceivingPort, deadlinePassed })
  } finally {
    replyReceivingPort.close()
    await worker.terminate()
  }
}

/**
 * A filter returning the paths `glob` matches, by picomatch, computed in a
 * worker thread so a glob that matches slowly never blocks the main thread.
 * - At most `maxRunningWorkers` workers run at once. A call over the limit
 *   waits for a running one to finish, oldest call first, and at most
 *   `maxWaitingCalls` calls wait.
 * - The `timeoutMs` deadline counts from the call's start, any wait for a
 *   worker and its start-up included. Past it, a running worker is terminated
 *   and the call rejects with `glob matching timed out after <timeoutMs> ms`.
 *   A call that finds `maxWaitingCalls` calls already waiting rejects at once
 *   with `glob matching timed out: too many glob calls are waiting`.
 * - A worker that fails to start, errors, exits early or replies malformed
 *   rejects with `glob matching failed`, the original error as its `cause`,
 *   and logs an error. The glob never falls back to the main thread.
 */
export const createGlobFilter = (limits: {
  maxRunningWorkers: number
  maxWaitingCalls: number
}): GlobFilter => {
  const workerSlots = createWorkerSlots(limits)

  const matchInSlot = async (params: {
    glob: string
    paths: readonly string[]
    deadlinePassed: DeadlinePassed
  }): Promise<GlobFilterOutcome> => {
    const { glob, paths, deadlinePassed } = params
    const slotRequest = workerSlots.request()

    if (!slotRequest.admitted) return { kind: "turned-away" }

    const firstEvent = await Promise.race([slotRequest.taken, deadlinePassed])

    try {
      if (firstEvent.kind === "timed-out") return firstEvent
      return await matchInWorker({ glob, paths, deadlinePassed })
    } finally {
      slotRequest.release()
    }
  }

  return async (params, logger) => {
    const { glob, paths, timeoutMs } = params
    const { promise: deadlinePassed, resolve: passDeadline } =
      Promise.withResolvers<Readonly<{ kind: "timed-out" }>>()
    const deadlineTimer = setTimeout(() => {
      passDeadline({ kind: "timed-out" })
    }, timeoutMs)

    const outcome = await matchInSlot({ glob, paths, deadlinePassed })
    clearTimeout(deadlineTimer)

    switch (outcome.kind) {
      case "matched":
        return outcome.matches
      // A timeout comes from this call's glob or from the calls queued ahead of
      // it, never from a fault in the worker, so logging it is left to the caller
      case "timed-out":
        throw new Error(`glob matching timed out after ${timeoutMs} ms`)
      // A full queue is no fault in the worker either. The error starts with "glob
      // matching timed out", so a caller matching the timeout's prefix catches it too
      case "turned-away":
        throw new Error("glob matching timed out: too many glob calls are waiting")
      case "failed":
        logger.error("glob matching failed", { error: describeError(outcome.cause) })
        throw new Error("glob matching failed", { cause: outcome.cause })
    }
  }
}
