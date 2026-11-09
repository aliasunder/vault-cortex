import { execFile, spawn, type ChildProcess } from "node:child_process"
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

// A page can expand before pdfjs returns, so both allocation and wall time need bounds.
const ACTIVE_TIMEOUT_MS = 20_000
// Reads precede queued indexing, but expire during a sustained stream of reads.
const QUEUE_TIMEOUT_MS = 60_000
// Bound the child's heap and Linux data allocations so an expanding PDF can be discarded.
const CHILD_HEAP_LIMIT_MIB = 512
// This is room above startup; a text-heavy 3,000-page PDF needs about 400 MiB of it.
const LINUX_DATA_BUDGET_MIB = 512
/** Matches the child's current data allocation in Linux proc status. */
const VM_DATA_PATTERN = /^VmData:\s+(?<startupDataKiB>\d+)\s+kB$/m
const execFileAsync = promisify(execFile)
// The child's extension follows this module's, so tsx runs spawn .ts and compiled images spawn .js.
const CHILD_ENTRY = fileURLToPath(
  new URL(`./pdf-extraction-child${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
)

export type PdfExtractor = {
  extractForIndex: (
    params: {
      path: string
      /** Replaces and rejects a queued same-path index job; an active job keeps running. */
      coalesce?: boolean
    },
    logger: Logger,
  ) => Promise<PdfTextResult>
  readText: (
    params: { path: string; startLine?: number | undefined; limit?: number | undefined },
    logger: Logger,
  ) => Promise<AssetTextResult>
  close: () => Promise<void>
}

type FailureCode = "pdf-resource" | "pdf-start" | "pdf-queue" | "pdf-closed" | "pdf-superseded"

const extractionError = (path: string, code: FailureCode): Error => {
  if (code === "pdf-start")
    return Object.assign(new Error(`PDF reader could not start: "${path}"; retry later`), {
      pdfFailure: code,
    })
  const remedy =
    code === "pdf-resource" ? "split or re-export the PDF, or provide a text copy" : "retry later"
  return Object.assign(
    new Error(`PDF text extraction stopped: "${path}" could not be completed; ${remedy}`),
    { pdfFailure: code },
  )
}

type Job = {
  request: PdfRequest
  logger: Logger
  resolve: (reply: PdfReply) => void
  reject: (error: Error) => void
  queueTimer?: ReturnType<typeof setTimeout>
}
type Reader = { child: ChildProcess; ready: boolean; exited: Promise<void>; ended: boolean }

const applyLinuxDataLimit = async (child: ChildProcess, logger: Logger): Promise<void> => {
  if (!child.pid) throw new Error("PDF child has no process ID")
  const status = await readFile(`/proc/${child.pid}/status`, "utf8")
  const startupDataKiB = Number(VM_DATA_PATTERN.exec(status)?.groups?.startupDataKiB)

  if (!Number.isSafeInteger(startupDataKiB) || startupDataKiB <= 0) {
    throw new Error("PDF child data footprint is unavailable")
  }
  // V8's x64 code region counts toward this limit, so fixed totals leave unequal room by architecture.
  const dataLimitKiB = startupDataKiB + LINUX_DATA_BUDGET_MIB * 1024
  await execFileAsync("prlimit", ["--pid", String(child.pid), `--data=${dataLimitKiB * 1024}`])
  logger.info("PDF child data limit applied", {
    childPid: child.pid,
    startupDataKiB,
    dataLimitKiB,
  })
}

/** One process owns all PDF text work; failed readers are reaped before the queue resumes. */
export const createPdfExtractor = (params: {
  vaultPath: string
  maxFileBytes: number
}): PdfExtractor => {
  // Queue, reader and cancellation state span process events and successive requests.
  const queue: Job[] = []
  let reader: Reader | undefined
  let running = false
  let closed = false
  let nextRequestId = 0
  let cancelActive: (() => void) | undefined
  // Concurrent shutdown and request failure must await the same child death.
  let stopping: Promise<void> = Promise.resolve()

  const stopReader = async (): Promise<void> => {
    const discarded = reader
    reader = undefined
    if (!discarded) return stopping
    if (!discarded.ended) discarded.child.kill("SIGKILL")
    stopping = discarded.exited
    await stopping
  }

  const startReader = (): Reader => {
    const nodeArgs = [
      `--max-old-space-size=${CHILD_HEAP_LIMIT_MIB}`,
      ...(CHILD_ENTRY.endsWith(".ts") ? ["--import", "tsx"] : []),
      CHILD_ENTRY,
    ]
    const child = spawn(process.execPath, nodeArgs, {
      // The child owns its Node flags; launcher/debug settings must not reach it.
      env: {
        ...inheritedEnvironment,
        NODE_OPTIONS: undefined,
        LOG_DIR: "none",
        // Avoid tsx's extra esbuild V8 isolate inflating the Linux startup footprint.
        ...(process.platform === "linux" && CHILD_ENTRY.endsWith(".ts")
          ? { ESBUILD_WORKER_THREADS: "0" }
          : {}),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    const state: Reader = { child, ready: false, ended: false, exited: Promise.resolve() }
    state.exited = new Promise((resolveExit) => {
      child.once("exit", () => {
        state.ended = true
        resolveExit()
      })
      child.once("error", () => {
        if (!child.pid) {
          state.ended = true
          resolveExit()
        }
      })
    })
    reader = state
    return state
  }

  const dispatch = (job: Job): Promise<void> => {
    return new Promise((resolveDispatch) => {
      const requestLogger = job.logger.child({ extractionRequestId: job.request.requestId })
      const state = reader && !reader.ended ? reader : startReader()
      const { child } = state
      // Settlement may race a deadline, IPC disconnect and process exit.
      let settled = false
      // Readiness spans the asynchronous Linux limit application.
      let initializing = false

      const finish = ({
        outcome,
        readerDisposition,
      }: {
        outcome: PdfReply | Error
        readerDisposition: "reap" | "reuse"
      }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off("message", onMessage)
        child.off("exit", onExit)
        child.off("error", onError)
        child.off("disconnect", onDisconnect)
        cancelActive = undefined
        requestLogger.debug("PDF extraction finished", {
          path: job.request.path,
          outcome: outcome instanceof Error ? outcome.message : outcome.kind,
        })
        if (outcome instanceof Error) job.reject(outcome)
        else job.resolve(outcome)
        // The queue awaits termination even though the caller can receive its error immediately.
        const complete = async (): Promise<void> => {
          if (readerDisposition === "reap") {
            await stopReader()
            requestLogger.warn("PDF extraction reader discarded", {
              path: job.request.path,
              exitCode: child.exitCode,
              signal: child.signalCode,
            })
          }
          resolveDispatch()
        }
        void complete()
      }
      const fail = (
        reason: string,
        failure: Parameters<typeof extractionError>[1] = state.ready ? "pdf-resource" : "pdf-start",
      ): void => {
        requestLogger.warn("PDF extraction child failed", {
          path: job.request.path,
          reason,
          exitCode: child.exitCode,
          signal: child.signalCode,
        })
        finish({
          outcome: extractionError(job.request.path, failure),
          readerDisposition: "reap",
        })
      }
      const send = (): void => {
        requestLogger.debug("PDF extraction dispatched", {
          path: job.request.path,
          kind: job.request.kind,
          childPid: child.pid,
        })
        child.send(job.request, (error) => {
          // The request never reached the child, so the PDF was not read and a fresh child can retry it.
          if (error) fail("send", "pdf-start")
        })
      }
      const initialize = async (): Promise<void> => {
        if (process.platform === "linux") {
          try {
            await applyLinuxDataLimit(child, requestLogger)
          } catch (error) {
            requestLogger.error("PDF child data limit could not be applied", {
              childPid: child.pid,
              ...describeErrorForLog(error),
            })
            fail("data limit")
            return
          }
        }
        if (settled) return
        state.ready = true
        send()
      }
      const onMessage = (message: unknown): void => {
        const parsed = pdfReplySchema.safeParse(message)

        if (!parsed.success) {
          fail("protocol")
          return
        }
        const reply = parsed.data

        if (reply.kind === "ready") {
          if (state.ready || initializing) {
            fail("duplicate readiness")
            return
          }
          initializing = true
          if (reply.oomPreference === "unavailable")
            requestLogger.warn("PDF child OOM preference unavailable", { childPid: child.pid })
          void initialize()
          return
        }
        if (reply.requestId !== job.request.requestId) {
          fail("unexpected request ID")
          return
        }
        if (reply.kind === "failure") {
          const code = reply.code === "size" ? "pdf-size" : "pdf-read"
          const failureDetails = reply.systemError ?? { pdfFailure: code }
          // The child catches per-file errors after the request unwinds, leaving its loop reusable.
          finish({
            outcome: Object.assign(
              new Error(reply.message, reply.cause ? { cause: reply.cause } : undefined),
              failureDetails,
            ),
            readerDisposition: "reuse",
          })
          return
        }
        const expected = job.request.kind === "index" ? "index-result" : "read-result"

        if (reply.kind !== expected) {
          fail("unexpected result")
          return
        }
        finish({ outcome: reply, readerDisposition: "reuse" })
      }
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        requestLogger.warn("PDF extraction child exited", {
          path: job.request.path,
          exitCode,
          signal,
        })
        fail("exit")
      }
      const onError = (): void => fail("process error")
      const onDisconnect = (): void => {
        // Exit delivers code/signal diagnostics; killing also reaps a live disconnected reader.
        fail("IPC disconnected")
      }
      const timer = setTimeout(() => {
        requestLogger.warn("PDF extraction deadline exceeded", {
          path: job.request.path,
          timeoutMs: ACTIVE_TIMEOUT_MS,
        })
        finish({
          outcome: extractionError(job.request.path, state.ready ? "pdf-resource" : "pdf-start"),
          readerDisposition: "reap",
        })
      }, ACTIVE_TIMEOUT_MS)
      cancelActive = () => {
        finish({
          outcome: extractionError(job.request.path, "pdf-closed"),
          readerDisposition: "reap",
        })
      }
      child.on("message", onMessage)
      child.once("exit", onExit)
      child.once("error", onError)
      child.once("disconnect", onDisconnect)
      if (state.ready) send()
    })
  }

  const drain = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (!closed && queue.length) {
        const readIndex = queue.findIndex((job) => job.request.kind === "read")
        const [job] = queue.splice(readIndex < 0 ? 0 : readIndex, 1)

        if (!job) continue
        clearTimeout(job.queueTimer)
        await dispatch(job)
      }
    } finally {
      running = false
    }
  }

  const enqueue = (
    { request, coalesce = false }: { request: PdfRequest; coalesce?: boolean | undefined },
    logger: Logger,
  ): Promise<PdfReply> => {
    if (closed) return Promise.reject(extractionError(request.path, "pdf-closed"))
    return new Promise((resolveReply, reject) => {
      if (coalesce) {
        const previousIndex = queue.findIndex(
          (queued) => queued.request.kind === "index" && queued.request.path === request.path,
        )
        const previous = previousIndex < 0 ? undefined : queue.splice(previousIndex, 1)[0]
        previous?.reject(extractionError(request.path, "pdf-superseded"))
      }
      const job: Job = { request, logger, resolve: resolveReply, reject }

      if (request.kind === "read")
        job.queueTimer = setTimeout(() => {
          const position = queue.indexOf(job)

          if (position < 0) return
          queue.splice(position, 1)
          logger.warn("PDF extraction queue wait expired", {
            path: request.path,
            extractionRequestId: request.requestId,
          })
          reject(extractionError(request.path, "pdf-queue"))
        }, QUEUE_TIMEOUT_MS)
      queue.push(job)
      logger.debug("PDF extraction queued", {
        path: request.path,
        kind: request.kind,
        extractionRequestId: request.requestId,
      })
      void drain()
    })
  }

  return {
    extractForIndex: async ({ path, coalesce }, logger) => {
      const reply = await enqueue(
        { request: { ...params, kind: "index", path, requestId: nextRequestId++ }, coalesce },
        logger,
      )

      if (reply.kind !== "index-result") throw new Error("unexpected PDF index result")
      return reply.result
    },
    readText: async ({ path, startLine, limit }, logger) => {
      const reply = await enqueue(
        {
          request: { ...params, kind: "read", path, startLine, limit, requestId: nextRequestId++ },
        },
        logger,
      )

      if (reply.kind !== "read-result") throw new Error("unexpected PDF text result")
      const { lineWindow, ...result } = reply.result
      return lineWindow ? { ...result, lineWindow } : result
    },
    close: async () => {
      closed = true
      for (const job of queue.splice(0)) {
        clearTimeout(job.queueTimer)
        job.reject(extractionError(job.request.path, "pdf-closed"))
      }
      cancelActive?.()
      await stopReader()
    },
  }
}
