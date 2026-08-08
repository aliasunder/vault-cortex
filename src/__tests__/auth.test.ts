import { describe, it, expect } from "vitest"
import { extractClientIp, safeEqual, parseBearer } from "../auth.js"

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

describe("extractClientIp", () => {
  const requestWith = (
    headers: Record<string, string>,
    ip?: string,
  ): Parameters<typeof extractClientIp>[0] => ({ headers, ip })

  it("extracts the IP from a plain Forwarded for= element", () => {
    const request = requestWith({ forwarded: "for=203.0.113.7" }, "10.0.0.1")
    expect(extractClientIp(request)).toBe("203.0.113.7")
  })

  it("extracts the IP from a quoted Forwarded for= element", () => {
    const request = requestWith({ forwarded: 'for="203.0.113.7"' }, "10.0.0.1")
    expect(extractClientIp(request)).toBe("203.0.113.7")
  })

  it("stops at parameter and element separators in the Forwarded value", () => {
    const request = requestWith(
      { forwarded: "for=203.0.113.7;proto=https, for=70.41.3.18" },
      "10.0.0.1",
    )
    expect(extractClientIp(request)).toBe("203.0.113.7")
  })

  it("takes the first for= element of joined duplicate Forwarded headers", () => {
    const request = requestWith(
      { forwarded: "for=203.0.113.7, for=70.41.3.18" },
      "10.0.0.1",
    )
    expect(extractClientIp(request)).toBe("203.0.113.7")
  })

  it("falls back to req.ip when no Forwarded header is present", () => {
    const request = requestWith({}, "10.0.0.1")
    expect(extractClientIp(request)).toBe("10.0.0.1")
  })

  it("returns 'unknown' when neither Forwarded nor req.ip is available", () => {
    const request = requestWith({})
    expect(extractClientIp(request)).toBe("unknown")
  })
})
