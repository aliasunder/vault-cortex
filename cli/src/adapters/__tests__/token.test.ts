import { describe, expect, it } from "vitest"

import { generateToken } from "../token.js"

describe("generateToken", () => {
  it("returns 64 lowercase hex characters (same shape as openssl rand -hex 32)", () => {
    const token = generateToken()

    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns a different token on every call", () => {
    const first = generateToken()
    const second = generateToken()

    expect(first).not.toBe(second)
  })
})
