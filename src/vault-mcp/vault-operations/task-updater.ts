/** Task mutations — surgical task-line creation and editing within a note.
 *
 *  Handles task creation, status changes, priority changes, date field
 *  management, description edits, sub-task operations, block_id assignment,
 *  and Kanban lane moves — all as atomic read-modify-write cycles under
 *  exclusive file locks. */

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

export type CreateTaskParams = {
  vaultPath: string
  path: string
  description: string
  blockId: string
  heading?: string | undefined
  parentTask?: string | number | undefined
  priority?: TaskPriority | undefined
  due?: string | undefined
  scheduled?: string | undefined
  start?: string | undefined
  taskId?: string | undefined
  dependsOn?: string[] | undefined
  subtasks?: string[] | undefined
  format?: "emoji" | "dataview" | undefined
}

export type CreateTaskResult = {
  path: string
  line: number
  description: string
  block_id: string
  heading: string | null
  changes: string[]
}

export type UpdateTaskParams = {
  vaultPath: string
  path: string
  blockId?: string | undefined
  line?: number | undefined
  status?: TaskStatus | undefined
  priority?: TaskPriority | "none" | undefined
  lane?: string | undefined
  description?: string | undefined
  due?: string | null | undefined
  scheduled?: string | null | undefined
  start?: string | null | undefined
  created?: string | null | undefined
  taskId?: string | null | undefined
  dependsOn?: string[] | null | undefined
  addSubtask?: string | undefined
  assignBlockId?: string | undefined
  format?: "emoji" | "dataview" | undefined
}

export type UpdateTaskResult = {
  path: string
  line: number
  description: string
  changes: string[]
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

/** Extracts the human-readable description from a task line, stripping
 *  the checkbox prefix, trailing block_id, and metadata (both emoji and
 *  Dataview formats). */
const extractDescription = (taskLine: string): string => {
  const match = /\[.\] *(.*)$/.exec(taskLine)
  if (!match) return taskLine
  const body = match[1] ?? ""
  // Strip block_id before metadata search — a bare `^id` with no metadata
  // signifiers would otherwise bleed into the description.
  const blockLinkMatch = tasks.BLOCK_LINK_RE.exec(body)
  const bodyWithoutBlock = blockLinkMatch
    ? body.slice(0, blockLinkMatch.index)
    : body
  const firstSignifier = bodyWithoutBlock.search(
    tasks.FIRST_METADATA_SIGNIFIER_RE,
  )
  const description =
    firstSignifier === -1
      ? bodyWithoutBlock
      : bodyWithoutBlock.slice(0, firstSignifier)
  return description.trim()
}

/** Validates a block_id: grammar check + uniqueness within the note. */
const validateBlockId = (
  blockId: string,
  bodyLines: readonly string[],
  excludeLineIndex?: number,
): void => {
  if (!BLOCK_ID_RE.test(blockId)) {
    throw new Error(
      `block_id "${blockId}" contains invalid characters (allowed: letters, digits, hyphens)`,
    )
  }
  const existingIndex = bodyLines.findIndex(
    (bodyLine, index) =>
      index !== excludeLineIndex && bodyLine.endsWith(` ^${blockId}`),
  )
  if (existingIndex !== -1) {
    throw new Error(`block_id "${blockId}" already exists in this note`)
  }
}

/** Validates a date string is a real calendar date. */
const validateDate = (date: string, fieldName: string): void => {
  if (!DateTime.fromFormat(date, "yyyy-MM-dd").isValid) {
    throw new Error(`invalid date: ${fieldName} "${date}" (use YYYY-MM-DD)`)
  }
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
    parentTask,
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

  // Parent (block_id) and heading are mutually exclusive
  if (parentTask && typeof parentTask === "string" && heading) {
    throw new Error(
      "parent and heading are mutually exclusive when parent is a block_id",
    )
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

    const changes: string[] = [`created: ${today}`]
    if (priority) changes.push(`priority: ${priority}`)
    if (due) changes.push(`due: ${due}`)
    if (scheduled) changes.push(`scheduled: ${scheduled}`)
    if (start) changes.push(`start: ${start}`)
    if (taskId) changes.push(`task_id: ${taskId}`)
    if (dependsOn && dependsOn.length > 0)
      changes.push(`depends_on: ${dependsOn.join(",")}`)

    // Determine insertion point and indent
    const resultLines = [...bodyLines]
    let insertAt: number
    let indent = ""
    let resolvedHeading: string | null

    if (parentTask !== undefined) {
      // Sub-task under a parent
      let parentLineIndex: number
      if (typeof parentTask === "string") {
        const foundIndex = tasks.findTaskByBlockId(bodyLines, parentTask)
        if (foundIndex === null) {
          throw new Error(`parent task not found: block_id "${parentTask}"`)
        }
        parentLineIndex = foundIndex
      } else {
        parentLineIndex = parentTask - 1 - bodyStartLine
        const parentLineText = bodyLines[parentLineIndex]
        if (
          parentLineIndex < 0 ||
          parentLineIndex >= bodyLines.length ||
          !parentLineText ||
          !tasks.isTaskLine(parentLineText)
        ) {
          throw new Error(`parent task not found: line ${parentTask}`)
        }
      }

      // Determine indent from existing children or parent + 2 spaces
      const parentLine = bodyLines[parentLineIndex]
      if (!parentLine) throw new Error("parent line out of bounds")
      const parentIndent = tasks.getTaskIndent(parentLine)
      const blockEnd = findTaskBlockEnd(resultLines, parentLineIndex)

      // Check if there are existing children to match their indent
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
      resolvedHeading = nearestHeading?.text ?? null
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
      // Append to end of body
      insertAt = resultLines.length
      resolvedHeading = null
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
      changes.push(`subtasks: ${subtasks.length}`)
    }

    resultLines.splice(insertAt, 0, ...linesToInsert)

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
      changes,
    }
  })
}

