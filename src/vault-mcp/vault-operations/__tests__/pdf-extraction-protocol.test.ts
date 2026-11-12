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
      name: "Error",
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
      name: "Error",
      message: "permission denied",
      systemError: { code: "EACCES", syscall: "open" },
    })
  })
  it("preserves the library's error name across serialization", () => {
    const reply = {
      kind: "failure",
      requestId: 7,
      name: "UnknownErrorException",
      message: "controlled parser failure",
    }
    const serialized: unknown = JSON.parse(JSON.stringify(reply))
    expect(pdfReplySchema.parse(serialized)).toEqual(reply)
  })
  it("carries the reason an OOM preference is unavailable", () => {
    const reply = {
      kind: "ready",
      oomPreference: "unavailable",
      oomPreferenceError: "[Error]: EACCES: permission denied, open '/proc/self/oom_score_adj'",
    }
    expect(pdfReplySchema.parse(reply)).toEqual(reply)
  })
  it("preserves the read window and file admission budget across serialization", () => {
    const request = { ...requestFields, kind: "read", startLine: 10, limit: 20 }
    const serialized: unknown = JSON.parse(JSON.stringify(request))

    expect(pdfRequestSchema.parse(serialized)).toEqual(request)
  })

  it.each([
    {
      label: "an unknown operation",
      request: { ...requestFields, kind: "raw" },
      rejectedPath: ["kind"],
    },
    {
      label: "a missing budget",
      request: { kind: "index", requestId: 0, vaultPath: "/vault", path: "paper.pdf" },
      rejectedPath: ["maxFileBytes"],
    },
    {
      label: "a negative budget",
      request: { ...requestFields, kind: "index", maxFileBytes: -1 },
      rejectedPath: ["maxFileBytes"],
    },
    {
      label: "a fractional request identity",
      request: { ...requestFields, kind: "index", requestId: 0.5 },
      rejectedPath: ["requestId"],
    },
    {
      label: "a nonnumeric window",
      request: { ...requestFields, kind: "read", startLine: "10" },
      rejectedPath: ["startLine"],
    },
  ])("rejects $label before the child can dispatch it", ({ request, rejectedPath }) => {
    const parsed = pdfRequestSchema.safeParse(request)

    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([rejectedPath])
  })

  it.each([
    {
      label: "an index payload marked as a read",
      reply: { kind: "read-result", requestId: 7, result: { text: "index", totalPages: 1 } },
      rejectedPaths: [
        ["result", "kind"],
        ["result", "path"],
      ],
    },
    {
      label: "a read payload marked as an index",
      reply: {
        kind: "index-result",
        requestId: 7,
        result: { kind: "text", path: "paper.pdf", text: "read" },
      },
      rejectedPaths: [["result", "totalPages"]],
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
      rejectedPaths: [["result", "lineWindow", "totalLines"]],
    },
    {
      label: "a fractional reply identity",
      reply: { kind: "index-result", requestId: 7.5, result: { text: "index", totalPages: 1 } },
      rejectedPaths: [["requestId"]],
    },
    {
      label: "a failure without the error's name",
      reply: { kind: "failure", requestId: 7, message: "failed" },
      rejectedPaths: [["name"]],
    },
    {
      label: "an exception object as a message",
      reply: {
        kind: "failure",
        requestId: 7,
        name: "Error",
        message: { message: "failed", stack: "/host/private/path" },
      },
      rejectedPaths: [["message"]],
    },
    {
      label: "an unknown OOM preference",
      reply: { kind: "ready", oomPreference: "assumed" },
      rejectedPaths: [["oomPreference"]],
    },
  ])("rejects $label instead of accepting another result shape", ({ reply, rejectedPaths }) => {
    const parsed = pdfReplySchema.safeParse(reply)

    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual(rejectedPaths)
  })

  it("keeps only controlled failure fields when the child adds internal details", () => {
    const reply = {
      kind: "failure",
      requestId: 7,
      name: "Error",
      message: 'file not found: "paper.pdf"',
      stack: "/private/server/path",
      command: "internal command",
    }

    expect(pdfReplySchema.parse(reply)).toEqual({
      kind: "failure",
      requestId: 7,
      name: "Error",
      message: 'file not found: "paper.pdf"',
    })
  })
})
