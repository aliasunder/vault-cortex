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
import { parseHeadings } from "../obsidian-markdown/headings.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { tasks } from "../obsidian-markdown/tasks.js"
import type {
  TaskStatus,
  TaskPriority,
  DateFieldKey,
} from "../obsidian-markdown/tasks.js"
import { readTaskFormatConfig } from "./task-format-config.js"
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
  priority?: TaskPriority | undefined
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
  heading?: string | undefined
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

type UpdateTaskResult = {
  path: string
  line: number
  description: string
  block_id?: string | undefined
  heading?: string | undefined
  subtasks?: SubtaskPosition[] | undefined
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

/** Reads a note for task mutation, returning frontmatter + body lines. */
const readNoteForUpdate = async (
  vaultPath: string,
  path: string,
): Promise<{
  fullPath: string
  data: Record<string, unknown>
  lines: string[]
}> => {
  assertPathHasExtension(path, ".md")
  const fullPath = resolveSafePath(vaultPath, path)
  try {
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = parseNote(fileContent)
    return {
      fullPath,
      data: parsed.data,
      lines: splitIntoLines(parsed.content),
    }
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

  const taskIndent = taskLine.match(/^(\s*)/)?.[0].length ?? 0
  let endIndex = taskLineIndex + 1

  while (endIndex < lines.length) {
    const line = lines[endIndex]
    if (line === undefined) break
    if (line.trim() === "") {
      endIndex++
      continue
    }
    const lineIndent = line.match(/^(\s*)/)?.[0].length ?? 0
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

/** Validates a date string is a real calendar date. */
const validateDate = (date: string, fieldName: string): void => {
  if (!DateTime.fromFormat(date, "yyyy-MM-dd").isValid) {
    throw new Error(`invalid date: ${fieldName} "${date}" (use YYYY-MM-DD)`)
  }
}

type ParentLocator =
  { kind: "blockId"; blockId: string } | { kind: "line"; line: number }

/** Returns the parent's body-line index; throws when the locator resolves to nothing or to a non-task line. */
const findParentLineIndex = ({
  locator,
  bodyLines,
  bodyStartLine,
}: {
  locator: ParentLocator
  bodyLines: string[]
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
    priority,
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

  // Validate dates
  if (due) validateDate(due, "due")
  if (scheduled) validateDate(scheduled, "scheduled")
  if (start) validateDate(start, "start")

  if (parentBlockId && parentLine) {
    throw new Error("parentBlockId and parentLine are mutually exclusive")
  }
  const parentLocator: ParentLocator | undefined = parentBlockId
    ? { kind: "blockId", blockId: parentBlockId }
    : parentLine
      ? { kind: "line", line: parentLine }
      : undefined
  // A sub-task lives wherever its parent lives — a heading has nothing to
  // place, so a parent locator and a heading are exclusive.
  if (parentLocator && heading) {
    throw new Error("parent and heading are mutually exclusive")
  }
  if (dependsOn !== undefined && dependsOn.length === 0) {
    throw new Error("dependsOn cannot be empty")
  }
  if (subtasks?.some((subtaskText) => !subtaskText.trim())) {
    throw new Error("subtasks cannot contain an empty item")
  }

  const { fullPath } = await readNoteForUpdate(vaultPath, path)

  return withExclusiveFileLock(fullPath, async () => {
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = parseNote(fileContent)
    const bodyLines = splitIntoLines(parsed.content)
    const headings = parseHeadings(bodyLines)

    const bodyStartLine = tasks.findBodyStartLine(splitIntoLines(fileContent))

    // Validate block_id grammar and uniqueness
    validateBlockId(blockId, bodyLines)

    const isKanbanBoard = Boolean(parsed.data["kanban-plugin"])
    const pluginConfig = await readTaskFormatConfig(vaultPath)
    const formatConfig = {
      taskFormat: format ?? pluginConfig.taskFormat,
      setDoneDate: pluginConfig.setDoneDate,
      setCancelledDate: pluginConfig.setCancelledDate,
    }

    const today = DateTime.now().toISODate()
    if (today === null) {
      throw new Error("failed to determine today's date")
    }

    // Every field is new on create, so each entry reads "(none) → value".
    const metadataFields: ReadonlyArray<{
      field: string
      value: string | null | undefined
    }> = [
      { field: "created", value: today },
      { field: "priority", value: priority },
      { field: "due", value: due },
      { field: "scheduled", value: scheduled },
      { field: "start", value: start },
      { field: "task_id", value: taskId },
      { field: "depends_on", value: formatDependsOn(dependsOn) },
    ]
    const changes: string[] = metadataFields
      .filter(({ value }) => Boolean(value))
      .map(({ field, value }) =>
        formatChange({ field, before: null, after: value }),
      )

    // Determine insertion point and indent
    const resultLines = [...bodyLines]
    let insertAt: number
    let indent = ""
    let resolvedHeading: string | undefined

    if (parentLocator) {
      // Sub-task under a parent
      const parentLineIndex = findParentLineIndex({
        locator: parentLocator,
        bodyLines,
        bodyStartLine,
      })

      // Match existing children's indent, or parent + 2 spaces
      const parentLineText = bodyLines[parentLineIndex]
      if (!parentLineText) throw new Error("parent line out of bounds")
      const parentIndent = tasks.getTaskIndent(parentLineText)
      const blockEnd = findTaskBlockEnd(resultLines, parentLineIndex)

      const firstChildIndex = parentLineIndex + 1
      if (firstChildIndex < blockEnd) {
        const firstChild = bodyLines[firstChildIndex]
        if (firstChild && firstChild.trim()) {
          const childIndent = firstChild.match(/^(\s*)/)?.[0] ?? ""
          indent = childIndent
        } else {
          indent = " ".repeat(parentIndent + 2)
        }
      } else {
        indent = " ".repeat(parentIndent + 2)
      }

      insertAt = blockEnd
      const nearestHeading = headings.findLast(
        (headingInfo) => headingInfo.startLine < parentLineIndex,
      )
      resolvedHeading = nearestHeading?.text
    } else if (heading) {
      // Insert under a specific heading
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
      insertAt = targetHeading.bodyStartLine
      // Skip blank lines and the **Complete** marker if present —
      // mirrors extractDoneLanes' scan: first non-blank line only.
      for (let scanLine = insertAt; scanLine < resultLines.length; scanLine++) {
        const trimmed = resultLines[scanLine]?.trim()
        if (!trimmed) continue
        if (trimmed === "**Complete**") {
          insertAt = scanLine + 1
        }
        break
      }
      resolvedHeading = heading
    } else if (isKanbanBoard) {
      throw new Error(
        "heading required for Kanban boards (note has kanban-plugin frontmatter)",
      )
    } else {
      // Append to end of body — under the note's last heading, if any
      insertAt = resultLines.length
      resolvedHeading = headings.at(-1)?.text
    }

    // Build the task line
    const taskLine = tasks.buildTaskLine(
      {
        description,
        blockId,
        priority,
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

    // Build sub-task lines
    const linesToInsert = [taskLine]
    if (subtasks && subtasks.length > 0) {
      const subtaskIndent = indent ? `${indent}  ` : "  "
      for (const subtaskText of subtasks) {
        linesToInsert.push(`${subtaskIndent}- [ ] ${subtaskText}`)
      }
      changes.push(
        formatChange({ field: "subtasks", before: 0, after: subtasks.length }),
      )
    }

    resultLines.splice(insertAt, 0, ...linesToInsert)

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
    await atomicWriteFile(fullPath, serialized)

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
    heading: targetHeadingParam,
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
      "at least one mutation (status, priority, heading, description, due, scheduled, start, created, taskId, dependsOn, addSubtasks, or assignBlockId) is required",
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

  if (addSubtasks !== undefined && addSubtasks.length === 0) {
    throw new Error("addSubtasks cannot be empty")
  }
  if (addSubtasks?.some((subtaskText) => !subtaskText.trim())) {
    throw new Error("addSubtasks cannot contain an empty item")
  }

  if (Array.isArray(dependsOn) && dependsOn.length === 0) {
    throw new Error("dependsOn cannot be empty (use null to clear)")
  }

  const { fullPath } = await readNoteForUpdate(vaultPath, path)

  return withExclusiveFileLock(fullPath, async () => {
    // Re-read inside the lock to guard against changes between the
    // initial read and lock acquisition
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = parseNote(fileContent)
    const bodyLines = splitIntoLines(parsed.content)
    const headings = parseHeadings(bodyLines)

    // Frontmatter offset — extractTasks uses the same formula:
    // file_line = bodyStartLine + bodyLineIndex + 1.
    const bodyStartLine = tasks.findBodyStartLine(splitIntoLines(fileContent))

    // Locate the task line (0-based index into bodyLines)
    let taskLineIndex: number
    if (blockId) {
      const foundIndex = tasks.findTaskByBlockId(bodyLines, blockId)
      if (foundIndex === null) {
        throw new Error(`blockId "${blockId}" not found in "${path}"`)
      }
      taskLineIndex = foundIndex
    } else {
      // line is guaranteed defined here: the identifier validation
      // above ensures exactly one of blockId/line is set.
      if (!line) {
        throw new Error("exactly one of blockId or line is required")
      }
      taskLineIndex = line - 1 - bodyStartLine
      const taskLineText = bodyLines[taskLineIndex]
      if (
        taskLineIndex < 0 ||
        taskLineIndex >= bodyLines.length ||
        !taskLineText ||
        !tasks.isTaskLine(taskLineText)
      ) {
        throw new Error(`no task at line ${line}`)
      }
    }

    const originalTaskLine = bodyLines[taskLineIndex]
    if (!originalTaskLine) {
      throw new Error(`task line index ${taskLineIndex} out of bounds`)
    }
    const isKanbanBoard = Boolean(parsed.data["kanban-plugin"])
    const isSubtask = tasks.getTaskIndent(originalTaskLine) > 0
    // Prior field values, so every `changes` entry can state before → after.
    const [taskBefore] = tasks.extractTasks(originalTaskLine)
    if (!taskBefore) {
      throw new Error(
        `task line index ${taskLineIndex} does not parse as a task`,
      )
    }

    // A sub-task's placement is its parent's — an explicit heading has
    // nothing to move.
    if (targetHeadingParam && isSubtask) {
      throw new Error(
        "cannot move a sub-task to a heading — the parent's heading determines placement",
      )
    }

    // Validate assign_block_id
    if (newBlockId) {
      validateBlockId(newBlockId, bodyLines, taskLineIndex)
    }

    // Apply in-line mutations
    let mutatedLine = originalTaskLine
    // Resolve format config: explicit param > plugin config > emoji default
    const pluginConfig = await readTaskFormatConfig(vaultPath)
    const formatConfig = {
      taskFormat: format ?? pluginConfig.taskFormat,
      setDoneDate: pluginConfig.setDoneDate,
      setCancelledDate: pluginConfig.setCancelledDate,
    }

    const changes: string[] = []

    // 1. Description replacement
    if (newDescription !== undefined) {
      const oldDescription = tasks.describeTaskLine(mutatedLine)
      mutatedLine = tasks.replaceTaskLineDescription(
        mutatedLine,
        newDescription,
      )
      // Both sides read the parser's view (tags re-appended), matching the
      // result's `description`.
      changes.push(
        formatChange({
          field: "description",
          before: oldDescription,
          after: tasks.describeTaskLine(mutatedLine),
        }),
      )
    }

    // 2. Status change
    if (status) {
      const today = DateTime.now().toISODate()
      if (today === null) {
        throw new Error("failed to determine today's date")
      }
      const checkboxMatch = /\[(.)]/.exec(originalTaskLine)
      const oldStatus = tasks.statusForChar(checkboxMatch?.[1] ?? " ")
      mutatedLine = tasks.updateTaskLineStatus({
        taskLine: mutatedLine,
        newStatus: status,
        today,
        config: formatConfig,
      })
      changes.push(
        formatChange({ field: "status", before: oldStatus, after: status }),
      )
    }

    // 3. Priority set/clear
    if (priority !== undefined) {
      mutatedLine = tasks.updateTaskLinePriority(
        mutatedLine,
        priority,
        formatConfig,
      )
      changes.push(
        formatChange({
          field: "priority",
          before: taskBefore.priority,
          after: priority,
        }),
      )
    }

    // 4. Date field set/clear
    for (const { field, value } of dateParams) {
      if (value === undefined) continue
      mutatedLine = tasks.updateTaskLineDate({
        taskLine: mutatedLine,
        field,
        date: value,
        config: formatConfig,
      })
      changes.push(
        formatChange({
          field,
          before: taskBefore[`${field}Date`],
          after: value,
        }),
      )
    }

    // 5. task_id set/clear
    if (taskId !== undefined) {
      mutatedLine = tasks.updateTaskLineTaskId(
        mutatedLine,
        taskId,
        formatConfig,
      )
      changes.push(
        formatChange({
          field: "task_id",
          before: taskBefore.taskId,
          after: taskId,
        }),
      )
    }

    // 6. depends_on set/clear
    if (dependsOn !== undefined) {
      mutatedLine = tasks.updateTaskLineDependsOn(
        mutatedLine,
        dependsOn,
        formatConfig,
      )
      changes.push(
        formatChange({
          field: "depends_on",
          before: formatDependsOn(taskBefore.dependsOn),
          after: formatDependsOn(dependsOn),
        }),
      )
    }

    // 7. assign_block_id
    if (newBlockId) {
      mutatedLine = tasks.assignBlockId(mutatedLine, newBlockId)
      changes.push(
        formatChange({
          field: "block_id",
          before: taskBefore.blockId,
          after: newBlockId,
        }),
      )
    }

    // Determine heading move target — skipped for sub-tasks
    let targetLane = targetHeadingParam
    if (!targetLane && status === "done" && isKanbanBoard && !isSubtask) {
      targetLane = detectDoneLane(bodyLines, headings)
    }

    // Apply lane move
    const resultLines = [...bodyLines]
    resultLines[taskLineIndex] = mutatedLine

    if (targetLane) {
      const targetHeading = headings.find(
        (heading) => heading.text === targetLane,
      )
      if (!targetHeading) {
        const availableHeadings = headings
          .map((heading) => heading.text)
          .join(", ")
        throw new Error(
          `heading "${targetLane}" not found; available: ${availableHeadings}`,
        )
      }

      // Find the current lane (nearest heading above the task)
      const currentHeading = headings.findLast(
        (heading) => heading.startLine < taskLineIndex,
      )
      const currentLane = currentHeading?.text ?? "(before first heading)"

      // Only move if the task isn't already in the target lane
      if (currentLane !== targetLane) {
        // Collect the task block (task line + indented sub-items)
        const taskBlockEnd = findTaskBlockEnd(resultLines, taskLineIndex)
        const taskBlock = resultLines.slice(taskLineIndex, taskBlockEnd)

        // Remove the task block from its current position
        resultLines.splice(taskLineIndex, taskBlockEnd - taskLineIndex)

        // Re-parse headings after removal (indices shifted)
        const updatedHeadings = parseHeadings(resultLines)
        const updatedTargetHeading = updatedHeadings.find(
          (heading) => heading.text === targetLane,
        )
        if (!updatedTargetHeading) {
          throw new Error(
            `heading "${targetLane}" not found after line removal`,
          )
        }

        // Insert after the **Complete** marker when the lane has one,
        // otherwise at the heading's body start. The marker sits between
        // the heading and the first list item — inserting before it would
        // break done-lane detection on subsequent reads. Blank lines are
        // skipped first, mirroring extractDoneLanes' scan (first non-blank
        // line only).
        let insertAt = updatedTargetHeading.bodyStartLine
        for (
          let scanLine = insertAt;
          scanLine < resultLines.length;
          scanLine++
        ) {
          const trimmed = resultLines[scanLine]?.trim()
          if (!trimmed) continue
          if (trimmed === "**Complete**") {
            insertAt = scanLine + 1
          }
          break
        }
        resultLines.splice(insertAt, 0, ...taskBlock)
        taskLineIndex = insertAt

        changes.push(
          formatChange({
            field: "heading",
            before: currentLane,
            after: targetLane,
          }),
        )
      }
    }

    // 8. add_subtasks — appended after all parent-line mutations and heading move
    // Assigned inside the branch below; stays undefined when nothing was added.
    let subtaskPositions: SubtaskPosition[] | undefined
    if (addSubtasks) {
      const parentIndent = tasks.getTaskIndent(resultLines[taskLineIndex] ?? "")
      const blockEnd = findTaskBlockEnd(resultLines, taskLineIndex)

      // Match existing children's indent, or parent + 2 spaces
      const firstChildIndex = taskLineIndex + 1
      let subtaskIndent: string
      if (firstChildIndex < blockEnd) {
        const firstChild = resultLines[firstChildIndex]
        subtaskIndent = firstChild?.trim()
          ? (firstChild.match(/^(\s*)/)?.[0] ?? " ".repeat(parentIndent + 2))
          : " ".repeat(parentIndent + 2)
      } else {
        subtaskIndent = " ".repeat(parentIndent + 2)
      }

      const subtaskLines = addSubtasks.map(
        (subtaskText) => `${subtaskIndent}- [ ] ${subtaskText}`,
      )
      const existingSubtaskCount = resultLines
        .slice(firstChildIndex, blockEnd)
        .filter((blockLine) => tasks.isTaskLine(blockLine)).length
      resultLines.splice(blockEnd, 0, ...subtaskLines)
      subtaskPositions = subtaskPositionsFrom({
        bodyStartLine,
        firstBodyIndex: blockEnd,
        descriptions: addSubtasks,
      })
      changes.push(
        formatChange({
          field: "subtasks",
          before: existingSubtaskCount,
          after: existingSubtaskCount + addSubtasks.length,
        }),
      )
    }

    const finalTaskIndex = taskLineIndex

    // Write atomically
    const serialized = stringifyNote(resultLines.join("\n"), parsed.data)
    await atomicWriteFile(fullPath, serialized)

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
      changes,
    }
  })
}

// ── Public surface ──────────────────────────────────────────────

export const taskMutations = {
  createTask,
  updateTask,
}
