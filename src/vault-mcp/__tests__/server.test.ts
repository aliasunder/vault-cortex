import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  onTestFinished,
} from "vitest"
import type { Request, Response, NextFunction } from "express"
import { createErrorMiddleware, createShutdownHandler } from "../server.js"
import { logger } from "../../logger.js"

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
  it("returns 500 with json error when headers have not been sent", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware()
    const { req, res, resStatus, resJson, next } = createMockReqRes()
    const err = new Error("boom")

    middleware(err, req, res, next)

    expect(resStatus).toHaveBeenCalledWith(500)
    expect(resJson).toHaveBeenCalledWith({ error: "internal server error" })
  })

  it("does not call res.status or res.json when headers have already been sent", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())
    const middleware = createErrorMiddleware()
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
    const middleware = createErrorMiddleware()
    const { req, res, next } = createMockReqRes({
      headers: { "mcp-session-id": "session-123" },
      ip: "192.0.2.5",
      method: "POST",
      path: "/mcp",
    })
    const err = new Error("kaboom")
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
    const middleware = createErrorMiddleware()
    const { req, res, next } = createMockReqRes({
      headers: {},
      ip: "192.0.2.6",
      method: "GET",
      path: "/healthz",
    })
    const err = new Error("nope")
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
    const middleware = createErrorMiddleware()
    const { req, res, next } = createMockReqRes({
      headers: { "mcp-session-id": "session-456" },
      ip: "10.0.0.2",
      method: "PUT",
      path: "/api",
    })
    const err = { name: "Error", message: "no stack" } as Error
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
    const middleware = createErrorMiddleware()
    const { req, res, resStatus, next } = createMockReqRes()

    middleware(new Error("x"), req, res, next)

    expect(resStatus).toHaveBeenCalledWith(500)
    expect(next).not.toHaveBeenCalled()
  })
})

describe("createShutdownHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(logger, "info").mockImplementation(() => {})
    vi.spyOn(logger, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("closes the server and exits 0 once draining completes", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    // close() that immediately invokes its callback = drain completes at once.
    const close = vi.fn((callback: () => void) => callback())

    createShutdownHandler({ close })()

    expect(close).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("forces exit 1 if the drain does not finish within the timeout", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never)
    onTestFinished(() => exitSpy.mockRestore())
    // close() that never invokes its callback = drain hangs.
    const close = vi.fn()

    createShutdownHandler({ close }, 10_000)()

    expect(exitSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
