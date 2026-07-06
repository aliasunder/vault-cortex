import { describe, it, expect } from "vitest"
import { isErrnoException } from "../is-errno-exception.js"

/** Creates a minimal ErrnoException-shaped error for testing. */
const makeErrno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`fake ${code}`), { code })

describe("isErrnoException", () => {
  describe("with code argument", () => {
    it("returns true when the error code matches", () => {
      expect(isErrnoException(makeErrno("ENOENT"), "ENOENT")).toBe(true)
    })

    it("returns false when the error code does not match", () => {
      expect(isErrnoException(makeErrno("EACCES"), "ENOENT")).toBe(false)
    })

    it("narrows error.code to the literal type", () => {
      const error: unknown = makeErrno("ENOENT")
      if (isErrnoException(error, "ENOENT")) {
        const code: "ENOENT" = error.code
        expect(code).toBe("ENOENT")
      } else {
        expect.unreachable("guard should have matched")
      }
    })
  })

  describe("without code argument", () => {
    it("returns true for any errno error", () => {
      expect(isErrnoException(makeErrno("EEXIST"))).toBe(true)
    })

    it("narrows error.code to string", () => {
      const error: unknown = makeErrno("EEXIST")
      if (isErrnoException(error)) {
        const code: string = error.code
        expect(code).toBe("EEXIST")
      } else {
        expect.unreachable("guard should have matched")
      }
    })
  })

  describe("rejects non-errno values", () => {
    it("returns false for a plain Error without a code property", () => {
      expect(isErrnoException(new Error("plain"))).toBe(false)
    })

    it("returns false for a string", () => {
      expect(isErrnoException("ENOENT")).toBe(false)
    })

    it("returns false for null", () => {
      expect(isErrnoException(null)).toBe(false)
    })

    it("returns false for undefined", () => {
      expect(isErrnoException(undefined)).toBe(false)
    })

    it("returns false for a plain object with a code property", () => {
      expect(isErrnoException({ code: "ENOENT" })).toBe(false)
    })
  })
})
