/** Task mutations — create a task line, or edit one in place (fields,
 *  block_id, checklist sub-items, heading placement). Every operation is a
 *  single atomic read-modify-write under an exclusive file lock. */

import { readFile } from "node:fs/promises"
import { DateTime } from "luxon"
import { parseNote, stringifyNote } from "../obsidian-markdown/frontmatter.js"
import { resolveSafePath, atomicWriteFile } from "./vault-filesystem.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { withExclusiveFileLock } from "../../utils/file-write-lock.js"
import { parseHeadings, type HeadingInfo } from "../obsidian-markdown/headings.js"
import {
  splitIntoLines,
  advanceFence,
  advanceComment,
  type OpenFence,
} from "../obsidian-markdown/lines.js"
import { tasks } from "../obsidian-markdown/tasks.js"
import type {
  TaskStatus,
  TaskPriority,
  DateFieldKey,
  ParsedTask,
  SubmittedTaskFields,
  TaskRoundTripDivergence,
} from "../obsidian-markdown/tasks.js"
import {
  parseRecurrenceRule,
  nextOccurrenceDates,
  type NextOccurrenceDates,
} from "../obsidian-markdown/recurrence.js"
import {
  readTaskFormatConfig,
  type TaskFormatConfig,
  type StatusClassification,
} from "./task-format-config.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

type CreateTaskParams = {
  vaultPath: string
  path: string
  description: string
  blockId: string
  heading?: string | undefined
  parentBlockId?: string | undefined
  parentLine?: number | undefined
  position?: "top" | "bottom" | number | undefined
  priority?: TaskPriority | undefined
  recurrence?: string | undefined
  onCompletion?: string | undefined
  due?: string | undefined
  scheduled?: string | undefined
  start?: string | undefined
  taskId?: string | undefined
  dependsOn?: string[] | undefined
  subtasks?: string[] | undefined
  format?: "emoji" | "dataview" | undefined
}

/** Where a checklist item written by this call landed — the handle for a
 *  follow-up update, since checklist items carry no block id. */
type SubtaskPosition = {
  line: number
  description: string
}

type CreateTaskResult = {
  path: string
  line: number
  description: string
  block_id: string
  heading?: string | undefined
  subtasks?: SubtaskPosition[] | undefined
  changes: string[]
  /** Round-trip warnings — present only when the written line parses back
   *  differently than the call submitted (description text read as fields).
   *  The write itself succeeded; these are informational. */
  advisories?: string[] | undefined
}

type UpdateTaskParams = {
  vaultPath: string
  path: string
  blockId?: string | undefined
  line?: number | undefined
  status?: TaskStatus | undefined
  priority?: TaskPriority | null | undefined
  recurrence?: string | null | undefined
  onCompletion?: string | null | undefined
  heading?: string | undefined
  position?: "top" | "bottom" | number | undefined
  description?: string | undefined
  due?: string | null | undefined
  scheduled?: string | null | undefined
  start?: string | null | undefined
  created?: string | null | undefined
  taskId?: string | null | undefined
  dependsOn?: string[] | null | undefined
  addSubtasks?: string[] | undefined
  assignBlockId?: string | undefined
  format?: "emoji" | "dataview" | undefined
}

/** The spawned next occurrence of a completed recurring task. It carries no
 *  block id, so `line` is its only handle. Date fields are present only when
 *  the occurrence has them. */
type NextOccurrencePosition = {
  line: number
  description: string
  due?: string | undefined
  scheduled?: string | undefined
  start?: string | undefined
}

type UpdateTaskResult = {
  path: string
  line: number
  description: string
  block_id?: string | undefined
  heading?: string | undefined
  subtasks?: SubtaskPosition[] | undefined
  next_occurrence?: NextOccurrencePosition | undefined
  changes: string[]
  advisories?: string[] | undefined
  /** The onCompletion action that was applied (e.g. "delete"). Present only
   *  when a task with 🏁/[onCompletion::] was transitioned to done. */
  on_completion_applied?: string | undefined
}

const ABSENT_VALUE = "(none)"

/** One grammar for every `changes` entry: `field: before → after`, with
 *  "(none)" standing in for an absent value on either side. */
const formatChange = ({
  field,
  before,
  after,
}: {
  field: string
  before: string | number | null | undefined
  after: string | number | null | undefined
}): string => {
  return `${field}: ${before ?? ABSENT_VALUE} → ${after ?? ABSENT_VALUE}`
}

/** Joins a dependency list for a `changes` entry; an empty list is absent. */
const formatDependsOn = (dependsOn: readonly string[] | null | undefined): string | null => {
  if (!dependsOn || dependsOn.length === 0) return null
  return dependsOn.join(",")
}

/** Quoted value for an advisory sentence; "(none)" for an absent value. */
const displayRoundTripValue = (value: string | null): string => {
  return value === null ? ABSENT_VALUE : `"${value}"`
}

/** The clause describing how a written description parses back.
 *  `storedTextNoun` is the subject phrase spliced into the sentence
 *  ("the stored description" / "its stored text"). */
const parsedDescriptionClause = ({
  storedValue,
  consumedTail,
  storedTextNoun,
}: {
  storedValue: string | null
  consumedTail: string | undefined
  storedTextNoun: string
}): string => {
  const parsedReading =
    storedValue === null
      ? `${storedTextNoun} parses back empty`
      : `${storedTextNoun} parses back as "${storedValue}"`
  const consumedNote = consumedTail
    ? ` — the trailing "${consumedTail}" was read as task metadata`
    : ""
  return `${parsedReading}${consumedNote}`
}

/** One advisory sentence per divergence, keyed on where the expectation came
 *  from — a value submitted this call, the line's previous parse, or nothing. */
const describeRoundTripDivergence = (divergence: TaskRoundTripDivergence): string => {
  if (divergence.field === "description") {
    const clause = parsedDescriptionClause({
      storedValue: divergence.storedValue,
      consumedTail: divergence.consumedTail,
      storedTextNoun: "the stored description",
    })
    return `description: the line was written as submitted, but ${clause}`
  }
  const storedDisplay = displayRoundTripValue(divergence.storedValue)

  if (divergence.expectedSource === "submitted") {
    return `${divergence.field}: submitted ${displayRoundTripValue(divergence.expected)} but the stored line parses back ${storedDisplay}`
  }
  if (divergence.expectedSource === "prior") {
    return `${divergence.field}: previously ${displayRoundTripValue(divergence.expected)}, but the stored line now parses back ${storedDisplay} — this call's edits changed what the line parses as this field`
  }
  return `${divergence.field}: the stored line parses back ${storedDisplay} although nothing set it — description text was read as this field`
}

/** Advisory sentences for a written task line; empty when the line parses
 *  back exactly as the call's inputs say it should. */
const roundTripAdvisories = ({
  taskLine,
  priorTaskLine,
  submitted,
}: {
  taskLine: string
  priorTaskLine: string | null
  submitted: SubmittedTaskFields
}): string[] => {
  return tasks
    .diffTaskRoundTrip({ taskLine, priorTaskLine, submitted })
    .map(describeRoundTripDivergence)
}

/** Advisory for one subtask whose description text was consumed as metadata. */
const buildSubtaskAdvisory = (subtaskText: string): string[] => {
  // The written subtask line carries indentation; the diff strips the whole
  // checkbox prefix before parsing, so a bare synthetic line reads the same.
  const divergences = tasks.diffTaskRoundTrip({
    taskLine: `- [ ] ${subtaskText}`,
    priorTaskLine: null,
    submitted: { description: subtaskText },
  })
  const descriptionDivergence = divergences.find((divergence) => divergence.field === "description")

  if (!descriptionDivergence) return []
  const clause = parsedDescriptionClause({
    storedValue: descriptionDivergence.storedValue,
    consumedTail: descriptionDivergence.consumedTail,
    storedTextNoun: "its stored text",
  })
  return [`subtask "${subtaskText}": written as submitted, but ${clause}`]
}

/** Description-only advisories for newly written checklist lines — a
 *  checklist item carries no metadata params, so the only divergence worth
 *  reporting is its text truncating into fields. */
const subtaskRoundTripAdvisories = (subtaskDescriptions: readonly string[]): string[] => {
  return subtaskDescriptions.flatMap(buildSubtaskAdvisory)
}

/** The done/cancelled-date expectations a status change implies — the same
 *  dates updateTaskLineStatus stamps or strips for each target status, so a
 *  stamp never registers as a field appearing from nowhere. */
const statusImpliedDateFields = ({
  status,
  config,
  today,
}: {
  status: TaskStatus | undefined
  config: { setDoneDate: boolean; setCancelledDate: boolean }
  today: string
}): SubmittedTaskFields => {
  if (!status) return {}
  if (status === "done") {
    return {
      doneDate: config.setDoneDate ? today : null,
      cancelledDate: null,
    }
  }
  if (status === "cancelled") {
    return {
      doneDate: null,
      cancelledDate: config.setCancelledDate ? today : null,
    }
  }
  return { doneDate: null, cancelledDate: null }
}

/** 1-based file positions of checklist lines written starting at a body index. */
const subtaskPositionsFrom = ({
  bodyStartLine,
  firstBodyIndex,
  descriptions,
}: {
  bodyStartLine: number
  firstBodyIndex: number
  descriptions: readonly string[]
}): SubtaskPosition[] => {
  return descriptions.map((description, offset) => ({
    // frontmatter lines + body index of the first subtask + offset within
    // the batch + 1 for the file's 1-based line numbering
    line: bodyStartLine + firstBodyIndex + offset + 1,
    description,
  }))
}

