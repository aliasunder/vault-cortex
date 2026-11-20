import { describe, it, expect } from "vitest"
import { assertPathWithinMaxLength, PathTooLongError } from "../assert-path-within-max-length.js"

// The longest path Linux accepts: PATH_MAX (4,096 bytes) less its terminating NUL
const LONGEST_ACCEPTED_BYTES = 4095

/** Catches the error a call throws, so a test can check its class and fields. */
const catchError = (call: () => void): unknown => {
  try {
    call()
  } catch (error) {
    return error
  }
  return undefined
}

describe("assertPathWithinMaxLength", () => {
  it("accepts an ASCII path of exactly 4,095 bytes", () => {
    const path = `${"a".repeat(LONGEST_ACCEPTED_BYTES - 3)}.md`

    expect(() => assertPathWithinMaxLength(path)).not.toThrow()
  })

  it("accepts a path of exactly 4,095 bytes made of three-byte characters", () => {
    // "語" is 3 bytes in UTF-8, so 1,365 of them are 4,095 bytes in 1,365 code units
    const path = "語".repeat(LONGEST_ACCEPTED_BYTES / 3)

    expect(() => assertPathWithinMaxLength(path)).not.toThrow()
  })

  it("refuses an ASCII path of 4,096 bytes, quoting it as given", () => {
    const path = `${"a".repeat(LONGEST_ACCEPTED_BYTES - 2)}.md`

    expect(() => assertPathWithinMaxLength(path)).toThrow(
      new Error(`ENAMETOOLONG: name too long, '${path}'`),
    )
  })

  it("measures bytes, not code units: refuses 1,366 three-byte characters", () => {
    const path = "語".repeat(LONGEST_ACCEPTED_BYTES / 3 + 1)

    expect(() => assertPathWithinMaxLength(path)).toThrow(
      new Error(`ENAMETOOLONG: name too long, '${path}'`),
    )
  })

  it("throws a PathTooLongError named Error with no code", () => {
    const error = catchError(() => assertPathWithinMaxLength("a".repeat(5000)))

    expect(error).toBeInstanceOf(PathTooLongError)
    expect(error instanceof Error ? error.name : undefined).toBe("Error")
    expect(error).not.toHaveProperty("code")
  })
})
