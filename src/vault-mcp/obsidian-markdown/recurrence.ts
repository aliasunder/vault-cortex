/** Tasks-plugin recurrence (🔁 / `[repeat:: ]`): parse the rule text and
 *  compute the next occurrence's dates when a recurring task is completed.
 *
 *  A transliteration of the plugin's own logic (obsidian-tasks
 *  `Recurrence.ts` + `Occurrence.ts`, verified at v8.4.0) on `YYYY-MM-DD`
 *  strings, running the same `rrule` version the plugin pins so rule parsing
 *  and next-hit computation are identical by construction:
 *
 *  - The rule text splits into an rrule natural-language part and an optional
 *    " when done" suffix. "when done" bases the next occurrence on the
 *    completion day; otherwise it advances from the reference date.
 *  - The reference date is due, else scheduled, else start — flipped to due,
 *    start, scheduled when `removeScheduledDateOnRecurrence` is on (the
 *    scheduled date is about to be dropped, so it must not anchor the series).
 *  - Every other present date keeps its day-distance from the reference date.
 *  - Monthly and yearly rules that skip too far (Jan 31 "every month" has no
 *    Feb 31) are clamped by the plugin's walk-back (see `nextAfterCapped`).
 *
 *  Deliberate divergence: when `rrule.after` finds no next hit (a finite rule
 *  is exhausted), this module returns null and the caller completes without
 *  spawning — the plugin wraps that null in an invalid moment and proceeds
 *  with garbage dates. */

import { createRequire } from "node:module"
import { DateTime } from "luxon"
import type { Options } from "rrule"
import type * as RRuleModule from "rrule"

// rrule@2.8.1 has no `exports` map, and no single `import` works on both
// resolution paths: plain node loads the CJS bundle (its named exports are
// invisible to cjs-module-lexer), while bundler-style resolvers load the ESM
// build (no default export, extensionless internal imports plain node
// rejects). CommonJS require resolves the same CJS bundle everywhere.
const requireModule = createRequire(import.meta.url)
const rrule: typeof RRuleModule = requireModule("rrule")
const { RRule } = rrule

// ── Rule parsing ────────────────────────────────────────────────

/** The plugin's rule grammar: rrule natural-language text plus an optional
 *  " when done" suffix (case-insensitive). Same charset the task-line parser
 *  accepts after 🔁. */
const RECURRENCE_RULE_RE = /^([a-zA-Z0-9, !]+?)( when done)?$/i

export type ParsedRecurrenceRule = {
  /** True for " when done" rules — the next occurrence advances from the
   *  completion day instead of the reference date. */
  baseOnToday: boolean
  /** rrule options from `RRule.parseText`, without a dtstart. */
  rruleOptions: Partial<Options>
}

/** Parses a 🔁 / `[repeat:: ]` rule's text, or null when the text is not a
 *  rule the plugin could read — the plugin treats such a task as
 *  non-recurring. */
export const parseRecurrenceRule = (
  recurrenceText: string,
): ParsedRecurrenceRule | null => {
  const ruleMatch = RECURRENCE_RULE_RE.exec(recurrenceText.trim())
  if (!ruleMatch?.[1]) return null

  const naturalLanguageRule = ruleMatch[1].trim()
  const baseOnToday = Boolean(ruleMatch[2])

  // The plugin wraps parseText in the same try/null — parseText throws on
  // text it half-recognizes and returns null on text it doesn't.
  try {
    const rruleOptions = RRule.parseText(naturalLanguageRule)
    if (rruleOptions === null) return null
    return { baseOnToday, rruleOptions }
  } catch {
    return null
  }
}

// ── Date plumbing ───────────────────────────────────────────────

/** A calendar day as a UTC-midnight Date — the plugin's `.utc(true)` trick:
 *  rrule computes in UTC only, so date-only values enter and leave as UTC
 *  midnights and no local-time conversion ever happens on the rrule leg. */
const utcMidnight = (isoDate: string): Date => {
  const day = DateTime.fromISO(isoDate, { zone: "utc" })
  if (!day.isValid) throw new Error(`invalid date: "${isoDate}"`)
  return day.toJSDate()
}

/** The last millisecond of a calendar day in UTC — the query point for
 *  "strictly after this day". */
const utcEndOfDay = (isoDate: string): Date => {
  const day = DateTime.fromISO(isoDate, { zone: "utc" })
  if (!day.isValid) throw new Error(`invalid date: "${isoDate}"`)
  return day.endOf("day").toJSDate()
}

/** The calendar day of a UTC-midnight Date as a `YYYY-MM-DD` string. */
const isoDateOfUtc = (date: Date): string => {
  const isoDate = DateTime.fromJSDate(date, { zone: "utc" }).toISODate()
  if (isoDate === null) throw new Error("invalid rrule result date")
  return isoDate
}

// ── Next-hit computation (the plugin's nextAfter) ───────────────

