/** The Obsidian Tasks-plugin task-line domain: parsing task metadata AND
 *  mutating task lines (status, priority, dates) in both of the plugin's
 *  formats — emoji signifiers and Dataview inline fields.
 *
 *  **Parsing:** a faithful reimplementation of the plugin's own parser
 *  (obsidian-tasks-group/obsidian-tasks, `DefaultTaskSerializer` +
 *  `DataviewTaskSerializer`): metadata is stripped off the END of the line, one
 *  `$`-anchored field at a time, in repeated passes until nothing matches. Any
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
 *  Like links.ts, the raw grammar regexes stay module-private behind the
 *  `tasks` namespace: one is `/g` (shared `lastIndex` footgun) and the
 *  `$`-anchored field regexes are only meaningful inside the stripping loop. */

import { DateTime } from "luxon"
import {
  advanceComment,
  advanceFence,
  type OpenFence,
  splitIntoLines,
} from "./lines.js"
import { parseHeadings, type HeadingInfo } from "./headings.js"
import type { TaskFormatConfig } from "../vault-operations/task-format-config.js"

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
  /** Verbatim recurrence rule text after 🔁 / `repeat::` (e.g. "every week
   *  when done"). Stored, never executed. */
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
   *  structural indentation relative to ancestor task lines. */
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
const TASK_LINE_RE = /^[\s\t>]*(?:[-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u

/** Matches a trailing block link ` ^block-id` at the very end of the line.
 *  Captures the ID without the caret (group 1). The plugin strips this before
 *  parsing metadata, so it must be removed first. Anchored — safe for .exec(). */
const BLOCK_LINK_RE = / \^([a-zA-Z0-9-]+)$/u

/** Matches inline hashtags: `#` preceded by start-of-string or whitespace,
 *  followed by anything except spaces and common punctuation — the plugin's
 *  own hashtag grammar (nested `#a/b` tags pass). Global — matchAll only. */
const HASHTAG_RE = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g

/** HASHTAG_RE anchored to line end, for stripping a trailing tag during the
 *  metadata loop (tags may interleave with signifiers). Non-global. */
const HASHTAG_FROM_END_RE = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+$/

// ── Field grammar (private) ─────────────────────────────────────
//
// Emoji regexes mirror the plugin's fieldRegex() construction: the signifier,
// an optional Variant Selector 16 (U+FE0F — platforms insert it after emoji
// like the 🗓 due-date variant), optional spaces, the value, then `$` —
// fields are matched and removed from the end of the line until none are left.
//
// Dataview regexes mirror toInlineFieldRegex(): the `key:: value` pair wrapped
// in matching `[...]` or `(...)` (lookaheads reject mismatched pairs), with an
// optional trailing comma, anchored to line end.

/** The allowed characters in a single 🆔 / `id::` task ID. */
const TASK_ID = /[a-zA-Z0-9_-]+/
/** Whole-string form of TASK_ID, for validating an id before it is written —
 *  anything else lands on the line as prose the parser never reads back. */
const TASK_ID_WHOLE_RE = new RegExp(`^${TASK_ID.source}$`)
const isTaskId = (candidate: string): boolean =>
  TASK_ID_WHOLE_RE.test(candidate)
/** A comma-separated sequence of task IDs, as accepted after ⛔ / `dependsOn::`. */
const TASK_ID_SEQUENCE = new RegExp(
  `${TASK_ID.source}( *, *${TASK_ID.source} *)*`,
)

/** Builds an emoji field regex: signifier + optional VS16 (U+FE0F, matched
 *  via escape so no invisible character hides in this source) + spaces +
 *  value, anchored to line end (see block comment above). */
const emojiField = (symbols: string, valuePattern: string): RegExp =>
  new RegExp(
    valuePattern === ""
      ? `${symbols}\\uFE0F?$`
      : `${symbols}\\uFE0F? *${valuePattern}$`,
  )

/** Builds a Dataview inline-field regex: `[key:: value]` or `(key:: value)`
 *  with matched brackets and an optional trailing comma, anchored to line end
 *  (see block comment above). */
const dataviewField = (innerPattern: string): RegExp =>
  new RegExp(
    `(?:(?=[^\\]]+\\])\\[|(?=[^)]+\\))\\() *${innerPattern} *[)\\]](?: *,)?$`,
  )

/** `YYYY-MM-DD` — the only date format the plugin recognizes on task lines. */
const DATE_VALUE = "(\\d{4}-\\d{2}-\\d{2})"

/** One date field's grammar in both formats, in the plugin's per-pass
 *  extraction order (done, cancelled, due, scheduled, start, created). */
const DATE_FIELDS: ReadonlyArray<{
  key: "done" | "cancelled" | "due" | "scheduled" | "start" | "created"
  emoji: RegExp
  dataview: RegExp
}> = [
  {
    key: "done",
    emoji: emojiField("✅", DATE_VALUE),
    dataview: dataviewField(`completion:: *${DATE_VALUE}`),
  },
  {
    key: "cancelled",
    emoji: emojiField("❌", DATE_VALUE),
    dataview: dataviewField(`cancelled:: *${DATE_VALUE}`),
  },
  {
    key: "due",
    emoji: emojiField("(?:📅|📆|🗓)", DATE_VALUE),
    dataview: dataviewField(`due:: *${DATE_VALUE}`),
  },
  {
    key: "scheduled",
    emoji: emojiField("(?:⏳|⌛)", DATE_VALUE),
    dataview: dataviewField(`scheduled:: *${DATE_VALUE}`),
  },
  {
    key: "start",
    emoji: emojiField("🛫", DATE_VALUE),
    dataview: dataviewField(`start:: *${DATE_VALUE}`),
  },
  {
    key: "created",
    emoji: emojiField("➕", DATE_VALUE),
    dataview: dataviewField(`created:: *${DATE_VALUE}`),
  },
]

/** Emoji priority signifier, anchored to line end. Captures the emoji. */
const EMOJI_PRIORITY_RE = emojiField("(🔺|⏫|🔼|🔽|⏬)", "")
/** Dataview priority field, anchored to line end. Captures the level word
 *  (lowercase only, matching the plugin's regex; `highest` before `high` so
 *  the longer word wins). */
const DATAVIEW_PRIORITY_RE = dataviewField(
  "priority:: *(highest|high|medium|low|lowest)",
)
/** Recurrence rule text after 🔁 — letters, digits, commas, spaces, `!`. */
const EMOJI_RECURRENCE_RE = emojiField("🔁", "([a-zA-Z0-9, !]+)")
const DATAVIEW_RECURRENCE_RE = dataviewField("repeat:: *([a-zA-Z0-9, !]+)")
/** On-completion action word after 🏁 (the plugin accepts delete/keep). */
const EMOJI_ON_COMPLETION_RE = emojiField("🏁", "([a-zA-Z]+)")
const DATAVIEW_ON_COMPLETION_RE = dataviewField("onCompletion:: *([a-zA-Z]+)")
/** The task's own ID after 🆔. */
const EMOJI_ID_RE = emojiField("🆔", `(${TASK_ID.source})`)
const DATAVIEW_ID_RE = dataviewField(`id:: *(${TASK_ID.source})`)
/** Comma-separated IDs this task depends on, after ⛔. */
const EMOJI_DEPENDS_ON_RE = emojiField("⛔", `(${TASK_ID_SEQUENCE.source})`)
const DATAVIEW_DEPENDS_ON_RE = dataviewField(
  `dependsOn:: *(${TASK_ID_SEQUENCE.source})`,
)

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

/** Maps a checkbox character to the plugin's core status types: `x`/`X` done,
 *  `-` cancelled, `/` in progress, everything else (including custom
 *  characters) todo — the plugin's unknown-symbol behavior. */
const statusForChar = (statusChar: string): TaskStatus => {
  if (statusChar === "x" || statusChar === "X") return "done"
  if (statusChar === "-") return "cancelled"
  if (statusChar === "/") return "in_progress"
  return "todo"
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

/** Passes cap for the stripping loop — the plugin's own runaway guard. A
 *  well-formed line finishes in one pass; 20 covers any field permutation. */
const MAX_STRIPPING_PASSES = 20

/** Extracts a regex capture group, throwing if absent. Capture groups are
 *  guaranteed by the engine when the regex matches, but noUncheckedIndexedAccess
 *  adds `| undefined` to all indexed access. */
const matchedText = (match: RegExpExecArray, index: number): string => {
  const value = match[index]
  if (value === undefined) {
    throw new Error(`expected capture group ${index}`)
  }
  return value
}

/** Strips metadata fields off the end of a task body, mirroring the plugin's
 *  deserialize(): each pass tries every field regex (all `$`-anchored) and
 *  removes what matches; the loop repeats until a pass matches nothing. Tags
 *  interleaved with signifiers are stripped too, then re-appended, so they
 *  stay part of the description without blocking fields to their left. */
const parseTaskMetadata = (taskBody: string): TaskMetadata => {
  // The stripping loop is inherently sequential — every match shortens the
  // line and later passes depend on it — so mutable locals thread the parser
  // state, mirroring the plugin's ParsingState.
  let line = taskBody.trim()
  // Assigned at the top of every stripping pass; no initializer needed.
  let matchedThisPass: boolean
  let priority: TaskPriority | null = null
  const dates: Record<(typeof DATE_FIELDS)[number]["key"], string | null> = {
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

  const extractField = (
    regex: RegExp,
    onMatch: (match: RegExpExecArray) => void,
  ): void => {
    const match = regex.exec(line)
    if (!match) return
    onMatch(match)
    line = line.replace(regex, "").trim()
    matchedThisPass = true
  }

  const extractDate = (
    regex: RegExp,
    key: (typeof DATE_FIELDS)[number]["key"],
  ): void => {
    extractField(regex, (match) => {
      dates[key] = matchedText(match, 1)
    })
  }

  for (let pass = 0; pass < MAX_STRIPPING_PASSES; pass++) {
    matchedThisPass = false

    extractField(EMOJI_PRIORITY_RE, (match) => {
      priority = PRIORITY_BY_EMOJI[matchedText(match, 1)] ?? priority
    })
    extractField(DATAVIEW_PRIORITY_RE, (match) => {
      priority = PRIORITY_BY_WORD[matchedText(match, 1)] ?? priority
    })

    for (const field of DATE_FIELDS) {
      extractDate(field.emoji, field.key)
      extractDate(field.dataview, field.key)
    }

    extractField(EMOJI_RECURRENCE_RE, (match) => {
      recurrence = matchedText(match, 1).trim()
    })
    extractField(DATAVIEW_RECURRENCE_RE, (match) => {
      recurrence = matchedText(match, 1).trim()
    })

    extractField(EMOJI_ON_COMPLETION_RE, (match) => {
      onCompletion = matchedText(match, 1)
    })
    extractField(DATAVIEW_ON_COMPLETION_RE, (match) => {
      onCompletion = matchedText(match, 1)
    })

    // Tags may be mixed among the signifiers (`desc #a 📅 2026-01-01 #b`);
    // strip them here so fields further left stay reachable, and re-append
    // them to the description after the loop. Right-to-left matching means
    // each stripped tag is prepended to keep the original order.
    extractField(HASHTAG_FROM_END_RE, (match) => {
      const tagText = matchedText(match, 0).trim()
      trailingTags =
        trailingTags === "" ? tagText : `${tagText} ${trailingTags}`
    })

    extractField(EMOJI_ID_RE, (match) => {
      taskId = matchedText(match, 1).trim()
    })
    extractField(DATAVIEW_ID_RE, (match) => {
      taskId = matchedText(match, 1).trim()
    })

    extractField(EMOJI_DEPENDS_ON_RE, (match) => {
      dependsOn = splitIdSequence(matchedText(match, 1))
    })
    extractField(DATAVIEW_DEPENDS_ON_RE, (match) => {
      dependsOn = splitIdSequence(matchedText(match, 1))
    })

    if (!matchedThisPass) break
  }

  const description =
    trailingTags === "" ? line : `${line} ${trailingTags}`.trim()

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
const extractInlineTags = (description: string): string[] => [
  ...new Set(
    [...description.matchAll(HASHTAG_RE)].map((match) =>
      match[0].trim().slice(1),
    ),
  ),
]

// ── Note scanning ───────────────────────────────────────────────

/** Returns the index of the first body line: 0 when the note has no
 *  frontmatter, otherwise the line after the closing `---`. A `---` opener
 *  with no closer is a horizontal rule, not frontmatter. */
const findBodyStartLine = (lines: readonly string[]): number => {
  if (lines[0] !== "---") return 0
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line === "---",
  )
  return closingIndex === -1 ? 0 : closingIndex + 1
}

/** Extracts every task line from raw note content (frontmatter included — it
 *  is skipped here so reported line numbers stay file-relative). Lines inside
 *  fenced code blocks and `%% %%` comment blocks are excluded via the shared
 *  fence and comment state machines. Each task carries the text of the nearest
 *  heading above it (its Kanban lane on a board), or null before the first
 *  heading. */
const extractTasks = (rawContent: string): ParsedTask[] => {
  const allLines = splitIntoLines(rawContent)
  const bodyStartLine = findBodyStartLine(allLines)
  const bodyLines = allLines.slice(bodyStartLine)
  const headings = parseHeadings(bodyLines)

  const extractedTasks: ParsedTask[] = []

  // Indent stack for parent-child tracking — each entry is a task's indent
  // level and 1-based file line:
  // - deeper indent than the stack top → the task is a child
  // - equal or shallower → ancestors are popped until the top is a parent
  // - a heading clears the stack (children can't span headings)
  type IndentEntry = {
    indent: number
    fileLine: number
  }
  const indentStack: IndentEntry[] = []

  // Fence and comment scans are inherently sequential — both thread mutable
  // state across the loop (same pattern as classifyLines).
  let openFence: OpenFence = null
  let commentOpen = false
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

    // Reset indent stack at heading boundaries — sub-tasks can't span headings
    const lineStartsHeading = headings.some(
      (heading) => heading.startLine === lineIndex,
    )
    if (lineStartsHeading) {
      indentStack.length = 0
    }

    const taskLineMatch = TASK_LINE_RE.exec(lineText)
    if (!taskLineMatch) continue

    const statusChar = matchedText(taskLineMatch, 1)
    // The block link sits at the absolute end of the line — strip it before
    // metadata parsing, exactly as the plugin does.
    const bodyWithBlockLink = matchedText(taskLineMatch, 2)
    const blockLinkMatch = BLOCK_LINK_RE.exec(bodyWithBlockLink)
    const blockId = blockLinkMatch?.[1] ?? null
    const taskBody = blockLinkMatch
      ? bodyWithBlockLink.slice(0, blockLinkMatch.index)
      : bodyWithBlockLink

    const nearestHeading = headings.findLast(
      (heading) => heading.startLine < lineIndex,
    )

    const taskIndent = getTaskIndent(lineText)
    // Pop ancestors that are at the same or deeper indent — they're siblings
    // or cousins, not parents
    while (indentStack.length > 0) {
      const topEntry = indentStack.at(-1)
      const topEntryIsParent =
        topEntry !== undefined && topEntry.indent < taskIndent
      if (topEntryIsParent) break
      indentStack.pop()
    }
    const parentEntry = indentStack.at(-1)
    const depth = indentStack.length
    const parentLine = parentEntry?.fileLine ?? null

    const fileLine = bodyStartLine + lineIndex + 1
    indentStack.push({ indent: taskIndent, fileLine })

    extractedTasks.push({
      line: fileLine,
      statusChar,
      status: statusForChar(statusChar),
      blockId,
      heading: nearestHeading?.text ?? null,
      depth,
      parentLine,
      ...parseTaskMetadata(taskBody),
    })
  }
  return extractedTasks
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

/** The checkbox character for a given status. */
const charForStatus = (status: TaskStatus): string => CHAR_FOR_STATUS[status]

/** The emoji signifier for a given priority level. */
const emojiForPriority = (priority: TaskPriority): string =>
  EMOJI_FOR_PRIORITY[priority]

// ── Inline field regexes (non-anchored, for mid-line replacement) ──
//
// Both emoji and Dataview inline-field formats are matched for stripping
// (users may have switched format mid-vault). Write format is determined
// by the TaskFormatConfig passed to each mutation function.

/** Matches a done date in either format: `✅ YYYY-MM-DD` (emoji) or
 *  `[completion:: YYYY-MM-DD]` / `(completion:: YYYY-MM-DD)` (Dataview). */
const DONE_DATE_INLINE_RE =
  /✅️? *\d{4}-\d{2}-\d{2}|[[(] *completion:: *\d{4}-\d{2}-\d{2} *[\])](?: *,)?/u

/** Matches a cancelled date in either format. */
const CANCELLED_DATE_INLINE_RE =
  /❌️? *\d{4}-\d{2}-\d{2}|[[(] *cancelled:: *\d{4}-\d{2}-\d{2} *[\])](?: *,)?/u

/** Matches a due date in either format (📅, 📆, 🗓 variants). */
const DUE_DATE_INLINE_RE =
  /(?:📅|📆|🗓)️? *\d{4}-\d{2}-\d{2}|[[(] *due:: *\d{4}-\d{2}-\d{2} *[\])](?: *,)?/u

/** Matches a scheduled date in either format (⏳, ⌛ variants). */
const SCHEDULED_DATE_INLINE_RE =
  /(?:⏳|⌛)️? *\d{4}-\d{2}-\d{2}|[[(] *scheduled:: *\d{4}-\d{2}-\d{2} *[\])](?: *,)?/u

/** Matches a start date in either format. */
const START_DATE_INLINE_RE =
  /🛫️? *\d{4}-\d{2}-\d{2}|[[(] *start:: *\d{4}-\d{2}-\d{2} *[\])](?: *,)?/u

/** Matches a created date in either format. */
const CREATED_DATE_INLINE_RE =
  /➕️? *\d{4}-\d{2}-\d{2}|[[(] *created:: *\d{4}-\d{2}-\d{2} *[\])](?: *,)?/u

/** Matches a task ID in either format. */
const TASK_ID_INLINE_RE =
  /🆔️? *[a-zA-Z0-9_-]+|[[(] *id:: *[a-zA-Z0-9_-]+ *[\])](?: *,)?/u

/** Matches a depends-on field in either format (comma-separated IDs). */
const DEPENDS_ON_INLINE_RE =
  /⛔️? *[a-zA-Z0-9_-]+(?:,\s*[a-zA-Z0-9_-]+)*|[[(] *dependsOn:: *[a-zA-Z0-9_-]+(?:,\s*[a-zA-Z0-9_-]+)* *[\])](?: *,)?/u

/** Matches any priority signifier in either format: emoji (🔺⏫🔼🔽⏬)
 *  or Dataview (`[priority:: level]` / `(priority:: level)`). */
const PRIORITY_INLINE_RE =
  /[🔺⏫🔼🔽⏬]️?|[[(] *priority:: *(?:highest|high|medium|low|lowest) *[\])](?: *,)?/u

/** Matches the first metadata signifier — the boundary between the
 *  human-written description and the machine-managed fields. Covers
 *  both emoji signifiers and Dataview field openers. */
const FIRST_METADATA_SIGNIFIER_RE =
  /(?:➕|🛫|⏳|⌛|📅|📆|🗓|✅|❌|🔁|🏁|🆔|⛔|🔺|⏫|🔼|🔽|⏬)️?|[[(](?:completion|cancelled|due|scheduled|start|created|priority|repeat|onCompletion|id|dependsOn)::/u

// ── Task-line mutation (pure string transforms) ─────────────────

/** Returns true when a line is a checkbox task line. */
const isTaskLine = (line: string): boolean => TASK_LINE_RE.test(line)

/** Replaces the checkbox character in a task line, e.g. `[/]` → `[x]`.
 *  Returns the line unchanged if it's not a task line. */
const replaceCheckboxChar = (taskLine: string, newChar: string): string =>
  taskLine.replace(/\[.\]/, `[${newChar}]`)

/** Removes a matched regex from the line and collapses any resulting
 *  double spaces. Preserves leading indentation. */
const stripField = (taskLine: string, regex: RegExp): string =>
  taskLine.replace(regex, "").replace(/ {2,}/g, " ").trimEnd()

// Re-export TaskFormatConfig so consumers of tasks.ts don't need a
// separate import from the vault-operations layer.
export type { TaskFormatConfig }

/** Formats a done date in the configured format. */
const formatDoneDate = (today: string, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[completion:: ${today}]` : `✅ ${today}`

/** Formats a cancelled date in the configured format. */
const formatCancelledDate = (
  today: string,
  format: "emoji" | "dataview",
): string => (format === "dataview" ? `[cancelled:: ${today}]` : `❌ ${today}`)

/** Formats a priority in the configured format. */
const formatPriority = (
  priority: TaskPriority,
  format: "emoji" | "dataview",
): string =>
  format === "dataview"
    ? `[priority:: ${priority}]`
    : emojiForPriority(priority)

/** Formats a task ID (🆔) in the configured format. */
const formatTaskId = (taskId: string, format: "emoji" | "dataview"): string =>
  format === "dataview" ? `[id:: ${taskId}]` : `🆔 ${taskId}`

/** Formats a depends-on list (⛔) in the configured format. */
const formatDependsOn = (
  dependsOn: readonly string[],
  format: "emoji" | "dataview",
): string => {
  const idList = dependsOn.join(",")
  return format === "dataview" ? `[dependsOn:: ${idList}]` : `⛔ ${idList}`
}

// ── Date field keys and their format/strip data ──────────────────
//
// Each settable date field has an emoji signifier, a Dataview key, and a
// non-anchored inline regex for stripping. The ordering here matches the
// Tasks-plugin field convention (priority → created → start → scheduled →
// due → done → cancelled), which buildTaskLine uses to assemble lines and
// updateTaskLineDate uses to find the insertion point.

/** The six date-field keys in the Tasks plugin's canonical ordering. */
type DateFieldKey =
  "created" | "start" | "scheduled" | "due" | "done" | "cancelled"

const DATE_FIELD_INFO: ReadonlyArray<{
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
const formatDateField = (
  field: DateFieldKey,
  date: string,
  format: "emoji" | "dataview",
): string => {
  const info = DATE_FIELD_INFO.find((entry) => entry.key === field)
  if (!info) throw new Error(`unknown date field: ${field}`)
  return format === "dataview"
    ? `[${info.dataviewKey}:: ${date}]`
    : `${info.emoji} ${date}`
}

/** Sets or clears a date field on a task line. Strips existing values in
 *  both formats; inserts the new value at the correct position per the
 *  Tasks-plugin field ordering convention. A null date clears the field. */
const updateTaskLineDate = (params: {
  taskLine: string
  field: DateFieldKey
  date: string | null
  config: TaskFormatConfig
}): string => {
  const fieldInfo = DATE_FIELD_INFO.find((entry) => entry.key === params.field)
  if (!fieldInfo) throw new Error(`unknown date field: ${params.field}`)

  // Later fields in the canonical order: the remaining dates, then
  // task_id and depends_on — a new date is inserted ahead of the first one
  // present so the line keeps the order the create path writes.
  const fieldIndex = DATE_FIELD_INFO.findIndex(
    (entry) => entry.key === params.field,
  )
  const laterFieldRegexes = [
    ...DATE_FIELD_INFO.slice(fieldIndex + 1).map((entry) => entry.inlineRegex),
    TASK_ID_INLINE_RE,
    DEPENDS_ON_INLINE_RE,
  ]

  return mapMetadataTail(params.taskLine, (metadata) => {
    const stripped = stripField(metadata, fieldInfo.inlineRegex)
    if (params.date === null) return stripped
    const dateText = formatDateField(
      params.field,
      params.date,
      params.config.taskFormat,
    )
    return insertFieldBefore(stripped, dateText, laterFieldRegexes)
  })
}

/** Sets or clears the Tasks-plugin `🆔` / `[id:: ]` field on a task line.
 *  A new id goes ahead of an existing depends_on, matching the create order. */
const updateTaskLineTaskId = (
  taskLine: string,
  taskId: string | null,
  config: TaskFormatConfig,
): string => {
  return mapMetadataTail(taskLine, (metadata) => {
    const stripped = stripField(metadata, TASK_ID_INLINE_RE)
    if (taskId === null) return stripped
    return insertFieldBefore(
      stripped,
      formatTaskId(taskId, config.taskFormat),
      [DEPENDS_ON_INLINE_RE],
    )
  })
}

/** Sets or clears the Tasks-plugin `⛔` / `[dependsOn:: ]` field. */
const updateTaskLineDependsOn = (
  taskLine: string,
  dependsOn: readonly string[] | null,
  config: TaskFormatConfig,
): string => {
  return mapMetadataTail(taskLine, (metadata) => {
    const stripped = stripField(metadata, DEPENDS_ON_INLINE_RE)
    if (dependsOn === null || dependsOn.length === 0) return stripped
    return appendField(stripped, formatDependsOn(dependsOn, config.taskFormat))
  })
}

/** Global twin of FIRST_METADATA_SIGNIFIER_RE for matchAll — kept separate
 *  so the non-global regex never carries a lastIndex. */
const METADATA_SIGNIFIER_CANDIDATES_RE = new RegExp(
  FIRST_METADATA_SIGNIFIER_RE.source,
  "gu",
)

/** Index in a task body (checkbox prefix and block link removed) where the
 *  metadata tail begins, or -1 when the whole body is description.
 *  - A signifier opens the tail only when everything after it parses as
 *    metadata — the parser strips from the right, so an emoji mid-sentence
 *    ("Prefer 🔼 arrows in docs 📅 2026-09-15") stays in the description.
 *  - Tags interleaved with fields belong to the tail, not the description. */
const findMetadataStart = (taskBody: string): number => {
  for (const candidate of taskBody.matchAll(METADATA_SIGNIFIER_CANDIDATES_RE)) {
    const tail = parseTaskMetadata(taskBody.slice(candidate.index))
    const tailDescription = tail.description.replace(HASHTAG_RE, "").trim()
    if (tailDescription === "") return candidate.index
  }
  return -1
}

type TaskLineParts = {
  /** Indentation, list marker, and checkbox, e.g. `  - [ ] `. */
  prefix: string
  description: string
  /** Metadata fields from the first real signifier on; "" when none. */
  metadata: string
  /** Trailing block link including its leading space; "" when none. */
  blockLink: string
}

/** Splits a task line at the parser's description/metadata boundary.
 *  Returns null when the line is not a task line. */
const splitTaskLine = (taskLine: string): TaskLineParts | null => {
  const checkboxMatch = /^([\s\t>]*(?:[-*+]|[0-9]+[.)]) +\[.\] *)/.exec(
    taskLine,
  )
  const prefix = checkboxMatch?.[1]
  if (!prefix) return null
  const afterCheckbox = taskLine.slice(prefix.length)
  const blockLinkMatch = BLOCK_LINK_RE.exec(afterCheckbox)
  const blockLink = blockLinkMatch?.[0] ?? ""
  const taskBody = blockLinkMatch
    ? afterCheckbox.slice(0, blockLinkMatch.index)
    : afterCheckbox
  const metadataStart = findMetadataStart(taskBody)
  if (metadataStart === -1) {
    return { prefix, description: taskBody.trim(), metadata: "", blockLink }
  }
  return {
    prefix,
    description: taskBody.slice(0, metadataStart).trim(),
    metadata: taskBody.slice(metadataStart).trim(),
    blockLink,
  }
}

const joinTaskLine = ({
  prefix,
  description,
  metadata,
  blockLink,
}: TaskLineParts): string => {
  const body = [description.trim(), metadata.trim()].filter(Boolean).join(" ")
  return `${prefix}${body}${blockLink}`
}

/** Applies a field mutation to the metadata tail only — field-like text
 *  inside the description ("Trip on 📅 2026-09-15, then relax") is prose to
 *  the parser and must never be matched by a strip or replace. Returns the
 *  line unchanged when it is not a task line. */
const mapMetadataTail = (
  taskLine: string,
  transform: (metadata: string) => string,
): string => {
  const parts = splitTaskLine(taskLine)
  if (!parts) return taskLine
  return joinTaskLine({ ...parts, metadata: transform(parts.metadata) })
}

/** Appends a field to the end of a metadata tail. */
const appendField = (metadata: string, fieldText: string): string =>
  [metadata, fieldText].filter(Boolean).join(" ")

/** Inserts a field ahead of the first later-ordered field present in the
 *  metadata tail, or appends it when none of them is. */
const insertFieldBefore = (
  metadata: string,
  fieldText: string,
  laterFieldRegexes: readonly RegExp[],
): string => {
  for (const laterFieldRegex of laterFieldRegexes) {
    const laterMatch = laterFieldRegex.exec(metadata)
    if (laterMatch) {
      return `${metadata.slice(0, laterMatch.index)}${fieldText} ${metadata.slice(laterMatch.index)}`
    }
  }
  return appendField(metadata, fieldText)
}

/** The description the parser sees for a task line — metadata stripped
 *  from the right, interleaved tags re-appended, block link removed. */
const describeTaskLine = (taskLine: string): string => {
  const taskLineMatch = TASK_LINE_RE.exec(taskLine)
  if (!taskLineMatch) return taskLine
  const bodyWithBlockLink = matchedText(taskLineMatch, 2)
  const blockLinkMatch = BLOCK_LINK_RE.exec(bodyWithBlockLink)
  const taskBody = blockLinkMatch
    ? bodyWithBlockLink.slice(0, blockLinkMatch.index)
    : bodyWithBlockLink
  return parseTaskMetadata(taskBody).description
}

/** Replaces the description text on a task line — everything before the
 *  metadata tail. Metadata fields, block_id, and indentation are preserved. */
const replaceTaskLineDescription = (
  taskLine: string,
  newDescription: string,
): string => {
  const parts = splitTaskLine(taskLine)
  if (!parts) return taskLine
  return joinTaskLine({ ...parts, description: newDescription })
}

/** Adds or replaces a `^block-id` at the end of a task line. */
const assignBlockId = (taskLine: string, blockId: string): string => {
  const existingMatch = BLOCK_LINK_RE.exec(taskLine)
  if (existingMatch) {
    return `${taskLine.slice(0, existingMatch.index)} ^${blockId}`
  }
  return `${taskLine} ^${blockId}`
}

/** Extracts the structural indent of a line — leading whitespace after
 *  stripping blockquote `>` markers. A top-level task returns 0; an
 *  indented sub-task returns the whitespace count before its list marker. */
const getTaskIndent = (line: string): number => {
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
  blockId: string
  priority?: TaskPriority | undefined
  created: string
  start?: string | undefined
  scheduled?: string | undefined
  due?: string | undefined
  taskId?: string | undefined
  dependsOn?: readonly string[] | undefined
  indent?: string | undefined
}

/** Assembles a complete task line in the correct field ordering:
 *  description → priority → ➕ created → 🛫 start → ⏳ scheduled →
 *  📅 due → 🆔 task_id → ⛔ depends_on → ^block_id */
const buildTaskLine = (
  params: BuildTaskLineParams,
  config: TaskFormatConfig,
): string => {
  const prefix = params.indent ?? ""
  const parts: string[] = [`${prefix}- [ ] ${params.description}`]

  if (params.priority) {
    parts.push(formatPriority(params.priority, config.taskFormat))
  }

  parts.push(formatDateField("created", params.created, config.taskFormat))

  if (params.start) {
    parts.push(formatDateField("start", params.start, config.taskFormat))
  }
  if (params.scheduled) {
    parts.push(
      formatDateField("scheduled", params.scheduled, config.taskFormat),
    )
  }
  if (params.due) {
    parts.push(formatDateField("due", params.due, config.taskFormat))
  }
  if (params.taskId) {
    parts.push(formatTaskId(params.taskId, config.taskFormat))
  }
  if (params.dependsOn && params.dependsOn.length > 0) {
    parts.push(formatDependsOn(params.dependsOn, config.taskFormat))
  }

  parts.push(`^${params.blockId}`)

  return parts.join(" ")
}

/** Stamps or strips a completion-style date field on a task line.
 *  When stamping is enabled, replaces an existing field or appends it
 *  to the metadata tail; when disabled, strips any existing field. */
const applyCompletionDate = (params: {
  taskLine: string
  shouldStamp: boolean
  dateField: string
  dateRegex: RegExp
}): string => {
  return mapMetadataTail(params.taskLine, (metadata) => {
    if (!params.shouldStamp) return stripField(metadata, params.dateRegex)
    return params.dateRegex.test(metadata)
      ? metadata.replace(params.dateRegex, params.dateField)
      : appendField(metadata, params.dateField)
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
  const withNewCheckbox = replaceCheckboxChar(
    params.taskLine,
    charForStatus(params.newStatus),
  )

  const stripMetadataField = (taskLine: string, regex: RegExp): string =>
    mapMetadataTail(taskLine, (metadata) => stripField(metadata, regex))

  if (params.newStatus === "done") {
    return applyCompletionDate({
      taskLine: stripMetadataField(withNewCheckbox, CANCELLED_DATE_INLINE_RE),
      shouldStamp: params.config.setDoneDate,
      dateField: formatDoneDate(params.today, params.config.taskFormat),
      dateRegex: DONE_DATE_INLINE_RE,
    })
  }

  if (params.newStatus === "cancelled") {
    return applyCompletionDate({
      taskLine: stripMetadataField(withNewCheckbox, DONE_DATE_INLINE_RE),
      shouldStamp: params.config.setCancelledDate,
      dateField: formatCancelledDate(params.today, params.config.taskFormat),
      dateRegex: CANCELLED_DATE_INLINE_RE,
    })
  }

  // todo / in_progress — strip both completion dates
  return stripMetadataField(
    stripMetadataField(withNewCheckbox, DONE_DATE_INLINE_RE),
    CANCELLED_DATE_INLINE_RE,
  )
}

/** Updates the priority on a task line: inserts, replaces, or removes
 *  it. A null priority removes any existing priority field (emoji or
 *  Dataview). Strips both formats; writes in the configured format.
 *
 *  Insertion position: after the description, before the first metadata
 *  signifier. If no signifiers exist, before the block ID or at end. */
const updateTaskLinePriority = (
  taskLine: string,
  newPriority: TaskPriority | null,
  config: TaskFormatConfig,
): string => {
  const parts = splitTaskLine(taskLine)
  if (!parts) return taskLine
  // Only the metadata tail can hold a priority field — a priority emoji
  // inside the description is prose to the parser and must be left alone.
  const hasExistingPriority = PRIORITY_INLINE_RE.test(parts.metadata)

  if (!newPriority) {
    if (!hasExistingPriority) return taskLine
    return joinTaskLine({
      ...parts,
      metadata: stripField(parts.metadata, PRIORITY_INLINE_RE),
    })
  }

  const priorityField = formatPriority(newPriority, config.taskFormat)

  if (hasExistingPriority) {
    return joinTaskLine({
      ...parts,
      metadata: parts.metadata.replace(PRIORITY_INLINE_RE, priorityField),
    })
  }

  // Priority leads the metadata tail — right after the description,
  // before dates.
  return joinTaskLine({
    ...parts,
    metadata: [priorityField, parts.metadata].filter(Boolean).join(" "),
  })
}

/** Finds the 0-based line index of a task whose line ends with
 *  ` ^blockId`. Returns null when no match is found. */
const findTaskByBlockId = (
  lines: readonly string[],
  blockId: string,
): number | null => {
  const suffix = ` ^${blockId}`
  const lineIndex = lines.findIndex(
    (line) => line.endsWith(suffix) && isTaskLine(line),
  )
  return lineIndex === -1 ? null : lineIndex
}

// ── Kanban done-lane detection ─────────────────────────────────

/** The Kanban plugin's per-lane completion marker: a bold "Complete"
 *  paragraph between the heading and the first list item. The plugin
 *  serializes it as `**Complete**` and reads it back by checking the
 *  paragraph's stripped text against the (English) string "Complete". */
const COMPLETE_MARKER = "**Complete**"

/** Extracts heading names whose body starts with a `**Complete**` marker
 *  paragraph — the Kanban plugin's per-lane completion signal. Relies on
 *  `parseHeadings` (which is fence/comment-aware) to define section
 *  boundaries, so markers inside code blocks are excluded by the heading
 *  parser's span computation — not re-checked here.
 *
 *  @param bodyLines Note body lines (frontmatter stripped)
 *  @param headings  Pre-parsed headings from `parseHeadings(bodyLines)` */
const extractDoneLanes = (
  bodyLines: readonly string[],
  headings: readonly HeadingInfo[],
): string[] => {
  const doneLanes: string[] = []

  for (const heading of headings) {
    // Scan the body of this heading for a Complete marker before the
    // first list item. Skip blank lines.
    for (
      let lineIndex = heading.bodyStartLine;
      lineIndex < heading.bodyEndLine;
      lineIndex++
    ) {
      const trimmed = bodyLines[lineIndex]?.trim()
      if (trimmed === undefined) break
      if (!trimmed) continue

      if (trimmed === COMPLETE_MARKER) {
        doneLanes.push(heading.text)
      }

      // Stop at the first non-blank line regardless — the marker must
      // be the very first content paragraph after the heading.
      break
    }
  }

  return doneLanes
}

// ── Public surface ──────────────────────────────────────────────

export const tasks = {
  extractTasks,
  isTaskId,
  charForStatus,
  statusForChar,
  emojiForPriority,
  isTaskLine,
  updateTaskLineStatus,
  updateTaskLinePriority,
  updateTaskLineDate,
  updateTaskLineTaskId,
  updateTaskLineDependsOn,
  replaceTaskLineDescription,
  describeTaskLine,
  assignBlockId,
  getTaskIndent,
  buildTaskLine,
  formatDateField,
  findTaskByBlockId,
  findBodyStartLine,
  extractDoneLanes,
  BLOCK_LINK_RE,
}

export type { DateFieldKey }
