import { describe, it, expect } from "vitest"
import { assertPathHasNoNul, PathHasNulError } from "../assert-path-has-no-nul.js"

/** Catches the error a call throws, so a test can check its class and fields. */
const catchError = (call: () => void): unknown => {
  try {
    call()
  } catch (error) {
    return error
  }
  return undefined
}

describe("assertPathHasNoNul", () => {
  it("accepts a path holding other control characters", () => {
    expect(() => assertPathHasNoNul("Notes/tab\there\u0001.md")).not.toThrow()
  })

  it("refuses a path holding a NUL character, quoting it as given", () => {
    expect(() => assertPathHasNoNul("Notes/Bad\u0000Name.md")).toThrow(
      new Error("EINVAL: a path cannot contain a NUL character, 'Notes/Bad\u0000Name.md'"),
    )
  })

  it("refuses a path whose only character is a NUL", () => {
    expect(() => assertPathHasNoNul("\u0000")).toThrow(
      new Error("EINVAL: a path cannot contain a NUL character, '\u0000'"),
    )
  })

  it("throws a PathHasNulError named Error with no code", () => {
    const error = catchError(() => assertPathHasNoNul("a\u0000.md"))

    expect(error).toBeInstanceOf(PathHasNulError)
    expect(error instanceof Error ? error.name : undefined).toBe("Error")
    expect(error).not.toHaveProperty("code")
  })
})