// ── Shared constants ────────────────────────────────────────────

const BLOCK_ID_RE = /^[a-zA-Z0-9-]+$/

// ── Internal helpers ────────────────────────────────────────────

/** Resolves a note path for mutation — `.md` extension + vault-root safety.
 *  No I/O: the note is read once, inside the file lock. */
const resolveNotePath = ({ vaultPath, path }: { vaultPath: string; path: string }): string => {
  assertPathHasExtension(path, ".md")
  return resolveSafePath(vaultPath, path)
}

/** Reads the note's raw content; a missing note surfaces as "note not found"
 *  with the vault-relative path the caller passed. */
const readNoteContent = async ({
  fullPath,
  path,
}: {
  fullPath: string
  path: string
}): Promise<string> => {
  try {
    return await readFile(fullPath, "utf8")
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) {
      throw new Error(`note not found: "${path}"`, { cause: err })
    }
    throw err
  }
}

/** Collects contiguous sub-items below a task line — lines with deeper
 *  indentation than the task itself. Returns the exclusive end index
 *  (the first line that is NOT a sub-item). */
const findTaskBlockEnd = (lines: readonly string[], taskLineIndex: number): number => {
  const taskLine = lines[taskLineIndex]

  if (!taskLine) return taskLineIndex + 1

  // Structural indent — blockquote markers stripped, the same measure the
  // parser uses for depth, so a quoted card's block matches its sub-tasks.
  const taskIndent = tasks.getTaskIndent(taskLine)
  // Walks forward with variable-length jumps (blank lines skipped,
  // sub-items grouped), then trims trailing blanks — both loops mutate.
  let endIndex = taskLineIndex + 1

  while (endIndex < lines.length) {
    const line = lines[endIndex]

    if (line === undefined) break
    if (line.trim() === "") {
      endIndex++
      continue
    }
    const lineIndent = tasks.getTaskIndent(line)

    if (lineIndent <= taskIndent) break
    endIndex++
  }

  // Trim trailing blank lines from the block
  while (endIndex > taskLineIndex + 1) {
    const prevLine = lines[endIndex - 1]

    if (prevLine?.trim()) break
    endIndex--
  }

  return endIndex
}

/** Matches everything before a line's list marker — blockquote markers and
 *  indentation — the same prefix class the task-line grammar accepts. */
const LIST_ITEM_PREFIX_RE = /^[\s>]*/u

/** Prefix for a new checklist item under a task: the first existing child's
 *  prefix, or the parent's prefix + 2 spaces. Carrying the prefix rather than
 *  a space count keeps a quoted card's children inside the blockquote. */
const subtaskIndentUnder = ({
  lines,
  parentLineIndex,
}: {
  lines: readonly string[]
  parentLineIndex: number
}): string => {
  const parentLine = lines[parentLineIndex]
  const parentPrefix = parentLine ? (LIST_ITEM_PREFIX_RE.exec(parentLine)?.[0] ?? "") : ""
  const blockEnd = findTaskBlockEnd(lines, parentLineIndex)
  const firstChildIndex = parentLineIndex + 1
  const hasExistingChildren = firstChildIndex < blockEnd
  const firstChild = hasExistingChildren ? lines[firstChildIndex] : undefined
  const firstChildPrefix = firstChild?.trim()
    ? LIST_ITEM_PREFIX_RE.exec(firstChild)?.[0]
    : undefined
  return firstChildPrefix ?? `${parentPrefix}  `
}

/** Skips past a `**Complete**` marker when present — inserting above it
 *  would break done-lane detection on later reads. */
const taskInsertIndexUnderHeading = ({
  lines,
  heading,
}: {
  lines: readonly string[]
  heading: HeadingInfo
}): number => {
  const firstContentIndex = lines.findIndex(
    (line, index) => index >= heading.bodyStartLine && line.trim() !== "",
  )

  if (firstContentIndex === -1) return heading.bodyStartLine
  const firstContent = lines[firstContentIndex]?.trim()
  return firstContent === "**Complete**" ? firstContentIndex + 1 : heading.bodyStartLine
}

/** Appends after the last non-blank line in the section body so new tasks
 *  land without trailing blank-line gaps. Falls back to bodyStartLine for
 *  empty sections. */
const taskAppendIndexUnderHeading = ({
  lines,
  heading,
}: {
  lines: readonly string[]
  heading: HeadingInfo
}): number => {
  const sectionLines = lines.slice(heading.bodyStartLine, heading.bodyEndLine)
  const lastContentOffset = sectionLines.findLastIndex((line) => line.trim() !== "")

  if (lastContentOffset === -1) return heading.bodyStartLine
  return heading.bodyStartLine + lastContentOffset + 1
}

/** A task line that the index would exclude — inside a fence/comment or
 *  typed NON_TASK in the status registry — is not a lane card for
 *  position-counting purposes. */
const isExcludedFromLane = ({
  line,
  lineIndex,
  lines,
  statusRegistry,
}: {
  line: string
  lineIndex: number
  lines: readonly string[]
  statusRegistry: ReadonlyMap<string, StatusClassification> | undefined
}): boolean => {
  if (isInsideFenceOrComment(lines, lineIndex)) return true

  if (!statusRegistry) return false

  const charMatch = CHECKBOX_CHAR_RE.exec(line)
  const statusChar = charMatch?.[1]

  if (!statusChar) return false

  return tasks.statusForChar(statusChar, statusRegistry) === "non_task"
}

const headingInsertIndexAtPosition = ({
  lines,
  heading,
  position,
  statusRegistry,
}: {
  lines: readonly string[]
  heading: HeadingInfo
  position: number
  statusRegistry?: ReadonlyMap<string, StatusClassification> | undefined
}): number => {
  // Start from bodyStartLine (not taskInsertIndexUnderHeading) so the
  // integer walk and positionOfTaskInLane count from the same window.
  // The **Complete** marker skip only matters for the "bottom" append.
  const sectionStart = heading.bodyStartLine
  const sectionEnd = heading.bodyEndLine

  // Cards under child headings belong to those headings, not this lane.
  const firstChildStart = parseHeadings(lines).find((childHeading) => {
    return childHeading.startLine >= sectionStart && childHeading.startLine < sectionEnd
  })?.startLine
  const walkEnd = firstChildStart ?? sectionEnd

  const cardStartIndices: number[] = []
  // Variable-length jumps through the section: each card's sub-item block
  // is skipped via findTaskBlockEnd, so the step size varies per iteration.
  // lastCardBlockEnd tracks the end of the final card's block so an integer
  // overshoot clamps to after the last card, not at the section's
  // trailing-content position.
  let walkIndex = sectionStart
  let lastCardBlockEnd = -1

  while (walkIndex < walkEnd) {
    const line = lines[walkIndex]

    if (!line?.trim() || !tasks.isTaskLine(line)) {
      walkIndex++
      continue
    }
    if (isExcludedFromLane({ line, lineIndex: walkIndex, lines, statusRegistry })) {
      walkIndex = findTaskBlockEnd(lines, walkIndex)
      continue
    }
    cardStartIndices.push(walkIndex)
    const blockEnd = findTaskBlockEnd(lines, walkIndex)
    lastCardBlockEnd = blockEnd
    walkIndex = blockEnd
  }

  // An overshoot lands after the last card when cards exist, before the
  // first child heading when the lane's own level has none, and at the
  // lane's insert slot otherwise.
  const overshootFallback =
    lastCardBlockEnd >= 0
      ? lastCardBlockEnd
      : (firstChildStart ?? taskInsertIndexUnderHeading({ lines, heading }))
  return cardStartIndices[position - 1] ?? overshootFallback
}

const headingInsertIndex = ({
  lines,
  heading,
  position,
  statusRegistry,
}: {
  lines: readonly string[]
  heading: HeadingInfo
  position: "top" | "bottom" | number
  statusRegistry?: ReadonlyMap<string, StatusClassification> | undefined
}): number => {
  if (typeof position === "number") {
    return headingInsertIndexAtPosition({ lines, heading, position, statusRegistry })
  }
  if (position === "top") {
    return taskInsertIndexUnderHeading({ lines, heading })
  }
  // "bottom" — append after the lane's own content, bounded at the first
  // child heading so the card doesn't land inside a nested section.
  const firstChildStart = parseHeadings(lines).find((childHeading) => {
    return (
      childHeading.startLine >= heading.bodyStartLine &&
      childHeading.startLine < heading.bodyEndLine
    )
  })?.startLine

  if (firstChildStart !== undefined) {
    const sectionLines = lines.slice(heading.bodyStartLine, firstChildStart)
    const lastContentOffset = sectionLines.findLastIndex((sectionLine) => sectionLine.trim() !== "")
    return lastContentOffset >= 0
      ? heading.bodyStartLine + lastContentOffset + 1
      : heading.bodyStartLine
  }
  return taskAppendIndexUnderHeading({ lines, heading })
}

/** Resolves the effective insertion position for a new task under a heading.
 *  The explicit param wins, then the Kanban setting, then the context default. */
