import { describe, expect, it } from "vitest"
import { classifyIsoDate } from "../classify-iso-date.js"

describe("classifyIsoDate", () => {
  it.each([
    { label: "an ordinary day", text: "2026-07-03" },
    { label: "February 29 in a leap year", text: "2024-02-29" },
  ])("classifies $label as a calendar date", ({ text }) => {
    expect(classifyIsoDate(text)).toBe("calendar-date")
  })

  it.each([
    { label: "February 30", text: "2026-02-30" },
    { label: "February 29 outside a leap year", text: "2025-02-29" },
    { label: "month 13", text: "2026-13-01" },
    { label: "month 00", text: "2026-00-10" },
    { label: "day 00", text: "2026-02-00" },
  ])("classifies $label as not a calendar date", ({ text }) => {
    expect(classifyIsoDate(text)).toBe("not-a-calendar-date")
  })

  it.each([
    { label: "a single-digit month and day", text: "2026-7-3" },
    { label: "a timestamp", text: "2026-07-03T10:30:00" },
    { label: "a five-digit year", text: "20260-01-01" },
    { label: "slashes", text: "2026/07/03" },
    { label: "a month name", text: "March 10" },
    { label: "surrounding whitespace", text: " 2026-07-03" },
    { label: "an empty string", text: "" },
  ])("classifies $label as malformed", ({ text }) => {
    expect(classifyIsoDate(text)).toBe("malformed")
  })
})
