import { describe, expect, it } from "vitest"
import { pdfReplySchema, pdfRequestSchema } from "../pdf-extraction-protocol.js"

const requestFields = {
  requestId: 7,
  vaultPath: "/vault",
  path: "paper.pdf",
  maxFileBytes: 1_000_000,
}

describe("PDF extraction protocol", () => {
  it("keeps safe filesystem metadata while discarding unrelated system error fields", () => {
    const reply = {
      kind: "failure",
      requestId: 7,
      code: "read",
      message: "permission denied",
      systemError: {
        code: "EACCES",
        syscall: "open",
        path: "/private/host/path",
        stack: "internal stack",
      },
    }
    expect(pdfReplySchema.parse(reply)).toEqual({
      kind: "failure",
      requestId: 7,
      code: "read",
      message: "permission denied",
      systemError: { code: "EACCES", syscall: "open" },
    })
  })
  it("preserves a size refusal independently of its human-readable message", () => {
    const reply = {
      kind: "failure",
      requestId: 7,
      code: "size",
      message: "controlled byte refusal",
    }
    const serialized: unknown = JSON.parse(JSON.stringify(reply))
    expect(pdfReplySchema.parse(serialized)).toEqual(reply)
  })
  it("preserves the read window and file admission budget across serialization", () => {
    const request = { ...requestFields, kind: "read", startLine: 10, limit: 20 }
    const serialized: unknown = JSON.parse(JSON.stringify(request))

    expect(pdfRequestSchema.parse(serialized)).toEqual(request)
  })

  it.each([
    { label: "an unknown operation", request: { ...requestFields, kind: "raw" } },
    {
      label: "a missing budget",
      request: { kind: "index", requestId: 0, vaultPath: "/vault", path: "paper.pdf" },
    },
    { label: "a negative budget", request: { ...requestFields, kind: "index", maxFileBytes: -1 } },
    {
      label: "a fractional request identity",
      request: { ...requestFields, kind: "index", requestId: 0.5 },
    },
    { label: "a nonnumeric window", request: { ...requestFields, kind: "read", startLine: "10" } },
  ])("rejects $label before the child can dispatch it", ({ request }) => {
    expect(pdfRequestSchema.safeParse(request).success).toBe(false)
  })

  it.each([
    {
      label: "an index payload marked as a read",
      reply: { kind: "read-result", requestId: 7, result: { text: "index", totalPages: 1 } },
    },
    {
      label: "a read payload marked as an index",
      reply: {
        kind: "index-result",
        requestId: 7,
        result: { kind: "text", path: "paper.pdf", text: "read" },
      },
    },
    {
      label: "a malformed line window",
      reply: {
        kind: "read-result",
        requestId: 7,
        result: {
          kind: "text",
          path: "paper.pdf",
          text: "read",
          lineWindow: { startLine: 3, endLine: 4 },
        },
      },
    },
    {
      label: "an unsupported failure code",
      reply: { kind: "failure", requestId: 7, code: "shell-command", message: "failed" },
    },
    {
      label: "a parse failure code the child never emits",
      reply: { kind: "failure", requestId: 7, code: "parse", message: "failed" },
    },
    {
      label: "an exception object as a message",
      reply: {
        kind: "failure",
        requestId: 7,
        code: "read",
        message: { message: "failed", stack: "/host/private/path" },
      },
    },
    { label: "an unknown OOM preference", reply: { kind: "ready", oomPreference: "assumed" } },
  ])("rejects $label instead of accepting another result shape", ({ reply }) => {
    expect(pdfReplySchema.safeParse(reply).success).toBe(false)
  })

  it("keeps only controlled failure fields when the child adds internal details", () => {
    const reply = {
      kind: "failure",
      requestId: 7,
      code: "read",
      message: 'file not found: "paper.pdf"',
      stack: "/private/server/path",
      command: "internal command",
    }

    expect(pdfReplySchema.parse(reply)).toEqual({
      kind: "failure",
      requestId: 7,
      code: "read",
      message: 'file not found: "paper.pdf"',
    })
  })
})