const resolveCreatePosition = ({
  explicitPosition,
  isKanbanBoard,
  bodyLines,
}: {
  explicitPosition: "top" | "bottom" | undefined
  isKanbanBoard: boolean
  bodyLines: readonly string[]
}): "top" | "bottom" => {
  if (explicitPosition) return explicitPosition
  if (isKanbanBoard) {
    const kanbanMethod = tasks.parseKanbanCardInsertionMethod(bodyLines)

    if (kanbanMethod === "prepend") return "top"
  }
  return "bottom"
}

type NewTaskPlacement = {
  /** Body index the new task line is inserted at. */
  insertAt: number
  /** Leading whitespace for the task line ("" for a top-level task). */
  indent: string
  /** The heading the task lands under, if the note has one there. */
  heading: string | undefined
}

/** Where a created task goes: under its parent's block, under a named
 *  heading, or at the end of the body. Kanban boards require a heading.
 *  Position is silently ignored for parent and no-heading cases. */
const resolveNewTaskPlacement = ({
  bodyLines,
  bodyStartLine,
  headings,
  parentLocator,
  heading,
  isKanbanBoard,
  position,
  statusRegistry,
}: {
  bodyLines: readonly string[]
  bodyStartLine: number
  headings: readonly HeadingInfo[]
  parentLocator: ParentLocator | undefined
  heading: string | undefined
  isKanbanBoard: boolean
  position: "top" | "bottom" | number | undefined
  statusRegistry: ReadonlyMap<string, StatusClassification> | undefined
}): NewTaskPlacement => {
  if (parentLocator) {
    const parentLineIndex = findParentLineIndex({
      locator: parentLocator,
      bodyLines,
      bodyStartLine,
      statusRegistry,
    })
    const nearestHeading = headings.findLast(
      (headingInfo) => headingInfo.startLine < parentLineIndex,
    )
    return {
      insertAt: findTaskBlockEnd(bodyLines, parentLineIndex),
      indent: subtaskIndentUnder({ lines: bodyLines, parentLineIndex }),
      heading: nearestHeading?.text,
    }
  }
  if (heading) {
    const targetHeading = headings.find((headingInfo) => headingInfo.text === heading)

    if (!targetHeading) {
      const availableHeadings = headings.map((headingInfo) => headingInfo.text).join(", ")
      throw new Error(`heading "${heading}" not found; available: ${availableHeadings}`)
    }
    if (typeof position === "number") {
      const matchCount = headings.filter((headingInfo) => headingInfo.text === heading).length

      if (matchCount > 1) {
        throw new Error(
          `cannot place at position ${position} under "${heading}" — the heading appears ${matchCount} times; rename one section to make it unique`,
        )
      }
    }
    // Integer positions bypass the Kanban default-resolution path
    const resolvedPosition =
      typeof position === "number"
        ? position
        : resolveCreatePosition({
            explicitPosition: position,
            isKanbanBoard,
            bodyLines,
          })
    return {
      insertAt: headingInsertIndex({
        lines: bodyLines,
        heading: targetHeading,
        position: resolvedPosition,
        statusRegistry,
      }),
      indent: "",
      heading,
    }
  }
  if (isKanbanBoard) {
    throw new Error("heading required for Kanban boards (note has kanban-plugin frontmatter)")
  }
  // End of body — under the note's last heading, if any
  return {
    insertAt: bodyLines.length,
    indent: "",
    heading: headings.at(-1)?.text,
  }
}

/** Today's calendar date for a completion stamp; Luxon's null case is
 *  unreachable for a valid `now()`, so it throws rather than degrading. */
const todayIsoDate = (): string => {
  const today = DateTime.now().toISODate()

  if (today === null) {
    throw new Error("failed to determine today's date")
  }
  return today
}

/** One in-line edit to a task line and the `changes` entry that describes it. */
type LineEdit = {
  apply: (taskLine: string) => string
  change: string
}

/** Block-id search that skips fenced code blocks and comment blocks —
 *  aligns lookup with validateBlockId's fence-skip uniqueness rule. */
const findBlockIdSkippingFences = (
  bodyLines: readonly string[],
  blockId: string,
): number | "fenced_only" | null => {
  const suffix = ` ^${blockId}`
  // Sequential parser state — fence and comment scanners are inherently stateful.
  let openFence: OpenFence = null
  let commentOpen = false
  let hasFencedMatch = false

  for (let index = 0; index < bodyLines.length; index++) {
    const lineText = bodyLines[index]

    // Empty strings are valid body lines (blank lines), so only undefined is skipped.
    if (lineText === undefined) continue

    // Fence scanner runs first; comment scanner only advances on non-fenced lines.
    let isExcluded = false

    if (!commentOpen) {
      const fenceResult = advanceFence(lineText, openFence)
      openFence = fenceResult.openFence

      if (fenceResult.lineIsCode) {
        isExcluded = true
      }
    }

    if (!isExcluded) {
      const commentResult = advanceComment(lineText, commentOpen)
      commentOpen = commentResult.commentOpen

      if (commentResult.lineIsComment) {
        isExcluded = true
      }
    }

    if (!lineText.trimEnd().endsWith(suffix) || !tasks.isTaskLine(lineText)) continue

    if (isExcluded) {
      hasFencedMatch = true
      continue
    }

    return index
  }

  return hasFencedMatch ? "fenced_only" : null
}

/** Body index of the task an update names — by block id, or by 1-based file
 *  line. Callers guarantee exactly one identifier is set. */
const locateTaskLine = ({
  bodyLines,
  bodyStartLine,
  blockId,
  line,
  path,
}: {
  bodyLines: readonly string[]
  bodyStartLine: number
  blockId: string | undefined
  line: number | undefined
  path: string
}): number => {
  if (blockId) {
    const result = findBlockIdSkippingFences(bodyLines, blockId)

    if (result === null) {
      throw new Error(`blockId "${blockId}" not found in "${path}"`)
    }
    if (result === "fenced_only") {
      throw new Error(`blockId "${blockId}" is inside a fenced code block or comment in "${path}"`)
    }
    return result
  }
  if (!line) {
    throw new Error("exactly one of blockId or line is required")
  }
  // 1-based file line → 0-based body index (subtract 1 for 1-based, then
  // subtract the frontmatter lines that precede the body array)
  const taskLineIndex = line - 1 - bodyStartLine
  const taskLineText = bodyLines[taskLineIndex]

  if (taskLineIndex < 0 || !taskLineText || !tasks.isTaskLine(taskLineText)) {
    throw new Error(`no task at line ${line}`)
  }
  if (isInsideFenceOrComment(bodyLines, taskLineIndex)) {
    throw new Error(`line ${line} is inside a fenced code block or comment`)
  }
  return taskLineIndex
}

/** Extracts the single character between `[` and `]` from a task line. */
const CHECKBOX_CHAR_RE = /\[(.)\]/u

/** The Tasks plugin's NON_TASK status type marks checkboxes that are
 *  excluded from the task system. The grammar regex still matches them,
 *  so callers guard after locating the line. */
const rejectNonTaskCheckbox = ({
  taskLine,
  statusRegistry,
}: {
  taskLine: string
  statusRegistry: ReadonlyMap<string, StatusClassification>
}): void => {
  const charMatch = CHECKBOX_CHAR_RE.exec(taskLine)

  if (!charMatch) return

  const statusChar = charMatch[1]

  if (!statusChar) return

  const classification = tasks.statusForChar(statusChar, statusRegistry)

  if (classification === "non_task") {
    throw new Error(`checkbox "[${statusChar}]" is a NON_TASK status in the Tasks plugin registry`)
  }
}

/** Returns true when the body-line index falls inside a fenced code block
 *  or a `%% %%` comment block — the same exclusions extractTasks applies. */
const isInsideFenceOrComment = (bodyLines: readonly string[], lineIndex: number): boolean => {
  // Sequential parser state — fence and comment scanners are inherently
  // stateful (same pattern as extractTasks in tasks.ts).
  let openFence: OpenFence = null
  let commentOpen = false

  for (let index = 0; index <= lineIndex; index++) {
    const lineText = bodyLines[index]

    if (lineText === undefined) return false

    if (!commentOpen) {
      const fenceResult = advanceFence(lineText, openFence)
      openFence = fenceResult.openFence

      if (index === lineIndex) return fenceResult.lineIsCode
      if (fenceResult.lineIsCode) continue
    }

    const commentResult = advanceComment(lineText, commentOpen)
    commentOpen = commentResult.commentOpen

    if (index === lineIndex) return commentResult.lineIsComment
  }
  return false
}

/** No-op when the task already sits under the target heading and no
 *  explicit position is requested. With a position, same-lane reorders
 *  go through the extract-reinsert cycle. */