/** Iteration cap for the walk-back loops. The plugin runs uncapped; each
 *  step moves the query one day into the past and the overflow being
 *  corrected is at most one month wide, so a bound in the tens is already
 *  generous — the cap only guards against a pathological rrule answer
 *  looping forever. */
const WALK_BACK_ITERATION_CAP = 100

/** Matches a monthly rule in rrule's canonical text ("every month",
 *  "every 3 months"), capturing the optional interval. */
const MONTHLY_RULE_TEXT_RE = /every( \d+)? month(s)?(.*)?/
/** Matches a yearly rule in rrule's canonical text, capturing the optional
 *  interval. */
const YEARLY_RULE_TEXT_RE = /every( \d+)? year(s)?(.*)?/

/** Months from `after` to `next`, counted on UTC calendar components. */
const monthsSkipped = (after: DateTime, next: DateTime): number => {
  return next.month - after.month + (next.year - after.year) * 12
}

/** One walk-back step — the plugin's `fromOneDayEarlier`, kept
 *  mutation-order-faithful: move the query day one day into the past,
 *  rebuild the rule with dtstart on that day (moving dtstart is what
 *  re-phases an inferred bymonthday), and query from that day's start. */
const walkBackOneDay = ({
  afterDay,
  rruleOptions,
}: {
  afterDay: DateTime
  rruleOptions: Partial<Options>
}): { afterDay: DateTime; next: Date | null } => {
  const earlierDay = afterDay.minus({ days: 1 }).startOf("day")
  const rebuiltRule = new RRule({
    ...rruleOptions,
    dtstart: earlierDay.toJSDate(),
  })
  return {
    afterDay: earlierDay,
    next: rebuiltRule.after(earlierDay.toJSDate()),
  }
}

/** The next rrule hit after `after`, with the plugin's monthly/yearly
 *  overflow correction: when the naive next hit skips more than the rule's
 *  month/year interval (Jan 31 "every month" → Mar 31, because rrule
 *  inferred `bymonthday: 31` and February has no 31st), the query walks
 *  back one day at a time until the interval is right (→ Feb 28). Month
 *  rules that fix a date explicitly ("every month on the 31st") keep
 *  rrule's native skipping; the plugin applies no such exemption to year
 *  rules. Returns null when the rule has no next hit (exhausted). */
const nextAfterCapped = ({
  after,
  rule,
  rruleOptions,
}: {
  after: Date
  rule: InstanceType<typeof RRule>
  rruleOptions: Partial<Options>
}): Date | null => {
  const naiveNext = rule.after(after)
  if (naiveNext === null) return null

  const canonicalRuleText = rule.toText()
  const monthMatch = MONTHLY_RULE_TEXT_RE.exec(canonicalRuleText)
  const yearMatch = YEARLY_RULE_TEXT_RE.exec(canonicalRuleText)

  // " on " in the canonical text means the rule fixes an explicit day
  // ("every month on the 31st") — rrule's native month-skipping is correct
  // for those, so the walk-back stands down. The plugin checks this for
  // month rules only; year rules walk back unconditionally (its reachable
  // yearly grammar never carries " on " in canonical text — "every January
  // on the 31st" canonicalizes without the word "year").
  const ruleFixesAnExplicitDay = canonicalRuleText.includes(" on ")
  const monthIntervalToEnforce =
    monthMatch && !ruleFixesAnExplicitDay
      ? Number.parseInt(monthMatch[1]?.trim() ?? "1", 10)
      : null
  const yearIntervalToEnforce = yearMatch
    ? Number.parseInt(yearMatch[1]?.trim() ?? "1", 10)
    : null
  if (monthIntervalToEnforce === null && yearIntervalToEnforce === null) {
    return naiveNext
  }

  // Walk-back loop — sequential by nature: each iteration re-queries from
  // one day earlier and the loop condition reads the newest answer.
  // afterDay starts at the query point's end-of-day and becomes start-of-day
  // after the first step (walkBackOneDay normalizes it); harmless, because
  // the loop reads only month/year components, which are the same at either
  // end of a calendar day.
  let afterDay: DateTime = DateTime.fromJSDate(after, { zone: "utc" })
  let next = naiveNext
  for (let iteration = 0; iteration < WALK_BACK_ITERATION_CAP; iteration++) {
    const nextDay = DateTime.fromJSDate(next, { zone: "utc" })
    const skipsTooManyMonths =
      monthIntervalToEnforce !== null &&
      monthsSkipped(afterDay, nextDay) > monthIntervalToEnforce
    const skipsTooManyYears =
      yearIntervalToEnforce !== null &&
      nextDay.year - afterDay.year > yearIntervalToEnforce
    if (!skipsTooManyMonths && !skipsTooManyYears) return next

    const walkedBack = walkBackOneDay({ afterDay, rruleOptions })
    if (walkedBack.next === null) return null
    afterDay = walkedBack.afterDay
    next = walkedBack.next
  }
  // Budget exhausted — the rrule answer stayed out-of-interval for 100
  // walk-back steps. Return null (no next occurrence) rather than the
  // uncorrected date: a skipped spawn is recoverable, a wrong date isn't.
  return null
}

