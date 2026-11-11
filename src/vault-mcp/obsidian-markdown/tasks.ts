/** The Obsidian Tasks-plugin task-line domain: parsing task metadata AND
 *  mutating task lines (status, priority, dates) in both of the plugin's
 *  formats — emoji signifiers and Dataview inline fields.
 *
 *  **Parsing:** a faithful reimplementation of the plugin's own parser
 *  (obsidian-tasks-group/obsidian-tasks, `DefaultTaskSerializer` +
 *  `DataviewTaskSerializer`): metadata is stripped off the END of the line, one
 *  `$`-anchored field at a time, until nothing matches or 21 passes finish. Any
 *  order of fields parses; unrecognized trailing text stops the scan and leaves
 *  everything to its left as description — exactly the plugin's behavior.
 *  Unlike the plugin (which reads one configured format per vault), both
 *  formats are recognized in the same pass, so mixed-format vaults index
 *  uniformly.
 *
 *  **Mutation:** surgical string transforms that update checkbox characters,
 *  insert/replace/strip date and priority fields. Strip regexes match both
 *  formats; new fields are written in the format specified by TaskFormatConfig
 *  (auto-detected from the Tasks plugin settings, overridable per call).
 *
 *  Like the `links` namespace in links.ts, the raw grammar regexes stay
 *  module-private behind the `tasks` namespace: HASHTAG_RE is `/g` (shared
 *  `lastIndex` footgun) and the `$`-anchored field regexes are only
 *  meaningful inside the stripping loop. BLOCK_LINK_RE is the one exported
 *  regex: it is non-global and reads a whole line's trailing block id, so it
 *  is safe to use outside the loop. */

import { DateTime } from "luxon"
import { advanceComment, advanceFence, type OpenFence, splitIntoLines } from "./lines.js"
import { parseHeadings, type HeadingInfo } from "./headings.js"
import { findBodyStartLine, splitPropertiesBlock } from "./frontmatter.js"
import type {
  StatusClassification,
  TaskFormatConfig,
} from "../vault-operations/task-format-config.js"

// ── Types ───────────────────────────────────────────────────────

/** The plugin's core status types, derived from the checkbox character.
 *  Unknown characters map to "todo" (the plugin's unknown-symbol behavior). */
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled"

/** The five explicit priority levels. A task with no priority signifier has
 *  priority null — the plugin ranks "none" between medium and low. */
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest"

/** One parsed task line. Dates are raw `YYYY-MM-DD` strings (the only format
 *  the plugin recognizes), so they compare lexicographically. A well-formed
 *  but calendar-invalid date (e.g. `2026-99-99`) is stripped like any
 *  recognized field but parsed as null, matching the plugin's exclusion of
 *  invalid dates from date comparisons. */
export type ParsedTask = Readonly<{
  /** 1-based line number in the full file (frontmatter included), matching
   *  what an editor or vault_read_note shows. */
  line: number
  /** The raw character inside the checkbox brackets, e.g. " ", "x", "/". */
  statusChar: string
  status: TaskStatus
  /** Task text with metadata stripped; inline #tags remain part of it. */
  description: string
  createdDate: string | null
  scheduledDate: string | null
  startDate: string | null
  dueDate: string | null
  doneDate: string | null
  cancelledDate: string | null
  priority: TaskPriority | null
  /** Recurrence rule text after 🔁 / `repeat::` (e.g. "every week when done").
   *  Completion uses it to compute the next occurrence, if one exists. */
  recurrence: string | null
  /** Raw word after 🏁 / `onCompletion::` (the plugin accepts "delete" and
   *  "keep"). */
  onCompletion: string | null
  /** The task's own 🆔 / `id::` value. */
  taskId: string | null
  /** IDs this task depends on (⛔ / `dependsOn::`), empty when none. */
  dependsOn: readonly string[]
  /** Inline #tags found in the description, stored bare (no "#") to match the
   *  vault-wide tag convention; nested tags keep their "/" segments. */
  tags: readonly string[]
  /** Block ID without the "^", e.g. "my-card" for `^my-card`. */
  blockId: string | null
  /** Text of the nearest heading above the task, or null before the first
   *  heading — on a Kanban board this is the lane. */
  heading: string | null
  /** Nesting depth: 0 for top-level tasks, 1+ for sub-tasks. Derived from
   *  structural indentation relative to ancestor task lines; a plain list
   *  item closes tasks at its indent or deeper without becoming a parent. */
  depth: number
  /** 1-based file line number of the parent task, or null for top-level
   *  tasks. The index resolves it to the parent's block_id; the wire shape
   *  never carries the line itself. */
  parentLine: number | null
}>

// ── Task-line grammar (private) ─────────────────────────────────

/** Matches a checkbox task line: optional indentation (spaces, tabs, and `>`
 *  for blockquotes/callouts), a list marker (`-`, `*`, `+`, or numbered like
 *  `1.` / `1)`), one or more spaces, and `[c]` with exactly one status
 *  character. Captures: [1] status character, [2] everything after the
 *  checkbox. Anchored and non-global — safe for .exec(). */
const TASK_LINE_RE = /^[\s>]*(?:[-*+]|[0-9]+[.)]) +\[(.)\](.*)$/u

/** Matches ASCII spaces before a task body's content. */
const LEADING_BODY_SPACES_RE = /^ +/

/** Matches any list item — the same prefix and marker grammar as
 *  TASK_LINE_RE without the checkbox. A non-task item at a task's indent
 *  ends that task's list, so it must close the task's sub-task scope too. */
const LIST_ITEM_RE = /^[\s>]*(?:[-*+]|[0-9]+[.)]) /u

/** Matches a trailing block link ` ^block-id` at the very end of the line.
 *  Captures the ID without the caret (group 1). The plugin strips this before
 *  parsing metadata, so it must be removed first. Anchored — safe for .exec().
 *  Always match against trimmed-end text (splitTrailingBlockLink does): a
 *  markdown hard break (two+ trailing spaces) would otherwise hide the link
 *  — and, since the unrecognized ` ^id` tail then stops the metadata scan,
 *  every field on the line with it. */
const BLOCK_LINK_RE = / \^([a-zA-Z0-9-]+)$/u

/** The parts around a task body's trailing block link. `body` is trimmed of
 *  trailing whitespace; `blockLink` keeps its leading space, "" when the
 *  line has none. */
const splitTrailingBlockLink = (
  taskBody: string,
): { body: string; blockId: string | null; blockLink: string } => {
  const trimmedBody = taskBody.trimEnd()
  const blockLinkMatch = BLOCK_LINK_RE.exec(trimmedBody)

  if (!blockLinkMatch) {
    return { body: trimmedBody, blockId: null, blockLink: "" }
  }
  return {
    body: trimmedBody.slice(0, blockLinkMatch.index),
    blockId: blockLinkMatch[1] ?? null,
    blockLink: blockLinkMatch[0],
  }
}

/** One character a hashtag may hold after its `#`, in the plugin's own
 *  hashtag grammar: anything except the ASCII space and common punctuation,
 *  so tabs pass and so do nested `#a/b` tags. Every hashtag regex in this file
 *  is built from it. */
const HASHTAG_CHARACTER_CLASS = '[^ !@#$%^&*(),.?":{}|<>]'

/** Matches inline hashtags: `#` preceded by start-of-string or whitespace,
 *  then one or more hashtag characters. Global — matchAll only. */
const HASHTAG_RE = new RegExp(`(^|\\s)#${HASHTAG_CHARACTER_CLASS}+`, "g")

/** HASHTAG_RE anchored to line end, for stripping a trailing tag during the
 *  metadata loop (tags may interleave with signifiers). Non-global. */
const HASHTAG_FROM_END_RE = new RegExp(`(^|\\s)#${HASHTAG_CHARACTER_CLASS}+$`)

// ── Field grammar (private) ─────────────────────────────────────
//
// Emoji regexes mirror the plugin's fieldRegex() construction: the signifier,
// an optional Variant Selector 16 (U+FE0F — platforms insert it after emoji
// like the 🗓 due-date variant), optional spaces, the value, then `$` —
// fields are matched and removed from the end of the line until none are left.
//
// Dataview regexes mirror toInlineFieldRegex(): the `key:: value` pair wrapped
// in matching `[...]` or `(...)`, with an optional trailing comma, anchored to
// line end. The suffix scan requires paired brackets, so a mismatched pair
// such as `[due:: 2026-01-01)` does not match.

/** The allowed characters in a single 🆔 / `id::` task ID. */
const TASK_ID = /[a-zA-Z0-9_-]+/
/** Whole-string form of TASK_ID, for validating an id before it is written —
 *  anything else lands on the line as prose the parser never reads back. */
const TASK_ID_WHOLE_RE = new RegExp(`^${TASK_ID.source}$`)
const isTaskId = (candidate: string): boolean => TASK_ID_WHOLE_RE.test(candidate)
/** A comma-separated sequence of task IDs, as accepted after ⛔ / `dependsOn::`:
 *  it matches all of `a`, `a,b` and `a , b`, and only the `a` of `a,,b`.
 *  - The Tasks plugin builds this as `ID( *, *ID *)*`. There, each repetition's
 *    trailing spaces can also match the next one's leading spaces, so a space
 *    before each comma causes exponential backtracking.
 *  - This form gives each space run one place to match. With two or more IDs,
 *    the final ` *(?! )` takes every space after the last one, as the
 *    plugin's trailing ` *` does, and the lookahead stops it from giving any
 *    back. A lone ID takes no trailing spaces, in either form. */
const TASK_ID_SEQUENCE = new RegExp(`${TASK_ID.source}(?:(?: *, *${TASK_ID.source})+ *(?! ))?`)

/** Builds an emoji field regex: signifier + optional VS16 (U+FE0F, matched
 *  via escape so no invisible character hides in this source) + spaces +
 *  value, anchored to line end (see block comment above). */
const emojiField = ({
  symbols,
  valuePattern,
}: {
  symbols: string
  valuePattern: string
}): RegExp => {
  // An empty valuePattern is for priority: the signifier is the value, so
  // `symbols` holds the capture group.
  if (valuePattern === "") return new RegExp(`${symbols}\\uFE0F?$`)
  return new RegExp(`${symbols}\\uFE0F? *${valuePattern}$`)
}

type FieldMatch = Pick<RegExpExecArray, number | "index">
/** The shape METADATA_MATCHERS needs: a RegExp satisfies it, and so does the
 *  hand-written matcher dataviewField returns. */
type FieldMatcher = { exec: (line: string) => FieldMatch | null }

/** Builds a matcher for one Dataview field at line end: `[key:: value]` or
 *  `(key:: value)`, brackets paired, spaces allowed inside the brackets and
 *  before an optional trailing comma. Only the last bracketed span on the line
 *  is tried. It returns a hand-written matcher, not a RegExp, because a
 *  `$`-anchored regex for this shape retries from every earlier opener on the
 *  line. */
const dataviewField = ({
  key,
  valuePattern,
}: {
  key: string
  valuePattern: string
}): FieldMatcher => {
  const keyPrefix = `${key}::`
  const innerPattern = `${keyPrefix} *${valuePattern}`
  /** Matches the complete field value after its surrounding ASCII spaces are removed. */
  const wholeValueRe = new RegExp(`^${valuePattern}$`)
  /** Matches the whole field, from its opener to the end of the line. */
  const fieldPattern = new RegExp(`^[[(] *${innerPattern} *[)\\]](?: *,)?$`)

  return {
    exec: (line) => {
      // The closing bracket ends the line, or sits before a trailing comma.
      let close = line.length - 1

      if (line[close] === ",") {
        close -= 1
        while (line[close] === " ") close -= 1
      }
      const closer = line[close]

      if (closer !== "]" && closer !== ")") return null
      // The field opens at the nearest `[` or `(` before the closer, and must pair with it.
      let open = close - 1

      while (open >= 0 && line[open] !== "[" && line[open] !== "(") open -= 1
      if (open < 0 || closer !== (line[open] === "[" ? "]" : ")")) return null
      let valueStart = open + 1

      while (line[valueStart] === " ") valueStart += 1
      if (!line.startsWith(keyPrefix, valueStart)) return null
      valueStart += keyPrefix.length
      while (line[valueStart] === " ") valueStart += 1
      let valueEnd = close

      while (valueEnd > valueStart && line[valueEnd - 1] === " ") valueEnd -= 1
      if (!wholeValueRe.test(line.slice(valueStart, valueEnd))) return null
      // The checks above found the field; the regex returns it with its
      // capture groups, as the RegExp matchers do.
      const match = fieldPattern.exec(line.slice(open))

      if (match) match.index += open
      return match
    },
  }
}

