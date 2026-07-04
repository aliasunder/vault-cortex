/** The Obsidian Tasks-plugin task-line domain: recognizing checkbox task lines
 *  in a note and parsing their metadata — status, the six date fields, priority,
 *  recurrence, dependencies, inline tags, and block IDs — in both of the
 *  plugin's read formats (emoji signifiers and Dataview inline fields).
 *
 *  The grammar is a faithful reimplementation of the plugin's own parser
 *  (obsidian-tasks-group/obsidian-tasks, `DefaultTaskSerializer` +
 *  `DataviewTaskSerializer`): metadata is stripped off the END of the line, one
 *  `$`-anchored field at a time, in repeated passes until nothing matches. Any
 *  order of fields parses; unrecognized trailing text stops the scan and leaves
 *  everything to its left as description — exactly the plugin's behavior.
 *  Unlike the plugin (which reads one configured format per vault), both
 *  formats are recognized in the same pass, so mixed-format vaults index
 *  uniformly.
 *
 *  Like links.ts, the raw grammar regexes stay module-private behind the
 *  `tasks` namespace: one is `/g` (shared `lastIndex` footgun) and the
 *  `$`-anchored field regexes are only meaningful inside the stripping loop. */

import { advanceFence, type OpenFence, splitIntoLines } from "./lines.js"
import { parseHeadings } from "./headings.js"

// ── Types ───────────────────────────────────────────────────────

/** The plugin's core status types, derived from the checkbox character.
 *  Unknown characters map to "todo" (the plugin's unknown-symbol behavior). */
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled"

/** The five explicit priority levels. A task with no priority signifier has
 *  priority null — the plugin ranks "none" between medium and low. */
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest"

/** One parsed task line. Dates are raw `YYYY-MM-DD` strings (the only format
 *  the plugin recognizes), so they compare lexicographically. */
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
const TASK_ID = /[a-zA-Z0-9-_]+/
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
    if (match === null) return
    onMatch(match)
    line = line.replace(regex, "").trim()
    matchedThisPass = true
  }

  const extractDate = (
    regex: RegExp,
    key: (typeof DATE_FIELDS)[number]["key"],
  ): void => {
    extractField(regex, (match) => {
      dates[key] = match[1]
    })
  }

  for (let pass = 0; pass < MAX_STRIPPING_PASSES; pass++) {
    matchedThisPass = false

    extractField(EMOJI_PRIORITY_RE, (match) => {
      priority = PRIORITY_BY_EMOJI[match[1]] ?? priority
    })
    extractField(DATAVIEW_PRIORITY_RE, (match) => {
      priority = PRIORITY_BY_WORD[match[1]] ?? priority
    })

    for (const field of DATE_FIELDS) {
      extractDate(field.emoji, field.key)
      extractDate(field.dataview, field.key)
    }

    extractField(EMOJI_RECURRENCE_RE, (match) => {
      recurrence = match[1].trim()
    })
    extractField(DATAVIEW_RECURRENCE_RE, (match) => {
      recurrence = match[1].trim()
    })

    extractField(EMOJI_ON_COMPLETION_RE, (match) => {
      onCompletion = match[1]
    })
    extractField(DATAVIEW_ON_COMPLETION_RE, (match) => {
      onCompletion = match[1]
    })

    // Tags may be mixed among the signifiers (`desc #a 📅 2026-01-01 #b`);
    // strip them here so fields further left stay reachable, and re-append
    // them to the description after the loop. Right-to-left matching means
    // each stripped tag is prepended to keep the original order.
    extractField(HASHTAG_FROM_END_RE, (match) => {
      const tagText = match[0].trim()
      trailingTags =
        trailingTags === "" ? tagText : `${tagText} ${trailingTags}`
    })

    extractField(EMOJI_ID_RE, (match) => {
      taskId = match[1].trim()
    })
    extractField(DATAVIEW_ID_RE, (match) => {
      taskId = match[1].trim()
    })

    extractField(EMOJI_DEPENDS_ON_RE, (match) => {
      dependsOn = splitIdSequence(match[1])
    })
    extractField(DATAVIEW_DEPENDS_ON_RE, (match) => {
      dependsOn = splitIdSequence(match[1])
    })

    if (!matchedThisPass) break
  }

  const description =
    trailingTags === "" ? line : `${line} ${trailingTags}`.trim()

  return {
    description,
    createdDate: dates.created,
    scheduledDate: dates.scheduled,
    startDate: dates.start,
    dueDate: dates.due,
    doneDate: dates.done,
    cancelledDate: dates.cancelled,
    priority,
    recurrence,
    onCompletion,
    taskId,
    dependsOn,
    tags: extractInlineTags(description),
  }
}

/** Splits a ⛔ / `dependsOn::` value ("a, b ,c") into individual IDs. */
const splitIdSequence = (idSequence: string): string[] =>
  idSequence
    .replace(/ /g, "")
    .split(",")
    .filter((id) => id !== "")

/** Collects every inline #tag in a description, deduplicated and stored bare
 *  (no "#") to match the vault-wide tag convention. */
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
 *  fenced code blocks are excluded via the shared fence state machine. Each
 *  task carries the text of the nearest heading above it (its Kanban lane on
 *  a board), or null before the first heading. */
const extractTasks = (rawContent: string): ParsedTask[] => {
  const allLines = splitIntoLines(rawContent)
  const bodyStartLine = findBodyStartLine(allLines)
  const bodyLines = allLines.slice(bodyStartLine)
  const headings = parseHeadings(bodyLines)

  const extracted: ParsedTask[] = []
  // A fenced-code scan is inherently sequential, so the open fence threads
  // through the loop mutably (same pattern as classifyLines).
  let openFence: OpenFence = null
  for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex++) {
    const lineText = bodyLines[lineIndex]
    const fenceResult = advanceFence(lineText, openFence)
    const lineIsCode = fenceResult.isFenceDelimiter || openFence !== null
    openFence = fenceResult.openFence
    if (lineIsCode) continue

    const taskLineMatch = TASK_LINE_RE.exec(lineText)
    if (taskLineMatch === null) continue

    const statusChar = taskLineMatch[1]
    // The block link sits at the absolute end of the line — strip it before
    // metadata parsing, exactly as the plugin does.
    const bodyWithBlockLink = taskLineMatch[2]
    const blockLinkMatch = BLOCK_LINK_RE.exec(bodyWithBlockLink)
    const blockId = blockLinkMatch === null ? null : blockLinkMatch[1]
    const taskBody =
      blockLinkMatch === null
        ? bodyWithBlockLink
        : bodyWithBlockLink.slice(0, blockLinkMatch.index)

    const nearestHeading = headings.findLast(
      (heading) => heading.startLine < lineIndex,
    )

    extracted.push({
      line: bodyStartLine + lineIndex + 1,
      statusChar,
      status: statusForChar(statusChar),
      blockId,
      heading: nearestHeading === undefined ? null : nearestHeading.text,
      ...parseTaskMetadata(taskBody),
    })
  }
  return extracted
}

// ── Public surface ──────────────────────────────────────────────

export const tasks = {
  extractTasks,
}
