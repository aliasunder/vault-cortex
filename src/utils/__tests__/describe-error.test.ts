import { describe, it, expect } from "vitest"
import { describeError } from "../describe-error.js"

describe("describeError", () => {
  it("returns an Error's message", () => {
    expect(describeError(new Error("boom"))).toBe("boom")
  })

  it("returns the message of an Error subclass", () => {
    expect(describeError(new TypeError("bad type"))).toBe("bad type")
  })

  it("stringifies a non-Error string", () => {
    expect(describeError("plain string")).toBe("plain string")
  })

  it("stringifies a non-Error number", () => {
    expect(describeError(42)).toBe("42")
  })

  it("stringifies null and undefined", () => {
    expect(describeError(null)).toBe("null")
    expect(describeError(undefined)).toBe("undefined")
  })
})