/** Regex source for a `YYYY-MM-DD` date, the only date format the plugin
 *  recognizes on task lines. */
const DATE_PATTERN = "\\d{4}-\\d{2}-\\d{2}"
/** DATE_PATTERN as capture group 1, for the parser's date fields. */
const CAPTURED_DATE_PATTERN = `(${DATE_PATTERN})`

/** One date field's grammar in both formats, in the plugin's per-pass
 *  extraction order (done, cancelled, due, scheduled, start, created).
 *  DATE_FIELDS_IN_LINE_ORDER holds the write side. */
const DATE_FIELD_PARSERS: ReadonlyArray<{
  key: DateFieldKey
  emoji: RegExp
  dataview: FieldMatcher
}> = [
  {
    key: "done",
    emoji: emojiField({ symbols: "✅", valuePattern: CAPTURED_DATE_PATTERN }),
    dataview: dataviewField({ key: "completion", valuePattern: CAPTURED_DATE_PATTERN }),
  },
  {
    key: "cancelled",
    emoji: emojiField({ symbols: "❌", valuePattern: CAPTURED_DATE_PATTERN }),
    dataview: dataviewField({ key: "cancelled", valuePattern: CAPTURED_DATE_PATTERN }),
  },
  {
    key: "due",
    emoji: emojiField({ symbols: "(?:📅|📆|🗓)", valuePattern: CAPTURED_DATE_PATTERN }),
    dataview: dataviewField({ key: "due", valuePattern: CAPTURED_DATE_PATTERN }),
  },
  {
    key: "scheduled",
    emoji: emojiField({ symbols: "(?:⏳|⌛)", valuePattern: CAPTURED_DATE_PATTERN }),
    dataview: dataviewField({ key: "scheduled", valuePattern: CAPTURED_DATE_PATTERN }),
  },
  {
    key: "start",
    emoji: emojiField({ symbols: "🛫", valuePattern: CAPTURED_DATE_PATTERN }),
    dataview: dataviewField({ key: "start", valuePattern: CAPTURED_DATE_PATTERN }),
  },
  {
    key: "created",
    emoji: emojiField({ symbols: "➕", valuePattern: CAPTURED_DATE_PATTERN }),
    dataview: dataviewField({ key: "created", valuePattern: CAPTURED_DATE_PATTERN }),
  },
]

/** Emoji priority signifier, anchored to line end. Captures the emoji. */
const EMOJI_PRIORITY_RE = emojiField({
  symbols: "(🔺|⏫|🔼|🔽|⏬)",
  valuePattern: "",
})
/** Dataview priority field, anchored to line end. Captures the level word
 *  (lowercase only, matching the plugin's regex; `highest` before `high` so
 *  the longer word wins). */
const DATAVIEW_PRIORITY_MATCHER = dataviewField({
  key: "priority",
  valuePattern: "(highest|high|medium|low|lowest)",
})
// The two recurrence regexes are written out rather than built by emojiField
// and dataviewField. A rule's characters include the space, so the capture
// takes the spaces around the rule (the parser trims them): a separate ` *`
// before or after it would give every space two places to match.

/** Recurrence rule text after 🔁 — letters, digits, commas, spaces, `!`. */
const EMOJI_RECURRENCE_RE = /🔁\uFE0F?([a-zA-Z0-9, !]+)$/
/** Matches `[repeat:: rule]` or `(repeat:: rule)` at line end, with an
 *  optional trailing comma. Captures the rule in group 1 (square brackets)
 *  or group 2 (parentheses). */
const DATAVIEW_RECURRENCE_RE =
  /(?:\[ *repeat::([a-zA-Z0-9, !]+)\]|\( *repeat::([a-zA-Z0-9, !]+)\))(?: *,)?$/
/** On-completion action word after 🏁 (the plugin accepts delete/keep). */
const EMOJI_ON_COMPLETION_RE = emojiField({
  symbols: "🏁",
  valuePattern: "([a-zA-Z]+)",
})
const DATAVIEW_ON_COMPLETION_MATCHER = dataviewField({
  key: "onCompletion",
  valuePattern: "([a-zA-Z]+)",
})
/** The task's own ID after 🆔. */
const EMOJI_ID_RE = emojiField({
  symbols: "🆔",
  valuePattern: `(${TASK_ID.source})`,
})
const DATAVIEW_ID_MATCHER = dataviewField({ key: "id", valuePattern: `(${TASK_ID.source})` })
/** Comma-separated IDs this task depends on, after ⛔. */
const EMOJI_DEPENDS_ON_RE = emojiField({
  symbols: "⛔",
  valuePattern: `(${TASK_ID_SEQUENCE.source})`,
})
const DATAVIEW_DEPENDS_ON_MATCHER = dataviewField({
  key: "dependsOn",
  valuePattern: `(${TASK_ID_SEQUENCE.source})`,
})

/** Emoji signifier → priority level. */
const PRIORITY_BY_EMOJI: Readonly<Record<string, TaskPriority>> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
}

/** Dataview level word → priority level (identity lookup that narrows the
 *  captured string to the TaskPriority union without a type assertion). */
const PRIORITY_BY_WORD: Readonly<Record<string, TaskPriority>> = {
  highest: "highest",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "lowest",
}

// ── Status mapping ──────────────────────────────────────────────

/** The Tasks plugin's built-in statuses — what the registry holds when the
 *  plugin config is absent. */
export const DEFAULT_STATUS_REGISTRY: ReadonlyMap<string, StatusClassification> = new Map([
  [" ", "todo"],
  ["x", "done"],
  ["X", "done"],
  ["/", "in_progress"],
  ["-", "cancelled"],
])

/** Maps a checkbox character to a status classification through the registry
 *  (from the Tasks plugin config), or the built-in statuses for a caller
 *  without one. A char the registry does not list is "todo". */
const statusForChar = (
  statusChar: string,
  statusRegistry?: ReadonlyMap<string, StatusClassification>,
): StatusClassification => {
  return (statusRegistry ?? DEFAULT_STATUS_REGISTRY).get(statusChar) ?? "todo"
}

// ── Metadata parsing ────────────────────────────────────────────

/** The metadata fields extracted from one task line's body (the text after
 *  the checkbox, block link already removed). */
type TaskMetadata = Pick<
  ParsedTask,
  | "description"
  | "createdDate"
  | "scheduledDate"
  | "startDate"
  | "dueDate"
  | "doneDate"
  | "cancelledDate"
  | "priority"
  | "recurrence"
  | "onCompletion"
  | "taskId"
  | "dependsOn"
  | "tags"
>

/** The Tasks plugin's own limit on stripping runs, copied from its deserializer. */
const PLUGIN_MAX_RUNS = 20
/** The plugin checks that limit after each pass, so it runs 21 passes, one more than the limit. */
const MAX_STRIPPING_PASSES = PLUGIN_MAX_RUNS + 1

/** Every field matcher, in the order one stripping pass tries them.
 *  parseTaskMetadata writes the same order out by hand, so the two change
 *  together. */
const METADATA_MATCHERS = [
  EMOJI_PRIORITY_RE,
  DATAVIEW_PRIORITY_MATCHER,
  ...DATE_FIELD_PARSERS.flatMap((field) => [field.emoji, field.dataview]),
  EMOJI_RECURRENCE_RE,
  DATAVIEW_RECURRENCE_RE,
  EMOJI_ON_COMPLETION_RE,
  DATAVIEW_ON_COMPLETION_MATCHER,
  HASHTAG_FROM_END_RE,
  EMOJI_ID_RE,
  DATAVIEW_ID_MATCHER,
  EMOJI_DEPENDS_ON_RE,
  DATAVIEW_DEPENDS_ON_MATCHER,
]

/** Extracts a regex capture group, throwing if absent. Capture groups are
 *  guaranteed by the engine when the regex matches, but noUncheckedIndexedAccess
 *  adds `| undefined` to all indexed access. */
const capturedGroup = (match: FieldMatch, index: number): string => {
  const value = match[index]

  if (value === undefined) {
    throw new Error(`expected capture group ${index}`)
  }
  return value
}

/** Looks a captured priority up in its table. The priority regexes capture
 *  only the table's keys, so a miss means a regex and its table disagree. */
const capturedPriority = (
  captured: string,
  priorityTable: Readonly<Record<string, TaskPriority>>,
): TaskPriority => {
  const priority = priorityTable[captured]

  if (!priority) {
    throw new Error(`no priority level for the captured "${captured}"`)
  }
  return priority
}

/** Strips metadata fields off the end of a task body, mirroring the plugin's
 *  deserialize():
 *  - each pass tries every field regex (all `$`-anchored) and removes what
 *    matches; the loop repeats until a pass matches nothing or the cap is reached;
 *  - a field written twice keeps its leftmost value, the one stripped last;
 *  - tags interleaved with signifiers are stripped too, then re-appended, so
 *    they stay part of the description without blocking fields to their left. */
const parseTaskMetadata = (taskBody: string): TaskMetadata => {
  // The stripping loop is inherently sequential — every match shortens the
  // line and later passes depend on it — so mutable locals thread the parser
  // state, mirroring the plugin's ParsingState.
  let line = taskBody.trim()
  // Assigned at the top of every stripping pass; no initializer needed.
  let matchedThisPass: boolean
  let priority: TaskPriority | null = null
  const dates: Record<DateFieldKey, string | null> = {
    done: null,
    cancelled: null,
    due: null,
    scheduled: null,
    start: null,
    created: null,
  }
  let recurrence: string | null = null
  let onCompletion: string | null = null
  let taskId: string | null = null
  let dependsOn: readonly string[] = []
  let trailingTags = ""

  const extractField = (matcher: FieldMatcher, onMatch: (match: FieldMatch) => void): void => {
    const match = matcher.exec(line)

    if (!match) return
    onMatch(match)
    line = line.slice(0, match.index).trim()
    matchedThisPass = true
  }

  const extractDate = (matcher: FieldMatcher, key: DateFieldKey): void => {
    extractField(matcher, (match) => {
      dates[key] = capturedGroup(match, 1)
    })
  }

  // Removing a suffix can expose a field whose turn already passed; the next pass reads it.
  for (let pass = 0; pass < MAX_STRIPPING_PASSES; pass++) {
    matchedThisPass = false

    extractField(EMOJI_PRIORITY_RE, (match) => {
      priority = capturedPriority(capturedGroup(match, 1), PRIORITY_BY_EMOJI)
    })
    extractField(DATAVIEW_PRIORITY_MATCHER, (match) => {
      priority = capturedPriority(capturedGroup(match, 1), PRIORITY_BY_WORD)
    })

    for (const field of DATE_FIELD_PARSERS) {
      extractDate(field.emoji, field.key)
      extractDate(field.dataview, field.key)
    }

    extractField(EMOJI_RECURRENCE_RE, (match) => {
      recurrence = capturedGroup(match, 1).trim()
    })
    extractField(DATAVIEW_RECURRENCE_RE, (match) => {
      const recurrenceValue = match[1] ?? capturedGroup(match, 2)
      recurrence = recurrenceValue.trim()
    })

    extractField(EMOJI_ON_COMPLETION_RE, (match) => {
      onCompletion = capturedGroup(match, 1)
    })
    extractField(DATAVIEW_ON_COMPLETION_MATCHER, (match) => {
      onCompletion = capturedGroup(match, 1)
    })

    // Tags may be mixed among the signifiers (`desc #a 📅 2026-01-01 #b`);
    // strip them here so fields further left stay reachable, and re-append
    // them to the description after the loop. Right-to-left matching means
    // each stripped tag is prepended to keep the original order.
    extractField(HASHTAG_FROM_END_RE, (match) => {
      const tagText = capturedGroup(match, 0).trim()
      trailingTags = trailingTags === "" ? tagText : `${tagText} ${trailingTags}`
    })

    extractField(EMOJI_ID_RE, (match) => {
      taskId = capturedGroup(match, 1).trim()
    })
    extractField(DATAVIEW_ID_MATCHER, (match) => {
      taskId = capturedGroup(match, 1).trim()
    })

    extractField(EMOJI_DEPENDS_ON_RE, (match) => {
      dependsOn = splitIdSequence(capturedGroup(match, 1))
    })
    extractField(DATAVIEW_DEPENDS_ON_MATCHER, (match) => {
      dependsOn = splitIdSequence(capturedGroup(match, 1))
    })

    if (!matchedThisPass) break
  }

  const description = trailingTags === "" ? line : `${line} ${trailingTags}`.trim()

  return {
    description,
    createdDate: calendarValidOrNull(dates.created),
    scheduledDate: calendarValidOrNull(dates.scheduled),
    startDate: calendarValidOrNull(dates.start),
    dueDate: calendarValidOrNull(dates.due),
    doneDate: calendarValidOrNull(dates.done),
    cancelledDate: calendarValidOrNull(dates.cancelled),
    priority,
    recurrence,
    onCompletion,
    taskId,
    dependsOn,
    tags: extractInlineTags(description),
  }
}

