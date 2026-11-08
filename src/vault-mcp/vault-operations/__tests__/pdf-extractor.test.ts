import { ChildProcess, spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { logger } from "../../../logger.js"
import { buildMinimalPdf } from "../../obsidian-markdown/__tests__/pdf-fixture.js"
import { createPdfExtractor } from "../pdf-extractor.js"

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

const codedError = (message: string, code: string): Error => {
  return Object.assign(new Error(message), { code })
}

describe("PDF extraction child", () => {
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
    await expect(extractor.readText({ path: "bad.pdf" }, logger)).rejects.toThrow(
      codedError(
        'PDF is damaged or not a PDF: "bad.pdf" exists (9 bytes) but cannot be parsed',
        "pdf-read",
      ),
    )
    expect(await extractor.readText({ path: "good.pdf" }, logger)).toEqual(expected)
    expect(await extractor.extractForIndex({ path: "good.pdf" }, logger)).toEqual({
      text: "Title: (untitled) | Pages: 1\n\nHello PDF",
      totalPages: 1,
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  }, 15_000)
})

describe("PDF extraction ownership", () => {
  it("starts the source child directly on macOS with only its own heap and loader flags", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")

    if (!descriptor) throw new Error("process.platform has no descriptor")
    Object.defineProperty(process, "platform", { value: "darwin" })
    onTestFinished(() => {
      Object.defineProperty(process, "platform", descriptor)
    })
    const { extractor, child } = startControlledExtractor()
    const result = extractor.extractForIndex({ path: "one.pdf" }, logger)
    ready(child)
    finishIndex(child, 0)
    await result

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "--max-old-space-size=512",
        "--import",
        "tsx",
        fileURLToPath(new URL("../pdf-extraction-child.ts", import.meta.url)),
      ],
      { env: { ...process.env, LOG_DIR: "none" }, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    )
  })

  it.each([
    { preference: "unavailable", warnings: 1 },
    { preference: "applied", warnings: 0 },
  ])(
    "logs $preference OOM preference once across reader reuse",
    async ({ preference, warnings }) => {
      const { extractor, child } = startControlledExtractor()
      const requestLogger = { ...logger, warn: vi.fn() }
      const callerLogger = { ...logger, child: vi.fn(() => requestLogger) }
      const first = extractor.readText({ path: "first.pdf" }, callerLogger)
      child.emit("message", { kind: "ready", oomPreference: preference })
      finishRead(child, 0, "first.pdf")
      expect(await first).toEqual({ kind: "text", path: "first.pdf", text: "read text" })
      const second = extractor.readText({ path: "second.pdf" }, callerLogger)
      await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
      finishRead(child, 1, "second.pdf")
      expect(await second).toEqual({ kind: "text", path: "second.pdf", text: "read text" })
      expect(requestLogger.warn).toHaveBeenCalledTimes(warnings)
      if (warnings)
        expect(requestLogger.warn).toHaveBeenCalledWith("PDF child OOM preference unavailable", {
          childPid: 1234,
        })
      expect(spawn).toHaveBeenCalledTimes(1)
    },
  )

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
      codedError(stoppedMessage("failed.pdf"), "pdf-resource"),
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

  it("applies both Linux process limits and suppresses child file logging", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")

    if (!descriptor) throw new Error("process.platform has no descriptor")
    Object.defineProperty(process, "platform", { value: "linux" })
    onTestFinished(() => {
      Object.defineProperty(process, "platform", descriptor)
    })
    const { extractor, child } = startControlledExtractor()
    const result = extractor.extractForIndex({ path: "one.pdf" }, logger)
    ready(child)
    finishIndex(child, 0)
    await result

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      [
        "-c",
        'ulimit -d 786432 && exec "$@"',
        "pdf-extraction",
        process.execPath,
        "--max-old-space-size=512",
        "--import",
        "tsx",
        fileURLToPath(new URL("../pdf-extraction-child.ts", import.meta.url)),
      ],
      { env: { ...process.env, LOG_DIR: "none" }, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    )
    expect(child.send).toHaveBeenCalledTimes(1)
    expect(child.send).toHaveBeenCalledWith(
      {
        kind: "index",
        path: "one.pdf",
        vaultPath: "/vault",
        maxFileBytes: 1_000_000,
        requestId: 0,
      },
      expect.any(Function),
    )
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

  it("coalesces only the queued update for the same PDF", async () => {
    const { extractor, child } = startControlledExtractor()
    const active = extractor.extractForIndex({ path: "same.pdf" }, logger)
    const oldUpdate = extractor.extractForIndex({ path: "same.pdf", coalesce: true }, logger)
    const oldRejection = expect(oldUpdate).rejects.toThrow(
      codedError(
        'PDF text extraction stopped: "same.pdf" could not be completed; retry later',
        "pdf-superseded",
      ),
    )
    const latestUpdate = extractor.extractForIndex({ path: "same.pdf", coalesce: true }, logger)
    await oldRejection
    ready(child)
    finishIndex(child, 0, "active")
    expect(await active).toEqual({ text: "active", totalPages: 1 })
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2))
    expect(child.send).toHaveBeenLastCalledWith(
      {
        kind: "index",
        path: "same.pdf",
        vaultPath: "/vault",
        maxFileBytes: 1_000_000,
        requestId: 2,
      },
      expect.any(Function),
    )
    finishIndex(child, 2, "latest")
    expect(await latestUpdate).toEqual({ text: "latest", totalPages: 1 })
  })

  it.each([
    { label: "exit", event: "exit", args: [1, null] },
    { label: "disconnect", event: "disconnect", args: [] },
    { label: "process error", event: "error", args: [new Error("reader failed")] },
  ])("reaps an active child's $label before starting its replacement", async ({ event, args }) => {
    const { extractor, child, children } = startControlledExtractor()
    const failed = extractor.readText({ path: "broken.pdf" }, logger)
    const replacement = createControlledChild(5678)
    children.push(replacement)
    vi.mocked(spawn).mockReturnValueOnce(replacement)
    const rejection = expect(failed).rejects.toThrow(
      codedError(stoppedMessage("broken.pdf"), "pdf-resource"),
    )
    const recovery = extractor.readText({ path: "recovered.pdf" }, logger)
    ready(child)
    child.emit(event, ...args)
    await rejection
    if (event !== "exit") {
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      child.emit("exit", null, "SIGKILL")
    }
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    ready(replacement)
    finishRead(replacement, 1, "recovered.pdf")
    expect(await recovery).toEqual({ kind: "text", path: "recovered.pdf", text: "read text" })
  })

  it("retains the reader-start diagnosis when the child fails before readiness", async () => {
    const { extractor, child } = startControlledExtractor()
    const request = extractor.readText({ path: "one.pdf" }, logger)
    const rejection = expect(request).rejects.toThrow(
      codedError('PDF reader could not start: "one.pdf"; retry later', "pdf-start"),
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
      codedError(stoppedMessage("one.pdf"), "pdf-resource"),
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
      codedError(stoppedMessage("slow.pdf"), "pdf-resource"),
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

  it("expires a read that waits sixty seconds behind earlier reads", async () => {
    vi.useFakeTimers()
    const { extractor, child } = startControlledExtractor()
    const active = extractor.extractForIndex({ path: "active.pdf" }, logger)
    const first = extractor.readText({ path: "first.pdf" }, logger)
    const second = extractor.readText({ path: "second.pdf" }, logger)
    const third = extractor.readText({ path: "third.pdf" }, logger)
    const expired = extractor.readText({ path: "expired.pdf" }, logger)
    const rejection = expect(expired).rejects.toThrow(
      codedError(
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
      codedError(
        'PDF text extraction stopped: "active.pdf" could not be completed; retry later',
        "pdf-closed",
      ),
    )
    const queuedRejection = expect(queued).rejects.toThrow(
      codedError(
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
      codedError(
        'PDF text extraction stopped: "later.pdf" could not be completed; retry later',
        "pdf-closed",
      ),
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
