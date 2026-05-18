import { describe, it, expect } from "vitest"
import { safeEqual, parseBearer } from "../auth.js"

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
