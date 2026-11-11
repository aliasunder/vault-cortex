import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  buildMinimalPdf,
  buildPasswordProtectedPdf,
  buildPdf,
} from "../../obsidian-markdown/__tests__/pdf-fixture.js"
import type { PdfRequest } from "../pdf-extraction-protocol.js"

const CHILD_ENTRY = fileURLToPath(new URL("../pdf-extraction-child.ts", import.meta.url))
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx")
const PDF_TEXT = "Title: (untitled) | Pages: 1\n\nHello PDF"
type ChildRequest =
  | Omit<Extract<PdfRequest, { kind: "read" }>, "vaultPath">
  | Omit<Extract<PdfRequest, { kind: "index" }>, "vaultPath">

const nextReply = (child: ChildProcess): Promise<unknown> => {
  return new Promise((resolveReply, reject) => {
    const onMessage = (message: unknown): void => {
      child.off("exit", onExit)
      resolveReply(message)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.off("message", onMessage)
      reject(new Error(`PDF child exited before replying: code=${code}, signal=${signal}`))
    }
    child.once("message", onMessage)
    child.once("exit", onExit)
  })
}

const startPdfChild = async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), "probe-pdf-child-"))
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CHILD_ENTRY], {
    cwd: vaultPath,
    env: { ...process.env, LOG_DIR: "none", LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      child.kill("SIGKILL")
      await Promise.race([closed, delay(2_000)])
    }
    await rm(vaultPath, { recursive: true, force: true })
  })
  // Output can arrive in several chunks before or after the IPC reply.
  let stdout = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  const readiness = await nextReply(child)
  expect(readiness).toEqual({
    kind: "ready",
    oomPreference:
      process.platform === "linux"
        ? expect.stringMatching(/^(applied|unavailable)$/)
        : "unsupported",
  })
  const request = async (params: ChildRequest): Promise<unknown> => {
    const reply = nextReply(child)
    child.send({ ...params, vaultPath })
    return reply
  }
  return { child, vaultPath, request, stdout: () => stdout }
}

