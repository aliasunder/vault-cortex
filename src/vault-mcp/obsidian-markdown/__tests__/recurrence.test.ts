import { describe, it, expect } from "vitest"
import { parseRecurrenceRule, nextOccurrenceDates } from "../recurrence.js"

/** Shorthand for the common case: no scheduled/start, no
 *  removeScheduledDateOnRecurrence, arithmetic in UTC so the vectors are
 *  machine-independent. */
const nextDatesForDue = ({
  recurrenceText,
  dueDate,
  today,
}: {
  recurrenceText: string
  dueDate: string | null
  today: string
}): ReturnType<typeof nextOccurrenceDates> => {
  return nextOccurrenceDates({
    recurrenceText,
    startDate: null,
    scheduledDate: null,
    dueDate,
    today,
    removeScheduledDateOnRecurrence: false,
    zone: "utc",
  })
}

describe("parseRecurrenceRule", () => {
  it("parses a plain rule without the when-done flag", () => {
    expect(parseRecurrenceRule("every week")?.baseOnToday).toBe(false)
  })

  it('parses the " when done" suffix case-insensitively', () => {
    expect(parseRecurrenceRule("every week WHEN DONE")?.baseOnToday).toBe(true)
  })

  it("returns null for text rrule cannot read", () => {
    expect(parseRecurrenceRule("whenever I feel like it")).toBeNull()
  })

  it("returns null for text outside the rule charset", () => {
    expect(parseRecurrenceRule("every week ⏰")).toBeNull()
  })
})