/** Drops calendar-invalid date values (e.g. "2026-99-99") after parsing. The
 *  plugin recognizes-and-strips a well-formed-but-invalid date field the same
 *  way, but marks it invalid and excludes it from every date comparison —
 *  mirrored here by indexing the value as null (dateless in filters/sorts). */
const calendarValidOrNull = (date: string | null): string | null =>
  date !== null && DateTime.fromFormat(date, "yyyy-MM-dd").isValid ? date : null

/** Splits a ⛔ / `dependsOn::` value ("a, b ,c") into individual IDs. */
const splitIdSequence = (idSequence: string): string[] =>
  idSequence
    .replace(/ /g, "")
    .split(",")
    .filter((id) => id !== "")

/** Collects every inline #tag in a description, deduplicated and stored bare
 *  (no "#") to match the notes table tag format used by vault_list_tags and
 *  vault_search_by_tag. */
const extractInlineTags = (description: string): string[] => {
  const hashtagMatches = [...description.matchAll(HASHTAG_RE)]
  const bareTags = hashtagMatches.map((match) => match[0].trim().slice(1))
  return [...new Set(bareTags)]
}

// ── Note scanning ───────────────────────────────────────────────

/** One open task on the extraction indent stack: its structural indent and
 *  1-based file line. */
type IndentEntry = {
  indent: number
  fileLine: number
}

/** The open tasks that are ancestors of a new list item: every stack entry
 *  at a shallower indent. Entries at the same or deeper indent are siblings or
 *  cousins of the item, so they are dropped. Stack indents strictly increase,
 *  so the ancestors are always a prefix of the stack. */
const ancestorsOf = (
  indentStack: readonly IndentEntry[],
  itemIndent: number,
): readonly IndentEntry[] => {
  return indentStack.filter((entry) => entry.indent < itemIndent)
}

/** Scans body lines for tasks, numbering each from `bodyStartLine`, the
 *  0-based file line the body starts on. Excluded: fenced code blocks,
 *  `%% %%` comment blocks, and checkboxes the status registry classifies as
 *  NON_TASK. Each task carries the nearest heading above it (its Kanban lane
 *  on a board), or null before the first heading. */
const scanBodyLinesForTasks = ({
  bodyLines,
  bodyStartLine,
  statusRegistry,
}: {
  bodyLines: readonly string[]
  bodyStartLine: number
  statusRegistry: ReadonlyMap<string, StatusClassification> | undefined
}): ParsedTask[] => {
  const headings = parseHeadings(bodyLines)

  const extractedTasks: ParsedTask[] = []

  // Indent stack for parent-child tracking:
  // - deeper indent than the stack top → the task is a child
  // - equal or shallower (task or plain list item) → the closed entries are
  //   dropped until the top is a parent
  // - a heading clears the stack (children can't span headings)
  // Sequential parser state, like the fence and comment scans below — each
  // step assigns a new stack, never mutates the current one.
  let indentStack: readonly IndentEntry[] = []

  // Fence and comment scans are inherently sequential — both thread mutable
  // state across the loop (same pattern as classifyLines).
  let openFence: OpenFence = null
  let commentOpen = false
  // headings[headingIndex] is the first heading not yet passed, and
  // nearestHeading the last one that starts above the current line.
  let headingIndex = 0
  let nearestHeading: HeadingInfo | undefined
  for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex++) {
    const lineText = bodyLines[lineIndex]

    if (lineText === undefined) continue

    // Fence/comment precedence: fence state advances only outside comments
    // (inside a comment, fence delimiters are just text). Comment toggles
    // run only outside fences (inside a fence, `%%` is just text).
    if (!commentOpen) {
      const fenceResult = advanceFence(lineText, openFence)
      openFence = fenceResult.openFence
      if (fenceResult.lineIsCode) continue
    }

    const commentResult = advanceComment(lineText, commentOpen)
    commentOpen = commentResult.commentOpen
    if (commentResult.lineIsComment) continue

    // A heading becomes the nearest one from the line after it starts; its
    // own line is the boundary checked below. The lines skipped above hold no
    // headings, since parseHeadings skips the same fence and comment lines.
    while ((headings[headingIndex]?.startLine ?? Infinity) < lineIndex) {
      nearestHeading = headings[headingIndex]
      headingIndex += 1
    }
    const lineStartsHeading = headings[headingIndex]?.startLine === lineIndex

    // Reset the indent stack at a heading: sub-tasks can't span headings.
    if (lineStartsHeading) {
      indentStack = []
    }

    const taskLineMatch = TASK_LINE_RE.exec(lineText)

    if (!taskLineMatch) {
      // A plain list item at a task's indent (or shallower) is that task's
      // sibling, so tasks nested under it belong to it, not to the earlier
      // task — drop the entries it closes. It is never a parent itself.
      if (LIST_ITEM_RE.test(lineText)) {
        indentStack = ancestorsOf(indentStack, getStructuralIndent(lineText))
      }
      continue
    }

    const statusChar = capturedGroup(taskLineMatch, 1)
    const resolvedStatus = statusForChar(statusChar, statusRegistry)

    // NON_TASK lines cannot parent tasks. Close tasks at the same or deeper
    // indent while retaining shallower task ancestors for the next task.
    // After this guard, resolvedStatus is narrowed to TaskStatus
    // (StatusClassification is TaskStatus | "non_task").
    if (resolvedStatus === "non_task") {
      indentStack = ancestorsOf(indentStack, getStructuralIndent(lineText))
      continue
    }

    // The block link sits at the end of the line — strip it before metadata
    // parsing, exactly as the plugin does.
    const bodyWithBlockLink = capturedGroup(taskLineMatch, 2).replace(LEADING_BODY_SPACES_RE, "")
    const { body: taskBody, blockId } = splitTrailingBlockLink(bodyWithBlockLink)

    const taskIndent = getStructuralIndent(lineText)
    const ancestors = ancestorsOf(indentStack, taskIndent)
    const parentEntry = ancestors.at(-1)
    const depth = ancestors.length
    const parentLine = parentEntry?.fileLine ?? null

    const fileLine = bodyStartLine + lineIndex + 1
    indentStack = [...ancestors, { indent: taskIndent, fileLine }]

    extractedTasks.push({
      line: fileLine,
      statusChar,
      status: resolvedStatus,
      blockId,
      heading: nearestHeading?.text ?? null,
      depth,
      parentLine,
      ...parseTaskMetadata(taskBody),
    })
  }
  return extractedTasks
}

/** Extracts the tasks in a whole note, skipping its properties block where
 *  splitPropertiesBlock ends it, so reported line numbers are the file's own. */
const extractTasks = (
  rawContent: string,
  statusRegistry?: ReadonlyMap<string, StatusClassification>,
): ParsedTask[] => {
  const { body } = splitPropertiesBlock(rawContent)

  return scanBodyLinesForTasks({
    bodyLines: splitIntoLines(body),
    bodyStartLine: findBodyStartLine(rawContent),
    statusRegistry,
  })
}

/** Extracts the tasks in text that is already a note's body, numbering lines
 *  from 1. It looks for no properties block, because `---` lines at the top
 *  of a body are rules, not a second block. */
const extractTasksFromBody = (
  bodyContent: string,
  statusRegistry?: ReadonlyMap<string, StatusClassification>,
): ParsedTask[] => {
  return scanBodyLinesForTasks({
    bodyLines: splitIntoLines(bodyContent),
    bodyStartLine: 0,
    statusRegistry,
  })
}

// ── Reverse mappings (status → char, priority → emoji) ─────────

const CHAR_FOR_STATUS: Readonly<Record<TaskStatus, string>> = {
  todo: " ",
  in_progress: "/",
  done: "x",
  cancelled: "-",
}

const EMOJI_FOR_PRIORITY: Readonly<Record<TaskPriority, string>> = {
  highest: "🔺",
  high: "⏫",
  medium: "🔼",
  low: "🔽",
  lowest: "⏬",
}

/** The checkbox character for a given status. When a registry is present,
 *  picks a char the registry maps to that classification — so the write
 *  path never emits a symbol the read path would classify differently. */
const charForStatus = (
  status: TaskStatus,
  statusRegistry?: ReadonlyMap<string, StatusClassification>,
): string => {
  if (statusRegistry) {
    for (const [char, classification] of statusRegistry) {
      if (classification === status) return char
    }
    // The registry has no char for this status. The hardcoded fallback is
    // safe only if the registry reads it back as the same status. A char the
    // registry does not list reads back as "todo", so such a fallback is safe
    // for "todo" alone.
    const fallback = CHAR_FOR_STATUS[status]
    const fallbackReadBack = statusRegistry.get(fallback) ?? "todo"

    if (fallbackReadBack !== status) {
      throw new Error(
        `no checkbox symbol for status "${status}" in the Tasks plugin registry (the default "${fallback}" is typed ${fallbackReadBack})`,
      )
    }
    return fallback
  }
  return CHAR_FOR_STATUS[status]
}

/** The emoji signifier for a given priority level. */
const emojiForPriority = (priority: TaskPriority): string => EMOJI_FOR_PRIORITY[priority]

// ── Inline field regexes (non-anchored, for mid-line replacement) ──
//
// Both emoji and Dataview inline-field formats are matched for stripping
// (users may have switched format mid-vault). Write format is determined
// by the TaskFormatConfig passed to each mutation function.

/** Builds a field regex that matches anywhere in the metadata tail, in either
 *  format: `<signifier> value` (emoji, optional VS16) or `[key:: value]` /
 *  `(key:: value)` (Dataview, optional trailing comma). `value` is regex
 *  source with no capture group. Unlike the parser, it also accepts unpaired
 *  brackets (`[due:: 2026-01-01)`); the metadata tail it searches holds only
 *  fields the parser read, so it holds none. */
const inlineFieldRegex = ({
  symbols,
  key,
  value,
}: {
  symbols: string
  key: string
  value: string
}): RegExp => {
  return new RegExp(`${symbols}\\uFE0F? *${value}|[[(] *${key}:: *${value} *[\\])](?: *,)?`, "u")
}

/** Matches a done date in either format: `✅ YYYY-MM-DD` (emoji) or
 *  `[completion:: YYYY-MM-DD]` / `(completion:: YYYY-MM-DD)` (Dataview). */
const DONE_DATE_INLINE_RE = inlineFieldRegex({
  symbols: "✅",
  key: "completion",
  value: DATE_PATTERN,
})

/** Matches a cancelled date in either format. */
const CANCELLED_DATE_INLINE_RE = inlineFieldRegex({
  symbols: "❌",
  key: "cancelled",
  value: DATE_PATTERN,
})

/** Matches a due date in either format (📅, 📆, 🗓 variants). */
const DUE_DATE_INLINE_RE = inlineFieldRegex({
  symbols: "(?:📅|📆|🗓)",
  key: "due",
  value: DATE_PATTERN,
})

/** Matches a scheduled date in either format (⏳, ⌛ variants). */
const SCHEDULED_DATE_INLINE_RE = inlineFieldRegex({
  symbols: "(?:⏳|⌛)",
  key: "scheduled",
  value: DATE_PATTERN,
})