describe("PDF extraction child admission", () => {
  it("exits on malformed IPC instead of dispatching an extraction", async () => {
    const { child } = await startPdfChild()
    const reply = vi.fn()
    child.on("message", reply)
    const exited = once(child, "exit")
    child.send({ kind: "raw" })

    expect(await exited).toEqual([1, null])
    expect(reply).not.toHaveBeenCalled()
  }, 15_000)

  it("exits when its parent disconnects the IPC channel", async () => {
    const { child } = await startPdfChild()
    const exited = once(child, "exit")
    child.disconnect()

    expect(await exited).toEqual([0, null])
  }, 15_000)

  it.each([
    {
      label: "traversal",
      path: "../outside.pdf",
      message: 'path traversal blocked: "../outside.pdf" escapes vault root',
    },
    {
      label: "absolute",
      path: "/outside.pdf",
      message: 'absolute path blocked: "/outside.pdf" must be vault-relative',
    },
    {
      label: "hidden",
      path: ".private/paper.pdf",
      message: 'hidden path blocked: ".private/paper.pdf" targets a hidden file or folder',
    },
    { label: "missing", path: "missing.pdf", message: 'file not found: "missing.pdf"' },
  ])(
    "returns the $label path error without losing the next valid extraction",
    async ({ path, message }) => {
      const { vaultPath, request } = await startPdfChild()
      await writeFile(join(vaultPath, "good.pdf"), buildMinimalPdf())

      expect(await request({ kind: "index", requestId: 0, path, maxFileBytes: 1_000_000 })).toEqual(
        {
          kind: "failure",
          requestId: 0,
          name: "Error",
          message,
        },
      )
      expect(
        await request({ kind: "read", requestId: 1, path: "good.pdf", maxFileBytes: 1_000_000 }),
      ).toEqual({
        kind: "read-result",
        requestId: 1,
        result: { kind: "text", path: "good.pdf", text: PDF_TEXT },
      })
    },
    15_000,
  )

  it("admits exactly the file cap and rejects the same file one byte above it", async () => {
    const { vaultPath, request } = await startPdfChild()
    const pdf = buildMinimalPdf()
    await writeFile(join(vaultPath, "good.pdf"), pdf)

    expect(
      await request({ kind: "read", requestId: 0, path: "good.pdf", maxFileBytes: pdf.length }),
    ).toEqual({
      kind: "read-result",
      requestId: 0,
      result: { kind: "text", path: "good.pdf", text: PDF_TEXT },
    })
    expect(
      await request({ kind: "read", requestId: 1, path: "good.pdf", maxFileBytes: pdf.length - 1 }),
    ).toEqual({
      kind: "failure",
      requestId: 1,
      name: "Error",
      message: `file too large: "good.pdf" is ${pdf.length} bytes (cap ${pdf.length - 1} bytes — raise MAX_FILE_BYTES to read larger files)`,
    })
  }, 15_000)

  it("preserves the wrapped parser cause when a PDF cannot be opened", async () => {
    const { vaultPath, request } = await startPdfChild()
    const content = Buffer.from("plain text, not a PDF")
    await writeFile(join(vaultPath, "damaged.pdf"), content)

    expect(
      await request({ kind: "read", requestId: 0, path: "damaged.pdf", maxFileBytes: 1_000_000 }),
    ).toEqual({
      kind: "failure",
      requestId: 0,
      name: "Error",
      message: `PDF is damaged or not a PDF: "damaged.pdf" exists (${content.length} bytes) but cannot be parsed`,
      cause: "[InvalidPDFException]: Invalid PDF structure.",
    })
  }, 15_000)

  it("names the password refusal and keeps the parser's own exception as the cause", async () => {
    const { vaultPath, request } = await startPdfChild()
    const pdf = buildPasswordProtectedPdf()
    await writeFile(join(vaultPath, "locked.pdf"), pdf)

    expect(
      await request({ kind: "read", requestId: 0, path: "locked.pdf", maxFileBytes: 1_000_000 }),
    ).toEqual({
      kind: "failure",
      requestId: 0,
      name: "Error",
      message: `PDF is password-protected: "locked.pdf" exists (${pdf.length} bytes) but cannot be opened without its password`,
      cause: "[PasswordException]: No password given",
    })
  }, 15_000)

  it("cuts index text at the byte budget on a whole code point", async () => {
    const { vaultPath, request } = await startPdfChild()
    // The 30-byte header plus 99 lines of 1,024 bytes leaves 994 bytes of the budget for line
    // 100, whose three-byte bullet begins at byte 994 and so falls outside the cut.
    const fullLine = "x".repeat(1023)
    const straddlingLine = `${"x".repeat(993)}•${"x".repeat(30)}`
    const lines = [...Array.from({ length: 99 }, () => fullLine), straddlingLine, fullLine]
    await writeFile(
      join(vaultPath, "wide.pdf"),
      buildPdf(lines.map((text, index) => ({ text, x: 0, y: 780 - index * 2, fontSize: 0.5 }))),
    )

    expect(
      await request({ kind: "index", requestId: 0, path: "wide.pdf", maxFileBytes: 1_000_000 }),
    ).toEqual({
      kind: "index-result",
      requestId: 0,
      result: {
        text: `Title: (untitled) | Pages: 1\n\n${lines.slice(0, 99).join("\n")}\n${"x".repeat(993)}`,
        totalPages: 1,
      },
    })
  }, 15_000)

  it("emits a successful read log without creating a persistent log directory", async () => {
    const { vaultPath, request, stdout } = await startPdfChild()
    await writeFile(join(vaultPath, "good.pdf"), buildMinimalPdf())

    expect(
      await request({ kind: "read", requestId: 0, path: "good.pdf", maxFileBytes: 1_000_000 }),
    ).toEqual({
      kind: "read-result",
      requestId: 0,
      result: { kind: "text", path: "good.pdf", text: PDF_TEXT },
    })
    await vi.waitFor(() => expect(stdout()).toContain('"message":"read asset"'))
    expect((await readdir(vaultPath)).toSorted()).toEqual(["good.pdf"])
  }, 15_000)

  it("returns only the allowed line window after completely extracting an oversized rendition", async () => {
    const { vaultPath, request } = await startPdfChild()
    const lines = Array.from(
      { length: 128 },
      (_, index) => `Line${String(index).padStart(3, "0")}:${"x".repeat(1024)}`,
    )
    const pdf = buildPdf(
      lines.map((text, index) => ({ text, x: 0, y: 780 - index * 2, fontSize: 0.5 })),
    )
    await writeFile(join(vaultPath, "long.pdf"), pdf)
    const expectedFullText = `Title: (untitled) | Pages: 1\n\n${lines.join("\n")}`

    expect(
      await request({ kind: "read", requestId: 0, path: "long.pdf", maxFileBytes: 1_000_000 }),
    ).toEqual({
      kind: "failure",
      requestId: 0,
      name: "Error",
      message: `text output too large: "long.pdf" renders to ${Buffer.byteLength(expectedFullText)} bytes (cap 102400 bytes)`,
    })
    const selectedWindow = await request({
      kind: "read",
      requestId: 1,
      path: "long.pdf",
      maxFileBytes: 1_000_000,
      startLine: 3,
      limit: 2,
    })
    expect(selectedWindow).toEqual({
      kind: "read-result",
      requestId: 1,
      result: {
        kind: "text",
        path: "long.pdf",
        text: lines.slice(0, 2).join("\n"),
        lineWindow: { startLine: 3, endLine: 4, totalLines: 130 },
      },
    })
    expect(Buffer.byteLength(JSON.stringify(selectedWindow))).toBeLessThanOrEqual(102_400)
    expect(
      await request({
        kind: "read",
        requestId: 2,
        path: "long.pdf",
        maxFileBytes: 1_000_000,
        startLine: 131,
        limit: 1,
      }),
    ).toEqual({
      kind: "failure",
      requestId: 2,
      name: "Error",
      message: 'start line past the end: "long.pdf" renders to 130 lines',
    })
  }, 15_000)
})
