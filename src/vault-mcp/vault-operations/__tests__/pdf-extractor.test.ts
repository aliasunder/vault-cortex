import { ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { logger } from "../../../logger.js"
import { buildMinimalPdf } from "../../obsidian-markdown/__tests__/pdf-fixture.js"
import { createPdfExtractor } from "../pdf-extractor.js"
import { createSafeHandlers } from "../../mcp-core/tools/tool-helpers.js"

vi.mock("node:child_process", { spy: true })

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const createControlledChild = (pid = 1234) => {
  return Object.assign(new ChildProcess(), {
    pid,
    send: vi.fn(() => true),
    kill: vi.fn(() => true),
  })
}

const startControlledExtractor = () => {
  // Controlled children exercise lifecycle events without accessing a real Linux PID.
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")

  if (!descriptor) throw new Error("process.platform has no descriptor")
  Object.defineProperty(process, "platform", { value: "darwin" })
  onTestFinished(() => {
    Object.defineProperty(process, "platform", descriptor)
  })
  const child = createControlledChild()
  const children = [child]
  vi.mocked(spawn).mockReturnValue(child)
  const extractor = createPdfExtractor({ vaultPath: "/vault", maxFileBytes: 1_000_000 })
  onTestFinished(async () => {
    const closing = extractor.close()
    for (const controlledChild of children) controlledChild.emit("exit", null, "SIGKILL")
    await closing
  })
  return { extractor, child, children }
}

const ready = (child: ChildProcess): void => {
  child.emit("message", { kind: "ready", oomPreference: "unsupported" })
}

const captureChildLaunch = (child: ChildProcess) => {
  const launch = vi.fn()
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    // Capture only child-owned settings so a failed assertion never prints the ambient environment.
    launch({
      command,
      args,
      stdio: options?.stdio,
      logDir: options?.env?.LOG_DIR,
      nodeOptions: options?.env?.NODE_OPTIONS,
      esbuildWorkerThreads: options?.env?.ESBUILD_WORKER_THREADS,
    })
    return child
  })
  return launch
}

const finishIndex = (child: ChildProcess, requestId: number, text = "indexed"): void => {
  child.emit("message", { kind: "index-result", requestId, result: { text, totalPages: 1 } })
}

const finishRead = (child: ChildProcess, requestId: number, path: string): void => {
  child.emit("message", {
    kind: "read-result",
    requestId,
    result: { kind: "text", path, text: "read text" },
  })
}

const stoppedMessage = (path: string): string => {
  return `PDF text extraction stopped: "${path}" could not be completed; split or re-export the PDF, or provide a text copy`
}

const pdfFailureError = (message: string, code: string): Error => {
  return Object.assign(new Error(message), { pdfFailure: code })
}

const errorRecord = (error: unknown) => {
  if (!(error instanceof Error)) throw error
  return { ...error, name: error.name, message: error.message, cause: error.cause }
}

