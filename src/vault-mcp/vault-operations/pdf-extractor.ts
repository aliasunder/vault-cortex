import { execFile, spawn, type ChildProcess } from "node:child_process"
import { on as iterateEvents } from "node:events"
import { readFile } from "node:fs/promises"
import { env as inheritedEnvironment } from "node:process"
import { extname } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { Logger } from "../../logger.js"
import { describeErrorForLog } from "../../utils/describe-error.js"
import type { AssetTextResult } from "./asset-text.js"
import type { PdfTextResult } from "../obsidian-markdown/pdf.js"
import { pdfReplySchema, type PdfReply, type PdfRequest } from "./pdf-extraction-protocol.js"

/**
 * Runs every PDF text extraction in one child process that the server can limit, replace and
 * outlive, because pdfjs parses untrusted input and one crafted PDF can exhaust a process.
 *
 * A request's journey:
 * 1. `readText` (a tool read) or `extractForIndex` (the index) queues it.
 * 2. The queue serves one request at a time. A read goes ahead of every queued index request
 *    but never interrupts the request already in the child. Index requests wait until
 *    `startIndexing` is called, which the server does after it listens.
 * 3. When no child is alive, one is started. It sends `ready`; on Linux its memory limit is then
 *    applied with prlimit, and only after that does the child count as ready.
 * 4. The request is sent, and the child answers with a result or a failure reply.
 * 5. A child that exits, loses its IPC channel, breaks the protocol or misses the deadline is
 *    killed; the next request starts a fresh one.
 *
 * The module-level functions below start the child and ready it (step 3), serve one request
 * (step 4) and report the failures of step 5. The queue (steps 1 and 2) and the kill in step 5
 * live inside `createPdfExtractor`.
 */

// One page can keep expanding inside pdfjs, so the child gets a wall-clock bound beside its
// memory bounds. The deadline also covers the child's start.
const ACTIVE_TIMEOUT_MS = 20_000
// Reads go ahead of queued index requests, so this expires only a read stuck behind a stream of
// other reads.
const QUEUE_TIMEOUT_MS = 60_000
// A page that expands past the child's V8 heap aborts the child, never the server.
const CHILD_HEAP_LIMIT_MIB = 512
// On Linux the child also gets an RLIMIT_DATA memory limit, which counts its data segment and
// its mmap regions. The limit is this budget above the child's own footprint at startup, not a
// fixed total, because the footprint differs by architecture (V8 maps a 512 MiB code region on
// x64 that RLIMIT_DATA counts). A text-heavy 3,000-page PDF needs about 400 MiB of the budget.
const LINUX_DATA_BUDGET_MIB = 512
/** Matches a process's current data allocation (VmData) in its Linux proc status. */
const VM_DATA_PATTERN = /^VmData:\s+(?<vmDataKiB>\d+)\s+kB$/m
const execFileAsync = promisify(execFile)
// The child's extension follows this module's, so a run from source spawns the .ts child and a
// compiled build spawns the .js one.
const MODULE_EXTENSION = extname(fileURLToPath(import.meta.url))
const CHILD_ENTRY = fileURLToPath(
  new URL(`./pdf-extraction-child${MODULE_EXTENSION}`, import.meta.url),
)
// The child's paths and byte cap arrive over IPC, so it gets only what Node and tsx need to run;
// the server's tokens and vault settings never enter the process that parses untrusted PDFs.
const CHILD_ENVIRONMENT_NAMES = ["PATH", "HOME", "TMPDIR", "TZ", "LANG"] as const

