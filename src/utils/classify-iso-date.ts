import { DateTime } from "luxon"

type IsoDateClass = "calendar-date" | "malformed" | "not-a-calendar-date"

/** Classifies text by whether it names a real day in YYYY-MM-DD form. The two failures:
 *  - "malformed": not in that form, such as "2026-7-3", "March 10" or a timestamp
 *  - "not-a-calendar-date": in that form, but the month or day doesn't exist,
 *    such as 2026-02-30 or 2026-13-01
 *  They stay apart so an error message can name the failure: a client told only
 *  "use YYYY-MM-DD" sends 2026-02-30 again, since it already used that form. */
export const classifyIsoDate = (text: string): IsoDateClass => {
  const parsedDate = DateTime.fromFormat(text, "yyyy-MM-dd")

  if (parsedDate.isValid) return "calendar-date"

  // Luxon checks the form first ("unparsable" when it doesn't match), then the
  // calendar ("unit out of range" for a month or day that doesn't exist)
  if (parsedDate.invalidReason === "unit out of range") return "not-a-calendar-date"

  return "malformed"
}
