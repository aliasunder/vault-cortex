import { describe, it, expect } from "vitest"
import { assertPathHasNoNul } from "../assert-path-has-no-nul.js"

// toThrow compares an Error argument's class and own properties as well as its
// message, so these assertions also fail on a subclass or an added `code`
describe("assertPathHasNoNul", () => {
  it("accepts a path holding other control characters", () => {
    expect(() => assertPathHasNoNul("Notes/tab\there\u0001.md")).not.toThrow()
  })

  it("refuses a path holding a NUL character with a plain Error, quoting it as given", () => {
    expect(() => assertPathHasNoNul("Notes/Bad\u0000Name.md")).toThrow(
      new Error("EINVAL: a path cannot contain a NUL character, 'Notes/Bad\u0000Name.md'"),
    )
  })

  it("refuses a path whose only character is a NUL", () => {
    expect(() => assertPathHasNoNul("\u0000")).toThrow(
      new Error("EINVAL: a path cannot contain a NUL character, '\u0000'"),
    )
  })
})
