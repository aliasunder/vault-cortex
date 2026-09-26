import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import type { Logger } from "../../../../logger.js"
import { describeTextWindow, safeHandlerStructured } from "../tool-helpers.js"

const createStubLogger = (): { logger: Logger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn()
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    child: () => logger,
  }
  return { logger, warn }
}

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

describe("safeHandlerStructured", () => {
  const resultSchema = z.object({
    path: z.string(),
    line: z.number(),
    heading: z.string().optional(),
  })

  it("returns the text block and structuredContent from one canonical object", async () => {
    const { logger } = createStubLogger()

    const result = await safeHandlerStructured(
      logger,
      async () => ({ path: "a.md", line: 3, heading: "Active" }),
      resultSchema,
    )

    expect(result).toStrictEqual({
      content: [{ type: "text", text: '{"path":"a.md","line":3,"heading":"Active"}' }],
      structuredContent: { path: "a.md", line: 3, heading: "Active" },
    })
  })

  it("drops optional keys the handler set to undefined from both fields", async () => {
    const { logger } = createStubLogger()

    const result = await safeHandlerStructured(
      logger,
      async () => ({ path: "a.md", line: 3, heading: undefined }),
      resultSchema,
    )

    expect(result).toStrictEqual({
      content: [{ type: "text", text: '{"path":"a.md","line":3}' }],
      structuredContent: { path: "a.md", line: 3 },
    })
  })

  it("strips keys the schema does not declare from both fields", async () => {
    const { logger } = createStubLogger()
    // The advertised JSON Schema forbids additional properties, so an
    // undeclared key must never reach the wire — clients would reject it.
    const driftedResult = { path: "a.md", line: 3, drifted_key: "surprise" }

    const result = await safeHandlerStructured(logger, async () => driftedResult, resultSchema)

    expect(result).toStrictEqual({
      content: [{ type: "text", text: '{"path":"a.md","line":3}' }],
      structuredContent: { path: "a.md", line: 3 },
    })
  })

  it("returns the shared error contract without structuredContent when the handler throws", async () => {
    const { logger, warn } = createStubLogger()

    const result = await safeHandlerStructured<{ path: string }>(
      logger,
      async () => {
        throw new Error("boom")
      },
      z.object({ path: z.string() }),
    )

    expect(result).toStrictEqual({
      content: [{ type: "text", text: "[Error]: boom" }],
      isError: true,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("tool_error", { error: "[Error]: boom" })
  })

  it("fails as a tool error when the result violates the schema", async () => {
    const { logger, warn } = createStubLogger()
    const missingRequiredLine = { path: "a.md" }

    // Zod's issue rendering changes across versions, so the expected message
    // is derived from the same ZodError the handler will hit, not hardcoded.
    const parseFailure = resultSchema.safeParse(missingRequiredLine)

    if (parseFailure.success) {
      throw new Error("fixture unexpectedly satisfies the schema")
    }

    const expectedMessage = `[${parseFailure.error.name}]: ${parseFailure.error.message}`

    const result = await safeHandlerStructured(
      logger,
      async () => missingRequiredLine,
      resultSchema,
    )

    expect(result).toStrictEqual({
      content: [{ type: "text", text: expectedMessage }],
      isError: true,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("tool_error", { error: expectedMessage })
  })
})