const childEnvironment = (): Record<string, string> => {
  return Object.fromEntries(
    CHILD_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = inheritedEnvironment[name]
      // An empty value is a set variable, so only an unset one is left out.
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

export type PdfIndexExtraction =
  | { status: "extracted"; result: PdfTextResult }
  /** A newer request for the same path replaced this one, or the extractor closed. */
  | { status: "cancelled" }

export type PdfExtractor = {
  extractForIndex: (
    params: {
      path: string
      /** Replaces and cancels a queued same-path index request; an active one keeps running. */
      coalesce?: boolean
    },
    logger: Logger,
  ) => Promise<PdfIndexExtraction>
  readText: (
    params: { path: string; startLine?: number | undefined; limit?: number | undefined },
    logger: Logger,
  ) => Promise<AssetTextResult>
  /** Lets queued index requests reach the child. Reads are never held. */
  startIndexing: () => void
  close: () => Promise<void>
}

/** Why a request failed, which picks the caller's message:
 *  - `pdf-start`: the child never became ready, or the request never reached it;
 *  - `pdf-resource`: a ready child died or missed the deadline on this PDF, so the PDF itself
 *    is suspect;
 *  - `pdf-protocol`: a ready child answered outside the protocol, which says nothing about
 *    the PDF;
 *  - `pdf-queue`: a read waited QUEUE_TIMEOUT_MS behind other reads;
 *  - `pdf-closed`: the extractor closed; `pdf-superseded`: a newer request for the same path
 *    replaced this queued one. */
type FailureCode =
  "pdf-resource" | "pdf-start" | "pdf-protocol" | "pdf-queue" | "pdf-closed" | "pdf-superseded"

const extractionFailureMessage = (path: string, code: FailureCode): string => {
  switch (code) {
    case "pdf-start":
      return `PDF reader could not start: "${path}"; retry later`
    case "pdf-resource":
      return `PDF text extraction stopped: "${path}" could not be completed; split or re-export the PDF, or provide a text copy`
    case "pdf-protocol":
    case "pdf-queue":
    case "pdf-closed":
    case "pdf-superseded":
      return `PDF text extraction stopped: "${path}" could not be completed; retry later`
  }
}

const extractionError = (path: string, code: FailureCode): Error => {
  return Object.assign(new Error(extractionFailureMessage(path, code)), { pdfFailure: code })
}

const isCancelledExtraction = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    "pdfFailure" in error &&
    (error.pdfFailure === "pdf-superseded" || error.pdfFailure === "pdf-closed")
  )
}

type QueuedRequest = {
  request: PdfRequest
  logger: Logger
  reply: PromiseWithResolvers<PdfReply>
  /** For a read, the timer that rejects it when it is still queued after QUEUE_TIMEOUT_MS. */
  queueExpiry?: ReturnType<typeof setTimeout>
}

/** Why the child process stopped serving, named by the event that reported it. Any exit
 *  counts, because a serving child never exits on its own. */
type ChildFailure = { reason: "exit" | "process error" | "IPC disconnected"; error?: Error }

type ExtractionChild = {
  process: ChildProcess
  /** Every IPC message the child sends, buffered in order until a request reads it. Closing
   *  the iterator (in stopChild) also releases a read still waiting on it. */
  messages: AsyncIterator<unknown[]>
  /** True once the child sent `ready` and, on Linux, its data limit is applied. */
  ready: boolean
  hasExited: boolean
  /** The first failure the process reported, kept for a request that starts after it. */
  failure: ChildFailure | undefined
  /** Set while a request is served on this child, and called with each failure reported. */
  onFailure: ((failure: ChildFailure) => void) | undefined
  /** Settles once the process has exited; a spawn that never got a process ID settles on its error. */
  exited: Promise<void>
}

/** How one request ended, whichever of the child, the deadline or close() ended it. */
type RequestOutcome =
  | { kind: "reply"; reply: PdfReply }
  | { kind: "failed"; reason: string; failure: FailureCode; error?: unknown }
  | { kind: "deadline" }
  | { kind: "closed" }

/** A child whose process exited or whose IPC channel closed cannot take a request. */
const isAlive = (child: ExtractionChild | undefined): child is ExtractionChild => {
  if (!child) return false
  return !child.hasExited && child.process.connected
}

/** A child that never became ready failed to start; a ready one failed on this PDF. */
const failureCodeFor = (child: ExtractionChild): FailureCode => {
  return child.ready ? "pdf-resource" : "pdf-start"
}

/**
 * Spawns the child and wires up the events this module reads from it. Nothing is awaited here,
 * so the `ready` message the child sends on start lands in `messages` instead of being missed.
 */
