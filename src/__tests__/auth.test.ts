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
    headers: Record<string, string | string[]>,
    ip?: string,
  ): Parameters<typeof extractClientIp>[0] => ({ headers, ip })

  describe("when the Forwarded header is not trusted (default)", () => {
    // Without a trusted edge proxy, any client can choose the header's
    // value, so it must never become the rate-limit identity.
    it("ignores a client-supplied Forwarded header and returns req.ip", () => {
      const request = requestWith({ forwarded: "for=203.0.113.7" }, "10.0.0.1")
      expect(extractClientIp(request, false)).toBe("10.0.0.1")
    })

    it("falls back to 'unknown' when req.ip is also unavailable", () => {
      const request = requestWith({ forwarded: "for=203.0.113.7" })
      expect(extractClientIp(request, false)).toBe("unknown")
    })
  })

  describe("when the Forwarded header is trusted (edge proxy deployment)", () => {
    it("extracts the IP from a plain Forwarded for= element", () => {
      const request = requestWith({ forwarded: "for=203.0.113.7" }, "10.0.0.1")
      expect(extractClientIp(request, true)).toBe("203.0.113.7")
    })

    it("extracts the IP from a quoted Forwarded for= element", () => {
      const request = requestWith(
        { forwarded: 'for="203.0.113.7"' },
        "10.0.0.1",
      )
      expect(extractClientIp(request, true)).toBe("203.0.113.7")
    })

    it("stops at parameter separators in the for= value", () => {
      const request = requestWith(
        { forwarded: "for=203.0.113.7;proto=https" },
        "10.0.0.1",
      )
      expect(extractClientIp(request, true)).toBe("203.0.113.7")
    })

    // A client can prepend its own elements whenever the edge proxy appends
    // (as API Gateway does) rather than replaces, so the first for= is
    // client-chosen — the last for= is the proxy's own claim.
    it("takes the last for= element of a multi-element Forwarded header", () => {
      const request = requestWith(
        { forwarded: "for=203.0.113.7, for=70.41.3.18" },
        "10.0.0.1",
      )
      expect(extractClientIp(request, true)).toBe("70.41.3.18")
    })

    // Duplicate header lines can arrive as an array when middleware or a
    // custom HTTP stack re-parses them — the last-for= property must span
    // the joined lines, not just the first line's value.
    it("takes the last for= element across duplicate Forwarded header lines", () => {
      const request = requestWith(
        { forwarded: ["for=203.0.113.7", "for=70.41.3.18"] },
        "10.0.0.1",
      )
      expect(extractClientIp(request, true)).toBe("70.41.3.18")
    })

    it("skips trailing elements that carry no for= parameter", () => {
      const request = requestWith(
        { forwarded: "for=203.0.113.7, proto=https" },
        "10.0.0.1",
      )
      expect(extractClientIp(request, true)).toBe("203.0.113.7")
    })

    it("falls back to req.ip when no Forwarded header is present", () => {
      const request = requestWith({}, "10.0.0.1")
      expect(extractClientIp(request, true)).toBe("10.0.0.1")
    })

    it("falls back to req.ip when the Forwarded header carries no for=", () => {
      const request = requestWith({ forwarded: "proto=https" }, "10.0.0.1")
      expect(extractClientIp(request, true)).toBe("10.0.0.1")
    })

    it("returns 'unknown' when neither Forwarded nor req.ip is available", () => {
      const request = requestWith({})
      expect(extractClientIp(request, true)).toBe("unknown")
    })
  })
})