/** Matches a start date in either format. */
const START_DATE_INLINE_RE = inlineFieldRegex({ symbols: "🛫", key: "start", value: DATE_PATTERN })

/** Matches a created date in either format. */
const CREATED_DATE_INLINE_RE = inlineFieldRegex({
  symbols: "➕",
  key: "created",
  value: DATE_PATTERN,
})

/** Matches a task ID in either format. */
const TASK_ID_INLINE_RE = inlineFieldRegex({ symbols: "🆔", key: "id", value: TASK_ID.source })

/** Matches a depends-on field in either format. The ID list allows spaces
 *  around each comma, as TASK_ID_SEQUENCE does, so a write replaces every ID
 *  the parser read. */
const DEPENDS_ON_INLINE_RE = inlineFieldRegex({
  symbols: "⛔",
  key: "dependsOn",
  value: `${TASK_ID.source}(?: *, *${TASK_ID.source})*`,
})

/** Matches a recurrence rule in either format: `🔁 rule text` (emoji) or
 *  `[repeat:: rule text]` / `(repeat:: rule text)` (Dataview). The value
 *  charset mirrors the parser's rule grammar, so the match ends where the
 *  next signifier begins. */
const RECURRENCE_INLINE_RE = inlineFieldRegex({
  symbols: "🔁",
  key: "repeat",
  value: "[a-zA-Z0-9, !]+",
})

/** Matches an onCompletion field in either format: `🏁 value` (emoji) or
 *  `[onCompletion:: value]` / `(onCompletion:: value)` (Dataview). */
const ON_COMPLETION_INLINE_RE = inlineFieldRegex({
  symbols: "🏁",
  key: "onCompletion",
  value: "[a-zA-Z]+",
})

/** Matches any priority signifier in either format: emoji (🔺⏫🔼🔽⏬)
 *  or Dataview (`[priority:: level]` / `(priority:: level)`). */
const PRIORITY_INLINE_RE =
  /[🔺⏫🔼🔽⏬]\uFE0F?|[[(] *priority:: *(?:highest|high|medium|low|lowest) *[\])](?: *,)?/u

/** Matches any opener a metadata-tail field starts with: an emoji signifier,
 *  or a Dataview bracket with its key and no space between them.
 *  findMetadataStart starts the tail only at a stripped field this matches at
 *  index 0. */
