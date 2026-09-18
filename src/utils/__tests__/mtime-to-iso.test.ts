import { describe, expect, it, onTestFinished } from "vitest"
import { Settings } from "luxon"
import { mtimeToIso } from "../mtime-to-iso.js"

describe("mtimeToIso", () => {
  const useUtc = (): void => {
    const previousZone = Settings.defaultZone
    Settings.defaultZone = "UTC"
    onTestFinished(() => {
      Settings.defaultZone = previousZone
    })
  }

  it("converts a valid epoch ms to an ISO string", () => {
    useUtc()
    expect(mtimeToIso(1700000000000)).toBe("2023-11-14T22:13:20.000Z")
  })

  it("rounds fractional milliseconds", () => {
    useUtc()
    expect(mtimeToIso(1700000000000.7)).toBe("2023-11-14T22:13:20.001Z")
  })

  it("throws on invalid mtime", () => {
    expect(() => mtimeToIso(NaN)).toThrow("invalid mtime: NaN")
  })
})
