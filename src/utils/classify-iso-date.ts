import { DateTime } from "luxon"

type IsoDateClass = "calendar-date" | "malformed" | "not-a-calendar-date"

/** Sorts text by whether it is a real YYYY-MM-DD day. The two failures:
 *  - "malformed": not in that form, such as "2026-7-3", "March 10" or a timestamp
 *  - "not-a-calendar-date": in that form, but the day doesn't exist, such as 2026-02-30
 *  They stay apart because a caller told only the format sends a missing day again. */
export const classifyIsoDate = (text: string): IsoDateClass => {
  const parsedDate = DateTime.fromFormat(text, "yyyy-MM-dd")

  if (parsedDate.isValid) return "calendar-date"

  // Luxon matches the form before it checks the calendar, and reports a month
  // or day out of range as "unit out of range"; any other reason is the form
  if (parsedDate.invalidReason === "unit out of range") return "not-a-calendar-date"

  return "malformed"
}
