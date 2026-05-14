import { describe, it, expect, vi } from "vitest"
import { safeEqual, parseBearer, createBearerMiddleware } from "../auth.js"
import type { Request, Response, NextFunction } from "express"

describe("safeEqual", () => {
  it("returns true for equal strings", () => {
    expect(safeEqual("secret-token", "secret-token")).toBe(true)
  })

  it("returns false for different strings of same length", () => {
    expect(safeEqual("secret-token", "wrong!-token")).toBe(false)
  })

  it("returns false for different length strings", () => {
    expect(safeEqual("short", "much-longer-string")).toBe(false)
  })

  it("handles empty strings", () => {
    expect(safeEqual("", "")).toBe(true)
    expect(safeEqual("", "notempty")).toBe(false)
  })
})

describe("parseBearer", () => {
  const scenarios = [
    {
      name: "valid Bearer token",
      input: "Bearer my-token",
      expected: "my-token",
    },
    {
      name: "case-insensitive bearer",
      input: "bearer my-token",
      expected: "my-token",
    },
    {
      name: "BEARER uppercase",
      input: "BEARER my-token",
      expected: "my-token",
    },
    { name: "undefined header", input: undefined, expected: null },
    { name: "empty string", input: "", expected: null },
    { name: "Basic auth prefix", input: "Basic dXNlcjpwYXNz", expected: null },
    { name: "no prefix", input: "my-token", expected: null },
    {
      name: "Bearer with extra whitespace",
      input: "  Bearer   my-token  ",
      expected: "my-token",
    },
  ] as const

  it.each(scenarios)("$name", ({ input, expected }) => {
    const result = parseBearer(input)
    expect(result).toBe(expected)
  })
})

describe("createBearerMiddleware", () => {
  const createMockReqResNext = (authHeader?: string) => {
    const req = {
      headers: authHeader !== undefined ? { authorization: authHeader } : {},
    } as unknown as Request

    const resJson = vi.fn()
    const resStatus = vi.fn().mockReturnValue({ json: resJson })
    const res = { status: resStatus, json: resJson } as unknown as Response

    const next = vi.fn() as unknown as NextFunction

    return { req, res, resStatus, resJson, next }
  }

  it("passes valid token to next()", () => {
    const middleware = createBearerMiddleware("valid-token")
    const { req, res, next } = createMockReqResNext("Bearer valid-token")
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it("rejects missing Authorization header with 401", () => {
    const middleware = createBearerMiddleware("valid-token")
    const { req, res, resStatus, next } = createMockReqResNext()
    middleware(req, res, next)
    expect(resStatus).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("rejects malformed Authorization header with 401", () => {
    const middleware = createBearerMiddleware("valid-token")
    const { req, res, resStatus, next } = createMockReqResNext("Basic abc123")
    middleware(req, res, next)
    expect(resStatus).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("rejects invalid token with 401", () => {
    const middleware = createBearerMiddleware("valid-token")
    const { req, res, resStatus, next } =
      createMockReqResNext("Bearer wrong-token")
    middleware(req, res, next)
    expect(resStatus).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("does not leak token value in error response", () => {
    const middleware = createBearerMiddleware("super-secret")
    const { req, res, resJson, next } = createMockReqResNext("Bearer wrong")
    middleware(req, res, next)
    const responseBody = resJson.mock.calls[0]?.[0] as { error: string }
    expect(JSON.stringify(responseBody)).not.toContain("super-secret")
    expect(JSON.stringify(responseBody)).not.toContain("wrong")
  })

  it("handles case-insensitive bearer prefix", () => {
    const middleware = createBearerMiddleware("my-token")
    const { req, res, next } = createMockReqResNext("bearer my-token")
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})
