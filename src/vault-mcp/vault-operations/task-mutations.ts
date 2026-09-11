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
import {
  parseHeadings,
  type HeadingInfo,
} from "../obsidian-markdown/headings.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { tasks } from "../obsidian-markdown/tasks.js"
import type {
  TaskStatus,
  TaskPriority,
  DateFieldKey,
  ParsedTask,
} from "../obsidian-markdown/tasks.js"
import {
  parseRecurrenceRule,
  nextOccurrenceDates,
  type NextOccurrenceDates,
} from "../obsidian-markdown/recurrence.js"
import {
  readTaskFormatConfig,
  type TaskFormatConfig,
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
  position?: "top" | "bottom" | undefined
  priority?: TaskPriority | undefined
  recurrence?: string | undefined
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
}

type UpdateTaskParams = {
  vaultPath: string
  path: string
  blockId?: string | undefined
  line?: number | undefined
  status?: TaskStatus | undefined
  priority?: TaskPriority | null | undefined
  recurrence?: string | null | undefined
  heading?: string | undefined
  position?: "top" | "bottom" | undefined
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
  /** Non-blocking notices about the write — omitted when there are none. */
  advisories?: string[] | undefined
  changes: string[]
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
const formatDependsOn = (
  dependsOn: readonly string[] | null | undefined,
): string | null => {
  if (!dependsOn || dependsOn.length === 0) return null
  return dependsOn.join(",")
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
    line: bodyStartLine + firstBodyIndex + offset + 1,
    description,
  }))
}

// ── Shared constants ────────────────────────────────────────────

const BLOCK_ID_RE = /^[a-zA-Z0-9-]+$/

// ── Internal helpers ────────────────────────────────────────────

/** Resolves a note path for mutation — `.md` extension + vault-root safety.
 *  No I/O: the note is read once, inside the file lock. */
const resolveNotePath = ({
  vaultPath,
  path,
}: {
  vaultPath: string
  path: string
}): string => {
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
const findTaskBlockEnd = (
  lines: readonly string[],
  taskLineIndex: number,
): number => {
  const taskLine = lines[taskLineIndex]
  if (!taskLine) return taskLineIndex + 1

  // Structural indent — blockquote markers stripped, the same measure the
  // parser uses for depth, so a quoted card's block matches its sub-tasks.
  const taskIndent = tasks.getTaskIndent(taskLine)
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
  const parentPrefix =
    LIST_ITEM_PREFIX_RE.exec(lines[parentLineIndex] ?? "")?.[0] ?? ""
  const blockEnd = findTaskBlockEnd(lines, parentLineIndex)
  const firstChildIndex = parentLineIndex + 1
  const hasExistingChildren = firstChildIndex < blockEnd
  const firstChild = hasExistingChildren ? lines[firstChildIndex] : undefined
  const firstChildPrefix = firstChild?.trim()
    ? LIST_ITEM_PREFIX_RE.exec(firstChild)?.[0]
    : undefined
  return firstChildPrefix ?? `${parentPrefix}  `
}

/** Top-of-section insertion index: the heading's body start, or just past
 *  a `**Complete**` marker — inserting above the marker would break
 *  done-lane detection on later reads. */
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
  return firstContent === "**Complete**"
    ? firstContentIndex + 1
    : heading.bodyStartLine
}

/** Bottom-of-section insertion index: after the last non-blank line in
 *  the section body, so the task appends to the existing content without
 *  trailing blank-line gaps. Falls back to bodyStartLine for empty sections. */
const taskAppendIndexUnderHeading = ({
  lines,
  heading,
}: {
  lines: readonly string[]
  heading: HeadingInfo
}): number => {
  const sectionLines = lines.slice(heading.bodyStartLine, heading.bodyEndLine)
  const lastContentOffset = sectionLines.findLastIndex(
    (line) => line.trim() !== "",
  )
  if (lastContentOffset === -1) return heading.bodyStartLine
  return heading.bodyStartLine + lastContentOffset + 1
}

const headingInsertIndex = ({
  lines,
  heading,
  position,
}: {
  lines: readonly string[]
  heading: HeadingInfo
  position: "top" | "bottom"
}): number => {
  return position === "top"
    ? taskInsertIndexUnderHeading({ lines, heading })
    : taskAppendIndexUnderHeading({ lines, heading })
}

