/** Task updater — surgical task-line edits within a single note.
 *
 *  Handles status changes, priority changes, and Kanban lane moves
 *  as a single atomic read-modify-write under one exclusive file lock. */

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
import type { TaskStatus, TaskPriority } from "../obsidian-markdown/tasks.js"
import { readTaskFormatConfig } from "./task-format-config.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

export type UpdateTaskParams = {
  vaultPath: string
  path: string
  blockId?: string | undefined
  line?: number | undefined
  status?: TaskStatus | undefined
  priority?: TaskPriority | "none" | undefined
  lane?: string | undefined
  format?: "emoji" | "dataview" | undefined
}

export type UpdateTaskResult = {
  path: string
  line: number
  description: string
  changes: string[]
}

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
  if (taskLine === undefined) return taskLineIndex + 1

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
 *  the checkbox prefix and trailing metadata (both emoji and Dataview
 *  formats). Capped at 120 chars. */
const extractDescription = (taskLine: string): string => {
  const match = /\[.\] *(.*)$/.exec(taskLine)
  if (!match) return taskLine.slice(0, 80)
  const body = match[1] ?? ""
  const firstSignifier = body.search(tasks.FIRST_METADATA_SIGNIFIER_RE)
  const description =
    firstSignifier === -1 ? body : body.slice(0, firstSignifier)
  return description.trim().slice(0, 120)
}

// ── Main operation ──────────────────────────────────────────────

/** Applies status, priority, and/or lane mutations to a task line
 *  within a single atomic read-modify-write cycle. */
const updateTask = async (
  params: UpdateTaskParams,
  logger: Logger,
): Promise<UpdateTaskResult> => {
  const { vaultPath, path, blockId, line, status, priority, lane, format } =
    params

  // Validation: exactly one identifier
  const identifierCount = (blockId ? 1 : 0) + (line ? 1 : 0)
  if (identifierCount === 0) {
    throw new Error("exactly one of blockId or line is required")
  }
  if (identifierCount > 1) {
    throw new Error("blockId and line are mutually exclusive")
  }

  // Validation: at least one mutation
  if (!status && !priority && !lane) {
    throw new Error(
      "at least one mutation (status, priority, or lane) is required",
    )
  }

  const { fullPath } = await readNoteForUpdate(vaultPath, path)

  return withExclusiveFileLock(fullPath, async () => {
    // Re-read inside the lock to guard against changes between the
    // initial read and lock acquisition
    const fileContent = await readFile(fullPath, "utf8")
    const parsed = parseNote(fileContent)
    const bodyLines = splitIntoLines(parsed.content)
    const headings = parseHeadings(bodyLines)

    // Compute the frontmatter offset: number of lines before the body
    // starts (frontmatter delimiters + content). extractTasks uses the
    // same formula: file_line = bodyStartLine + bodyLineIndex + 1.
    const allFileLines = splitIntoLines(fileContent)
    const bodyStartLine =
      allFileLines[0] === "---"
        ? allFileLines.findIndex(
            (fileLine, index) => index > 0 && fileLine === "---",
          ) + 1
        : 0

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

    // Validate lane param requires a Kanban board
    if (lane && !isKanbanBoard) {
      throw new Error(
        "lane requires a Kanban board (note must have kanban-plugin frontmatter)",
      )
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

    if (priority) {
      const newPriority = priority === "none" ? null : priority
      mutatedLine = tasks.updateTaskLinePriority(
        mutatedLine,
        newPriority,
        formatConfig,
      )
      changes.push(`priority: ${priority === "none" ? "removed" : priority}`)
    }

    // Determine lane move target
    let targetLane = lane
    if (!targetLane && status === "done" && isKanbanBoard) {
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
      description: extractDescription(mutatedLine),
      changes,
    }
  })
}

// ── Public surface ──────────────────────────────────────────────

export const taskUpdater = {
  updateTask,
}