// ── updateTask ──────────────────────────────────────────────────

/** Applies mutations to a task line within a single atomic
 *  read-modify-write cycle. Composes status, priority, description,
 *  dates, task_id, depends_on, assign_block_id, lane moves, and
 *  add_subtask — all in one write. */
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
    lane,
    format,
    description: newDescription,
    due,
    scheduled,
    start,
    created,
    taskId,
    dependsOn,
    addSubtask,
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
    lane !== undefined ||
    newDescription !== undefined ||
    due !== undefined ||
    scheduled !== undefined ||
    start !== undefined ||
    created !== undefined ||
    taskId !== undefined ||
    dependsOn !== undefined ||
    addSubtask !== undefined ||
    newBlockId !== undefined
  if (!hasMutation) {
    throw new Error(
      "at least one mutation (status, priority, lane, description, due, scheduled, start, created, task_id, depends_on, add_subtask, or assign_block_id) is required",
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

  if (addSubtask !== undefined && !addSubtask.trim()) {
    throw new Error("add_subtask cannot be empty")
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
        throw new Error(`block_id "${blockId}" not found in "${path}"`)
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

    // Validate lane param requires a Kanban board
    if (lane && !isKanbanBoard) {
      throw new Error(
        "lane requires a Kanban board (note must have kanban-plugin frontmatter)",
      )
    }

    // Sub-task guard: explicit lane on a sub-task is an error
    if (lane && isSubtask) {
      throw new Error(
        "cannot lane-move a sub-task — the parent's lane determines placement",
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
      const oldDescription = extractDescription(mutatedLine)
      mutatedLine = tasks.replaceTaskLineDescription(
        mutatedLine,
        newDescription,
      )
      changes.push(`description: ${oldDescription} → ${newDescription}`)
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
      changes.push(`status: ${oldStatus} → ${status}`)
    }

    // 3. Priority change
    if (priority) {
      const newPriority = priority === "none" ? null : priority
      mutatedLine = tasks.updateTaskLinePriority(
        mutatedLine,
        newPriority,
        formatConfig,
      )
      changes.push(`priority: ${priority === "none" ? "removed" : priority}`)
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
      changes.push(value === null ? `${field}: removed` : `${field}: ${value}`)
    }

    // 5. task_id set/clear
    if (taskId !== undefined) {
      mutatedLine = tasks.updateTaskLineTaskId(
        mutatedLine,
        taskId,
        formatConfig,
      )
      changes.push(taskId === null ? "task_id: removed" : `task_id: ${taskId}`)
    }

    // 6. depends_on set/clear
    if (dependsOn !== undefined) {
      mutatedLine = tasks.updateTaskLineDependsOn(
        mutatedLine,
        dependsOn,
        formatConfig,
      )
      changes.push(
        dependsOn === null || dependsOn.length === 0
          ? "depends_on: removed"
          : `depends_on: ${dependsOn.join(",")}`,
      )
    }

    // 7. assign_block_id
    if (newBlockId) {
      mutatedLine = tasks.assignBlockId(mutatedLine, newBlockId)
      changes.push(`block_id assigned: ${newBlockId}`)
    }

    // Determine lane move target — skipped for sub-tasks
    let targetLane = lane
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

        // Insert after the **Complete** marker if present, otherwise
        // at the heading's body start. The marker sits between the heading
        // and the first list item — inserting before it would break
        // done-lane detection on subsequent reads.
        const insertLine = updatedTargetHeading.bodyStartLine
        const firstBodyLine = resultLines[insertLine]?.trim()
        const insertAt =
          firstBodyLine === "**Complete**" ? insertLine + 1 : insertLine
        resultLines.splice(insertAt, 0, ...taskBlock)
        taskLineIndex = insertAt

        changes.push(`lane: ${currentLane} → ${targetLane}`)
      }
    }

    // 8. add_subtask — appended after all parent-line mutations and lane move
    if (addSubtask) {
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

      const subtaskLine = `${subtaskIndent}- [ ] ${addSubtask}`
      resultLines.splice(blockEnd, 0, subtaskLine)
      changes.push(`subtask added: ${addSubtask}`)
    }

    const finalTaskIndex = taskLineIndex

    // Write atomically
    const serialized = stringifyNote(resultLines.join("\n"), parsed.data)
    await atomicWriteFile(fullPath, serialized)

    const finalLine = bodyStartLine + finalTaskIndex + 1

    logger.info("task updated", {
      path,
      line: finalLine,
      changes,
    })

    return {
      path,
      line: finalLine,
      description: extractDescription(
        resultLines[finalTaskIndex] ?? mutatedLine,
      ),
      changes,
    }
  })
}

// ── Public surface ──────────────────────────────────────────────

export const taskMutations = {
  createTask,
  updateTask,
}