const moveTaskBlock = ({
  lines,
  taskLineIndex,
  targetLane,
  headings,
  position,
  beforePosition,
  statusRegistry,
}: {
  lines: readonly string[]
  taskLineIndex: number
  targetLane: string
  headings: readonly HeadingInfo[]
  position?: "top" | "bottom" | number
  beforePosition?: number | undefined
  statusRegistry?: ReadonlyMap<string, StatusClassification> | undefined
}): {
  lines: readonly string[]
  taskLineIndex: number
  changes: string[]
  /** Lines the move relocated (task + sub-items) — how far the splices
   *  shifted every line between the block's old and new positions. Absent
   *  when the task already sat under the target heading and nothing moved. */
  movedBlockLength?: number
} => {
  const targetHeading = headings.find((heading) => heading.text === targetLane)

  if (!targetHeading) {
    const availableHeadings = headings.map((heading) => heading.text).join(", ")
    throw new Error(`heading "${targetLane}" not found; available: ${availableHeadings}`)
  }

  const currentHeading = headings.findLast((heading) => heading.startLine < taskLineIndex)
  const currentLane = currentHeading?.text ?? "(before first heading)"
  const isSameLane = currentLane === targetLane

  if (isSameLane && !position) return { lines, taskLineIndex, changes: [] }

  const taskBlockEnd = findTaskBlockEnd(lines, taskLineIndex)
  const taskBlock = lines.slice(taskLineIndex, taskBlockEnd)
  const linesWithoutBlock = lines.toSpliced(taskLineIndex, taskBlockEnd - taskLineIndex)

  // Heading positions shift once the block is gone — re-parse before placing
  const headingsAfterRemoval = parseHeadings(linesWithoutBlock)
  const matchingHeadings = headingsAfterRemoval.filter((heading) => heading.text === targetLane)

  if (matchingHeadings.length > 1 && (isSameLane || typeof position === "number")) {
    throw new Error(
      isSameLane
        ? `cannot reorder within "${targetLane}" — the heading appears ${matchingHeadings.length} times; rename one section to make it unique`
        : `cannot place at position ${String(position)} under "${targetLane}" — the heading appears ${matchingHeadings.length} times; rename one section to make it unique`,
    )
  }

  const headingAfterRemoval = matchingHeadings[0]

  if (!headingAfterRemoval) {
    throw new Error(`heading "${targetLane}" not found after line removal`)
  }
  const resolvedPosition = position ?? "top"
  const insertAt = headingInsertIndex({
    lines: linesWithoutBlock,
    heading: headingAfterRemoval,
    position: resolvedPosition,
    statusRegistry,
  })

  // An unchanged raw index means the card is already at the target slot.
  if (isSameLane && insertAt === taskLineIndex) return { lines, taskLineIndex, changes: [] }

  const resultLines = linesWithoutBlock.toSpliced(insertAt, 0, ...taskBlock)

  // The insertion shifts headings below insertAt — re-parse so
  // positionOfTaskInLane sees the correct bodyEndLine.
  const headingInResult = parseHeadings(resultLines).findLast(
    (heading) => heading.startLine < insertAt,
  )

  const changes: string[] = []

  if (!isSameLane) {
    changes.push(formatChange({ field: "heading", before: currentLane, after: targetLane }))
  }
  if (isSameLane) {
    const before =
      beforePosition ??
      positionOfTaskInLane({ lines, heading: targetHeading, taskLineIndex, statusRegistry })
    const after = headingInResult
      ? positionOfTaskInLane({
          lines: resultLines,
          heading: headingInResult,
          taskLineIndex: insertAt,
          statusRegistry,
        })
      : 1

    // Compare the card's position in the move-input lines (not the
    // pre-spawn before-value) with the result — a spawn shifts the
    // card's slot, so pre-spawn equality would suppress a real move.
    const currentSlot = positionOfTaskInLane({
      lines,
      heading: targetHeading,
      taskLineIndex,
      statusRegistry,
    })

    if (currentSlot === after) return { lines, taskLineIndex, changes: [] }
    changes.push(formatChange({ field: "position", before, after }))
  } else if (typeof position === "number") {
    const before = currentHeading
      ? (beforePosition ??
        positionOfTaskInLane({ lines, heading: currentHeading, taskLineIndex, statusRegistry }))
      : null
    const after = headingInResult
      ? positionOfTaskInLane({
          lines: resultLines,
          heading: headingInResult,
          taskLineIndex: insertAt,
          statusRegistry,
        })
      : 1
    changes.push(formatChange({ field: "position", before, after }))
  }

  return {
    lines: resultLines,
    taskLineIndex: insertAt,
    changes,
    movedBlockLength: taskBlock.length,
  }
}

/** 1-based position of a task among its lane's top-level cards. */
const positionOfTaskInLane = ({
  lines,
  heading,
  taskLineIndex,
  statusRegistry,
}: {
  lines: readonly string[]
  heading: HeadingInfo
  taskLineIndex: number
  statusRegistry?: ReadonlyMap<string, StatusClassification> | undefined
}): number => {
  // Scan from the heading's body start, not the insert slot — the insert
  // slot skips past a **Complete** marker, but cards above the marker are
  // still lane members for position-counting purposes.
  const sectionStart = heading.bodyStartLine
  const sectionEnd = heading.bodyEndLine

  const firstChildStart = parseHeadings(lines).find((childHeading) => {
    return childHeading.startLine >= sectionStart && childHeading.startLine < sectionEnd
  })?.startLine
  const walkEnd = firstChildStart ?? sectionEnd

  // Each card's sub-items are skipped via findTaskBlockEnd, so the
  // step size varies per iteration — both counters must be mutable.
  let walkIndex = sectionStart
  let cardPosition = 0

  while (walkIndex < walkEnd) {
    const line = lines[walkIndex]

    if (!line?.trim() || !tasks.isTaskLine(line)) {
      walkIndex++
      continue
    }
    if (isExcludedFromLane({ line, lineIndex: walkIndex, lines, statusRegistry })) {
      walkIndex = findTaskBlockEnd(lines, walkIndex)
      continue
    }
    cardPosition++
    if (walkIndex === taskLineIndex) return cardPosition
    walkIndex = findTaskBlockEnd(lines, walkIndex)
  }
  throw new Error(
    `task at line ${taskLineIndex} not found in the "${heading.text}" section (${cardPosition} cards scanned)`,
  )
}

/** Appends checklist items under a task, after its existing sub-items. */
const appendSubtasks = ({
  lines,
  taskLineIndex,
  descriptions,
  bodyStartLine,
  statusRegistry,
}: {
  lines: readonly string[]
  taskLineIndex: number
  descriptions: readonly string[]
  bodyStartLine: number
  statusRegistry: ReadonlyMap<string, StatusClassification> | undefined
}): {
  lines: readonly string[]
  subtaskPositions: SubtaskPosition[]
  change: string
} => {
  const blockEnd = findTaskBlockEnd(lines, taskLineIndex)
  const subtaskIndent = subtaskIndentUnder({
    lines,
    parentLineIndex: taskLineIndex,
  })
  const todoChar = tasks.charForStatus("todo", statusRegistry)
  const subtaskLines = descriptions.map(
    (subtaskText) => `${subtaskIndent}- [${todoChar}] ${subtaskText}`,
  )
  // Body-only content (lines has no frontmatter) so extractTasks line
  // numbers are 1-based within the body, matching taskLineIndex + 1.
  const bodyContent = lines.join("\n")
  const taskBodyLine = taskLineIndex + 1
  const existingSubtaskCount = tasks
    .extractTasks(bodyContent, statusRegistry)
    .filter((extractedTask) => extractedTask.parentLine === taskBodyLine).length
  return {
    lines: lines.toSpliced(blockEnd, 0, ...subtaskLines),
    subtaskPositions: subtaskPositionsFrom({
      bodyStartLine,
      firstBodyIndex: blockEnd,
      descriptions,
    }),
    change: formatChange({
      field: "subtasks",
      before: existingSubtaskCount,
      after: existingSubtaskCount + descriptions.length,
    }),
  }
}

/** What completing a recurring task produces: a spawned next-occurrence
 *  line, an advisory when the rule yields no next occurrence, or nothing
 *  (the task is not recurring, or is not transitioning to done). */
type RecurrenceSpawn =
  | { kind: "spawn"; spawnedLine: string; nextDates: NextOccurrenceDates }
  | { kind: "advisory"; advisory: string }
  | { kind: "none" }

/** Resolves the recurrence spawn for an update, mirroring the Tasks plugin:
 *  spawn only on a transition to done from a not-done status (custom
 *  DONE-typed checkbox chars from the status registry count as done), with
 *  the recurrence rule and dates read from the fully edited task line — so
 *  an update that changes dates or the rule and completes in one call
 *  advances from the edited values. The status edit on that line is
 *  harmless here: the spawned copy strips completion dates and resets the
 *  checkbox itself.
 *
 *  Cancelling never spawns, in the plugin too: its spawn gate is
 *  `Status.isCompleted()`, which is true for the DONE status type only —
 *  not CANCELLED (`Task.isDone` is a different, broader method). */
const resolveRecurrenceSpawn = ({
  status,
  taskBefore,
  editedTaskLine,
  today,
  config,
}: {
  status: TaskStatus | undefined
  taskBefore: ParsedTask
  editedTaskLine: string
  today: string
  config: TaskFormatConfig
}): RecurrenceSpawn => {
  if (status !== "done") return { kind: "none" }

  // taskBefore.status already reflects the registry (extractTasks receives
  // it), so the registry lookup is belt-and-suspenders — guards against a
  // caller that extracted tasks without the registry.
  const wasAlreadyDone =
    taskBefore.status === "done" || config.statusRegistry.get(taskBefore.statusChar) === "done"

  if (wasAlreadyDone) return { kind: "none" }

  // The note-level parser handles a bare task line: no frontmatter means a
  // body offset of zero and the one line parses to a one-element array.
  const editedTask = tasks.extractTasks(editedTaskLine, config.statusRegistry).at(0)

  if (!editedTask?.recurrence) return { kind: "none" }
  const recurrenceText = editedTask.recurrence

  if (parseRecurrenceRule(recurrenceText) === null) {
    return {
      kind: "advisory",
      advisory: `The task was completed, but its recurrence rule "${recurrenceText}" is not a rule the Tasks plugin recognizes, so no next occurrence was created.`,
    }
  }

  const nextDates = nextOccurrenceDates({
    recurrenceText,
    startDate: editedTask.startDate,
    scheduledDate: editedTask.scheduledDate,
    dueDate: editedTask.dueDate,
    today,
    removeScheduledDateOnRecurrence: config.removeScheduledDateOnRecurrence,
  })

  if (nextDates === null) {
    return {
      kind: "advisory",
      advisory: `The task was completed, but its recurrence rule "${recurrenceText}" produced no next occurrence, so none was created.`,
    }
  }

  return {
    kind: "spawn",
    spawnedLine: tasks.buildNextOccurrenceLine({
      taskLine: editedTaskLine,
      nextDates,
      today,
      config,
    }),
    nextDates,
  }
}