describe("nextOccurrenceDates", () => {
  it("advances a weekly rule one week from the due date", () => {
    const next = nextDatesForDue({
      recurrenceText: "every week",
      dueDate: "2026-01-05",
      today: "2026-01-05",
    })
    expect(next).toEqual({
      startDate: null,
      scheduledDate: null,
      dueDate: "2026-01-12",
    })
  })

  it("advances from the original due date even when long overdue", () => {
    // The plugin's non-when-done recurrence ignores the completion day.
    const next = nextDatesForDue({
      recurrenceText: "every week",
      dueDate: "2026-01-05",
      today: "2026-09-11",
    })
    expect(next?.dueDate).toBe("2026-01-12")
  })

  // Plugin test: "creates a recurring instance even if no date is given"
  it("spawns a dateless occurrence for a task with no dates", () => {
    const next = nextDatesForDue({
      recurrenceText: "every week",
      dueDate: null,
      today: "2026-01-05",
    })
    expect(next).toEqual({
      startDate: null,
      scheduledDate: null,
      dueDate: null,
    })
  })

  // Plugin test: "creates a recurrence the next month, even on the 31st"
  it("clamps a monthly rule from Jan 31 to Feb 28", () => {
    const next = nextDatesForDue({
      recurrenceText: "every month",
      dueDate: "2022-01-31",
      today: "2022-01-31",
    })
    expect(next?.dueDate).toBe("2022-02-28")
  })

  // Plugin test: "creates a recurrence 3 months in"
  it("clamps a 3-month rule from Jan 31 to Apr 30", () => {
    const next = nextDatesForDue({
      recurrenceText: "every 3 months",
      dueDate: "2022-01-31",
      today: "2022-01-31",
    })
    expect(next?.dueDate).toBe("2022-04-30")
  })

  // Plugin test: "creates a recurrence the next month, even across years"
  it("clamps a 2-month rule from Dec 31 to leap-year Feb 29", () => {
    const next = nextDatesForDue({
      recurrenceText: "every 2 months",
      dueDate: "2023-12-31",
      today: "2023-12-31",
    })
    expect(next?.dueDate).toBe("2024-02-29")
  })

  // Plugin test: "creates a recurrence in 2 years, even on Feb 29th" —
  // exercises the year walk-back, which has no " on " exemption.
  it("clamps a 2-year rule from Feb 29 to Feb 28", () => {
    const next = nextDatesForDue({
      recurrenceText: "every 2 years",
      dueDate: "2024-02-29",
      today: "2024-02-29",
    })
    expect(next?.dueDate).toBe("2026-02-28")
  })

  // Plugin test: "creates a recurrence in 11 months, even on March 31"
  it("clamps an 11-month rule from Mar 31 to Feb 28", () => {
    const next = nextDatesForDue({
      recurrenceText: "every 11 months",
      dueDate: "2020-03-31",
      today: "2020-03-31",
    })
    expect(next?.dueDate).toBe("2021-02-28")
  })

  // Plugin test: "creates a recurrence in 13 months, even on Jan 31"
  it("clamps a 13-month rule from Jan 31 to Feb 28 the next year", () => {
    const next = nextDatesForDue({
      recurrenceText: "every 13 months",
      dueDate: "2020-01-31",
      today: "2020-01-31",
    })
    expect(next?.dueDate).toBe("2021-02-28")
  })

  it('keeps rrule\'s native month-skipping for rules that fix a date with " on "', () => {
    // February has no 31st, so the rule skips it — no walk-back clamp.
    const next = nextDatesForDue({
      recurrenceText: "every month on the 31st",
      dueDate: "2026-01-31",
      today: "2026-01-31",
    })
    expect(next?.dueDate).toBe("2026-03-31")
  })

  it("skips missing days natively for a yearly rule fixing month and day", () => {
    // "every January on the 31st" is yearly-frequency, but its canonical
    // rrule text is not "every year", so the year walk-back does not apply
    // — rrule's own skipping stands, as in the plugin.
    const next = nextDatesForDue({
      recurrenceText: "every January on the 31st",
      dueDate: "2026-01-31",
      today: "2026-01-31",
    })
    expect(next?.dueDate).toBe("2027-01-31")
  })

  it("shifts every present date by its distance from the reference date", () => {
    const next = nextOccurrenceDates({
      recurrenceText: "every week",
      startDate: "2026-01-04",
      scheduledDate: "2026-01-08",
      dueDate: "2026-01-10",
      today: "2026-01-10",
      removeScheduledDateOnRecurrence: false,
      zone: "utc",
    })
    expect(next).toEqual({
      startDate: "2026-01-11",
      scheduledDate: "2026-01-15",
      dueDate: "2026-01-17",
    })
  })

  it('bases a "when done" rule on the completion day, not the due date', () => {
    const next = nextDatesForDue({
      recurrenceText: "every week when done",
      dueDate: "2026-01-05",
      today: "2026-09-11",
    })
    expect(next?.dueDate).toBe("2026-09-18")
  })

  it('advances "every day when done" completed today to tomorrow', () => {
    // The next hit is strictly after today's end of day.
    const next = nextDatesForDue({
      recurrenceText: "every day when done",
      dueDate: "2026-09-11",
      today: "2026-09-11",
    })
    expect(next?.dueDate).toBe("2026-09-12")
  })

  // Plugin test: "should remove the scheduledDate when removeScheduledDate
  // is true"
  it("drops the scheduled date under removeScheduledDateOnRecurrence", () => {
    const next = nextOccurrenceDates({
      recurrenceText: "every month",
      startDate: "2022-01-01",
      scheduledDate: "2022-01-04",
      dueDate: "2022-01-10",
      today: "2022-01-10",
      removeScheduledDateOnRecurrence: true,
      zone: "utc",
    })
    expect(next).toEqual({
      startDate: "2022-02-01",
      scheduledDate: null,
      dueDate: "2022-02-10",
    })
  })

  // Plugin test: "should not remove the scheduledDate when it is the only
  // date"
  it("keeps the scheduled date when it is the only date", () => {
    const next = nextOccurrenceDates({
      recurrenceText: "every month",
      startDate: null,
      scheduledDate: "2022-01-04",
      dueDate: null,
      today: "2022-01-04",
      removeScheduledDateOnRecurrence: true,
      zone: "utc",
    })
    expect(next).toEqual({
      startDate: null,
      scheduledDate: "2022-02-04",
      dueDate: null,
    })
  })

  // Plugin test: 'calculates correct start date with "dropScheduledDate"
  // and "when done", with no due date' — the reference priority flips to
  // due, start, scheduled, so the start date anchors the series.
  it("anchors on the start date under removeScheduledDateOnRecurrence with when done", () => {
    const next = nextOccurrenceDates({
      recurrenceText: "every 3 days when done",
      startDate: "2022-01-01",
      scheduledDate: "2022-01-04",
      dueDate: null,
      today: "2022-01-10",
      removeScheduledDateOnRecurrence: true,
      zone: "utc",
    })
    expect(next).toEqual({
      startDate: "2022-01-13",
      scheduledDate: null,
      dueDate: null,
    })
  })

  it("returns null for an unparseable rule", () => {
    const next = nextDatesForDue({
      recurrenceText: "whenever I feel like it",
      dueDate: "2026-01-05",
      today: "2026-01-05",
    })
    expect(next).toBeNull()
  })

  it("returns null for an exhausted finite rule", () => {
    // Count 1 means the reference day is the rule's only occurrence, so
    // there is nothing after it — the deliberate no-spawn divergence (the
    // plugin proceeds on an invalid date here).
    const next = nextDatesForDue({
      recurrenceText: "every day for 1 times",
      dueDate: "2026-01-05",
      today: "2026-01-05",
    })
    expect(next).toBeNull()
  })

  it("computes day distances on zone-local instants, like the plugin", () => {
    // Pacific/Apia skipped 2011-12-30 crossing the date line: between
    // Dec 29 and Dec 31 one local day elapsed, while the UTC labels are
    // two days apart. The plugin's moment arithmetic sees one day.
    const shiftedInApia = nextOccurrenceDates({
      recurrenceText: "every week",
      startDate: "2011-12-29",
      scheduledDate: null,
      dueDate: "2011-12-31",
      today: "2011-12-31",
      removeScheduledDateOnRecurrence: false,
      zone: "Pacific/Apia",
    })
    expect(shiftedInApia?.dueDate).toBe("2012-01-07")
    expect(shiftedInApia?.startDate).toBe("2012-01-06")

    // The same dates in UTC keep their two-day label distance.
    const shiftedInUtc = nextOccurrenceDates({
      recurrenceText: "every week",
      startDate: "2011-12-29",
      scheduledDate: null,
      dueDate: "2011-12-31",
      today: "2011-12-31",
      removeScheduledDateOnRecurrence: false,
      zone: "utc",
    })
    expect(shiftedInUtc?.startDate).toBe("2012-01-05")
  })
})