describe("PDF extraction child", () => {
  it.skipIf(process.platform !== "linux")(
    "sets both Linux data limits to startup data plus 512 MiB",
    async () => {
      const vaultPath = await mkdtemp(join(tmpdir(), "probe-pdf-data-limit-"))
      const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 1_000_000 })
      onTestFinished(async () => {
        await extractor.close()
        await rm(vaultPath, { recursive: true, force: true })
      })
      const appliedLimit = Promise.withResolvers<{
        childPid: number
        startupDataKiB: number
        dataLimitKiB: number
      }>()
      const info = vi.fn((message: string, data?: Record<string, unknown>) => {
        if (message !== "PDF child data limit applied") return
        const { childPid, startupDataKiB, dataLimitKiB } = data ?? {}

        if (
          typeof childPid !== "number" ||
          typeof startupDataKiB !== "number" ||
          typeof dataLimitKiB !== "number"
        ) {
          throw new Error("PDF data limit log is missing numeric fields")
        }
        appliedLimit.resolve({ childPid, startupDataKiB, dataLimitKiB })
      })
      const requestLogger = { ...logger, info }
      const callerLogger = { ...logger, child: () => requestLogger }
      await writeFile(join(vaultPath, "good.pdf"), buildMinimalPdf())

      expect(await extractor.readText({ path: "good.pdf" }, callerLogger)).toEqual({
        kind: "text",
        path: "good.pdf",
        text: "Title: (untitled) | Pages: 1\n\nHello PDF",
      })
      const { childPid, startupDataKiB, dataLimitKiB } = await appliedLimit.promise
      expect(startupDataKiB).toBeGreaterThan(0)
      expect(dataLimitKiB).toBe(startupDataKiB + 512 * 1024)
      expect(info).toHaveBeenCalledExactlyOnceWith("PDF child data limit applied", {
        childPid,
        startupDataKiB,
        dataLimitKiB,
      })
      const limits = await readFile(`/proc/${childPid}/limits`, "utf8")
      /** Matches the kernel's soft and hard data limits in bytes. */
      const dataLimitsPattern = /^Max data size\s+(?<soft>\d+)\s+(?<hard>\d+)\s+bytes[ \t]*$/m
      const dataLimits = dataLimitsPattern.exec(limits)?.groups
      expect(dataLimits).toEqual({
        soft: String(dataLimitKiB * 1024),
        hard: String(dataLimitKiB * 1024),
      })
      expect(spawn).toHaveBeenCalledTimes(1)
    },
    15_000,
  )

  it.skipIf(process.platform !== "linux")(
    "rejects startup and replaces the child when prlimit is unavailable",
    async () => {
      const vaultPath = await mkdtemp(join(tmpdir(), "probe-pdf-no-prlimit-"))
      const emptyPath = join(vaultPath, "empty-path")
      await mkdir(emptyPath)
      const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 1_000_000 })
      onTestFinished(async () => {
        vi.unstubAllEnvs()
        await extractor.close()
        await rm(vaultPath, { recursive: true, force: true })
      })
      await writeFile(join(vaultPath, "good.pdf"), buildMinimalPdf())
      const failedLimit = Promise.withResolvers<Record<string, unknown> | undefined>()
      const error = vi.fn((_message: string, data?: Record<string, unknown>) => {
        failedLimit.resolve(data)
      })
      const requestLogger = { ...logger, error }
      const callerLogger = { ...logger, child: () => requestLogger }
      vi.stubEnv("PATH", emptyPath)

      await expect(extractor.readText({ path: "good.pdf" }, callerLogger)).rejects.toThrow(
        pdfFailureError('PDF reader could not start: "good.pdf"; retry later', "pdf-start"),
      )
      const failure = await failedLimit.promise

      if (!(failure?.error instanceof Error)) throw new Error("PDF limit failure has no cause")
      expect(failure.error.message).toBe("spawn prlimit ENOENT")
      expect(error).toHaveBeenCalledExactlyOnceWith("PDF child data limit could not be applied", {
        childPid: expect.any(Number),
        error: failure.error,
      })
      vi.unstubAllEnvs()
      expect(await extractor.readText({ path: "good.pdf" }, callerLogger)).toEqual({
        kind: "text",
        path: "good.pdf",
        text: "Title: (untitled) | Pages: 1\n\nHello PDF",
      })
      expect(spawn).toHaveBeenCalledTimes(2)
    },
    15_000,
  )

  it("reuses a real child after a successful read and a damaged-file error", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "probe-pdf-extractor-"))
    const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 1_000_000 })
    onTestFinished(async () => {
      await extractor.close()
      await rm(vaultPath, { recursive: true, force: true })
    })
    await writeFile(join(vaultPath, "good.pdf"), buildMinimalPdf())
    await writeFile(join(vaultPath, "bad.pdf"), "not a PDF")
    const expected = {
      kind: "text",
      path: "good.pdf",
      text: "Title: (untitled) | Pages: 1\n\nHello PDF",
    }

    expect(await extractor.readText({ path: "good.pdf" }, logger)).toEqual(expected)
    const requestLogger = { ...logger, warn: vi.fn() }
    const { safeHandler } = createSafeHandlers({ vaultPath, isToolEnabled: () => false })
    expect(
      await safeHandler(
        requestLogger,
        () => extractor.readText({ path: "bad.pdf" }, logger),
        (result) => result.text,
      ),
    ).toEqual({
      content: [
        {
          type: "text",
          text: '[Error]: PDF is damaged or not a PDF: "bad.pdf" exists (9 bytes) but cannot be parsed',
        },
      ],
      isError: true,
    })
    expect(requestLogger.warn).toHaveBeenCalledExactlyOnceWith("tool_error", {
      error:
        '[Error]: PDF is damaged or not a PDF: "bad.pdf" exists (9 bytes) but cannot be parsed',
      cause: "[InvalidPDFException]: Invalid PDF structure.",
    })
    expect(await extractor.readText({ path: "good.pdf" }, logger)).toEqual(expected)
    expect(await extractor.extractForIndex({ path: "good.pdf" }, logger)).toEqual({
      text: "Title: (untitled) | Pages: 1\n\nHello PDF",
      totalPages: 1,
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  }, 15_000)

  it("preserves the real child's selected text window and total line count", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "probe-pdf-window-"))
    const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 1_000_000 })
    onTestFinished(async () => {
      await extractor.close()
      await rm(vaultPath, { recursive: true, force: true })
    })
    await writeFile(join(vaultPath, "good.pdf"), buildMinimalPdf())

    expect(await extractor.readText({ path: "good.pdf", startLine: 3, limit: 1 }, logger)).toEqual({
      kind: "text",
      path: "good.pdf",
      text: "Hello PDF",
      lineWindow: { startLine: 3, endLine: 3, totalLines: 3 },
    })
  }, 15_000)
})