/** The spawned line's index after every splice that follows its insert:
 *  the done-lane move (block removal, then reinsertion under the target
 *  heading) and the checklist append. Tracked arithmetically, never by
 *  content search — a vault can hold two byte-identical recurring lines,
 *  and a search would find the wrong one.
 *
 *  Worked example — spawn at 5, the completed block [3, 5) moves to done
 *  lane at line 8. Removing the block shifts the spawn to 5 − 2 = 3,
 *  reinserting at 8 lands below 3 so no shift. A subtask append at or
 *  above the spawn (the on-next-line layout) shifts it once more. */
const spawnIndexAfterSplices = ({
  spawnIndex,
  doneLaneMove,
  subtaskAppend,
}: {
  spawnIndex: number
  doneLaneMove?: { moveStart: number; movedBlockLength: number; insertAt: number } | undefined
  subtaskAppend?: { insertIndex: number; lineCount: number } | undefined
}): number => {
  const indexAfterRemoval =
    !doneLaneMove || spawnIndex < doneLaneMove.moveStart
      ? spawnIndex
      : spawnIndex - doneLaneMove.movedBlockLength
  const doneLaneInsertShift =
    doneLaneMove && doneLaneMove.insertAt <= indexAfterRemoval ? doneLaneMove.movedBlockLength : 0
  const indexAfterMove = indexAfterRemoval + doneLaneInsertShift

  const subtaskAppendShift =
    subtaskAppend && subtaskAppend.insertIndex <= indexAfterMove ? subtaskAppend.lineCount : 0
  return indexAfterMove + subtaskAppendShift
}

/** Builds the wire-format position of a spawned next occurrence — shared
 *  by the onCompletion-delete early return and the normal completion path. */
const buildNextOccurrencePosition = ({
  bodyStartLine,
  spawnIndex,
  recurrenceSpawn,
}: {
  bodyStartLine: number
  spawnIndex: number
  recurrenceSpawn: Extract<RecurrenceSpawn, { kind: "spawn" }>
}): NextOccurrencePosition => ({
  line: bodyStartLine + spawnIndex + 1,
  description: tasks.describeTaskLine(recurrenceSpawn.spawnedLine),
  ...(recurrenceSpawn.nextDates.dueDate ? { due: recurrenceSpawn.nextDates.dueDate } : {}),
  ...(recurrenceSpawn.nextDates.scheduledDate
    ? { scheduled: recurrenceSpawn.nextDates.scheduledDate }
    : {}),
  ...(recurrenceSpawn.nextDates.startDate ? { start: recurrenceSpawn.nextDates.startDate } : {}),
})

/** Detects the done lane for auto-completion: checks for **Complete**
 *  markers first, falls back to a heading named "Done". */
const detectDoneLane = (
  bodyLines: readonly string[],
  headings: ReturnType<typeof parseHeadings>,
): string => {
  const doneLanes = tasks.extractDoneLanes(bodyLines, headings)

  if (doneLanes.length > 1) {
    throw new Error("multiple done lanes detected")
  }

  if (doneLanes.length === 1) {
    const lane = doneLanes[0]

    if (!lane) {
      throw new Error("unexpected empty done lanes")
    }
    return lane
  }

  // No **Complete** marker found — fall back to a heading named "Done"
  const doneHeading = headings.find((heading) => heading.text === "Done")

  if (doneHeading) return "Done"

  throw new Error("no done lane detected")
}

/** Validates a block_id: grammar check + uniqueness within the note. */
const validateBlockId = (
  blockId: string,
  bodyLines: readonly string[],
  excludeLineIndex?: number,
): void => {
  if (!BLOCK_ID_RE.test(blockId)) {
    throw new Error(
      `blockId "${blockId}" contains invalid characters (allowed: letters, digits, hyphens)`,
    )
  }
  // trimEnd: a hard break's trailing spaces must not hide an existing
  // block link — an invisible duplicate would win every later id lookup.
  const existingIndex = bodyLines.findIndex((bodyLine, index) => {
    if (index === excludeLineIndex) return false
    if (!bodyLine.trimEnd().endsWith(` ^${blockId}`)) return false
    return !isInsideFenceOrComment(bodyLines, index)
  })

  if (existingIndex !== -1) {
    throw new Error(`blockId "${blockId}" already exists in this note`)
  }
}

/** Rejects a task_id or depends_on entry the parser could not read back —
 *  an id outside the plugin's grammar is written as prose, so the call
 *  would report success while the field silently never exists. */
const assertTaskIdGrammar = ({
  taskId,
  dependsOn,
}: {
  taskId: string | null | undefined
  dependsOn: readonly string[] | null | undefined
}): void => {
  if (taskId && !tasks.isTaskId(taskId)) {
    throw new Error(
      `taskId "${taskId}" contains invalid characters (allowed: letters, digits, hyphens, underscores)`,
    )
  }
  const invalidDependency = dependsOn?.find((dependencyId) => !tasks.isTaskId(dependencyId))

  if (invalidDependency !== undefined) {
    throw new Error(
      `dependsOn entry "${invalidDependency}" contains invalid characters (allowed: letters, digits, hyphens, underscores)`,
    )
  }
}

/** Rejects a recurrence rule the plugin's grammar cannot read — written
 *  as-is it would parse as a recurrence that silently never recurs. */
const assertRecurrenceRuleGrammar = (recurrenceText: string | null | undefined): void => {
  if (!recurrenceText) return
  if (parseRecurrenceRule(recurrenceText) === null) {
    throw new Error(
      `unrecognized recurrence rule "${recurrenceText}" (use the Tasks plugin's natural language, e.g. "every week", "every 2 weeks when done")`,
    )
  }
}

/** Matches CR/LF anywhere in a string — a task is one file line, so a line
 *  break in its text would split the metadata onto a line the parser never
 *  reads as part of the task. */
const TASK_TEXT_LINE_BREAK_PATTERN = /[\r\n]/

/** Validates a date string is a real calendar date. */
const validateDate = (date: string, fieldName: string): void => {
  if (!DateTime.fromFormat(date, "yyyy-MM-dd").isValid) {
    throw new Error(`invalid date: ${fieldName} "${date}" (use YYYY-MM-DD)`)
  }
}

type ParentLocator = { kind: "blockId"; blockId: string } | { kind: "line"; line: number }

/** The parent locator a create call named, or undefined for a top-level task.
 *  Callers reject the both-given case before this runs. */
const parentTaskLocatorFrom = ({
  parentBlockId,
  parentLine,
}: {
  parentBlockId: string | undefined
  parentLine: number | undefined
}): ParentLocator | undefined => {
  if (parentBlockId) return { kind: "blockId", blockId: parentBlockId }
  if (parentLine) return { kind: "line", line: parentLine }
  return undefined
}

/** The parent's body-line index; throws when the locator resolves to
 *  nothing, a non-task line, or a NON_TASK-typed checkbox. */
const findParentLineIndex = ({
  locator,
  bodyLines,
  bodyStartLine,
  statusRegistry,
}: {
  locator: ParentLocator
  bodyLines: readonly string[]
  bodyStartLine: number
  statusRegistry: ReadonlyMap<string, StatusClassification> | undefined
}): number => {
  if (locator.kind === "blockId") {
    const result = findBlockIdSkippingFences(bodyLines, locator.blockId)

    if (result === null) {
      throw new Error(`parent task not found: blockId "${locator.blockId}"`)
    }
    if (result === "fenced_only") {
      throw new Error(
        `parent task not found: blockId "${locator.blockId}" is inside a fenced code block or comment`,
      )
    }
    const foundLine = bodyLines[result]

    if (statusRegistry && foundLine) {
      rejectNonTaskCheckbox({ taskLine: foundLine, statusRegistry })
    }
    return result
  }
  const parentLineIndex = locator.line - 1 - bodyStartLine
  const parentLineText = bodyLines[parentLineIndex]

  if (!parentLineText || !tasks.isTaskLine(parentLineText)) {
    throw new Error(`parent task not found: line ${locator.line}`)
  }
  if (isInsideFenceOrComment(bodyLines, parentLineIndex)) {
    throw new Error(
      `parent task not found: line ${locator.line} is inside a fenced code block or comment`,
    )
  }
  if (statusRegistry) {
    rejectNonTaskCheckbox({ taskLine: parentLineText, statusRegistry })
  }
  return parentLineIndex
}

// ── createTask ──────────────────────────────────────────────────