// ── Next occurrence dates (the plugin's Recurrence.next + Occurrence.next) ──

export type NextOccurrenceParams = {
  /** Verbatim rule text from the task line (after 🔁 / `repeat::`). */
  recurrenceText: string
  startDate: string | null
  scheduledDate: string | null
  dueDate: string | null
  /** The completion day, `YYYY-MM-DD` — "when done" rules advance from it. */
  today: string
  removeScheduledDateOnRecurrence: boolean
  /** IANA zone for the relative-shift day arithmetic (the plugin computes it
   *  on local instants, which differs from UTC-label arithmetic across
   *  half-day-plus timezone discontinuities). Defaults to the server zone. */
  zone?: string | undefined
}

export type NextOccurrenceDates = {
  startDate: string | null
  scheduledDate: string | null
  dueDate: string | null
}

/** First present date in the plugin's reference priority order. With
 *  `removeScheduledDateOnRecurrence` on, the scheduled date is about to be
 *  dropped from the new occurrence, so it ranks below the start date. */
const referenceDateOf = ({
  startDate,
  scheduledDate,
  dueDate,
  removeScheduledDateOnRecurrence,
}: {
  startDate: string | null
  scheduledDate: string | null
  dueDate: string | null
  removeScheduledDateOnRecurrence: boolean
}): string | null => {
  const datesInPriorityOrder = removeScheduledDateOnRecurrence
    ? [dueDate, startDate, scheduledDate]
    : [dueDate, scheduledDate, startDate]
  return datesInPriorityOrder.find((date) => date !== null) ?? null
}

/** A date shifted to keep its day-distance from the reference date, computed
 *  on zone-local instants with rounding — the plugin's moment arithmetic. */
const shiftKeepingDistance = ({
  date,
  referenceDate,
  nextReferenceDate,
  zone,
}: {
  date: string
  referenceDate: string
  nextReferenceDate: string
  zone: string
}): string => {
  const dateInZone = DateTime.fromISO(date, { zone })
  const referenceInZone = DateTime.fromISO(referenceDate, { zone })
  // Unitless diff then .as("days") is instant math — the plugin's moment
  // .diff() semantics. A "days"-unit diff would count calendar labels and
  // disagree across timezone discontinuities; rounding absorbs ordinary
  // DST hours.
  const dayDistance = Math.round(dateInZone.diff(referenceInZone).as("days"))
  const shifted = DateTime.fromISO(nextReferenceDate, { zone })
    .plus({ days: dayDistance })
    .toISODate()
  if (shifted === null) throw new Error("invalid shifted occurrence date")
  return shifted
}

/** The next occurrence's dates for a completed recurring task, or null when
 *  there is no next occurrence (rule text unparseable, or a finite rule is
 *  exhausted — the caller completes the task without spawning). A recurring
 *  task with no dates at all returns all-null dates: the plugin spawns a
 *  dateless copy. */
export const nextOccurrenceDates = (
  params: NextOccurrenceParams,
): NextOccurrenceDates | null => {
  const parsedRule = parseRecurrenceRule(params.recurrenceText)
  if (parsedRule === null) return null

  const referenceDate = referenceDateOf(params)

  // The rule's dtstart anchors the series: the reference date normally, the
  // completion day for "when done" rules or when the task has no dates.
  const seriesAnchor =
    parsedRule.baseOnToday || referenceDate === null
      ? params.today
      : referenceDate
  const rule = new RRule({
    ...parsedRule.rruleOptions,
    dtstart: utcMidnight(seriesAnchor),
  })

  // The next hit must be strictly after the anchor day, so the query point
  // is that day's last millisecond.
  const nextHit = nextAfterCapped({
    after: utcEndOfDay(seriesAnchor),
    rule,
    rruleOptions: parsedRule.rruleOptions,
  })
  if (nextHit === null) return null

  // No reference date → the plugin spawns a dateless copy (it computes the
  // next hit and then discards it).
  if (referenceDate === null) {
    return { startDate: null, scheduledDate: null, dueDate: null }
  }

  const nextReferenceDate = isoDateOfUtc(nextHit)
  const zone = params.zone ?? "local"

  const shiftedDate = (date: string | null): string | null => {
    if (date === null) return null
    return shiftKeepingDistance({
      date,
      referenceDate,
      nextReferenceDate,
      zone,
    })
  }

  // The scheduled date is dropped from the new occurrence when the setting
  // is on and another date survives to carry the series.
  const shouldDropScheduledDate =
    params.removeScheduledDateOnRecurrence &&
    (params.startDate !== null || params.dueDate !== null)

  return {
    startDate: shiftedDate(params.startDate),
    scheduledDate: shouldDropScheduledDate
      ? null
      : shiftedDate(params.scheduledDate),
    dueDate: shiftedDate(params.dueDate),
  }
}