/** Resolves the effective insertion position for a new task under a heading.
 *  Priority: explicit param > Kanban setting > context default. */
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
}: {
  bodyLines: readonly string[]
  bodyStartLine: number
  headings: readonly HeadingInfo[]
  parentLocator: ParentLocator | undefined
  heading: string | undefined
  isKanbanBoard: boolean
  position: "top" | "bottom" | undefined
}): NewTaskPlacement => {
  if (parentLocator) {
    const parentLineIndex = findParentLineIndex({
      locator: parentLocator,
      bodyLines,
      bodyStartLine,
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
    const targetHeading = headings.find(
      (headingInfo) => headingInfo.text === heading,
    )
    if (!targetHeading) {
      const availableHeadings = headings
        .map((headingInfo) => headingInfo.text)
        .join(", ")
      throw new Error(
        `heading "${heading}" not found; available: ${availableHeadings}`,
      )
    }
    const resolvedPosition = resolveCreatePosition({
      explicitPosition: position,
      isKanbanBoard,
      bodyLines,
    })
    return {
      insertAt: headingInsertIndex({
        lines: bodyLines,
        heading: targetHeading,
        position: resolvedPosition,
      }),
      indent: "",
      heading,
    }
  }
  if (isKanbanBoard) {
    throw new Error(
      "heading required for Kanban boards (note has kanban-plugin frontmatter)",
    )
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
    const foundIndex = tasks.findTaskByBlockId(bodyLines, blockId)
    if (foundIndex === null) {
      throw new Error(`blockId "${blockId}" not found in "${path}"`)
    }
    return foundIndex
  }
  if (!line) {
    throw new Error("exactly one of blockId or line is required")
  }
  const taskLineIndex = line - 1 - bodyStartLine
  const taskLineText = bodyLines[taskLineIndex]
  if (taskLineIndex < 0 || !taskLineText || !tasks.isTaskLine(taskLineText)) {
    throw new Error(`no task at line ${line}`)
  }
  return taskLineIndex
}

/** Moves a task line and its indented sub-items under another heading.
 *  Returns the lines unchanged, with no `change`, when the task already
 *  sits under that heading. */
const moveTaskBlock = ({
  lines,
  taskLineIndex,
  targetLane,
  headings,
  position = "top",
}: {
  lines: readonly string[]
  taskLineIndex: number
  targetLane: string
  headings: readonly HeadingInfo[]
  position?: "top" | "bottom"
}): {
  lines: readonly string[]
  taskLineIndex: number
  change?: string
  /** Lines the move relocated (task + sub-items) — how far the splices
   *  shifted every line between the block's old and new positions. Absent
   *  when the task already sat in the target lane and nothing moved. */
  movedBlockLength?: number
} => {
  const targetHeading = headings.find((heading) => heading.text === targetLane)
  if (!targetHeading) {
    const availableHeadings = headings.map((heading) => heading.text).join(", ")
    throw new Error(
      `heading "${targetLane}" not found; available: ${availableHeadings}`,
    )
  }

  const currentHeading = headings.findLast(
    (heading) => heading.startLine < taskLineIndex,
  )
  const currentLane = currentHeading?.text ?? "(before first heading)"
  if (currentLane === targetLane) return { lines, taskLineIndex }

  const taskBlockEnd = findTaskBlockEnd(lines, taskLineIndex)
  const taskBlock = lines.slice(taskLineIndex, taskBlockEnd)
  const linesWithoutBlock = lines.toSpliced(
    taskLineIndex,
    taskBlockEnd - taskLineIndex,
  )

  // Heading positions shift once the block is gone — re-parse before placing
  const headingAfterRemoval = parseHeadings(linesWithoutBlock).find(
    (heading) => heading.text === targetLane,
  )
  if (!headingAfterRemoval) {
    throw new Error(`heading "${targetLane}" not found after line removal`)
  }
  const insertAt = headingInsertIndex({
    lines: linesWithoutBlock,
    heading: headingAfterRemoval,
    position,
  })
  return {
    lines: linesWithoutBlock.toSpliced(insertAt, 0, ...taskBlock),
    taskLineIndex: insertAt,
    change: formatChange({
      field: "heading",
      before: currentLane,
      after: targetLane,
    }),
    movedBlockLength: taskBlock.length,
  }
}

/** Appends checklist items under a task, after its existing sub-items. */
const appendSubtasks = ({
  lines,
  taskLineIndex,
  descriptions,
  bodyStartLine,
}: {
  lines: readonly string[]
  taskLineIndex: number
  descriptions: readonly string[]
  bodyStartLine: number
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
  const subtaskLines = descriptions.map(
    (subtaskText) => `${subtaskIndent}- [ ] ${subtaskText}`,
  )
  const existingSubtaskCount = lines
    .slice(taskLineIndex + 1, blockEnd)
    .filter((blockLine) => tasks.isTaskLine(blockLine)).length
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

  const wasAlreadyDone =
    taskBefore.status === "done" ||
    config.doneStatusSymbols.includes(taskBefore.statusChar)
  if (wasAlreadyDone) return { kind: "none" }

  const editedTask = tasks.extractTasks(editedTaskLine).at(0)
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

/** The spawned line's index after the done-lane move's two splices (block
 *  removal, then reinsertion under the target heading) — tracked
 *  arithmetically, never by content search: a vault can hold two
 *  byte-identical recurring lines, and a search would find the wrong one. */
const spawnIndexAfterMove = ({
  spawnIndex,
  moveStart,
  movedBlockLength,
  insertAt,
}: {
  spawnIndex: number
  moveStart: number
  movedBlockLength: number
  insertAt: number
}): number => {
  const indexAfterRemoval =
    spawnIndex < moveStart ? spawnIndex : spawnIndex - movedBlockLength
  return insertAt <= indexAfterRemoval
    ? indexAfterRemoval + movedBlockLength
    : indexAfterRemoval
}

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
    if (!lane) throw new Error("unexpected empty done lanes")
    return lane
  }

  // Fallback: look for a heading named "Done"
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
  const existingIndex = bodyLines.findIndex(
    (bodyLine, index) =>
      index !== excludeLineIndex && bodyLine.endsWith(` ^${blockId}`),
  )
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
  const invalidDependency = dependsOn?.find(
    (dependencyId) => !tasks.isTaskId(dependencyId),
  )
  if (invalidDependency !== undefined) {
    throw new Error(
      `dependsOn entry "${invalidDependency}" contains invalid characters (allowed: letters, digits, hyphens, underscores)`,
    )
  }
}

/** Rejects a recurrence rule the plugin's grammar cannot read — written
 *  as-is it would parse as a recurrence that silently never recurs. */
const assertRecurrenceRuleGrammar = (
  recurrenceText: string | null | undefined,
): void => {
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

type ParentLocator =
  { kind: "blockId"; blockId: string } | { kind: "line"; line: number }

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

/** Returns the parent's body-line index; throws when the locator resolves to nothing or to a non-task line. */
const findParentLineIndex = ({
  locator,
  bodyLines,
  bodyStartLine,
}: {
  locator: ParentLocator
  bodyLines: readonly string[]
  bodyStartLine: number
}): number => {
  if (locator.kind === "blockId") {
    const foundIndex = tasks.findTaskByBlockId(bodyLines, locator.blockId)
    if (foundIndex === null) {
      throw new Error(`parent task not found: blockId "${locator.blockId}"`)
    }
    return foundIndex
  }
  const parentLineIndex = locator.line - 1 - bodyStartLine
  const parentLineText = bodyLines[parentLineIndex]
  if (!parentLineText || !tasks.isTaskLine(parentLineText)) {
    throw new Error(`parent task not found: line ${locator.line}`)
  }
  return parentLineIndex
}

// ── createTask ──────────────────────────────────────────────────

const createTask = async (
  params: CreateTaskParams,
  logger: Logger,
): Promise<CreateTaskResult> => {
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
  if (due) validateDate(due, "due")
  if (scheduled) validateDate(scheduled, "scheduled")
  if (start) validateDate(start, "start")

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
  if (
    subtasks?.some((subtaskText) =>
      TASK_TEXT_LINE_BREAK_PATTERN.test(subtaskText),
    )
  ) {
    throw new Error("subtasks items must be a single line")
  }

  const fullPath = resolveNotePath({ vaultPath, path })

  return withExclusiveFileLock(fullPath, async () => {
    const fileContent = await readNoteContent({ fullPath, path })
    const parsed = parseNote(fileContent)
    const bodyLines = splitIntoLines(parsed.content)
    const headings = parseHeadings(bodyLines)

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
      { field: "due", value: due },
      { field: "scheduled", value: scheduled },
      { field: "start", value: start },
      { field: "task_id", value: taskId },
      { field: "depends_on", value: formatDependsOn(dependsOn) },
    ]
    const metadataChanges = metadataFields
      .filter(({ value }) => Boolean(value))
      .map(({ field, value }) =>
        formatChange({ field, before: null, after: value }),
      )

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
    })

    const taskLine = tasks.buildTaskLine(
      {
        description,
        blockId,
        priority,
        recurrence,
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

    const subtaskIndent = `${indent}  `
    const subtaskLines = (subtasks ?? []).map(
      (subtaskText) => `${subtaskIndent}- [ ] ${subtaskText}`,
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

    const resultLines = bodyLines.toSpliced(
      insertAt,
      0,
      taskLine,
      ...subtaskLines,
    )

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
    }
  })
}

// ── updateTask ──────────────────────────────────────────────────

/** Applies every requested mutation to a task line in one atomic
 *  read-modify-write cycle. */
const updateTask = async (
  params: UpdateTaskParams,
  logger: Logger,
): Promise<UpdateTaskResult> => {
  const {
    vaultPath,
    path,
    blockId,
    line,
    status,
    priority,
    recurrence,
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

  // Validation: exactly one identifier
  const identifierCount = (blockId ? 1 : 0) + (line ? 1 : 0)
  if (identifierCount === 0) {
    throw new Error("exactly one of blockId or line is required")
  }
  if (identifierCount > 1) {
    throw new Error("blockId and line are mutually exclusive")
  }

  // Validation: at least one mutation
  const hasMutation =
    status !== undefined ||
    priority !== undefined ||
    recurrence !== undefined ||
    targetHeadingParam !== undefined ||
    newDescription !== undefined ||
    due !== undefined ||
    scheduled !== undefined ||
    start !== undefined ||
    created !== undefined ||
    taskId !== undefined ||
    dependsOn !== undefined ||
    addSubtasks !== undefined ||
    newBlockId !== undefined
  if (!hasMutation) {
    throw new Error(
      "at least one mutation (status, priority, recurrence, heading, description, due, scheduled, start, created, taskId, dependsOn, addSubtasks, or assignBlockId) is required",
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
    if (typeof value === "string") validateDate(value, field)
  }

  if (newDescription !== undefined && !newDescription.trim()) {
    throw new Error("description cannot be empty")
  }
  if (
    newDescription !== undefined &&
    TASK_TEXT_LINE_BREAK_PATTERN.test(newDescription)
  ) {
    throw new Error("description must be a single line")
  }

  if (addSubtasks !== undefined && addSubtasks.length === 0) {
    throw new Error("addSubtasks cannot be empty")
  }
  if (addSubtasks?.some((subtaskText) => !subtaskText.trim())) {
    throw new Error("addSubtasks cannot contain an empty item")
  }
  if (
    addSubtasks?.some((subtaskText) =>
      TASK_TEXT_LINE_BREAK_PATTERN.test(subtaskText),
    )
  ) {
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

    // Frontmatter offset — extractTasks uses the same formula:
    // file_line = bodyStartLine + bodyLineIndex + 1.
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
    // Prior field values, so every `changes` entry can state before → after.
    // Parsed from the whole note so `depth` counts task ancestors the way
    // the index does — raw indentation would call a checklist item under a
    // plain bullet a sub-task while the index lists it as top-level.
    const taskFileLine = bodyStartLine + taskLineIndex + 1
    const taskBefore = tasks
      .extractTasks(fileContent)
      .find((task) => task.line === taskFileLine)
    if (!taskBefore) {
      throw new Error(
        `task line index ${taskLineIndex} does not parse as a task`,
      )
    }
    const isSubtask = taskBefore.depth > 0

    // A sub-task's placement is its parent's — an explicit heading has
    // nothing to move.
    if (targetHeadingParam && isSubtask) {
      throw new Error(
        "cannot move a sub-task to a heading — the parent's heading determines placement",
      )
    }
    if (newBlockId) {
      validateBlockId(newBlockId, bodyLines, taskLineIndex)
    }

    // Resolve format config: explicit param > plugin config > emoji default
    const pluginConfig = await readTaskFormatConfig(vaultPath)
    const formatConfig = {
      ...pluginConfig,
      taskFormat: format ?? pluginConfig.taskFormat,
    }

    const today = todayIsoDate()

    // In-line edits. Metadata edits (status included) apply first and the
    // description edit applies LAST: every metadata edit splits the line at
    // the description/metadata boundary, and prose in a new description can
    // be indistinguishable from trailing metadata — a splitting edit running
    // after the description edit could rewrite what the caller typed. The
    // recurrence spawn reads the fully edited line (its gate uses the
    // pre-edit parse, and the spawned copy strips completion dates itself),
    // so an update that changes dates or the rule and completes in one call
    // advances from the edited values. Each edit carries its own `changes`
    // entry; description's after-value is read through the parser so tags
    // match the result's `description`.
    const descriptionEdit: LineEdit | undefined =
      newDescription !== undefined
        ? {
            apply: (taskLine: string) =>
              tasks.replaceTaskLineDescription({ taskLine, newDescription }),
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
          }
        : undefined
    const statusEdit: LineEdit | undefined = status
      ? {
          apply: (taskLine: string) =>
            tasks.updateTaskLineStatus({
              taskLine,
              newStatus: status,
              today,
              config: formatConfig,
            }),
          change: formatChange({
            field: "status",
            before: taskBefore.status,
            after: status,
          }),
        }
      : undefined
    const priorityEdit: LineEdit | undefined =
      priority !== undefined
        ? {
            apply: (taskLine: string) =>
              tasks.updateTaskLinePriority({
                taskLine,
                newPriority: priority,
                config: formatConfig,
              }),
            change: formatChange({
              field: "priority",
              before: taskBefore.priority,
              after: priority,
            }),
          }
        : undefined
    const dateEdits: LineEdit[] = dateParams.flatMap(({ field, value }) =>
      value === undefined
        ? []
        : [
            {
              apply: (taskLine: string) =>
                tasks.updateTaskLineDate({
                  taskLine,
                  field,
                  date: value,
                  config: formatConfig,
                }),
              change: formatChange({
                field,
                before: taskBefore[`${field}Date`],
                after: value,
              }),
            },
          ],
    )
    const recurrenceEdit: LineEdit | undefined =
      recurrence !== undefined
        ? {
            apply: (taskLine: string) =>
              tasks.updateTaskLineRecurrence({
                taskLine,
                recurrenceText: recurrence,
                config: formatConfig,
              }),
            change: formatChange({
              field: "recurrence",
              before: taskBefore.recurrence,
              after: recurrence,
            }),
          }
        : undefined
    const taskIdEdit: LineEdit | undefined =
      taskId !== undefined
        ? {
            apply: (taskLine: string) =>
              tasks.updateTaskLineTaskId({
                taskLine,
                taskId,
                config: formatConfig,
              }),
            change: formatChange({
              field: "task_id",
              before: taskBefore.taskId,
              after: taskId,
            }),
          }
        : undefined
    const dependsOnEdit: LineEdit | undefined =
      dependsOn !== undefined
        ? {
            apply: (taskLine: string) =>
              tasks.updateTaskLineDependsOn({
                taskLine,
                dependsOn,
                config: formatConfig,
              }),
            change: formatChange({
              field: "depends_on",
              before: formatDependsOn(taskBefore.dependsOn),
              after: formatDependsOn(dependsOn),
            }),
          }
        : undefined
    const blockIdEdit: LineEdit | undefined = newBlockId
      ? {
          apply: (taskLine: string) =>
            tasks.assignBlockId({ taskLine, blockId: newBlockId }),
          change: formatChange({
            field: "block_id",
            before: taskBefore.blockId,
            after: newBlockId,
          }),
        }
      : undefined

    const orderedEdits = [
      priorityEdit,
      ...dateEdits,
      recurrenceEdit,
      taskIdEdit,
      dependsOnEdit,
      blockIdEdit,
      statusEdit,
      descriptionEdit,
    ].filter((edit) => edit !== undefined)
    const mutatedLine = orderedEdits.reduce(
      (taskLine, edit) => edit.apply(taskLine),
      originalTaskLine,
    )

    // `changes` keeps its documented order (description first, status
    // second) regardless of the application order above.
    const lineChanges = [
      descriptionEdit,
      statusEdit,
      priorityEdit,
      ...dateEdits,
      recurrenceEdit,
      taskIdEdit,
      dependsOnEdit,
      blockIdEdit,
    ]
      .filter((edit) => edit !== undefined)
      .map((edit) => edit.change)

    const recurrenceSpawn = resolveRecurrenceSpawn({
      status,
      taskBefore,
      editedTaskLine: mutatedLine,
      today,
      config: formatConfig,
    })

    const linesWithEdits = bodyLines.with(taskLineIndex, mutatedLine)

    // The spawned occurrence is written adjacent to the completed line —
    // above it by default, below with recurrenceOnNextLine — and never
    // rides the done-lane move: a recurring card's next instance stays in
    // the source lane. Adjacency is plugin parity: with recurrenceOnNextLine
    // the pair is completed-then-spawn, so the completed card's checklist
    // sits structurally under the SPAWN — in Obsidian too — and the
    // done-lane move takes the completed line alone, leaving the checklist
    // with the next occurrence in the source lane.
    const spawnInsertIndex = formatConfig.recurrenceOnNextLine
      ? taskLineIndex + 1
      : taskLineIndex
    const linesWithSpawn =
      recurrenceSpawn.kind === "spawn"
        ? linesWithEdits.toSpliced(
            spawnInsertIndex,
            0,
            recurrenceSpawn.spawnedLine,
          )
        : linesWithEdits
    const completedIndexAfterSpawn =
      recurrenceSpawn.kind === "spawn" && !formatConfig.recurrenceOnNextLine
        ? taskLineIndex + 1
        : taskLineIndex

    // The spawn insert shifts every heading below it by one line — the lane
    // move must see re-parsed positions or it lands on a stale boundary.
    const headingsAfterSpawn =
      recurrenceSpawn.kind === "spawn"
        ? parseHeadings(linesWithSpawn)
        : headings

    // Heading move — an explicit heading, or the done lane when completing
    // a top-level card on a Kanban board.
    const autoDoneLane =
      !targetHeadingParam && status === "done" && isKanbanBoard && !isSubtask
    const targetLane = autoDoneLane
      ? detectDoneLane(linesWithSpawn, headingsAfterSpawn)
      : targetHeadingParam
    const moved = targetLane
      ? moveTaskBlock({
          lines: linesWithSpawn,
          taskLineIndex: completedIndexAfterSpawn,
          targetLane,
          headings: headingsAfterSpawn,
          position: position ?? "top",
        })
      : {
          lines: linesWithSpawn,
          taskLineIndex: completedIndexAfterSpawn,
          change: undefined,
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
        })
      : { lines: moved.lines, subtaskPositions: undefined, change: undefined }

    const resultLines = withSubtasks.lines
    const finalTaskIndex = moved.taskLineIndex
    const subtaskPositions = withSubtasks.subtaskPositions

    // The spawned line's final index, adjusted through the lane move's
    // splices and the checklist insert (which shifts it only when the
    // checklist lands at or above it — the on-next-line case).
    const spawnIndexUnmoved =
      recurrenceSpawn.kind === "spawn" ? spawnInsertIndex : undefined
    const spawnIndexPostMove =
      spawnIndexUnmoved !== undefined && moved.movedBlockLength !== undefined
        ? spawnIndexAfterMove({
            spawnIndex: spawnIndexUnmoved,
            moveStart: completedIndexAfterSpawn,
            movedBlockLength: moved.movedBlockLength,
            insertAt: moved.taskLineIndex,
          })
        : spawnIndexUnmoved
    const firstSubtaskPosition = subtaskPositions?.at(0)
    const subtaskInsertIndex = firstSubtaskPosition
      ? firstSubtaskPosition.line - bodyStartLine - 1
      : undefined
    const spawnFinalIndex =
      spawnIndexPostMove !== undefined &&
      subtaskInsertIndex !== undefined &&
      subtaskInsertIndex <= spawnIndexPostMove
        ? spawnIndexPostMove + (addSubtasks?.length ?? 0)
        : spawnIndexPostMove

    const nextOccurrence: NextOccurrencePosition | undefined =
      recurrenceSpawn.kind === "spawn" && spawnFinalIndex !== undefined
        ? {
            line: bodyStartLine + spawnFinalIndex + 1,
            description: tasks.describeTaskLine(recurrenceSpawn.spawnedLine),
            ...(recurrenceSpawn.nextDates.dueDate
              ? { due: recurrenceSpawn.nextDates.dueDate }
              : {}),
            ...(recurrenceSpawn.nextDates.scheduledDate
              ? { scheduled: recurrenceSpawn.nextDates.scheduledDate }
              : {}),
            ...(recurrenceSpawn.nextDates.startDate
              ? { start: recurrenceSpawn.nextDates.startDate }
              : {}),
          }
        : undefined

    const changes = [
      ...lineChanges,
      moved.change,
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
    const finalBlockId = tasks.BLOCK_LINK_RE.exec(finalTaskLine)?.[1]
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
      advisories:
        recurrenceSpawn.kind === "advisory"
          ? [recurrenceSpawn.advisory]
          : undefined,
      changes,
    }
  })
}

// ── Public surface ──────────────────────────────────────────────

export const taskMutations = {
  createTask,
  updateTask,
}