const createTask = async (params: CreateTaskParams, logger: Logger): Promise<CreateTaskResult> => {
  const {
    vaultPath,
    path,
    description,
    blockId,
    heading,
    parentBlockId,
    parentLine,
    position,
    priority,
    recurrence,
    onCompletion,
    due,
    scheduled,
    start,
    taskId,
    dependsOn,
    subtasks,
    format,
  } = params

  if (!description.trim()) {
    throw new Error("description is empty")
  }
  if (TASK_TEXT_LINE_BREAK_PATTERN.test(description)) {
    throw new Error("description must be a single line")
  }

  // Validate dates
  if (due) {
    validateDate(due, "due")
  }
  if (scheduled) {
    validateDate(scheduled, "scheduled")
  }
  if (start) {
    validateDate(start, "start")
  }

  if (parentBlockId && parentLine) {
    throw new Error("parentBlockId and parentLine are mutually exclusive")
  }
  const parentLocator = parentTaskLocatorFrom({ parentBlockId, parentLine })

  // A sub-task lives wherever its parent lives — a heading has nothing to
  // place, so a parent locator and a heading are exclusive.
  if (parentLocator && heading) {
    throw new Error("parent and heading are mutually exclusive")
  }
  if (dependsOn !== undefined && dependsOn.length === 0) {
    throw new Error("dependsOn cannot be empty")
  }
  assertTaskIdGrammar({ taskId, dependsOn })
  assertRecurrenceRuleGrammar(recurrence)
  if (subtasks?.some((subtaskText) => !subtaskText.trim())) {
    throw new Error("subtasks cannot contain an empty item")
  }
  if (subtasks?.some((subtaskText) => TASK_TEXT_LINE_BREAK_PATTERN.test(subtaskText))) {
    throw new Error("subtasks items must be a single line")
  }

  const fullPath = resolveNotePath({ vaultPath, path })

  return withExclusiveFileLock(fullPath, async () => {
    const fileContent = await readNoteContent({ fullPath, path })
    const parsed = parseNote(fileContent)
    const bodyLines = splitIntoLines(parsed.content)
    const headings = parseHeadings(bodyLines)

    // findBodyStartLine needs the raw file (bodyLines came from the parsed
    // content, which has no frontmatter) to count the frontmatter offset.
    const bodyStartLine = tasks.findBodyStartLine(splitIntoLines(fileContent))

    // Validate block_id grammar and uniqueness
    validateBlockId(blockId, bodyLines)

    const isKanbanBoard = Boolean(parsed.data["kanban-plugin"])
    const pluginConfig = await readTaskFormatConfig(vaultPath)
    const formatConfig = {
      ...pluginConfig,
      taskFormat: format ?? pluginConfig.taskFormat,
    }

    const today = todayIsoDate()

    // Every field is new on create, so each entry reads "(none) → value".
    const metadataFields: ReadonlyArray<{
      field: string
      value: string | null | undefined
    }> = [
      { field: "created", value: today },
      { field: "priority", value: priority },
      { field: "recurrence", value: recurrence },
      { field: "on_completion", value: onCompletion },
      { field: "due", value: due },
      { field: "scheduled", value: scheduled },
      { field: "start", value: start },
      { field: "task_id", value: taskId },
      { field: "depends_on", value: formatDependsOn(dependsOn) },
    ]
    const metadataChanges = metadataFields
      .filter(({ value }) => Boolean(value))
      .map(({ field, value }) => formatChange({ field, before: null, after: value }))

    const {
      insertAt,
      indent,
      heading: resolvedHeading,
    } = resolveNewTaskPlacement({
      bodyLines,
      bodyStartLine,
      headings,
      parentLocator,
      heading,
      isKanbanBoard,
      position,
      statusRegistry: formatConfig.statusRegistry,
    })

    const taskLine = tasks.buildTaskLine(
      {
        description,
        blockId,
        priority,
        recurrence,
        onCompletion,
        created: today,
        start,
        scheduled,
        due,
        taskId,
        dependsOn,
        indent,
      },
      formatConfig,
    )

    const advisories = [
      ...roundTripAdvisories({
        taskLine,
        priorTaskLine: null,
        submitted: {
          description,
          createdDate: today,
          ...(priority && { priority }),
          ...(recurrence && { recurrence }),
          ...(onCompletion && { onCompletion }),
          ...(due && { dueDate: due }),
          ...(scheduled && { scheduledDate: scheduled }),
          ...(start && { startDate: start }),
          ...(taskId && { taskId }),
          ...(dependsOn && { dependsOn }),
        },
      }),
      ...subtaskRoundTripAdvisories(subtasks ?? []),
    ]

    const subtaskIndent = `${indent}  `
    const subtaskTodoChar = tasks.charForStatus("todo", formatConfig.statusRegistry)
    const subtaskLines = (subtasks ?? []).map(
      (subtaskText) => `${subtaskIndent}- [${subtaskTodoChar}] ${subtaskText}`,
    )
    const changes =
      subtaskLines.length > 0
        ? [
            ...metadataChanges,
            formatChange({
              field: "subtasks",
              before: 0,
              after: subtaskLines.length,
            }),
          ]
        : metadataChanges

    const resultLines = bodyLines.toSpliced(insertAt, 0, taskLine, ...subtaskLines)

    // Checklist lines follow the card line, so the first one sits at insertAt + 1
    const subtaskPositions = subtasks?.length
      ? subtaskPositionsFrom({
          bodyStartLine,
          firstBodyIndex: insertAt + 1,
          descriptions: subtasks,
        })
      : undefined

    // Write atomically
    const serialized = stringifyNote(resultLines.join("\n"), parsed.data)
    await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)

    const finalLine = bodyStartLine + insertAt + 1

    logger.info("task created", {
      path,
      line: finalLine,
      blockId,
      heading: resolvedHeading,
      changes,
    })

    return {
      path,
      line: finalLine,
      description,
      block_id: blockId,
      heading: resolvedHeading,
      subtasks: subtaskPositions,
      changes,
      ...(advisories.length > 0 && { advisories }),
    }
  })
}

// ── updateTask ──────────────────────────────────────────────────

/** Applies every requested mutation to a task line in one atomic
 *  read-modify-write cycle. */