describe("PDF extraction ownership", () => {
  it("preserves system error metadata for the caller's repair guidance", async () => {
    const { extractor, child } = startControlledExtractor()
    const request = extractor.readText({ path: "locked.pdf" }, logger)
    const rejected = expect(request.catch(errorRecord)).resolves.toEqual({
      name: "Error",
      message: "permission denied",
      code: "EACCES",
      syscall: "open",
      cause: undefined,
    })
    ready(child)
    child.emit("message", {
      kind: "failure",
      requestId: 0,
      code: "read",
      message: "permission denied",
      systemError: { code: "EACCES", syscall: "open" },
    })
    await rejected
    expect(child.kill).not.toHaveBeenCalled()
  })
  it("uses the controlled size code without interpreting the failure message", async () => {
    const { extractor, child } = startControlledExtractor()
    const request = extractor.extractForIndex({ path: "one.pdf" }, logger)
    const rejected = expect(request.catch(errorRecord)).resolves.toEqual({
      name: "Error",
      message: "controlled byte refusal",
      pdfFailure: "pdf-size",
      cause: undefined,
    })
    ready(child)
    child.emit("message", {
      kind: "failure",
      requestId: 0,
      code: "size",
      message: "controlled byte refusal",
    })
    await rejected
    expect(child.kill).not.toHaveBeenCalled()
    const recovery = extractor.extractForIndex({ path: "next.pdf" }, logger)
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    finishIndex(child, 1)
    expect(await recovery).toEqual({ text: "indexed", totalPages: 1 })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it("starts the source child directly on macOS with only its own heap and loader flags", async () => {
    vi.stubEnv("NODE_OPTIONS", "--inspect=127.0.0.1:0 --max-old-space-size=128")
    vi.stubEnv("ESBUILD_WORKER_THREADS", "1")
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")

    if (!descriptor) throw new Error("process.platform has no descriptor")
    Object.defineProperty(process, "platform", { value: "darwin" })
    onTestFinished(() => {
      Object.defineProperty(process, "platform", descriptor)
    })
    const { extractor, child } = startControlledExtractor()
    const launch = captureChildLaunch(child)
    const result = extractor.extractForIndex({ path: "one.pdf" }, logger)
    ready(child)
    finishIndex(child, 0)
    await result

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      command: process.execPath,
      args: [
        "--max-old-space-size=512",
        "--import",
        "tsx",
        fileURLToPath(new URL("../pdf-extraction-child.ts", import.meta.url)),
      ],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      logDir: "none",
      nodeOptions: undefined,
      esbuildWorkerThreads: "1",
    })
  })

  it("logs unavailable OOM preference once across reader reuse", async () => {
    const { extractor, child } = startControlledExtractor()
    const requestLogger = { ...logger, warn: vi.fn() }
    const callerLogger = { ...logger, child: vi.fn(() => requestLogger) }
    const first = extractor.readText({ path: "first.pdf" }, callerLogger)
    child.emit("message", { kind: "ready", oomPreference: "unavailable" })
    finishRead(child, 0, "first.pdf")
    expect(await first).toEqual({ kind: "text", path: "first.pdf", text: "read text" })
    const second = extractor.readText({ path: "second.pdf" }, callerLogger)
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    finishRead(child, 1, "second.pdf")
    expect(await second).toEqual({ kind: "text", path: "second.pdf", text: "read text" })
    expect(requestLogger.warn).toHaveBeenCalledExactlyOnceWith(
      "PDF child OOM preference unavailable",
      { childPid: 1234 },
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("reuses a reader with applied OOM preference without warning", async () => {
    const { extractor, child } = startControlledExtractor()
    const requestLogger = { ...logger, warn: vi.fn() }
    const callerLogger = { ...logger, child: vi.fn(() => requestLogger) }
    const first = extractor.readText({ path: "first.pdf" }, callerLogger)
    child.emit("message", { kind: "ready", oomPreference: "applied" })
    finishRead(child, 0, "first.pdf")
    expect(await first).toEqual({ kind: "text", path: "first.pdf", text: "read text" })
    const second = extractor.readText({ path: "second.pdf" }, callerLogger)
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    finishRead(child, 1, "second.pdf")
    expect(await second).toEqual({ kind: "text", path: "second.pdf", text: "read text" })
    expect(requestLogger.warn).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it.each([
    { signal: "SIGABRT" as const },
    { signal: "SIGTRAP" as const },
    { signal: "SIGKILL" as const },
  ])("records $signal without diagnosing its cause and replaces the child", async ({ signal }) => {
    const { extractor, child, children } = startControlledExtractor()
    const replacement = createControlledChild(1235)
    children.push(replacement)
    const requestLogger = { ...logger, warn: vi.fn() }
    const callerLogger = { ...logger, child: vi.fn(() => requestLogger) }
    const request = extractor.readText({ path: "failed.pdf" }, callerLogger)
    vi.mocked(spawn).mockReturnValueOnce(replacement)
    const rejected = expect(request).rejects.toThrow(
      pdfFailureError(stoppedMessage("failed.pdf"), "pdf-resource"),
    )
    ready(child)
    Object.assign(child, { signalCode: signal })
    child.emit("exit", null, signal)
    await rejected
    expect(requestLogger.warn).toHaveBeenCalledWith("PDF extraction child exited", {
      path: "failed.pdf",
      exitCode: null,
      signal,
    })
    const recovery = extractor.readText({ path: "recovered.pdf" }, callerLogger)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    ready(replacement)
    finishRead(replacement, 1, "recovered.pdf")
    expect(await recovery).toEqual({ kind: "text", path: "recovered.pdf", text: "read text" })
  })

  it("starts the Linux source child directly and suppresses child file logging", async () => {
    vi.stubEnv("ESBUILD_WORKER_THREADS", "1")
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")

    if (!descriptor) throw new Error("process.platform has no descriptor")
    const { extractor, child } = startControlledExtractor()
    Object.defineProperty(process, "platform", { value: "linux" })
    onTestFinished(() => {
      Object.defineProperty(process, "platform", descriptor)
    })
    const launch = captureChildLaunch(child)
    const result = extractor.extractForIndex({ path: "one.pdf" }, logger)
    const rejection = expect(result).rejects.toThrow(
      pdfFailureError(
        'PDF text extraction stopped: "one.pdf" could not be completed; retry later',
        "pdf-closed",
      ),
    )

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      command: process.execPath,
      args: [
        "--max-old-space-size=512",
        "--import",
        "tsx",
        fileURLToPath(new URL("../pdf-extraction-child.ts", import.meta.url)),
      ],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      logDir: "none",
      nodeOptions: undefined,
      esbuildWorkerThreads: "0",
    })
    expect(child.send).not.toHaveBeenCalled()
    const closing = extractor.close()
    child.emit("exit", null, "SIGKILL")
    await closing
    await rejection
  })

  it("runs a queued read before queued indexing after the current extraction", async () => {
    const { extractor, child } = startControlledExtractor()
    const active = extractor.extractForIndex({ path: "active.pdf" }, logger)
    const queued = extractor.extractForIndex({ path: "queued.pdf" }, logger)
    const read = extractor.readText({ path: "read.pdf", startLine: 2, limit: 3 }, logger)
    ready(child)
    expect(child.send).toHaveBeenCalledTimes(1)
    finishIndex(child, 0)
    await active
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    expect(child.send).toHaveBeenLastCalledWith(
      {
        kind: "read",
        path: "read.pdf",
        startLine: 2,
        limit: 3,
        vaultPath: "/vault",
        maxFileBytes: 1_000_000,
        requestId: 2,
      },
      expect.any(Function),
    )
    finishRead(child, 2, "read.pdf")
    expect(await read).toEqual({ kind: "text", path: "read.pdf", text: "read text" })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(3))
    finishIndex(child, 1, "queued")
    expect(await queued).toEqual({ text: "queued", totalPages: 1 })
  })

  it("coalesces only the queued index update for the same PDF", async () => {
    const { extractor, child } = startControlledExtractor()
    const active = extractor.extractForIndex({ path: "same.pdf" }, logger)
    const otherPath = extractor.extractForIndex({ path: "other.pdf" }, logger)
    const samePathRead = extractor.readText({ path: "same.pdf" }, logger)
    const oldUpdate = extractor.extractForIndex({ path: "same.pdf", coalesce: true }, logger)
    const oldRejection = expect(oldUpdate).rejects.toThrow(
      pdfFailureError(
        'PDF text extraction stopped: "same.pdf" could not be completed; retry later',
        "pdf-superseded",
      ),
    )
    const latestUpdate = extractor.extractForIndex({ path: "same.pdf", coalesce: true }, logger)
    // Observe rejected decoys immediately if a regression settles the wrong queued job.
    const queuedResults = Promise.allSettled([otherPath, samePathRead, latestUpdate])
    await oldRejection
    ready(child)
    finishIndex(child, 0, "active")
    expect(await active).toEqual({ text: "active", totalPages: 1 })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    expect(child.send).toHaveBeenLastCalledWith(
      {
        kind: "read",
        path: "same.pdf",
        startLine: undefined,
        limit: undefined,
        vaultPath: "/vault",
        maxFileBytes: 1_000_000,
        requestId: 2,
      },
      expect.any(Function),
    )
    finishRead(child, 2, "same.pdf")
    expect(await samePathRead).toEqual({ kind: "text", path: "same.pdf", text: "read text" })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(3))
    expect(child.send).toHaveBeenLastCalledWith(
      {
        kind: "index",
        path: "other.pdf",
        vaultPath: "/vault",
        maxFileBytes: 1_000_000,
        requestId: 1,
      },
      expect.any(Function),
    )
    finishIndex(child, 1, "other path")
    expect(await otherPath).toEqual({ text: "other path", totalPages: 1 })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(4))
    expect(child.send).toHaveBeenLastCalledWith(
      {
        kind: "index",
        path: "same.pdf",
        vaultPath: "/vault",
        maxFileBytes: 1_000_000,
        requestId: 4,
      },
      expect.any(Function),
    )
    finishIndex(child, 4, "latest")
    expect(await latestUpdate).toEqual({ text: "latest", totalPages: 1 })
    await queuedResults
  })

  it("reaps a reader after an IPC send failure before dispatching queued recovery", async () => {
    const { extractor, child, children } = startControlledExtractor()
    const send = vi.fn((_request: unknown, callback: (error: Error) => void) => {
      callback(new Error("controlled IPC send failure"))
      return false
    })
    Object.assign(child, { send })
    const replacement = createControlledChild(5678)
    children.push(replacement)
    const failed = extractor.readText({ path: "failed.pdf" }, logger)
    vi.mocked(spawn).mockReturnValueOnce(replacement)
    const rejection = expect(failed).rejects.toThrow(
      pdfFailureError(stoppedMessage("failed.pdf"), "pdf-resource"),
    )
    const recovery = extractor.readText({ path: "recovered.pdf" }, logger)
    ready(child)
    await rejection
    expect(send).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
    expect(spawn).toHaveBeenCalledTimes(1)
    child.emit("exit", null, "SIGKILL")
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    ready(replacement)
    finishRead(replacement, 1, "recovered.pdf")
    expect(await recovery).toEqual({ kind: "text", path: "recovered.pdf", text: "read text" })
  })

  it("recovers from a spawn error with no PID without waiting for an exit event", async () => {
    const { extractor, child, children } = startControlledExtractor()
    Object.assign(child, { pid: undefined })
    const failed = extractor.readText({ path: "failed.pdf" }, logger)
    const rejection = expect(failed).rejects.toThrow(
      pdfFailureError('PDF reader could not start: "failed.pdf"; retry later', "pdf-start"),
    )
    const replacement = createControlledChild(5678)
    children.push(replacement)
    vi.mocked(spawn).mockReturnValueOnce(replacement)
    const recovery = extractor.readText({ path: "recovered.pdf" }, logger)
    child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }))
    await rejection
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.send).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    ready(replacement)
    finishRead(replacement, 1, "recovered.pdf")
    expect(await recovery).toEqual({ kind: "text", path: "recovered.pdf", text: "read text" })
  })

  it("replaces a child that already exited without overlapping it", async () => {
    const { extractor, child, children } = startControlledExtractor()
    const failed = extractor.readText({ path: "broken.pdf" }, logger)
    const replacement = createControlledChild(5678)
    children.push(replacement)
    vi.mocked(spawn).mockReturnValueOnce(replacement)
    const rejection = expect(failed).rejects.toThrow(
      pdfFailureError(stoppedMessage("broken.pdf"), "pdf-resource"),
    )
    const recovery = extractor.readText({ path: "recovered.pdf" }, logger)
    ready(child)
    child.emit("exit", 1, null)
    await rejection
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    ready(replacement)
    finishRead(replacement, 1, "recovered.pdf")
    expect(await recovery).toEqual({ kind: "text", path: "recovered.pdf", text: "read text" })
  })

  it.each([
    { label: "disconnect", event: "disconnect", args: [] },
    { label: "process error", event: "error", args: [new Error("reader failed")] },
  ])("reaps an active child's $label before starting its replacement", async ({ event, args }) => {
    const { extractor, child, children } = startControlledExtractor()
    const failed = extractor.readText({ path: "broken.pdf" }, logger)
    const replacement = createControlledChild(5678)
    children.push(replacement)
    vi.mocked(spawn).mockReturnValueOnce(replacement)
    const rejection = expect(failed).rejects.toThrow(
      pdfFailureError(stoppedMessage("broken.pdf"), "pdf-resource"),
    )
    const recovery = extractor.readText({ path: "recovered.pdf" }, logger)
    ready(child)
    child.emit(event, ...args)
    await rejection
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    child.emit("exit", null, "SIGKILL")
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    ready(replacement)
    finishRead(replacement, 1, "recovered.pdf")
    expect(await recovery).toEqual({ kind: "text", path: "recovered.pdf", text: "read text" })
  })

  it("retains the reader-start diagnosis when the child fails before readiness", async () => {
    const { extractor, child } = startControlledExtractor()
    const request = extractor.readText({ path: "one.pdf" }, logger)
    const rejection = expect(request).rejects.toThrow(
      pdfFailureError('PDF reader could not start: "one.pdf"; retry later', "pdf-start"),
    )
    child.emit("exit", 1, null)
    await rejection
    expect(child.send).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "an invalid message",
      reply: { kind: "read-result", requestId: 0, result: "invalid" },
    },
    {
      label: "another request's result",
      reply: {
        kind: "read-result",
        requestId: 99,
        result: { kind: "text", path: "one.pdf", text: "wrong request" },
      },
    },
    {
      label: "an index result for a read",
      reply: {
        kind: "index-result",
        requestId: 0,
        result: { text: "wrong operation", totalPages: 1 },
      },
    },
    { label: "duplicate readiness", reply: { kind: "ready", oomPreference: "unsupported" } },
  ])("discards a reader that sends $label", async ({ reply }) => {
    const { extractor, child } = startControlledExtractor()
    const request = extractor.readText({ path: "one.pdf" }, logger)
    const rejection = expect(request).rejects.toThrow(
      pdfFailureError(stoppedMessage("one.pdf"), "pdf-resource"),
    )
    ready(child)
    child.emit("message", reply)
    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    child.emit("exit", null, "SIGKILL")
  })

  it("terminates an active extraction at the deadline and settles it once", async () => {
    vi.useFakeTimers()
    const { extractor, child } = startControlledExtractor()
    const request = extractor.readText({ path: "slow.pdf" }, logger)
    const rejection = expect(request).rejects.toThrow(
      pdfFailureError(stoppedMessage("slow.pdf"), "pdf-resource"),
    )
    ready(child)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    child.emit("message", {
      kind: "read-result",
      requestId: 0,
      result: { kind: "text", text: "late", path: "slow.pdf" },
    })
    child.emit("disconnect")
    child.emit("exit", null, "SIGKILL")
    expect(child.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("classifies a deadline before readiness as a reader-start failure", async () => {
    vi.useFakeTimers()
    const { extractor, child } = startControlledExtractor()
    const request = extractor.readText({ path: "slow-start.pdf" }, logger)
    const rejection = expect(request.catch(errorRecord)).resolves.toEqual({
      name: "Error",
      message: 'PDF reader could not start: "slow-start.pdf"; retry later',
      pdfFailure: "pdf-start",
      cause: undefined,
    })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(child.send).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
    child.emit("exit", null, "SIGKILL")
  })

  it("expires a read that waits sixty seconds behind earlier reads", async () => {
    vi.useFakeTimers()
    const { extractor, child } = startControlledExtractor()
    const active = extractor.extractForIndex({ path: "active.pdf" }, logger)
    const first = extractor.readText({ path: "first.pdf" }, logger)
    const second = extractor.readText({ path: "second.pdf" }, logger)
    const third = extractor.readText({ path: "third.pdf" }, logger)
    const expired = extractor.readText({ path: "expired.pdf" }, logger)
    const rejection = expect(expired).rejects.toThrow(
      pdfFailureError(
        'PDF text extraction stopped: "expired.pdf" could not be completed; retry later',
        "pdf-queue",
      ),
    )
    ready(child)
    await vi.advanceTimersByTimeAsync(19_000)
    finishIndex(child, 0)
    await active
    await vi.advanceTimersByTimeAsync(19_000)
    finishRead(child, 1, "first.pdf")
    await first
    await vi.advanceTimersByTimeAsync(19_000)
    finishRead(child, 2, "second.pdf")
    await second
    await vi.advanceTimersByTimeAsync(3_000)
    await rejection
    finishRead(child, 3, "third.pdf")
    await third
    await vi.advanceTimersByTimeAsync(0)
    expect(child.send).toHaveBeenCalledTimes(4)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it("rejects active, queued and future work during shutdown", async () => {
    const { extractor, child } = startControlledExtractor()
    const active = extractor.readText({ path: "active.pdf" }, logger)
    const queued = extractor.readText({ path: "queued.pdf" }, logger)
    const activeRejection = expect(active).rejects.toThrow(
      pdfFailureError(
        'PDF text extraction stopped: "active.pdf" could not be completed; retry later',
        "pdf-closed",
      ),
    )
    const queuedRejection = expect(queued).rejects.toThrow(
      pdfFailureError(
        'PDF text extraction stopped: "queued.pdf" could not be completed; retry later',
        "pdf-closed",
      ),
    )
    ready(child)
    const closing = extractor.close()
    const closed = vi.fn()
    // Observe settlement without awaiting it before the child's exit event.
    const observedClose = closing.then(closed)
    await activeRejection
    await queuedRejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
    child.emit("exit", null, "SIGKILL")
    await observedClose
    expect(closed).toHaveBeenCalledTimes(1)
    await expect(extractor.readText({ path: "later.pdf" }, logger)).rejects.toThrow(
      pdfFailureError(
        'PDF text extraction stopped: "later.pdf" could not be completed; retry later',
        "pdf-closed",
      ),
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
