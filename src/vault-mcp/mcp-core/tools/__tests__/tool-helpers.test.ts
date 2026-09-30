import { describe, it, expect, onTestFinished, vi } from "vitest"
import { logger } from "../../../../logger.js"
import { describeTextWindow, safeHandlerContent } from "../tool-helpers.js"

/** A handler failure whose cause carries detail the client must never see. */
const failWithCause = async (): Promise<string> => {
  throw new RangeError("limit out of range", {
    cause: new Error("EACCES: permission denied, open '/srv/vault/.obsidian/app.json'"),
  })
}

describe("safeHandlerContent", () => {
  it("returns a throw as an isError result holding only the error's name and message", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const result = await safeHandlerContent(logger, failWithCause, (text) => [
      { type: "text", text },
    ])

    expect(result).toEqual({
      content: [{ type: "text", text: "[RangeError]: limit out of range" }],
      isError: true,
    })
  })

  it("logs a throw as tool_error on the caller's logger", async () => {
    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn").mockImplementation(() => {})
    const rootWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => rootWarnSpy.mockRestore())

    await safeHandlerContent(requestLogger, failWithCause, (text) => [{ type: "text", text }])

    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("tool_error", {
      error: "[RangeError]: limit out of range",
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })
})

describe("describeTextWindow", () => {
  it("reports zero lines for an empty rendition", () => {
    expect(
      describeTextWindow("empty.md", {
        startLine: 1,
        endLine: 0,
        totalLines: 0,
      }),
    ).toBe("empty.md — 0 lines (end of file)")
  })

  it("reports end of file on the final window", () => {
    expect(
      describeTextWindow("note.md", {
        startLine: 3,
        endLine: 5,
        totalLines: 5,
      }),
    ).toBe("note.md — lines 3–5 of 5 (end of file)")
  })

  it("reports the next start_line on a mid-file window", () => {
    expect(
      describeTextWindow("note.md", {
        startLine: 1,
        endLine: 20,
        totalLines: 100,
      }),
    ).toBe("note.md — lines 1–20 of 100 (continue with start_line: 21)")
  })

  it("handles a single-line window", () => {
    expect(
      describeTextWindow("one.md", {
        startLine: 3,
        endLine: 3,
        totalLines: 10,
      }),
    ).toBe("one.md — lines 3–3 of 10 (continue with start_line: 4)")
  })

  it("handles endLine equal to totalLines as end of file", () => {
    expect(
      describeTextWindow("full.md", {
        startLine: 1,
        endLine: 1,
        totalLines: 1,
      }),
    ).toBe("full.md — lines 1–1 of 1 (end of file)")
  })
})