const updateTask = async (params: UpdateTaskParams, logger: Logger): Promise<UpdateTaskResult> => {
  const {
    vaultPath,
    path,
    blockId,
    line,
    status,
    priority,
    recurrence,
    onCompletion,
    heading: targetHeadingParam,
    position,
    format,
    description: newDescription,
    due,
    scheduled,
    start,
    created,
    taskId,
    dependsOn,
    addSubtasks,
    assignBlockId: newBlockId,
  } = params

  // Exactly one identifier required
  const identifierCount = [blockId, line].filter(Boolean).length

  if (identifierCount === 0) {
    throw new Error("exactly one of blockId or line is required")
  }
  if (identifierCount > 1) {
    throw new Error("blockId and line are mutually exclusive")
  }

  // At least one mutation required
  const hasMutation =
    status !== undefined ||
    priority !== undefined ||
    recurrence !== undefined ||
    onCompletion !== undefined ||
    targetHeadingParam !== undefined ||
    newDescription !== undefined ||
    due !== undefined ||
    scheduled !== undefined ||
    start !== undefined ||
    created !== undefined ||
    taskId !== undefined ||
    dependsOn !== undefined ||
    addSubtasks !== undefined ||
    newBlockId !== undefined ||
    position !== undefined

  if (!hasMutation) {
    throw new Error(
      "at least one mutation (status, priority, recurrence, onCompletion, heading, position, description, due, scheduled, start, created, taskId, dependsOn, addSubtasks, or assignBlockId) is required",
    )
  }

  // Validate dates
  const dateParams: ReadonlyArray<{
    field: DateFieldKey
    value: string | null | undefined
  }> = [
    { field: "due", value: due },
    { field: "scheduled", value: scheduled },
    { field: "start", value: start },
    { field: "created", value: created },
  ]
  for (const { field, value } of dateParams) {
    if (typeof value === "string") {
      validateDate(value, field)
    }
  }

  if (newDescription !== undefined && !newDescription.trim()) {
    throw new Error("description cannot be empty")
  }
  if (newDescription !== undefined && TASK_TEXT_LINE_BREAK_PATTERN.test(newDescription)) {
    throw new Error("description must be a single line")
  }

  if (addSubtasks !== undefined && addSubtasks.length === 0) {
    throw new Error("addSubtasks cannot be empty")
  }
  if (addSubtasks?.some((subtaskText) => !subtaskText.trim())) {
    throw new Error("addSubtasks cannot contain an empty item")
  }
  if (addSubtasks?.some((subtaskText) => TASK_TEXT_LINE_BREAK_PATTERN.test(subtaskText))) {
    throw new Error("addSubtasks items must be a single line")
  }

  if (Array.isArray(dependsOn) && dependsOn.length === 0) {
    throw new Error("dependsOn cannot be empty (use null to clear)")
  }
  assertTaskIdGrammar({ taskId, dependsOn })
  assertRecurrenceRuleGrammar(recurrence)

  const fullPath = resolveNotePath({ vaultPath, path })

  return withExclusiveFileLock(fullPath, async () => {
    const fileContent = await readNoteContent({ fullPath, path })
    const parsed = parseNote(fileContent)
    const bodyLines = splitIntoLines(parsed.content)
    const headings = parseHeadings(bodyLines)

    // extractTasks uses the same formula (file_line = bodyStartLine +
    // bodyLineIndex + 1), so the offset must match.
    const bodyStartLine = tasks.findBodyStartLine(splitIntoLines(fileContent))

    const taskLineIndex = locateTaskLine({
      bodyLines,
      bodyStartLine,
      blockId,
      line,
      path,
    })
    const originalTaskLine = bodyLines[taskLineIndex]

    if (!originalTaskLine) {
      throw new Error(`task line index ${taskLineIndex} out of bounds`)
    }
    const isKanbanBoard = Boolean(parsed.data["kanban-plugin"])

    // Resolve format config early — the status registry is needed for
    // extractTasks so taskBefore.status reflects custom classifications.
    const pluginConfig = await readTaskFormatConfig(vaultPath)
    const formatConfig = {
      ...pluginConfig,
      taskFormat: format ?? pluginConfig.taskFormat,
    }

    rejectNonTaskCheckbox({
      taskLine: originalTaskLine,
      statusRegistry: formatConfig.statusRegistry,
    })

    // Prior field values, so every `changes` entry can state before → after.
    // Parsed from the whole note so `depth` counts task ancestors the way
    // the index does — raw indentation would call a checklist item under a
    // plain bullet a sub-task while the index lists it as top-level.
    const taskFileLine = bodyStartLine + taskLineIndex + 1
    const taskBefore = tasks
      .extractTasks(fileContent, formatConfig.statusRegistry)
      .find((task) => task.line === taskFileLine)

    if (!taskBefore) {
      throw new Error(`task line index ${taskLineIndex} does not parse as a task`)
    }
    const isSubtask = taskBefore.depth > 0

    // A sub-task's placement is its parent's — neither a heading move
    // nor a position reorder applies.
    if (targetHeadingParam && isSubtask) {
      throw new Error(
        "cannot move a sub-task to a heading — the parent's heading determines placement",
      )
    }
    if (position && isSubtask) {
      throw new Error("cannot reposition a sub-task — the parent's position determines placement")
    }
    if (newBlockId) {
      validateBlockId(newBlockId, bodyLines, taskLineIndex)
    }

    const today = todayIsoDate()

    // In-line edits applied to the task line in order. Description must
    // be last: field edits split at the description/metadata boundary,
    // and a signifier in new description text shifts that boundary.
    const lineEdits: LineEdit[] = [
      ...(status
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.updateTaskLineStatus({
                  taskLine,
                  newStatus: status,
                  today,
                  config: formatConfig,
                })
              },
              change: formatChange({
                field: "status",
                before: taskBefore.status,
                after: status,
              }),
            },
          ]
        : []),
      ...(priority !== undefined
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.updateTaskLinePriority({
                  taskLine,
                  newPriority: priority,
                  config: formatConfig,
                })
              },
              change: formatChange({
                field: "priority",
                before: taskBefore.priority,
                after: priority,
              }),
            },
          ]
        : []),
      ...dateParams.flatMap(({ field, value }) => {
        if (value === undefined) return []
        return [
          {
            apply: (taskLine: string) => {
              return tasks.updateTaskLineDate({
                taskLine,
                field,
                date: value,
                config: formatConfig,
              })
            },
            change: formatChange({
              field,
              before: taskBefore[`${field}Date`],
              after: value,
            }),
          },
        ]
      }),
      ...(recurrence !== undefined
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.updateTaskLineRecurrence({
                  taskLine,
                  recurrenceText: recurrence,
                  config: formatConfig,
                })
              },
              change: formatChange({
                field: "recurrence",
                before: taskBefore.recurrence,
                after: recurrence,
              }),
            },
          ]
        : []),
      ...(onCompletion !== undefined
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.updateTaskLineOnCompletion({
                  taskLine,
                  onCompletion,
                  config: formatConfig,
                })
              },
              change: formatChange({
                field: "on_completion",
                before: taskBefore.onCompletion,
                after: onCompletion,
              }),
            },
          ]
        : []),
      ...(taskId !== undefined
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.updateTaskLineTaskId({
                  taskLine,
                  taskId,
                  config: formatConfig,
                })
              },
              change: formatChange({
                field: "task_id",
                before: taskBefore.taskId,
                after: taskId,
              }),
            },
          ]
        : []),
      ...(dependsOn !== undefined
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.updateTaskLineDependsOn({
                  taskLine,
                  dependsOn,
                  config: formatConfig,
                })
              },
              change: formatChange({
                field: "depends_on",
                before: formatDependsOn(taskBefore.dependsOn),
                after: formatDependsOn(dependsOn),
              }),
            },
          ]
        : []),
      ...(newBlockId
        ? [
            {
              apply: (taskLine: string) => tasks.assignBlockId({ taskLine, blockId: newBlockId }),
              change: formatChange({
                field: "block_id",
                before: taskBefore.blockId,
                after: newBlockId,
              }),
            },
          ]
        : []),
      // The description edit must run last. Every field edit above splits
      // the line at the description/metadata boundary, and a signifier in
      // the NEW description text shifts that boundary — a field edit running
      // after it would strip or duplicate fields inside the caller's prose.
      // With the old description still in place, the boundary stays stable.
      ...(newDescription !== undefined
        ? [
            {
              apply: (taskLine: string) => {
                return tasks.replaceTaskLineDescription({ taskLine, newDescription })
              },
              // The after-value previews the swap on the ORIGINAL line. The
              // field edits above never move the description/metadata
              // boundary (the old description is still in place while they
              // run), so this preview parses the same as the final line.
              change: formatChange({
                field: "description",
                before: taskBefore.description,
                after: tasks.describeTaskLine(
                  tasks.replaceTaskLineDescription({
                    taskLine: originalTaskLine,
                    newDescription,
                  }),
                ),
              }),
            },
          ]
        : []),
    ]
    const editedLine = lineEdits.reduce((taskLine, edit) => edit.apply(taskLine), originalTaskLine)
    // Deduplicate tags that appear in both the description and the metadata
    // tail — the round-trip artifact of the parser's tag re-append.
    const tagDedup = tasks.deduplicateDescriptionTags(editedLine)
    const mutatedLine = tagDedup.taskLine

    // The description edit's after-value previews the swap on the original
    // line, which predates dedup. When dedup strips a metadata tag, the
    // preview re-appends it via describeTaskLine, showing a doubled tag the
    // written line doesn't have. Recompute from the post-dedup line.
    const descriptionChangedAndDeduped = newDescription && tagDedup.deduplicatedTags.length > 0

    const lineChanges = descriptionChangedAndDeduped
      ? lineEdits.map((edit) => {
          // Identify the description entry by its formatted prefix —
          // formatChange produces "description: ..." strings.
          if (edit.change?.startsWith("description:")) {
            return formatChange({
              field: "description",
              before: taskBefore.description,
              after: tasks.describeTaskLine(mutatedLine),
            })
          }
          return edit.change
        })
      : lineEdits.map((edit) => edit.change)

    const tagDedupAdvisories = tagDedup.deduplicatedTags.map((tag) => {
      return `tag: "${tag}" appeared in both the description and the metadata tail — deduplicated to one copy`
    })

    const recurrenceSpawn = resolveRecurrenceSpawn({
      status,
      taskBefore,
      editedTaskLine: mutatedLine,
      today,
      config: formatConfig,
    })

    const linesWithEdits = bodyLines.with(taskLineIndex, mutatedLine)

    // The spawned occurrence is written on the line directly adjacent to
    // the completed task line — above it by default, directly below it
    // with recurrenceOnNextLine — matching how the plugin writes the pair.
    // Below-placement puts the spawn between the completed line and its
    // checklist, so the checklist belongs to the spawn from then on (in
    // Obsidian too) and the later done-lane move takes the completed line
    // alone. The spawn never rides that move: the next instance stays in
    // the source lane.
    const spawnInsertIndex = formatConfig.recurrenceOnNextLine ? taskLineIndex + 1 : taskLineIndex
    const linesWithSpawn =
      recurrenceSpawn.kind === "spawn"
        ? linesWithEdits.toSpliced(spawnInsertIndex, 0, recurrenceSpawn.spawnedLine)
        : linesWithEdits
    const completedIndexAfterSpawn =
      recurrenceSpawn.kind === "spawn" && !formatConfig.recurrenceOnNextLine
        ? taskLineIndex + 1
        : taskLineIndex

    // The spawn insert shifts every heading below it by one line — the lane
    // move must see re-parsed positions or it lands on a stale boundary.
    const headingsAfterSpawn =
      recurrenceSpawn.kind === "spawn" ? parseHeadings(linesWithSpawn) : headings

    const roundTripAndSubtaskAdvisories = [
      ...roundTripAdvisories({
        taskLine: mutatedLine,
        priorTaskLine: originalTaskLine,
        submitted: {
          ...(newDescription !== undefined && { description: newDescription }),
          ...(priority !== undefined && { priority }),
          ...(due !== undefined && { dueDate: due }),
          ...(scheduled !== undefined && { scheduledDate: scheduled }),
          ...(start !== undefined && { startDate: start }),
          ...(created !== undefined && { createdDate: created }),
          ...(taskId !== undefined && { taskId }),
          ...(dependsOn !== undefined && { dependsOn }),
          ...(recurrence !== undefined && { recurrence }),
          ...(onCompletion !== undefined && { onCompletion }),
          ...statusImpliedDateFields({ status, config: formatConfig, today }),
        },
      }),
      ...subtaskRoundTripAdvisories(addSubtasks ?? []),
      ...tagDedupAdvisories,
    ]

    const advisories = [
      ...(recurrenceSpawn.kind === "advisory" ? [recurrenceSpawn.advisory] : []),
      ...roundTripAndSubtaskAdvisories,
    ]

    // onCompletion "delete": the Tasks plugin removes the completed
    // instance when the field says "delete". Only on a genuine transition
    // to done — not on updates to an already-done task, and not on
    // cancellation. When the task also recurs, the spawn has already
    // inserted the next occurrence into linesWithSpawn above — only the
    // completed line (and its children) is removed; the spawn survives.
    // When onCompletion is submitted in the same call, the submitted
    // value takes precedence — setting "keep" while completing a "delete"
    // task must not delete the task.
    const effectiveOnCompletion =
      onCompletion !== undefined ? onCompletion : taskBefore.onCompletion
    // Registry lookup mirrors resolveRecurrenceSpawn's belt-and-suspenders
    // guard — taskBefore.status already reflects the registry.
    const shouldDeleteOnCompletion =
      status === "done" &&
      taskBefore.status !== "done" &&
      formatConfig.statusRegistry.get(taskBefore.statusChar) !== "done" &&
      effectiveOnCompletion?.toLowerCase() === "delete"

    if (shouldDeleteOnCompletion) {
      const taskBlockEnd = findTaskBlockEnd(linesWithSpawn, completedIndexAfterSpawn)
      const deleteCount = taskBlockEnd - completedIndexAfterSpawn
      const childCount = deleteCount - 1
      const childLabel = childCount === 1 ? "child" : "children"
      const deletionChange =
        childCount > 0
          ? `on_completion: task and ${childCount} ${childLabel} removed (🏁 delete)`
          : "on_completion: task removed (🏁 delete)"

      // When the task also spawned, compute the spawn's final position
      // after the completed block is removed from linesWithSpawn.
      const spawnFinalIndexAfterDelete =
        recurrenceSpawn.kind === "spawn" && completedIndexAfterSpawn < spawnInsertIndex
          ? spawnInsertIndex - deleteCount
          : spawnInsertIndex

      const nextOccurrence: NextOccurrencePosition | undefined =
        recurrenceSpawn.kind === "spawn"
          ? buildNextOccurrencePosition({
              bodyStartLine,
              spawnIndex: spawnFinalIndexAfterDelete,
              recurrenceSpawn,
            })
          : undefined

      const changes = [
        ...lineChanges,
        ...(nextOccurrence
          ? [
              formatChange({
                field: "next_occurrence",
                before: null,
                after: `line ${nextOccurrence.line}`,
              }),
            ]
          : []),
        deletionChange,
      ]

      const resultLines = linesWithSpawn.toSpliced(completedIndexAfterSpawn, deleteCount)

      const serialized = stringifyNote(resultLines.join("\n"), parsed.data)
      await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)

      const headingBefore = headingsAfterSpawn.findLast(
        (heading) => heading.startLine < completedIndexAfterSpawn,
      )

      logger.info("task deleted on completion", {
        path,
        line: bodyStartLine + completedIndexAfterSpawn + 1,
        onCompletion: "delete",
        childrenRemoved: childCount,
      })

      return {
        path,
        line: bodyStartLine + completedIndexAfterSpawn + 1,
        description: tasks.describeTaskLine(mutatedLine),
        block_id: taskBefore.blockId ?? undefined,
        heading: headingBefore?.text,
        next_occurrence: nextOccurrence,
        changes,
        // Round-trip advisories are about a line that no longer exists —
        // drop them. Recurrence advisories ("rule unreadable, no spawn")
        // matter because the caller needs to know the chain broke.
        ...(recurrenceSpawn.kind === "advisory" && {
          advisories: [recurrenceSpawn.advisory],
        }),
        on_completion_applied: "delete",
      }
    }

    // Three paths resolve the target lane:
    //   1. Explicit heading param — the caller picks the destination.
    //   2. Auto-done-lane — completing a top-level Kanban card with no
    //      explicit heading detects the board's done lane.
    //   3. Same-lane reorder — position without a heading or auto-done
    //      resolves the card's current heading so it stays in place.
    const autoDoneLane = !targetHeadingParam && status === "done" && isKanbanBoard && !isSubtask
    // Path 3: look up the card's current heading for a position-only reorder.
    // Kept as a HeadingInfo (not .text) so an empty-named heading is not
    // misread as "above all headings."
    const currentHeadingForReorder =
      !targetHeadingParam && !autoDoneLane && position
        ? headingsAfterSpawn.findLast((heading) => heading.startLine < completedIndexAfterSpawn)
        : undefined

    if (!targetHeadingParam && !autoDoneLane && position && !currentHeadingForReorder) {
      throw new Error("cannot reorder a task that sits above the first heading — pass a heading")
    }

    // Pre-spawn position for accurate before/after reporting — the spawn
    // may add a card to the lane, inflating the count. Applies to all three
    // move paths (explicit heading, auto-done, same-lane) when an integer
    // position is requested and the task has a heading to count against.
    const preSpawnHeading =
      recurrenceSpawn.kind === "spawn" && position
        ? headings.findLast((heading) => heading.startLine < taskLineIndex)
        : undefined
    const beforePositionInLane = preSpawnHeading
      ? positionOfTaskInLane({
          lines: linesWithEdits,
          heading: preSpawnHeading,
          taskLineIndex,
          statusRegistry: formatConfig.statusRegistry,
        })
      : undefined

    const targetLane = autoDoneLane
      ? detectDoneLane(linesWithSpawn, headingsAfterSpawn)
      : (targetHeadingParam ?? currentHeadingForReorder?.text)
    const noMoveChanges: string[] = []
    // Gate on presence, not truthiness — an empty-string heading text
    // ("## ") is a valid lane name and must trigger the move.
    const moved =
      targetLane !== undefined
        ? moveTaskBlock({
            lines: linesWithSpawn,
            taskLineIndex: completedIndexAfterSpawn,
            targetLane,
            headings: headingsAfterSpawn,
            statusRegistry: formatConfig.statusRegistry,
            ...(position && { position }),
            ...(beforePositionInLane !== undefined && { beforePosition: beforePositionInLane }),
          })
        : {
            lines: linesWithSpawn,
            taskLineIndex: completedIndexAfterSpawn,
            changes: noMoveChanges,
            movedBlockLength: undefined,
          }

    // Checklist items go after every parent-line edit and the move, so they
    // land under the card's final position.
    const withSubtasks = addSubtasks
      ? appendSubtasks({
          lines: moved.lines,
          taskLineIndex: moved.taskLineIndex,
          descriptions: addSubtasks,
          bodyStartLine,
          statusRegistry: formatConfig.statusRegistry,
        })
      : { lines: moved.lines, subtaskPositions: undefined, change: undefined }

    const resultLines = withSubtasks.lines
    const finalTaskIndex = moved.taskLineIndex
    const subtaskPositions = withSubtasks.subtaskPositions

    const moveSplice =
      moved.movedBlockLength !== undefined
        ? {
            moveStart: completedIndexAfterSpawn,
            movedBlockLength: moved.movedBlockLength,
            insertAt: moved.taskLineIndex,
          }
        : undefined
    const firstSubtaskPosition = subtaskPositions?.at(0)
    const checklistSplice =
      firstSubtaskPosition && addSubtasks
        ? {
            insertIndex: firstSubtaskPosition.line - bodyStartLine - 1,
            lineCount: addSubtasks.length,
          }
        : undefined
    const spawnFinalIndex =
      recurrenceSpawn.kind === "spawn"
        ? spawnIndexAfterSplices({
            spawnIndex: spawnInsertIndex,
            doneLaneMove: moveSplice,
            subtaskAppend: checklistSplice,
          })
        : undefined

    const nextOccurrence: NextOccurrencePosition | undefined =
      recurrenceSpawn.kind === "spawn" && spawnFinalIndex !== undefined
        ? buildNextOccurrencePosition({
            bodyStartLine,
            spawnIndex: spawnFinalIndex,
            recurrenceSpawn,
          })
        : undefined

    const changes = [
      ...lineChanges,
      ...moved.changes,
      withSubtasks.change,
      ...(nextOccurrence
        ? [
            formatChange({
              field: "next_occurrence",
              before: null,
              after: `line ${nextOccurrence.line}`,
            }),
          ]
        : []),
    ].filter((change) => change !== undefined)

    // Write atomically
    const serialized = stringifyNote(resultLines.join("\n"), parsed.data)
    await atomicWriteFile({ filePath: fullPath, content: serialized }, logger)

    const finalLine = bodyStartLine + finalTaskIndex + 1
    const finalTaskLine = resultLines[finalTaskIndex] ?? mutatedLine
    // Trimmed-end per BLOCK_LINK_RE's contract: a heading-only move splices
    // the raw line, and a trailing hard break would hide the anchored match.
    const finalBlockId = tasks.BLOCK_LINK_RE.exec(finalTaskLine.trimEnd())?.[1]
    const finalHeading = parseHeadings(resultLines).findLast(
      (heading) => heading.startLine < finalTaskIndex,
    )

    logger.info("task updated", {
      path,
      line: finalLine,
      changes,
    })

    return {
      path,
      line: finalLine,
      description: tasks.describeTaskLine(finalTaskLine),
      block_id: finalBlockId,
      heading: finalHeading?.text,
      subtasks: subtaskPositions,
      next_occurrence: nextOccurrence,
      changes,
      ...(advisories.length > 0 && { advisories }),
    }
  })
}

// ── Public surface ──────────────────────────────────────────────

export const taskMutations = {
  createTask,
  updateTask,
}