const startChild = (): ExtractionChild => {
  // The child takes this process's Node flags, as Node's fork() does, so a run from source passes
  // on the TypeScript loader the .ts child needs. The heap flag comes last, so it wins over one
  // this process runs with.
  const nodeArgs = [
    ...process.execArgv,
    `--max-old-space-size=${CHILD_HEAP_LIMIT_MIB}`,
    CHILD_ENTRY,
  ]
  const childProcess = spawn(process.execPath, nodeArgs, {
    // The environment is the allowlist above, so NODE_OPTIONS is dropped.
    env: {
      ...childEnvironment(),
      // The child's logger writes nowhere; it reports failures over IPC and this process logs them.
      LOG_DIR: "none",
      // A run from source loads esbuild in the child, and esbuild's worker isolate would count
      // against the Linux data limit. Nothing loads esbuild in a compiled child.
      ESBUILD_WORKER_THREADS: "0",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  const exit = Promise.withResolvers<undefined>()
  const child: ExtractionChild = {
    process: childProcess,
    messages: iterateEvents(childProcess, "message"),
    ready: false,
    hasExited: false,
    failure: undefined,
    onFailure: undefined,
    exited: exit.promise,
  }
  const markExited = (): void => {
    child.hasExited = true
    exit.resolve(undefined)
  }
  const reportFailure = (failure: ChildFailure): void => {
    if (child.failure) return
    child.failure = failure
    child.onFailure?.(failure)
  }

  childProcess.once("exit", () => {
    markExited()
    reportFailure({ reason: "exit" })
  })
  childProcess.once("error", (error) => {
    // A failed spawn emits error with no exit, so the error marks the child exited; a child that
    // has a process ID gets its exit event later.
    if (!childProcess.pid) markExited()
    reportFailure({ reason: "process error", error })
  })
  childProcess.once("disconnect", () => reportFailure({ reason: "IPC disconnected" }))
  return child
}

/** The child's next IPC message, parsed; undefined when it does not fit the protocol. */
const nextReply = async (child: ExtractionChild): Promise<PdfReply | undefined> => {
  // A closed iterator yields no message, which fails the parse like a protocol break would. The
  // outcome is never read then, because the request that closed it has already settled.
  const [message]: unknown[] = (await child.messages.next()).value ?? []
  const parsed = pdfReplySchema.safeParse(message)

  return parsed.success ? parsed.data : undefined
}

/**
 * Sets the child's RLIMIT_DATA to its own startup footprint plus LINUX_DATA_BUDGET_MIB. The
 * footprint is read from proc status, and prlimit comes with util-linux. Without either, the
 * limit cannot be applied, and the request fails as a start failure rather than running
 * unbounded.
 */
const applyLinuxDataLimit = async (
  childProcess: ChildProcess,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> => {
  if (!childProcess.pid) throw new Error("PDF child has no process ID")
  const processStatus = await readFile(`/proc/${childProcess.pid}/status`, {
    encoding: "utf8",
    signal,
  })
  const startupDataKiB = Number(VM_DATA_PATTERN.exec(processStatus)?.groups?.vmDataKiB)
  const footprintAvailable = Number.isSafeInteger(startupDataKiB) && startupDataKiB > 0

  if (!footprintAvailable) throw new Error("PDF child data footprint is unavailable")

  const dataLimitKiB = startupDataKiB + LINUX_DATA_BUDGET_MIB * 1024
  const dataLimitBytes = dataLimitKiB * 1024
  await execFileAsync("prlimit", ["--pid", String(childProcess.pid), `--data=${dataLimitBytes}`], {
    signal,
  })
  logger.info("PDF child data limit applied", {
    childPid: childProcess.pid,
    startupDataKiB,
    dataLimitKiB,
  })
}

/** Waits for the child's `ready` message, then on Linux applies its memory limit. */
const waitUntilReady = async (
  child: ExtractionChild,
  signal: AbortSignal,
  logger: Logger,
): Promise<RequestOutcome | { kind: "ready" }> => {
  const reply = await nextReply(child)

  if (reply?.kind !== "ready") {
    return { kind: "failed", reason: "protocol", failure: "pdf-start" }
  }
  // The child asks the kernel to pick it, never the server, when host memory runs out.
  if (reply.oomPreference === "unavailable") {
    logger.warn("PDF child OOM preference unavailable", {
      childPid: child.process.pid,
      error: reply.oomPreferenceError,
    })
  }
  if (process.platform === "linux") {
    try {
      await applyLinuxDataLimit(child.process, signal, logger)
    } catch (error) {
      // A deadline or close() that killed the child meanwhile has already settled the request,
      // so this value is never read.
      if (signal.aborted) return { kind: "closed" }
      logger.error("PDF child data limit could not be applied", {
        childPid: child.process.pid,
        ...describeErrorForLog(error),
      })
      return { kind: "failed", reason: "data limit", failure: "pdf-start" }
    }
  }
  child.ready = true
  return { kind: "ready" }
}

/**
 * Sends the request over IPC. Settles only when the send fails: the PDF was not read, so the
 * caller's retry reaches a fresh child. A sent request is answered through `messages` instead.
 */
const sendRequest = (child: ExtractionChild, request: PdfRequest): Promise<RequestOutcome> => {
  return new Promise((resolve) => {
    child.process.send(request, (error) => {
      if (error) resolve({ kind: "failed", reason: "send", failure: "pdf-start", error })
    })
  })
}

/** Reads the child's reply to the request and checks that it answers that request. */
const awaitReply = async (child: ExtractionChild, request: PdfRequest): Promise<RequestOutcome> => {
  const reply = await nextReply(child)

  if (!reply) return { kind: "failed", reason: "protocol", failure: "pdf-protocol" }
  if (reply.kind === "ready") {
    return { kind: "failed", reason: "duplicate readiness", failure: "pdf-protocol" }
  }
  if (reply.requestId !== request.requestId) {
    return { kind: "failed", reason: "unexpected request ID", failure: "pdf-protocol" }
  }
  // A failure reply means the child caught the error itself and can take the next request.
  if (reply.kind === "failure") return { kind: "reply", reply }
  const expectedReplyKind = request.kind === "index" ? "index-result" : "read-result"

  if (reply.kind !== expectedReplyKind) {
    return { kind: "failed", reason: "unexpected result", failure: "pdf-protocol" }
  }
  return { kind: "reply", reply }
}

/**
 * Readies the child when it is new, then sends the request and reads the reply. The caller
 * aborts `signal` once the request has settled another way, which stops the memory limit step.
 */
const serveRequest = async (
  child: ExtractionChild,
  request: PdfRequest,
  signal: AbortSignal,
  logger: Logger,
): Promise<RequestOutcome> => {
  if (!child.ready) {
    const readiness = await waitUntilReady(child, signal, logger)

    if (readiness.kind !== "ready") return readiness
  }
  logger.debug("PDF extraction dispatched", {
    path: request.path,
    kind: request.kind,
    childPid: child.process.pid,
  })
  // sendRequest settles only on a send failure, so this is the reply unless the send failed.
  return Promise.race([sendRequest(child, request), awaitReply(child, request)])
}

/** The error the MCP tool handler would have seen had the extraction run in this process. */
const errorFromFailureReply = (reply: Extract<PdfReply, { kind: "failure" }>): Error => {
  // The error keeps its library name, and a Node error keeps its code and syscall, so the tool
  // handler describes it exactly as an in-process failure.
  const errorOptions = reply.cause ? { cause: reply.cause } : undefined

  return Object.assign(new Error(reply.message, errorOptions), {
    name: reply.name,
    ...reply.systemError,
  })
}

/** One process owns all PDF text work; a failed child is reaped before the queue resumes. */
export const createPdfExtractor = (params: {
  vaultPath: string
  maxFileBytes: number
}): PdfExtractor => {
  const { vaultPath, maxFileBytes } = params
  // The queue is edited in place: a request leaves it when served, expired, superseded or closed.
  const queue: QueuedRequest[] = []
  // The queue loop runs once at a time; index requests wait in the queue until startIndexing.
  let queueRunning = false
  let indexingStarted = false
  let closed = false
  let nextRequestId = 0
  // Settles the active request when close() is called, so it ends at once instead of at its
  // deadline. Set per request: a promise that outlived the requests it was raced against would
  // keep every request's outcome, PDF text included, in memory.
  let interruptActiveRequest: ((outcome: RequestOutcome) => void) | undefined
  // The child's lifecycle. One child serves every request until it fails; stopChild then kills it
  // and records its exit, which a request failure and close() both await before moving on.
  let currentChild: ExtractionChild | undefined
  let childStopped: Promise<void> = Promise.resolve()

  const enqueue = (
    { request, coalesce = false }: { request: PdfRequest; coalesce?: boolean | undefined },
    logger: Logger,
  ): Promise<PdfReply> => {
    if (closed) return Promise.reject(extractionError(request.path, "pdf-closed"))
    if (coalesce) supersedeQueuedIndexRequests(request.path)
    const queued: QueuedRequest = { request, logger, reply: Promise.withResolvers<PdfReply>() }

    if (request.kind === "read") {
      queued.queueExpiry = setTimeout(() => expireQueuedRead(queued), QUEUE_TIMEOUT_MS)
    }
    queue.push(queued)
    logger.debug("PDF extraction queued", {
      path: request.path,
      kind: request.kind,
      extractionRequestId: request.requestId,
    })
    void runQueue()
    return queued.reply.promise
  }

  /** Removes every queued index request for the path and settles each as superseded. */
  const supersedeQueuedIndexRequests = (path: string): void => {
    const superseded = queue.filter((queued) => {
      return queued.request.kind === "index" && queued.request.path === path
    })

    for (const supersededRequest of superseded) {
      queue.splice(queue.indexOf(supersededRequest), 1)
      supersededRequest.reply.reject(extractionError(path, "pdf-superseded"))
    }
  }

  const expireQueuedRead = (queued: QueuedRequest): void => {
    const position = queue.indexOf(queued)

    if (position < 0) return
    queue.splice(position, 1)
    queued.logger.warn("PDF extraction queue wait expired", {
      path: queued.request.path,
      extractionRequestId: queued.request.requestId,
    })
    queued.reply.reject(extractionError(queued.request.path, "pdf-queue"))
  }

  const runQueue = async (): Promise<void> => {
    if (queueRunning) return
    queueRunning = true
    try {
      while (!closed) {
        const queued = takeNextRequest()

        if (!queued) break
        clearTimeout(queued.queueExpiry)
        try {
          await serveQueuedRequest(queued)
        } catch (error) {
          // Everything else in serveQueuedRequest settles through an outcome, so a throw is
          // spawn's: it throws some failures (E2BIG, ENOMEM) instead of emitting them, before any
          // listener or timer exists, so the request has no other way to settle.
          queued.logger.error("PDF extraction child could not be spawned", {
            path: queued.request.path,
            ...describeErrorForLog(error),
          })
          queued.reply.reject(extractionError(queued.request.path, "pdf-start"))
        }
      }
    } finally {
      queueRunning = false
    }
  }

  /** A queued read, else the oldest queued index request once indexing has started. */
  const takeNextRequest = (): QueuedRequest | undefined => {
    const readPosition = queue.findIndex((queued) => queued.request.kind === "read")

    if (readPosition >= 0) return queue.splice(readPosition, 1)[0]
    if (!indexingStarted) return undefined
    return queue.shift()
  }

  /** Serves one request on the current child, or on a new one when none is alive. */
  const serveQueuedRequest = async (queued: QueuedRequest): Promise<void> => {
    const { request } = queued
    const logger = queued.logger.child({ extractionRequestId: request.requestId })
    const child = isAlive(currentChild) ? currentChild : replaceChild()
    // Settled by the deadline, a child failure or close(), whichever comes first.
    const interruption = Promise.withResolvers<RequestOutcome>()
    const deadlineTimer = setTimeout(() => {
      interruption.resolve({ kind: "deadline" })
    }, ACTIVE_TIMEOUT_MS)
    const requestAbort = new AbortController()
    const failRequest = ({ reason, error }: ChildFailure): void => {
      interruption.resolve({ kind: "failed", reason, failure: failureCodeFor(child), error })
    }

    if (child.failure) failRequest(child.failure)
    child.onFailure = failRequest
    interruptActiveRequest = interruption.resolve
    try {
      const outcome = await Promise.race([
        serveRequest(child, request, requestAbort.signal, logger),
        interruption.promise,
      ])
      // Aborted before settleRequest awaits the child's exit, so a memory limit step that fails
      // on the killed child returns without logging an error.
      requestAbort.abort()
      await settleRequest({ queued, child, outcome }, logger)
    } finally {
      clearTimeout(deadlineTimer)
      requestAbort.abort()
      child.onFailure = undefined
      interruptActiveRequest = undefined
    }
  }

  /** Answers the caller, then keeps a child that replied and reaps one that did not. */
  const settleRequest = async (
    params: { queued: QueuedRequest; child: ExtractionChild; outcome: RequestOutcome },
    logger: Logger,
  ): Promise<void> => {
    const { queued, child, outcome } = params
    const { request } = queued

    if (outcome.kind === "reply") {
      logger.debug("PDF extraction finished", { path: request.path, outcome: outcome.reply.kind })
      if (outcome.reply.kind === "failure") {
        queued.reply.reject(errorFromFailureReply(outcome.reply))
      } else {
        queued.reply.resolve(outcome.reply)
      }
      return
    }

    switch (outcome.kind) {
      case "closed":
        queued.reply.reject(extractionError(request.path, "pdf-closed"))
        break
      case "deadline":
        logger.warn("PDF extraction deadline exceeded", {
          path: request.path,
          timeoutMs: ACTIVE_TIMEOUT_MS,
        })
        queued.reply.reject(extractionError(request.path, failureCodeFor(child)))
        break
      case "failed":
        logger.warn("PDF extraction child failed", {
          path: request.path,
          reason: outcome.reason,
          exitCode: child.process.exitCode,
          signal: child.process.signalCode,
          ...(outcome.error ? describeErrorForLog(outcome.error) : {}),
        })
        queued.reply.reject(extractionError(request.path, outcome.failure))
        break
    }
    // The caller already has its error. The queue waits for the child to be gone, so the next
    // request's replacement never overlaps it. After close(), this awaits the stop close() began.
    await stopChild()
    logger.warn("PDF extraction reader discarded", {
      path: request.path,
      exitCode: child.process.exitCode,
      signal: child.process.signalCode,
    })
  }

  /** Starts a fresh child, after clearing a current one that is no longer alive. */
  const replaceChild = (): ExtractionChild => {
    // A current child here has exited or lost its IPC channel (a live one is reused). One that
    // only lost its channel is still exiting, and nothing waits for it: it can take no request.
    void stopChild()
    const child = startChild()
    currentChild = child
    return child
  }

  /** Kills the current child, if any, and resolves once it has exited. With no current child
   *  it resolves with the last stop, so a second caller waits for the same exit. */
  const stopChild = (): Promise<void> => {
    const child = currentChild
    currentChild = undefined

    if (!child) return childStopped
    // Ends the message iterator, which also releases a nextReply still waiting on it.
    void child.messages.return?.()
    if (!child.hasExited) child.process.kill("SIGKILL")
    childStopped = child.exited
    return childStopped
  }

  return {
    extractForIndex: async ({ path, coalesce }, logger) => {
      const request: PdfRequest = {
        kind: "index",
        vaultPath,
        maxFileBytes,
        path,
        requestId: nextRequestId++,
      }
      try {
        const reply = await enqueue({ request, coalesce }, logger)

        // awaitReply already matched the kind to the request; this narrows the type.
        if (reply.kind !== "index-result") throw new Error("unexpected PDF index result")
        return { status: "extracted", result: reply.result }
      } catch (error) {
        if (isCancelledExtraction(error)) return { status: "cancelled" }
        throw error
      }
    },
    readText: async ({ path, startLine, limit }, logger) => {
      const request: PdfRequest = {
        kind: "read",
        vaultPath,
        maxFileBytes,
        path,
        startLine,
        limit,
        requestId: nextRequestId++,
      }
      const reply = await enqueue({ request }, logger)

      if (reply.kind !== "read-result") throw new Error("unexpected PDF text result")
      // The parsed reply carries lineWindow as an explicit undefined, which the result type's
      // optional property does not admit under exactOptionalPropertyTypes.
      const { lineWindow, ...result } = reply.result
      return lineWindow ? { ...result, lineWindow } : result
    },
    startIndexing: () => {
      indexingStarted = true
      void runQueue()
    },
    close: async () => {
      closed = true
      for (const queued of queue.splice(0)) {
        clearTimeout(queued.queueExpiry)
        queued.reply.reject(extractionError(queued.request.path, "pdf-closed"))
      }
      interruptActiveRequest?.({ kind: "closed" })
      await stopChild()
    },
  }
}
