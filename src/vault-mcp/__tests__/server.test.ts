import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Request, Response, NextFunction } from "express"
import { createErrorMiddleware } from "../server.js"
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
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it("returns 500 with json error when headers have not been sent", () => {
    const middleware = createErrorMiddleware()
    const { req, res, resStatus, resJson, next } = createMockReqRes()
    const err = new Error("boom")

    middleware(err, req, res, next)

    expect(resStatus).toHaveBeenCalledWith(500)
    expect(resJson).toHaveBeenCalledWith({ error: "internal server error" })
  })

  it("does not call res.status or res.json when headers have already been sent", () => {
    const middleware = createErrorMiddleware()
    const { req, res, resStatus, resJson, next } = createMockReqRes({}, true)
    const err = new Error("boom")

    middleware(err, req, res, next)

    expect(resStatus).not.toHaveBeenCalled()
    expect(resJson).not.toHaveBeenCalled()
  })

  it("logs unhandled_error with session, ip, method, path, and error message", () => {
    const middleware = createErrorMiddleware()
    const { req, res, next } = createMockReqRes({
      headers: { "mcp-session-id": "session-123" },
      ip: "192.0.2.5",
      method: "POST",
      path: "/mcp",
    })
    const err = new Error("kaboom")

    middleware(err, req, res, next)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith("unhandled_error", {
      sessionId: "session-123",
      clientIp: "192.0.2.5",
      method: "POST",
      path: "/mcp",
      error: "kaboom",
    })
  })

  it("logs sessionId as undefined when mcp-session-id header is absent", () => {
    const middleware = createErrorMiddleware()
    const { req, res, next } = createMockReqRes({
      headers: {},
      ip: "192.0.2.6",
      method: "GET",
      path: "/healthz",
    })
    const err = new Error("nope")

    middleware(err, req, res, next)

    expect(errorSpy).toHaveBeenCalledWith("unhandled_error", {
      sessionId: undefined,
      clientIp: "192.0.2.6",
      method: "GET",
      path: "/healthz",
      error: "nope",
    })
  })

  it("does not call next() (terminal error handler)", () => {
    const middleware = createErrorMiddleware()
    const { req, res, next } = createMockReqRes()

    middleware(new Error("x"), req, res, next)

    expect(next).not.toHaveBeenCalled()
  })
})
