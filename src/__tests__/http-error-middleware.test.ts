import { describe, it, expect, vi, onTestFinished } from "vitest"
import type { Request, Response, NextFunction } from "express"
import { createErrorMiddleware } from "../http-error-middleware.js"
import { logger } from "../logger.js"

const IGNORE_FORWARDED_HEADER = 0

type MockRes = {
  headersSent: boolean
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

const createMockReqRes = (
  reqOverrides: Partial<{
    headers: Record<string, string | undefined>
    ip: string
    method: string
    path: string
  }> = {},
  headersSent = false,
) => {
  const req = {
    headers: reqOverrides.headers ?? {},
    ip: reqOverrides.ip ?? "10.0.0.1",
    method: reqOverrides.method ?? "POST",
    path: reqOverrides.path ?? "/mcp",
  } as unknown as Request

  const resJson = vi.fn()
  const resStatus = vi.fn().mockReturnValue({ json: resJson })
  const res = {
    headersSent,
    status: resStatus,
    json: resJson,
  } as unknown as Response & MockRes

  const next = vi.fn() as unknown as NextFunction

  return { req, res, resStatus, resJson, next }
}

describe("createErrorMiddleware", () => {
  it("logs a client error without writing a second response when headers are already sent", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const middleware = createErrorMiddleware({ trustForwardedHops: 0 })
    const { req, res, resStatus, resJson, next } = createMockReqRes({}, true)
    const error = Object.assign(new Error("private body"), { status: 400, expose: true })

    middleware(error, req, res, next)

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith("request_body_rejected", {
      sessionId: undefined,
      clientIp: "10.0.0.1",
      method: "POST",
      path: "/mcp",
      type: "Error",
      status: 400,
    })
    expect(errorSpy).not.toHaveBeenCalled()
    expect(resStatus).not.toHaveBeenCalled()
    expect(resJson).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "malformed JSON",
      status: 400,
      type: "entity.parse.failed",
      message: "invalid request body",
    },
    {
      label: "other exposed 4xx",
      status: 422,
      type: "other.client.error",
      message: "invalid request body",
    },
    {
      label: "oversized body",
      status: 413,
      type: "entity.too.large",
      message: "request body too large",
    },
  ])("answers $label with its status and one short warning", ({ status, type, message }) => {
    const records: Record<string, unknown>[] = []
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)))
      return true
    })
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const middleware = createErrorMiddleware({ trustForwardedHops: 0 })
    const { req, res, resStatus, resJson, next } = createMockReqRes({
      path: "p".repeat(300),
      ip: "i".repeat(300),
      headers: { "mcp-session-id": "🎉".repeat(300) },
    })
    const error = Object.assign(new Error("private body contents"), { status, expose: true, type })

    middleware(error, req, res, next)

    expect(resStatus).toHaveBeenCalledTimes(1)
    expect(resStatus).toHaveBeenCalledWith(status)
    expect(resJson).toHaveBeenCalledTimes(1)
    expect(resJson).toHaveBeenCalledWith({ error: message })
    expect(records).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "request_body_rejected",
        source: expect.stringMatching(/^http-error-middleware\.ts:\d+$/),
        path: "p".repeat(255) + "…",
        clientIp: "i".repeat(255) + "…",
        sessionId: "🎉".repeat(255) + "…",
        method: "POST",
        type,
        status,
      },
    ])
    expect(errorSpy).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it("caps request fields on server errors while keeping the full stack", () => {
    const records: Record<string, unknown>[] = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)))
      return true
    })
    onTestFinished(() => stderrSpy.mockRestore())
    const middleware = createErrorMiddleware({ trustForwardedHops: 0 })
    const { req, res, next } = createMockReqRes({
      path: "p".repeat(300),
      ip: "i".repeat(300),
      headers: { "mcp-session-id": "s".repeat(300) },
    })
    const error = new Error("boom")
    Object.defineProperty(error, "stack", { value: "Error: boom\n    at test" })

    middleware(error, req, res, next)

    expect(records).toEqual([
      {
        timestamp: expect.any(String),
        level: "error",
        name: "vault-cortex",
        message: "unhandled_error",
        source: expect.stringMatching(/^http-error-middleware\.ts:\d+$/),
        method: "POST",
        path: "p".repeat(255) + "…",
        clientIp: "i".repeat(255) + "…",
        sessionId: "s".repeat(255) + "…",
        error: "[Error]: boom",
        stack: "Error: boom\n    at test",
      },
    ])
  })

  it("returns 500 with json error when headers have not been sent", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware({
      trustForwardedHops: IGNORE_FORWARDED_HEADER,
    })
    const { req, res, resStatus, resJson, next } = createMockReqRes()
    const err = new Error("boom")

    middleware(err, req, res, next)

    expect(resStatus).toHaveBeenCalledWith(500)
    expect(resJson).toHaveBeenCalledWith({ error: "internal server error" })
  })

  it("does not call res.status or res.json when headers have already been sent", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware({
      trustForwardedHops: IGNORE_FORWARDED_HEADER,
    })
    const { req, res, resStatus, resJson, next } = createMockReqRes({}, true)
    const err = new Error("boom")

    middleware(err, req, res, next)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(resStatus).not.toHaveBeenCalled()
    expect(resJson).not.toHaveBeenCalled()
  })

  it("logs unhandled_error with session, ip, method, path, error, and stack", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware({
      trustForwardedHops: IGNORE_FORWARDED_HEADER,
    })
    const { req, res, next } = createMockReqRes({
      headers: { "mcp-session-id": "session-123" },
      ip: "192.0.2.5",
      method: "POST",
      path: "/mcp",
    })
    const err = new Error("kaboom")
    // Replace V8's generated stack with a predictable value so the assertion
    // below is an exact match — otherwise `stack: err.stack` in the assertion
    // passes trivially even if the middleware never sets the field.
    Object.defineProperty(err, "stack", {
      value: "Error: kaboom\n    at test",
    })

    middleware(err, req, res, next)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith("unhandled_error", {
      sessionId: "session-123",
      clientIp: "192.0.2.5",
      method: "POST",
      path: "/mcp",
      error: "[Error]: kaboom",
      stack: "Error: kaboom\n    at test",
    })
  })

  it("logs sessionId as undefined, error, and stack when mcp-session-id header is absent", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware({
      trustForwardedHops: IGNORE_FORWARDED_HEADER,
    })
    const { req, res, next } = createMockReqRes({
      headers: {},
      ip: "192.0.2.6",
      method: "GET",
      path: "/healthz",
    })
    const err = new Error("nope")
    // Replace V8's generated stack with a predictable value so the assertion
    // below is an exact match — otherwise `stack: err.stack` in the assertion
    // passes trivially even if the middleware never sets the field.
    Object.defineProperty(err, "stack", {
      value: "Error: nope\n    at test",
    })

    middleware(err, req, res, next)

    expect(errorSpy).toHaveBeenCalledWith("unhandled_error", {
      sessionId: undefined,
      clientIp: "192.0.2.6",
      method: "GET",
      path: "/healthz",
      error: "[Error]: nope",
      stack: "Error: nope\n    at test",
    })
  })

  it("logs stack as undefined when the error has no stack property", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware({
      trustForwardedHops: IGNORE_FORWARDED_HEADER,
    })
    const { req, res, next } = createMockReqRes({
      headers: { "mcp-session-id": "session-456" },
      ip: "10.0.0.2",
      method: "PUT",
      path: "/api",
    })
    const err = new Error("no stack")
    delete (err as { stack?: string }).stack

    middleware(err, req, res, next)

    expect(errorSpy).toHaveBeenCalledWith("unhandled_error", {
      sessionId: "session-456",
      clientIp: "10.0.0.2",
      method: "PUT",
      path: "/api",
      error: "[Error]: no stack",
      stack: undefined,
    })
  })

  it("does not call next() (terminal error handler)", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware({
      trustForwardedHops: IGNORE_FORWARDED_HEADER,
    })
    const { req, res, resStatus, next } = createMockReqRes()

    middleware(new Error("x"), req, res, next)

    expect(resStatus).toHaveBeenCalledWith(500)
    expect(next).not.toHaveBeenCalled()
  })
})