const FIRST_METADATA_SIGNIFIER_RE =
  /(?:➕|🛫|⏳|⌛|📅|📆|🗓|✅|❌|🔁|🏁|🆔|⛔|🔺|⏫|🔼|🔽|⏬)\uFE0F?|[[(](?:completion|cancelled|due|scheduled|start|created|priority|repeat|onCompletion|id|dependsOn)::/u

// ── Task-line mutation (pure string transforms) ─────────────────

/** Returns true when a line is a checkbox task line. */
const isTaskLine = (line: string): boolean => TASK_LINE_RE.test(line)

/** Replaces the checkbox character in a task line, e.g. `[/]` → `[x]`. It
 *  rewrites the first `[c]` on the line, which on a task line is always the
 *  checkbox, since no `[` can come before it. */
const replaceCheckboxChar = ({
  taskLine,
  newChar,
}: {
  taskLine: string
  newChar: string
}): string => taskLine.replace(/\[.\]/u, `[${newChar}]`)

/** Removes the LAST occurrence of a field regex from a metadata tail. Clearing
 *  a field removes every copy instead, with removeAllMetadataMatches.
 *  - The last, because description text ending in a parseable signifier
 *    lands at the front of the tail and the real field sits to its right
 *    (fields are appended after existing content), so a first-occurrence
 *    strip would delete the description text and keep the stale field.
 *  - After a removal the tail is trimmed, and every run of spaces in it
 *    collapses to one, not only the gap the removal left. With no match the
 *    tail comes back unchanged. */
const removeLastMetadataMatch = (metadata: string, regex: RegExp): string => {
  // A fresh global twin per call — the shared constants stay non-global so
  // .exec call sites never carry a lastIndex.
  const globalFlags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`
  const occurrences = [...metadata.matchAll(new RegExp(regex.source, globalFlags))]
  const lastOccurrence = occurrences.at(-1)

  if (!lastOccurrence) return metadata
  const beforeMatch = metadata.slice(0, lastOccurrence.index)
  const afterMatch = metadata.slice(lastOccurrence.index + lastOccurrence[0].length)
  return `${beforeMatch}${afterMatch}`.replace(/ {2,}/g, " ").trim()
}

type MetadataRemovalGrammar = Readonly<{
  regex: RegExp
  /** The emoji signifiers that open the field, as a plain string to search. */
  signifierCharacters: string
  key: string
  valueKind: "date" | "priority" | "id" | "dependencies" | "recurrence" | "action"
}>

/** Matches a lowercase priority-word character. */
const PRIORITY_CHARACTER_RE = /[a-z]/u
/** Matches an on-completion action character. */
const ACTION_CHARACTER_RE = /[a-zA-Z]/u
/** Matches a recurrence-rule character. */
const RECURRENCE_CHARACTER_RE = /[a-zA-Z0-9, !]/u
/** Matches one task-ID character, the class TASK_ID repeats. */
const TASK_ID_CHARACTER_RE = /[a-zA-Z0-9_-]/u
/** The length of a `YYYY-MM-DD` date value. */
const DATE_VALUE_LENGTH = "YYYY-MM-DD".length

/** How removeAllMetadataMatches reads each removable field. The INLINE regex
 *  decides what counts as the field; the signifiers, Dataview key and value
 *  kind only tell the walk where a candidate field ends. */
const METADATA_REMOVAL_GRAMMARS: ReadonlyArray<MetadataRemovalGrammar> = [
  {
    regex: DONE_DATE_INLINE_RE,
    signifierCharacters: "✅",
    key: "completion",
    valueKind: "date",
  },
  {
    regex: CANCELLED_DATE_INLINE_RE,
    signifierCharacters: "❌",
    key: "cancelled",
    valueKind: "date",
  },
  { regex: DUE_DATE_INLINE_RE, signifierCharacters: "📅📆🗓", key: "due", valueKind: "date" },
  {
    regex: SCHEDULED_DATE_INLINE_RE,
    signifierCharacters: "⏳⌛",
    key: "scheduled",
    valueKind: "date",
  },
  { regex: START_DATE_INLINE_RE, signifierCharacters: "🛫", key: "start", valueKind: "date" },
  { regex: CREATED_DATE_INLINE_RE, signifierCharacters: "➕", key: "created", valueKind: "date" },
  {
    regex: PRIORITY_INLINE_RE,
    signifierCharacters: "🔺⏫🔼🔽⏬",
    key: "priority",
    valueKind: "priority",
  },
  { regex: TASK_ID_INLINE_RE, signifierCharacters: "🆔", key: "id", valueKind: "id" },
  {
    regex: DEPENDS_ON_INLINE_RE,
    signifierCharacters: "⛔",
    key: "dependsOn",
    valueKind: "dependencies",
  },
  {
    regex: RECURRENCE_INLINE_RE,
    signifierCharacters: "🔁",
    key: "repeat",
    valueKind: "recurrence",
  },
  {
    regex: ON_COMPLETION_INLINE_RE,
    signifierCharacters: "🏁",
    key: "onCompletion",
    valueKind: "action",
  },
]

/** Removes every occurrence of one field from a metadata tail, with the same
 *  result as repeating removeLastMetadataMatch until nothing changes:
 *  - an occurrence that forms only once a removal joins the text around it
 *    goes too, so `📅20📅2026-01-0226-01-02` loses both dates;
 *  - after any removal, space runs collapse to one and the tail is trimmed;
 *  - with no match the tail comes back unchanged.
 *  `regex` must be one of METADATA_REMOVAL_GRAMMARS' regexes; it selects the
 *  grammar entry. */
const removeAllMetadataMatches = (metadata: string, regex: RegExp): string => {
  const grammar = METADATA_REMOVAL_GRAMMARS.find((entry) => entry.regex === regex)

  if (!grammar) throw new Error("unknown metadata removal grammar")
  /** The field regex, anchored to the start of a candidate. */
  const fieldAtStartRe = new RegExp(`^(?:${regex.source})`, regex.flags)
  // The walk goes right to left. keptCodePoints holds the surviving text to
  // the right of the walk, one code point per entry, in reverse: the last
  // entry is the leftmost character, so removing a field pops entries. For
  // the tail `⏫ 🆔ab` with the ID removed, the entries are `b`, `a`, `🆔`
  // once the walk reaches the 🆔; the ID is the last three, so they are
  // popped, and the trim then drops the space left of them.
  const keptCodePoints: string[] = []
  // Entries before keptStart are whitespace at the end of the text, dropped
  // by the trim that follows a removal.
  let keptStart = 0
  let removed = false
  /** The kept code point `offset` places right of the leftmost one, or "" past the end. */
  const keptCodePointAt = (offset: number): string => {
    const index = keptCodePoints.length - 1 - offset

    return index >= keptStart ? (keptCodePoints[index] ?? "") : ""
  }
  // Space runs collapse as the text is kept, so at most one space separates two characters.
  const skipSpace = (offset: number): number => offset + Number(keptCodePointAt(offset) === " ")
  /** The offset after the run of `characterPattern` characters that starts at `offset`. */
  const skipCharacters = (offset: number, characterPattern: RegExp): number => {
    let end = offset

    while (end < keptCodePoints.length - keptStart && characterPattern.test(keptCodePointAt(end))) {
      end += 1
    }
    return end
  }
  /** The offset after a field value that starts at `offset`. A date is taken
   *  as its ten characters unchecked; fieldAtStartRe checks it. */
  const fieldValueEnd = (offset: number): number => {
    switch (grammar.valueKind) {
      case "date":
        return offset + DATE_VALUE_LENGTH
      case "priority":
        return skipCharacters(offset, PRIORITY_CHARACTER_RE)
      case "id":
        return skipCharacters(offset, TASK_ID_CHARACTER_RE)
      case "action":
        return skipCharacters(offset, ACTION_CHARACTER_RE)
      case "recurrence":
        return skipCharacters(offset, RECURRENCE_CHARACTER_RE)
      case "dependencies": {
        let end = skipCharacters(offset, TASK_ID_CHARACTER_RE)
        let comma = skipSpace(end)

        while (keptCodePointAt(comma) === ",") {
          const nextStart = skipSpace(comma + 1)
          const nextEnd = skipCharacters(nextStart, TASK_ID_CHARACTER_RE)

          if (nextEnd === nextStart) break
          end = nextEnd
          comma = skipSpace(end)
        }
        return end
      }
    }
  }
  /** The number of code points in the field that starts at the leftmost kept
   *  code point, `character`, or 0 when none starts there:
   *  1. Walk the grammar entry rightward to find where a candidate field
   *     would end. The walk accepts any ten characters as a date and any
   *     lowercase word as a priority level.
   *  2. Run fieldAtStartRe over that candidate alone; it decides whether the
   *     candidate is a field, and how long it is. */
  const fieldLengthAt = (character: string): number => {
    const bracketed = character === "[" || character === "("

    if (!bracketed && !grammar.signifierCharacters.includes(character)) return 0
    let offset = 1

    if (bracketed) {
      offset = skipSpace(offset)
      for (const keyCharacter of `${grammar.key}::`) {
        if (keptCodePointAt(offset) !== keyCharacter) return 0
        offset += 1
      }
    } else if (keptCodePointAt(offset) === "\uFE0F") {
      offset += 1
    }
    // An emoji priority has no value: the signifier is the level.
    if (bracketed || grammar.valueKind !== "priority") {
      offset = fieldValueEnd(skipSpace(offset))
    }
    if (bracketed) {
      offset = skipSpace(offset)
      if (keptCodePointAt(offset) !== "]" && keptCodePointAt(offset) !== ")") return 0
      offset += 1
      const comma = skipSpace(offset)

      if (keptCodePointAt(comma) === ",") offset = comma + 1
    }
    if (offset > keptCodePoints.length - keptStart) return 0
    const candidate = keptCodePoints
      .slice(keptCodePoints.length - offset)
      .toReversed()
      .join("")
    const match = fieldAtStartRe.exec(candidate)

    return match?.[0].length ? Array.from(match[0]).length : 0
  }

  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    // Read one code point leftward: a low surrogate with a high surrogate
    // before it is one character.
    const codeUnit = metadata.charCodeAt(index)
    const precedingCodeUnit = metadata.charCodeAt(index - 1)
    const hasSurrogatePair =
      codeUnit >= 0xdc00 &&
      codeUnit <= 0xdfff &&
      precedingCodeUnit >= 0xd800 &&
      precedingCodeUnit <= 0xdbff
    const character = metadata.slice(index - Number(hasSurrogatePair), index + 1)

    index -= Number(hasSurrogatePair)
    // A space next to a kept space is dropped: space runs collapse to one.
    if (character === " " && keptCodePointAt(0) === " ") continue
    // After a removal, whitespace with no kept text to its right is trimmed away.
    if (removed && keptCodePoints.length === keptStart && character.trim() === "") continue

    // A removal can bring a lone high surrogate next to a lone low surrogate,
    // and the two then form one emoji: in `\uD83D⏫\uDD3A`, removing the ⏫
    // forms 🔺. The pair is kept as one character.
    const isLoneHighSurrogate = character.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdbff
    const nextCharacter = keptCodePointAt(0)
    const nextCodeUnit = nextCharacter.charCodeAt(0)
    const formsSurrogatePair =
      isLoneHighSurrogate && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
    const fieldCharacter = formsSurrogatePair ? character + nextCharacter : character

    if (formsSurrogatePair) keptCodePoints.pop()
    keptCodePoints.push(fieldCharacter)
    const fieldLength = fieldLengthAt(fieldCharacter)

    if (!fieldLength) continue
    keptCodePoints.length -= fieldLength
    removed = true
    // Trim the end of the kept text, as each removal's trim does.
    while (keptStart < keptCodePoints.length && keptCodePoints[keptStart]?.trim() === "") {
      keptStart += 1
    }
  }
  return removed ? keptCodePoints.slice(keptStart).toReversed().join("").trim() : metadata
}

// Re-export config types so consumers of tasks.ts don't need a
// separate import from the vault-operations layer.
export type { StatusClassification, TaskFormatConfig }

/** Formats a done date in the configured format. */
const formatDoneDate = (today: string, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[completion:: ${today}]` : `✅ ${today}`

/** Formats a cancelled date in the configured format. */
const formatCancelledDate = (today: string, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[cancelled:: ${today}]` : `❌ ${today}`

/** Formats a priority in the configured format. */
const formatPriority = (priority: TaskPriority, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[priority:: ${priority}]` : emojiForPriority(priority)

/** Formats a task ID (🆔) in the configured format. */
const formatTaskId = (taskId: string, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[id:: ${taskId}]` : `🆔 ${taskId}`

/** Formats a recurrence rule (🔁) in the configured format. */
const formatRecurrence = (recurrenceText: string, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[repeat:: ${recurrenceText}]` : `🔁 ${recurrenceText}`

/** Formats an onCompletion value (🏁) in the configured format. */
const formatOnCompletion = (value: string, format: "emoji" | "dataview"): string => {
  return format === "dataview" ? `[onCompletion:: ${value}]` : `🏁 ${value}`
}

/** Formats a depends-on list (⛔) in the configured format. */
const formatDependsOn = (dependsOn: readonly string[], format: "emoji" | "dataview"): string => {
  const idList = dependsOn.join(",")
  return format === "dataview" ? `[dependsOn:: ${idList}]` : `⛔ ${idList}`
}

// ── Date field keys and their format/strip data ──────────────────
//
// Each settable date field has an emoji signifier, a Dataview key, and a
// non-anchored inline regex for stripping. DATE_FIELDS_IN_LINE_ORDER lists
// the dates in the order buildTaskLine writes them (created → start →
// scheduled → due), then done and cancelled; updateTaskLineDate reads that
// order to find where a date goes.

type DateFieldKey = "created" | "start" | "scheduled" | "due" | "done" | "cancelled"

/** The write side of the date fields, in line order. DATE_FIELD_PARSERS holds
 *  the read side: its `$`-anchored regexes, in the plugin's extraction order. */
const DATE_FIELDS_IN_LINE_ORDER: ReadonlyArray<{
  key: DateFieldKey
  emoji: string
  dataviewKey: string
  inlineRegex: RegExp
}> = [
  {
    key: "created",
    emoji: "➕",
    dataviewKey: "created",
    inlineRegex: CREATED_DATE_INLINE_RE,
  },
  {
    key: "start",
    emoji: "🛫",
    dataviewKey: "start",
    inlineRegex: START_DATE_INLINE_RE,
  },
  {
    key: "scheduled",
    emoji: "⏳",
    dataviewKey: "scheduled",
    inlineRegex: SCHEDULED_DATE_INLINE_RE,
  },
  {
    key: "due",
    emoji: "📅",
    dataviewKey: "due",
    inlineRegex: DUE_DATE_INLINE_RE,
  },
  {
    key: "done",
    emoji: "✅",
    dataviewKey: "completion",
    inlineRegex: DONE_DATE_INLINE_RE,
  },
  {
    key: "cancelled",
    emoji: "❌",
    dataviewKey: "cancelled",
    inlineRegex: CANCELLED_DATE_INLINE_RE,
  },
]

/** Formats a date field in the configured format. */
const formatDateField = ({
  field,
  date,
  format,
}: {
  field: DateFieldKey
  date: string
  format: "emoji" | "dataview"
}): string => {
  const info = DATE_FIELDS_IN_LINE_ORDER.find((entry) => entry.key === field)

  if (!info) throw new Error(`unknown date field: ${field}`)
  return format === "dataview" ? `[${info.dataviewKey}:: ${date}]` : `${info.emoji} ${date}`
}

/** Sets or clears a date field on a task line. Strips existing values in
 *  both formats and inserts the new value where buildTaskLine writes that
 *  field. A null date clears the field. */
const updateTaskLineDate = (params: {
  taskLine: string
  field: DateFieldKey
  date: string | null
  config: TaskFormatConfig
}): string => {
  const fieldIndex = DATE_FIELDS_IN_LINE_ORDER.findIndex((entry) => entry.key === params.field)
  const fieldInfo = DATE_FIELDS_IN_LINE_ORDER[fieldIndex]

  if (!fieldInfo) throw new Error(`unknown date field: ${params.field}`)

  // Later fields in the written order: the remaining dates, then task_id
  // and depends_on — a new date is inserted ahead of the first one present
  // so the line keeps the order buildTaskLine writes.
  const laterFieldRegexes = [
    ...DATE_FIELDS_IN_LINE_ORDER.slice(fieldIndex + 1).map((entry) => entry.inlineRegex),
    TASK_ID_INLINE_RE,
    DEPENDS_ON_INLINE_RE,
  ]

  return transformMetadata(params.taskLine, (metadata) => {
    // Clearing removes every copy, so no stale date survives.
    if (params.date === null) {
      return removeAllMetadataMatches(metadata, fieldInfo.inlineRegex)
    }
    // Setting removes only the last copy. A field-like signifier in the
    // description sits at the front and must survive as prose.
    const metadataWithoutDate = removeLastMetadataMatch(metadata, fieldInfo.inlineRegex)
    const dateText = formatDateField({
      field: params.field,
      date: params.date,
      format: params.config.taskFormat,
    })
    return insertFieldAtPosition({
      metadata: metadataWithoutDate,
      fieldText: dateText,
      laterFieldRegexes,
    })
  })
}

/** Sets or clears the Tasks-plugin `🆔` / `[id:: ]` field on a task line.
 *  A new id goes ahead of an existing depends_on, matching the create order. */
const updateTaskLineTaskId = ({
  taskLine,
  taskId,
  config,
}: {
  taskLine: string
  taskId: string | null
  config: TaskFormatConfig
}): string => {
  return transformMetadata(taskLine, (metadata) => {
    if (taskId === null) return removeAllMetadataMatches(metadata, TASK_ID_INLINE_RE)
    const metadataWithoutTaskId = removeLastMetadataMatch(metadata, TASK_ID_INLINE_RE)
    return insertFieldAtPosition({
      metadata: metadataWithoutTaskId,
      fieldText: formatTaskId(taskId, config.taskFormat),
      laterFieldRegexes: [DEPENDS_ON_INLINE_RE],
    })
  })
}

/** Sets or clears the 🔁 / `[repeat:: ]` recurrence rule on a task line.
 *  A new rule is inserted after the priority and before the dates, where
 *  buildTaskLine writes it. The rule text is written verbatim; callers
 *  validate it parses before writing. */
const updateTaskLineRecurrence = ({
  taskLine,
  recurrenceText,
  config,
}: {
  taskLine: string
  recurrenceText: string | null
  config: TaskFormatConfig
}): string => {
  return transformMetadata(taskLine, (metadata) => {
    if (recurrenceText === null) {
      return removeAllMetadataMatches(metadata, RECURRENCE_INLINE_RE)
    }
    const metadataWithoutRecurrence = removeLastMetadataMatch(metadata, RECURRENCE_INLINE_RE)
    return insertFieldAtPosition({
      metadata: metadataWithoutRecurrence,
      fieldText: formatRecurrence(recurrenceText, config.taskFormat),
      laterFieldRegexes: [
        ON_COMPLETION_INLINE_RE,
        ...DATE_FIELDS_IN_LINE_ORDER.map((dateField) => dateField.inlineRegex),
        TASK_ID_INLINE_RE,
        DEPENDS_ON_INLINE_RE,
      ],
    })
  })
}

/** Sets or clears 🏁 / `[onCompletion:: ]`, replacing every duplicate action.
 *  New actions follow recurrence and precede dates, where buildTaskLine writes them. */
const updateTaskLineOnCompletion = ({
  taskLine,
  onCompletion,
  config,
}: {
  taskLine: string
  onCompletion: string | null
  config: TaskFormatConfig
}): string => {
  return transformMetadata(taskLine, (metadata) => {
    // Parsing keeps the leftmost action; a surviving copy could still make completion delete the task.
    const metadataWithoutOnCompletion = removeAllMetadataMatches(metadata, ON_COMPLETION_INLINE_RE)

    if (onCompletion === null) {
      return metadataWithoutOnCompletion
    }
    return insertFieldAtPosition({
      metadata: metadataWithoutOnCompletion,
      fieldText: formatOnCompletion(onCompletion, config.taskFormat),
      laterFieldRegexes: [
        ...DATE_FIELDS_IN_LINE_ORDER.map((dateField) => dateField.inlineRegex),
        TASK_ID_INLINE_RE,
        DEPENDS_ON_INLINE_RE,
      ],
    })
  })
}

/** Sets or clears the Tasks-plugin `⛔` / `[dependsOn:: ]` field. */
const updateTaskLineDependsOn = ({
  taskLine,
  dependsOn,
  config,
}: {
  taskLine: string
  dependsOn: readonly string[] | null
  config: TaskFormatConfig
}): string => {
  return transformMetadata(taskLine, (metadata) => {
    if (dependsOn === null || dependsOn.length === 0) {
      return removeAllMetadataMatches(metadata, DEPENDS_ON_INLINE_RE)
    }
    const metadataWithoutDependsOn = removeLastMetadataMatch(metadata, DEPENDS_ON_INLINE_RE)
    // Depends-on is the last field buildTaskLine writes, so its place is the end.
    return appendMetadataField({
      metadata: metadataWithoutDependsOn,
      fieldText: formatDependsOn(dependsOn, config.taskFormat),
    })
  })
}

/** The index where a task body's metadata tail starts, or -1 when it has none.
 *  The tail starts at the leftmost signifier (a FIRST_METADATA_SIGNIFIER_RE
 *  match) from which the rest of the body parses as fields and hashtags only.
 *  - It runs the plugin's stripping loop once, within its pass limit
 *    (MAX_STRIPPING_PASSES), and keeps the leftmost stripped field that
 *    starts with a signifier.
 *  - A hashtag is the one field whose text can hold a signifier
 *    (`#trip📅2026-01-01`), since every other field's value allows only
 *    letters, digits and a little punctuation. A parse that starts inside a
 *    tag can therefore start the tail there, so each stripped tag's text is
 *    walked too. In `Do #x🆔abc` the loop strips `#x🆔abc` whole, as a tag,
 *    so no stripped field starts with a signifier; walked from after its `#`,
 *    the tag's text loses `🆔abc` to the ID matcher, so the tail is `🆔abc`. */
const findMetadataStart = (taskBody: string): number => {
  /** The leftmost signifier-led field the stripping loop removes from
   *  `text`, as an index into the task body (`offset` is where `text` starts
   *  there), or Infinity. The loop starts partway through a pass: at pass
   *  `resumePass`, matcher `resumeMatcher`, with `passAlreadyMatched` saying
   *  whether that pass has stripped a field already. */
  const findEarliestFieldStart = ({
    text,
    offset,
    resumePass,
    resumeMatcher,
    passAlreadyMatched,
  }: {
    text: string
    offset: number
    resumePass: number
    resumeMatcher: number
    passAlreadyMatched: boolean
  }): number => {
    // Suffix removal and the earliest consumed signifier are sequential parser
    // state. Unlike parseTaskMetadata, the walk trims only the end, so match
    // indices stay offsets into `text`; every matcher is anchored at the end,
    // so leading spaces never decide whether a field matches.
    let line = text.trimEnd()
    let earliestStart = Infinity

    for (let pass = resumePass; pass < MAX_STRIPPING_PASSES; pass++) {
      let matchedThisPass = pass === resumePass && passAlreadyMatched
      const matcherStart = pass === resumePass ? resumeMatcher : 0

      for (
        let matcherIndex = matcherStart;
        matcherIndex < METADATA_MATCHERS.length;
        matcherIndex++
      ) {
        const matcher = METADATA_MATCHERS[matcherIndex]
        const match = matcher?.exec(line)

        if (!match) continue
        const matchedText = capturedGroup(match, 0)

        if (matcher === HASHTAG_FROM_END_RE) {
          // A parse that starts inside this tag strips the same fields to its
          // right up to this point, then reads the tag's text after the '#'
          // as plain text, so the loop resumes there at the next matcher.
          const tagTextStart = match.index + matchedText.indexOf("#") + 1
          const innerStart = findEarliestFieldStart({
            text: line.slice(tagTextStart),
            offset: offset + tagTextStart,
            resumePass: pass,
            resumeMatcher: matcherIndex + 1,
            passAlreadyMatched: matchedThisPass,
          })
          earliestStart = Math.min(earliestStart, innerStart)
        } else if (FIRST_METADATA_SIGNIFIER_RE.exec(matchedText)?.index === 0) {
          // A Dataview field with a space after its bracket (`[ due:: …]`)
          // parses as a field, but FIRST_METADATA_SIGNIFIER_RE does not match
          // it, so it cannot start the tail.
          earliestStart = Math.min(earliestStart, offset + match.index)
        }
        matchedThisPass = true
        line = line.slice(0, match.index).trimEnd()
      }
      if (!matchedThisPass) break
    }
    return earliestStart
  }
  const earliestStart = findEarliestFieldStart({
    text: taskBody,
    offset: 0,
    resumePass: 0,
    resumeMatcher: 0,
    passAlreadyMatched: false,
  })

  return Number.isFinite(earliestStart) ? earliestStart : -1
}

type TaskLineParts = {
  /** Indentation, list marker, and checkbox, e.g. `  - [ ] `. */
  prefix: string
  description: string
  /** Metadata fields from the first real signifier on; "" when none. */
  metadata: string
  /** Trailing block link including its leading space; "" when none. */
  blockLink: string
  /** Trailing whitespace after the block link (or after metadata when no
   *  block link is present) — a markdown hard break. "" when none. */
  trailingWhitespace: string
}

/** Same prefix grammar as TASK_LINE_RE, captured up to and including the
 *  checkbox — the two must stay in sync on what counts as the prefix. The
 *  spaces or tabs after the checkbox are captured too, so an edit keeps them. */
const TASK_PREFIX_RE = /^([\s>]*(?:[-*+]|[0-9]+[.)]) +\[.\][ \t]*)/u

/** Matches line terminators excluded by TASK_LINE_RE's body capture. */
const TASK_BODY_LINE_BREAK_RE = /[\r\n\u2028\u2029]/u

/** Splits a task line at the parser's description/metadata boundary.
 *  Returns null when the line is not a task line. */
const splitTaskLine = (taskLine: string): TaskLineParts | null => {
  const checkboxMatch = TASK_PREFIX_RE.exec(taskLine)
  const prefix = checkboxMatch?.[1]

  if (!prefix) return null
  // Split from the checkbox's closing bracket, not the spaces after it, so the
  // spaces after an empty checkbox still separate a block link or end the
  // line: in `- [ ] ^id`, the text after the bracket is ` ^id`, which
  // BLOCK_LINK_RE reads as a block link, while `^id` alone is plain text.
  const checkboxEnd = prefix.trimEnd().length
  const afterCheckbox = taskLine.slice(checkboxEnd)

  // The parser's task-line regex stops at a line break, so text holding one
  // is not a task line to it.
  if (TASK_BODY_LINE_BREAK_RE.test(afterCheckbox)) return null

  // Capture trailing whitespace before splitTrailingBlockLink trims it —
  // a markdown hard break (two+ trailing spaces) must survive the round-trip.
  const trimmedAfterCheckbox = afterCheckbox.trimEnd()
  const trailingWhitespace = afterCheckbox.slice(trimmedAfterCheckbox.length)
  const { body: taskBody, blockLink } = splitTrailingBlockLink(trimmedAfterCheckbox)
  const metadataStart = findMetadataStart(taskBody)

  // A task with text keeps its spacing after the checkbox, even none: in
  // `- [ ]^id`, adding a space would turn the `^id` text into a block link.
  // An empty task gets the one space the Tasks plugin writes before new text.
  const linePrefix = taskBody.trim() ? prefix : `${taskLine.slice(0, checkboxEnd)} `

  if (metadataStart === -1) {
    return {
      prefix: linePrefix,
      description: taskBody.trim(),
      metadata: "",
      blockLink,
      trailingWhitespace,
    }
  }
  return {
    prefix: linePrefix,
    description: taskBody.slice(0, metadataStart).trim(),
    metadata: taskBody.slice(metadataStart).trim(),
    blockLink,
    trailingWhitespace,
  }
}

const joinTaskLine = ({
  prefix,
  description,
  metadata,
  blockLink,
  trailingWhitespace,
}: TaskLineParts): string => {
  const body = [description.trim(), metadata.trim()].filter(Boolean).join(" ")

  // A line left with no text drops the spaces after its checkbox, so they
  // cannot turn into a hard break on the next edit.
  const linePrefix = body ? prefix : prefix.trimEnd()
  return `${linePrefix}${body}${blockLink}${trailingWhitespace}`
}

/** Applies a field mutation to the metadata tail only — field-like text
 *  inside the description ("Trip on 📅 2026-09-15, then relax") is prose to
 *  the parser and must never be matched by a strip or replace. Returns the
 *  line unchanged when it is not a task line. */
const transformMetadata = (taskLine: string, transform: (metadata: string) => string): string => {
  const parts = splitTaskLine(taskLine)

  if (!parts) return taskLine
  return joinTaskLine({ ...parts, metadata: transform(parts.metadata) })
}

/** Appends a field to the end of a metadata tail. */
const appendMetadataField = ({
  metadata,
  fieldText,
}: {
  metadata: string
  fieldText: string
}): string => [metadata, fieldText].filter(Boolean).join(" ")

/** Inserts the field before the first of `laterFieldRegexes`, in list order
 *  rather than line order, that matches the tail, or appends it when none
 *  matches. Existing fields keep their order, even when it differs from the
 *  list's. */
const insertFieldAtPosition = ({
  metadata,
  fieldText,
  laterFieldRegexes,
}: {
  metadata: string
  fieldText: string
  laterFieldRegexes: readonly RegExp[]
}): string => {
  for (const laterFieldRegex of laterFieldRegexes) {
    const laterMatch = laterFieldRegex.exec(metadata)

    if (laterMatch) {
      return `${metadata.slice(0, laterMatch.index)}${fieldText} ${metadata.slice(laterMatch.index)}`
    }
  }
  return appendMetadataField({ metadata, fieldText })
}

/** The metadata the parser reads back from one task line (checkbox prefix
 *  and block link removed), or null when the line is not a task line. */
const parseTaskLineMetadata = (taskLine: string): TaskMetadata | null => {
  const taskLineMatch = TASK_LINE_RE.exec(taskLine)

  if (!taskLineMatch) return null
  const bodyWithBlockLink = capturedGroup(taskLineMatch, 2).replace(LEADING_BODY_SPACES_RE, "")
  const { body: taskBody } = splitTrailingBlockLink(bodyWithBlockLink)
  return parseTaskMetadata(taskBody)
}

/** The description the parser sees for a task line — metadata stripped
 *  from the right, interleaved tags re-appended, block link removed. */
const describeTaskLine = (taskLine: string): string => {
  return parseTaskLineMetadata(taskLine)?.description ?? taskLine
}

// ── Round-trip divergence detection ─────────────────────────────

/** The values a mutation call submitted for one task line — the expectation
 *  each field should parse back to. An absent key means the call did not set
 *  the field; an explicit null means the field was cleared (expect absent).
 *  Machine-stamped effects (the created date on create, the done/cancelled
 *  dates a status change writes or strips) belong here too, so stamps never
 *  register as fields appearing from nowhere. */
export type SubmittedTaskFields = Readonly<{
  description?: string | undefined
  priority?: TaskPriority | null | undefined
  createdDate?: string | null | undefined
  startDate?: string | null | undefined
  scheduledDate?: string | null | undefined
  dueDate?: string | null | undefined
  doneDate?: string | null | undefined
  cancelledDate?: string | null | undefined
  taskId?: string | null | undefined
  dependsOn?: readonly string[] | null | undefined
  recurrence?: string | null | undefined
  onCompletion?: string | null | undefined
}>

/** One field whose parse-back value differs from what the call's inputs say
 *  it should be. Values are display strings; null means absent/empty. */
export type TaskRoundTripDivergence = Readonly<{
  field: string
  expected: string | null
  /** Where the expectation came from: a value submitted this call, the
   *  pre-mutation line's parse, or nothing (the field should be absent). */
  expectedSource: "submitted" | "prior" | "none"
  storedValue: string | null
  /** The submitted description tail that parsed as metadata instead of
   *  staying description text. Only a description divergence carries it. */
  consumedTail?: string | undefined
}>

/** The round-trip diff's reading of one written line: the full metadata
 *  parse, plus `rawDescription`, the text before the metadata boundary
 *  (without the #tags the parser re-appends from the tail). See
 *  descriptionDivergences for when each representation is compared. */
type RoundTripLineReading = {
  metadata: TaskMetadata
  rawDescription: string | null
}

const readTaskLineForRoundTrip = (taskLine: string): RoundTripLineReading | null => {
  const metadata = parseTaskLineMetadata(taskLine)
  const parts = splitTaskLine(taskLine)

  if (!metadata || !parts) return null
  return {
    metadata,
    rawDescription: parts.description === "" ? null : parts.description,
  }
}

/** One field's participation in the round-trip diff. An undefined return
 *  from readSubmitted means the call did not set the field; a field with no
 *  readSubmitted can never be set by a call, so its expectation always
 *  comes from the prior parse. */
type RoundTripFieldReading = {
  field: string
  readParsed: (reading: RoundTripLineReading) => string | null
  readSubmitted?: (submitted: SubmittedTaskFields) => string | null | undefined
}

const ROUND_TRIP_FIELDS: readonly RoundTripFieldReading[] = [
  {
    field: "priority",
    readParsed: (reading) => reading.metadata.priority,
    readSubmitted: (submitted) => submitted.priority,
  },
  {
    field: "created",
    readParsed: (reading) => reading.metadata.createdDate,
    readSubmitted: (submitted) => submitted.createdDate,
  },
  {
    field: "start",
    readParsed: (reading) => reading.metadata.startDate,
    readSubmitted: (submitted) => submitted.startDate,
  },
  {
    field: "scheduled",
    readParsed: (reading) => reading.metadata.scheduledDate,
    readSubmitted: (submitted) => submitted.scheduledDate,
  },
  {
    field: "due",
    readParsed: (reading) => reading.metadata.dueDate,
    readSubmitted: (submitted) => submitted.dueDate,
  },
  {
    field: "done",
    readParsed: (reading) => reading.metadata.doneDate,
    readSubmitted: (submitted) => submitted.doneDate,
  },
  {
    field: "cancelled",
    readParsed: (reading) => reading.metadata.cancelledDate,
    readSubmitted: (submitted) => submitted.cancelledDate,
  },
  {
    field: "task_id",
    readParsed: (reading) => reading.metadata.taskId,
    readSubmitted: (submitted) => submitted.taskId,
  },
  {
    field: "depends_on",
    readParsed: (reading) => {
      return reading.metadata.dependsOn.length === 0 ? null : reading.metadata.dependsOn.join(",")
    },
    readSubmitted: (submitted) => {
      if (submitted.dependsOn === undefined) return undefined
      if (submitted.dependsOn === null || submitted.dependsOn.length === 0) {
        return null
      }
      return submitted.dependsOn.join(",")
    },
  },
  {
    field: "recurrence",
    readParsed: (reading) => reading.metadata.recurrence,
    readSubmitted: (submitted) => submitted.recurrence,
  },
  {
    field: "on_completion",
    readParsed: (reading) => reading.metadata.onCompletion,
    readSubmitted: (submitted) => submitted.onCompletion,
  },
]

/** The expected parse-back value for one field: the submitted value when the
 *  call set the field, else the prior line's parsed value, else absent. */
const expectedRoundTripValue = ({
  submittedValue,
  priorValue,
}: {
  submittedValue: string | null | undefined
  priorValue: string | null
}): Pick<TaskRoundTripDivergence, "expected" | "expectedSource"> => {
  if (submittedValue !== undefined) {
    return { expected: submittedValue, expectedSource: "submitted" }
  }
  if (priorValue !== null) {
    return { expected: priorValue, expectedSource: "prior" }
  }
  return { expected: null, expectedSource: "none" }
}

/** The trailing part of a submitted description that the parser consumed
 *  as metadata. Defined when the stored description matches the start of
 *  the submitted one but is shorter (the parser only ever strips from
 *  the right). */
const consumedDescriptionTail = ({
  submittedDescription,
  storedDescription,
}: {
  submittedDescription: string | null
  storedDescription: string | null
}): string | undefined => {
  if (submittedDescription === null) return undefined
  if (storedDescription === null) return submittedDescription
  if (!submittedDescription.startsWith(storedDescription)) return undefined
  const tail = submittedDescription.slice(storedDescription.length).trim()
  return tail === "" ? undefined : tail
}

/** Description divergence compares one of two representations, depending
 *  on whether the call submitted a description:
 *  - Submitted this call: the trimmed submitted text may match either the
 *    raw description or the parser's description with tags re-appended.
 *  - Not submitted: the prior parser description against the new one. Both
 *    sides carry re-appended tags alike, so a trailing tag that moves into
 *    the raw description when the last metadata field is cleared reads as
 *    no change.
 *  Example, for the line `- [ ] Buy groceries 📅 2026-09-15 #errand`: the
 *  raw description is "Buy groceries"; the parser's is "Buy groceries #errand". */
const descriptionDivergences = ({
  afterReading,
  priorReading,
  submitted,
}: {
  afterReading: RoundTripLineReading
  priorReading: RoundTripLineReading | null
  submitted: SubmittedTaskFields
}): TaskRoundTripDivergence[] => {
  const submittedDescription = submitted.description?.trim()
  const storedDescription =
    afterReading.metadata.description === "" ? null : afterReading.metadata.description

  if (submittedDescription !== undefined) {
    if (afterReading.rawDescription === submittedDescription) return []
    if (storedDescription === submittedDescription) return []
    const consumedTail = consumedDescriptionTail({ submittedDescription, storedDescription })
    return [
      {
        field: "description",
        expected: submittedDescription,
        expectedSource: "submitted",
        storedValue: storedDescription,
        ...(consumedTail && { consumedTail }),
      },
    ]
  }

  const priorDescription =
    priorReading && priorReading.metadata.description !== ""
      ? priorReading.metadata.description
      : null

  if (storedDescription === priorDescription) return []
  return [
    {
      field: "description",
      expected: priorDescription,
      expectedSource: priorDescription === null ? "none" : "prior",
      storedValue: storedDescription,
    },
  ]
}

/** Diffs a written task line against what the call's inputs say it should
 *  parse back to. Every divergence is a place where description prose and
 *  the plugin's end-anchored field grammar interfered: a truncated
 *  description, a submitted field whose value did not survive, or a field
 *  materializing that nothing set. Returns [] for a clean round-trip or a
 *  non-task line. */
const diffTaskRoundTrip = ({
  taskLine,
  priorTaskLine,
  submitted,
}: {
  taskLine: string
  priorTaskLine: string | null
  submitted: SubmittedTaskFields
}): TaskRoundTripDivergence[] => {
  const afterReading = readTaskLineForRoundTrip(taskLine)

  if (!afterReading) return []
  const priorReading = priorTaskLine === null ? null : readTaskLineForRoundTrip(priorTaskLine)

  const fieldDivergences = ROUND_TRIP_FIELDS.flatMap((fieldReading) => {
    const submittedValue = fieldReading.readSubmitted?.(submitted)
    const priorValue = priorReading ? fieldReading.readParsed(priorReading) : null
    const expectation = expectedRoundTripValue({ submittedValue, priorValue })
    const storedValue = fieldReading.readParsed(afterReading)

    if (storedValue === expectation.expected) return []
    return [{ field: fieldReading.field, ...expectation, storedValue }]
  })

  return [...descriptionDivergences({ afterReading, priorReading, submitted }), ...fieldDivergences]
}

/** Replaces the description text on a task line — everything before the
 *  metadata tail. Metadata fields, block_id, and indentation are preserved. */
const replaceTaskLineDescription = ({
  taskLine,
  newDescription,
}: {
  taskLine: string
  newDescription: string
}): string => {
  const parts = splitTaskLine(taskLine)

  if (!parts) return taskLine
  return joinTaskLine({ ...parts, description: newDescription })
}

/** Matches one character allowed after '#' in the plugin's hashtag grammar. */
const HASHTAG_CHARACTER_RE = new RegExp(HASHTAG_CHARACTER_CLASS, "u")
/** Matches the whitespace that may precede a hashtag's '#', the `\s` in HASHTAG_RE. */
const TAG_WHITESPACE_RE = /\s/u

/** The hashtags at the end of `text`, in line order: the tags that stripping
 *  HASHTAG_FROM_END_RE again and again would remove, up to the first text
 *  that is not a tag. */
const extractTrailingTags = (text: string): readonly string[] => {
  const tags: string[] = []
  // The end of the tag being read; it moves left past each tag found.
  let end = text.length

  while (end > 0) {
    let start = end - 1

    while (start >= 0 && HASHTAG_CHARACTER_RE.test(text.charAt(start))) start -= 1
    const hasTagValue = start < end - 1
    const hasTagBoundary = start === 0 || TAG_WHITESPACE_RE.test(text.charAt(start - 1))

    if (text[start] !== "#" || !hasTagValue || !hasTagBoundary) break
    tags.push(text.slice(start, end).trim())
    end = start
    while (end > 0 && TAG_WHITESPACE_RE.test(text.charAt(end - 1))) end -= 1
  }
  return tags.toReversed()
}

/** Strips tags from the metadata tail that byte-match trailing tags in the
 *  description — the round-trip duplication that occurs when an agent writes
 *  back the parser's re-appended view of interleaved tags. Returns the
 *  cleaned line and the tags that were removed. */
const deduplicateDescriptionTags = (
  taskLine: string,
): { taskLine: string; deduplicatedTags: readonly string[] } => {
  const parts = splitTaskLine(taskLine)

  if (!parts || !parts.metadata) {
    return { taskLine, deduplicatedTags: [] }
  }

  const descriptionTrailingTags = extractTrailingTags(parts.description)

  if (descriptionTrailingTags.length === 0) {
    return { taskLine, deduplicatedTags: [] }
  }

  /** The places a tag can start in `metadata`: each '#' that opens it or
   *  follows whitespace. The tail parsed as metadata, so it holds at most
   *  MAX_STRIPPING_PASSES of them: each pass strips one hashtag at most, and
   *  no other field's value contains a '#'. Finding them again after each
   *  removal therefore stays cheap. */
  const tagPositionsIn = (metadata: string): readonly number[] => {
    const positions: number[] = []

    for (let index = 0; index < metadata.length; index++) {
      if (
        metadata[index] === "#" &&
        (index === 0 || TAG_WHITESPACE_RE.test(metadata.charAt(index - 1)))
      ) {
        positions.push(index)
      }
    }
    return positions
  }

  // Each description tag is compared at the tag positions alone. A removal
  // shifts the text after it, so the positions are found again.
  let dedupedMetadata = parts.metadata
  let tagPositions = tagPositionsIn(dedupedMetadata)
  const deduplicatedTags: string[] = []
  for (const tag of descriptionTrailingTags) {
    const tagStart = tagPositions.find((position) => {
      const tagEnd = position + tag.length
      const hasTokenEnd =
        tagEnd === dedupedMetadata.length || TAG_WHITESPACE_RE.test(dedupedMetadata.charAt(tagEnd))
      return hasTokenEnd && dedupedMetadata.startsWith(tag, position)
    })

    if (tagStart === undefined) continue
    const removalStart = tagStart === 0 ? 0 : tagStart - 1
    dedupedMetadata = (
      dedupedMetadata.slice(0, removalStart) + dedupedMetadata.slice(tagStart + tag.length)
    ).trim()
    tagPositions = tagPositionsIn(dedupedMetadata)
    deduplicatedTags.push(tag)
  }

  if (deduplicatedTags.length === 0) {
    return { taskLine, deduplicatedTags: [] }
  }

  return {
    taskLine: joinTaskLine({ ...parts, metadata: dedupedMetadata }),
    deduplicatedTags,
  }
}

/** Adds or replaces a `^block-id` at the end of a task line. Trailing
 *  whitespace (a markdown hard break) is preserved through the replacement. */
const assignBlockId = ({ taskLine, blockId }: { taskLine: string; blockId: string }): string => {
  const trimmedLine = taskLine.trimEnd()
  const trailingWhitespace = taskLine.slice(trimmedLine.length)
  const existingMatch = BLOCK_LINK_RE.exec(trimmedLine)

  if (existingMatch) {
    return `${trimmedLine.slice(0, existingMatch.index)} ^${blockId}${trailingWhitespace}`
  }
  return `${trimmedLine} ^${blockId}${trailingWhitespace}`
}

/** Removes a task line's trailing `^block-id`, keeping trailing whitespace
 *  (a markdown hard break) as assignBlockId does; a line without one is
 *  returned unchanged. */
const removeBlockId = (taskLine: string): string => {
  const trimmedLine = taskLine.trimEnd()
  const trailingWhitespace = taskLine.slice(trimmedLine.length)
  const blockLinkMatch = BLOCK_LINK_RE.exec(trimmedLine)

  if (!blockLinkMatch) return taskLine
  return `${trimmedLine.slice(0, blockLinkMatch.index)}${trailingWhitespace}`
}

/** Removes a task line's trailing whitespace and then its ` ^block-id`, unlike
 *  removeBlockId, which keeps the whitespace. The one space before the `^`
 *  goes with the ID (`- [ ] task ^id` becomes `- [ ] task`); any extra
 *  spaces before it remain. */
const removeTrailingWhitespaceAndBlockId = (taskLine: string): string => {
  const trimmedLine = taskLine.trimEnd()
  const blockLinkMatch = BLOCK_LINK_RE.exec(trimmedLine)

  if (!blockLinkMatch) return trimmedLine
  return trimmedLine.slice(0, blockLinkMatch.index)
}

/** Counts leading whitespace characters after removing column-zero blockquote prefixes.
 *  Each tab counts as one; whitespace before `>` remains part of the indent. */
const getStructuralIndent = (line: string): number => {
  // Strip leading blockquote markers: each `> ` (one `>` + one optional
  // space) is a blockquote level. Only the marker's own space is consumed;
  // additional spaces are structural indent that must be measured.
  const withoutBlockquotes = line.replace(/^(?:> ?)+/, "")
  const indentMatch = /^(\s*)/.exec(withoutBlockquotes)
  return indentMatch?.[1]?.length ?? 0
}

// ── Task line builder ─────────────────────────────────────────────

/** Parameters for building a complete task line. */
type BuildTaskLineParams = {
  description: string
  blockId?: string | undefined
  priority?: TaskPriority | undefined
  recurrence?: string | undefined
  onCompletion?: string | undefined
  created: string
  start?: string | undefined
  scheduled?: string | undefined
  due?: string | undefined
  taskId?: string | undefined
  dependsOn?: readonly string[] | undefined
  indent?: string | undefined
}

/** Assembles a complete task line. Every update function keeps this field
 *  order, which the Tasks plugin reads back in any order:
 *  description → priority → 🔁 recurrence → 🏁 onCompletion → ➕ created →
 *  🛫 start → ⏳ scheduled → 📅 due → 🆔 task_id → ⛔ depends_on → ^block_id */
const buildTaskLine = (params: BuildTaskLineParams, config: TaskFormatConfig): string => {
  const format = config.taskFormat
  const optionalDates: ReadonlyArray<{
    field: DateFieldKey
    date: string | undefined
  }> = [
    { field: "start", date: params.start },
    { field: "scheduled", date: params.scheduled },
    { field: "due", date: params.due },
  ]
  const optionalDateFields = optionalDates.flatMap(({ field, date }) =>
    date ? [formatDateField({ field, date, format })] : [],
  )

  const parts = [
    `${params.indent ?? ""}- [${charForStatus("todo", config.statusRegistry)}] ${params.description}`,
    ...(params.priority ? [formatPriority(params.priority, format)] : []),
    ...(params.recurrence ? [formatRecurrence(params.recurrence, format)] : []),
    ...(params.onCompletion ? [formatOnCompletion(params.onCompletion, format)] : []),
    formatDateField({ field: "created", date: params.created, format }),
    ...optionalDateFields,
    ...(params.taskId ? [formatTaskId(params.taskId, format)] : []),
    ...(params.dependsOn?.length ? [formatDependsOn(params.dependsOn, format)] : []),
    ...(params.blockId ? [`^${params.blockId}`] : []),
  ]
  return parts.join(" ")
}

/** Stamps or strips a completion-style date field on a task line. Stamping
 *  removes any existing stamp and appends the new one at the end of the
 *  metadata tail; disabled stamping just removes any existing stamp. */
const applyCompletionDate = (params: {
  taskLine: string
  shouldStamp: boolean
  dateFieldText: string
  dateRegex: RegExp
}): string => {
  return transformMetadata(params.taskLine, (metadata) => {
    const metadataWithoutStamp = removeAllMetadataMatches(metadata, params.dateRegex)

    if (!params.shouldStamp) return metadataWithoutStamp
    return appendMetadataField({
      metadata: metadataWithoutStamp,
      fieldText: params.dateFieldText,
    })
  })
}

/** Updates the status-related fields of a task line: checkbox character
 *  and done/cancelled dates. Pure string transform — does not move lines
 *  between sections. Strips both emoji and Dataview formats; writes new
 *  fields in the configured format. */
const updateTaskLineStatus = (params: {
  taskLine: string
  newStatus: TaskStatus
  today: string
  config: TaskFormatConfig
}): string => {
  const withNewCheckbox = replaceCheckboxChar({
    taskLine: params.taskLine,
    newChar: charForStatus(params.newStatus, params.config.statusRegistry),
  })

  const stripMetadataField = (taskLine: string, regex: RegExp): string => {
    return transformMetadata(taskLine, (metadata) => {
      return removeAllMetadataMatches(metadata, regex)
    })
  }

  if (params.newStatus === "done") {
    return applyCompletionDate({
      taskLine: stripMetadataField(withNewCheckbox, CANCELLED_DATE_INLINE_RE),
      shouldStamp: params.config.setDoneDate,
      dateFieldText: formatDoneDate(params.today, params.config.taskFormat),
      dateRegex: DONE_DATE_INLINE_RE,
    })
  }

  if (params.newStatus === "cancelled") {
    return applyCompletionDate({
      taskLine: stripMetadataField(withNewCheckbox, DONE_DATE_INLINE_RE),
      shouldStamp: params.config.setCancelledDate,
      dateFieldText: formatCancelledDate(params.today, params.config.taskFormat),
      dateRegex: CANCELLED_DATE_INLINE_RE,
    })
  }

  // todo / in_progress — strip both completion dates
  return stripMetadataField(
    stripMetadataField(withNewCheckbox, DONE_DATE_INLINE_RE),
    CANCELLED_DATE_INLINE_RE,
  )
}

/** The next-occurrence line for a completed recurring task — the plugin's
 *  createNextOccurrence as a line transform. The completed line's copy keeps
 *  its description, priority, tags, recurrence rule, and indentation, and:
 *  - becomes the configured todo checkbox with done/cancelled dates stripped;
 *  - loses its block link, 🆔 id, and ⛔ dependencies (a new occurrence
 *    cannot share identity with the completed one);
 *  - has start/scheduled/due replaced by the next occurrence's dates;
 *  - has its created date replaced — ➕ today when the plugin's
 *    `setCreatedDate` is on, removed otherwise (the plugin never carries
 *    the original ➕ forward). */
const buildNextOccurrenceLine = ({
  taskLine,
  nextDates,
  today,
  config,
}: {
  taskLine: string
  nextDates: {
    startDate: string | null
    scheduledDate: string | null
    dueDate: string | null
  }
  today: string
  config: TaskFormatConfig
}): string => {
  const todoLine = updateTaskLineStatus({
    taskLine: removeTrailingWhitespaceAndBlockId(taskLine),
    newStatus: "todo",
    today,
    config,
  })
  const withoutTaskId = updateTaskLineTaskId({
    taskLine: todoLine,
    taskId: null,
    config,
  })
  const withoutDependencies = updateTaskLineDependsOn({
    taskLine: withoutTaskId,
    dependsOn: null,
    config,
  })

  const dateReplacements: ReadonlyArray<{
    field: DateFieldKey
    date: string | null
  }> = [
    { field: "created", date: config.setCreatedDate ? today : null },
    { field: "start", date: nextDates.startDate },
    { field: "scheduled", date: nextDates.scheduledDate },
    { field: "due", date: nextDates.dueDate },
  ]
  return dateReplacements.reduce((line, { field, date }) => {
    return updateTaskLineDate({ taskLine: line, field, date, config })
  }, withoutDependencies)
}

/** Updates the priority on a task line: inserts, replaces, or removes
 *  it. A null priority removes any existing priority field (emoji or
 *  Dataview). Strips both formats; writes in the configured format.
 *
 *  A new priority leads the metadata tail, right after the description and
 *  before any other field, where buildTaskLine writes it. */
const updateTaskLinePriority = ({
  taskLine,
  newPriority,
  config,
}: {
  taskLine: string
  newPriority: TaskPriority | null
  config: TaskFormatConfig
}): string => {
  const parts = splitTaskLine(taskLine)

  if (!parts) return taskLine
  // Only the metadata tail can hold a priority field — a priority emoji
  // inside the description is prose to the parser and must be left alone.
  const hasExistingPriority = PRIORITY_INLINE_RE.test(parts.metadata)

  if (!newPriority) {
    if (!hasExistingPriority) return taskLine
    return joinTaskLine({
      ...parts,
      metadata: removeAllMetadataMatches(parts.metadata, PRIORITY_INLINE_RE),
    })
  }

  const priorityField = formatPriority(newPriority, config.taskFormat)

  // Strip the LAST existing signifier (a first-match replace would rewrite a
  // description emoji that the parser read as metadata and leave the real
  // field as a duplicate), then lead the tail with the new priority.
  const metadataWithoutPriority = removeLastMetadataMatch(parts.metadata, PRIORITY_INLINE_RE)
  return joinTaskLine({
    ...parts,
    metadata: [priorityField, metadataWithoutPriority].filter(Boolean).join(" "),
  })
}

// ── Kanban done-lane detection ─────────────────────────────────

/** The Kanban plugin's per-lane completion marker: a bold "Complete"
 *  paragraph between the heading and the first list item. The plugin
 *  serializes it as `**Complete**` and reads it back by checking the
 *  paragraph's stripped text against the (English) string "Complete". */
const COMPLETE_MARKER = "**Complete**"

/** The headings whose body starts with a `**Complete**` marker paragraph —
 *  the Kanban plugin's per-lane completion signal. Returned as the parsed
 *  headings, not their names, because lane names can repeat.
 *
 *  @param bodyLines Note body lines (frontmatter stripped)
 *  @param headings  Pre-parsed headings from `parseHeadings(bodyLines)` */
const extractDoneLaneHeadings = (
  bodyLines: readonly string[],
  headings: readonly HeadingInfo[],
): HeadingInfo[] => {
  // The marker must be the first non-blank line under the heading. A fence
  // or `%%` line counts as such a line, so a marker inside a code block or
  // comment never qualifies.
  const startsWithCompleteMarker = (heading: HeadingInfo): boolean => {
    const firstContentLine = bodyLines
      .slice(heading.bodyStartLine, heading.bodyEndLine)
      .find((line) => line.trim() !== "")
    return firstContentLine?.trim() === COMPLETE_MARKER
  }
  return headings.filter(startsWithCompleteMarker)
}

/** The names of the done lanes (see extractDoneLaneHeadings). */
const extractDoneLanes = (
  bodyLines: readonly string[],
  headings: readonly HeadingInfo[],
): string[] => {
  return extractDoneLaneHeadings(bodyLines, headings).map((heading) => heading.text)
}

// ── Kanban settings parser ──────────────────────────────────────

/** The two values the Kanban plugin recognizes for `new-card-insertion-method`. */
type KanbanCardInsertionMethod = "prepend" | "append"

/** Matches a backtick fence delimiter (with or without a language tag). */
const BACKTICK_FENCE_RE = /^`{3,}/

/** Reads `new-card-insertion-method` after a `%% kanban:settings` marker.
 *  - The JSON is the text between the first two backtick fences after the
 *    marker; where the `%%` comment closes is not checked.
 *  - Returns `undefined` for missing fences, malformed JSON, or an unrecognized value. */
const parseKanbanCardInsertionMethod = (
  bodyLines: readonly string[],
): KanbanCardInsertionMethod | undefined => {
  const settingsLineIndex = bodyLines.findIndex((line) =>
    line.trimStart().startsWith("%% kanban:settings"),
  )

  if (settingsLineIndex === -1) return undefined

  const blockLines = bodyLines.slice(settingsLineIndex + 1)
  const fenceStart = blockLines.findIndex((line) => BACKTICK_FENCE_RE.test(line.trim()))

  if (fenceStart === -1) return undefined

  const afterFence = blockLines.slice(fenceStart + 1)
  const fenceEnd = afterFence.findIndex((line) => BACKTICK_FENCE_RE.test(line.trim()))

  if (fenceEnd === -1) return undefined

  const jsonLines = afterFence.slice(0, fenceEnd)

  if (jsonLines.length === 0) return undefined

  try {
    const parsed: unknown = JSON.parse(jsonLines.join("\n"))

    if (typeof parsed !== "object" || parsed === null) return undefined
    if (!("new-card-insertion-method" in parsed)) return undefined
    const method = parsed["new-card-insertion-method"]

    if (method === "prepend") return "prepend"
    if (method === "append") return "append"
    return undefined
  } catch {
    return undefined
  }
}

// ── Public surface ──────────────────────────────────────────────

export const tasks = {
  extractTasks,
  extractTasksFromBody,
  isTaskId,
  charForStatus,
  statusForChar,
  emojiForPriority,
  isTaskLine,
  updateTaskLineStatus,
  updateTaskLinePriority,
  updateTaskLineDate,
  updateTaskLineTaskId,
  updateTaskLineRecurrence,
  updateTaskLineOnCompletion,
  updateTaskLineDependsOn,
  replaceTaskLineDescription,
  describeTaskLine,
  diffTaskRoundTrip,
  assignBlockId,
  removeBlockId,
  getStructuralIndent,
  buildTaskLine,
  buildNextOccurrenceLine,
  formatDateField,
  extractDoneLaneHeadings,
  extractDoneLanes,
  parseKanbanCardInsertionMethod,
  deduplicateDescriptionTags,
  BLOCK_LINK_RE,
}

export type { DateFieldKey }
