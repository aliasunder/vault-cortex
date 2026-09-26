/** Output schemas for the task tools — the structured-result wire contract
 *  advertised in tools/list and validated by the SDK on every success result.
 *  Field order mirrors the data-layer result types so the text block's key
 *  order is unchanged by the schema parse. Exact-type conformance with those
 *  types is compile-checked in __tests__/task-output-schemas.test.ts
 *  (expectTypeOf — the build typechecks test files). */

import { z } from "zod"

const taskStatusSchema = z.enum(["todo", "in_progress", "done", "cancelled"])

const taskPrioritySchema = z.enum(["highest", "high", "medium", "low", "lowest"])

const subtaskProgressSchema = z.object({
  done: z.number(),
  total: z.number(),
})

/** One task on the wire — mirrors TaskEntry in search-index.ts. */
export const taskEntrySchema = z.object({
  path: z.string(),
  line: z.number(),
  status: taskStatusSchema,
  status_char: z.string(),
  description: z.string(),
  heading: z.string().optional(),
  folder: z.string(),
  created: z.string().optional(),
  scheduled: z.string().optional(),
  start: z.string().optional(),
  due: z.string().optional(),
  done: z.string().optional(),
  cancelled: z.string().optional(),
  priority: taskPrioritySchema.optional(),
  recurrence: z.string().optional(),
  on_completion: z.string().optional(),
  task_id: z.string().optional(),
  depends_on: z.array(z.string()),
  tags: z.array(z.string()),
  block_id: z.string().optional(),
  depth: z.number(),
  parent_block_id: z.string().optional(),
  subtask_progress: subtaskProgressSchema.optional(),
  is_kanban_task: z.boolean(),
  done_lanes: z.array(z.string()).optional(),
})

/** Mirrors SubtaskPosition in task-mutations.ts. */
const subtaskPositionSchema = z.object({
  line: z.number(),
  description: z.string(),
})

/** Mirrors NextOccurrencePosition in task-mutations.ts. */
const nextOccurrencePositionSchema = z.object({
  line: z.number(),
  description: z.string(),
  due: z.string().optional(),
  scheduled: z.string().optional(),
  start: z.string().optional(),
})

// Each tool exports the raw shape (what registerTool's outputSchema takes)
// and the built object schema (what safeHandlerStructured parses with).

export const listTasksOutputShape = {
  total: z.number(),
  tasks: z.array(taskEntrySchema),
}

export const listTasksOutputSchema = z.object(listTasksOutputShape)

export const createTaskOutputShape = {
  path: z.string(),
  line: z.number(),
  description: z.string(),
  block_id: z.string(),
  heading: z.string().optional(),
  subtasks: z.array(subtaskPositionSchema).optional(),
  changes: z.array(z.string()),
  advisories: z.array(z.string()).optional(),
}

export const createTaskOutputSchema = z.object(createTaskOutputShape)

export const updateTaskOutputShape = {
  path: z.string(),
  line: z.number(),
  description: z.string(),
  block_id: z.string().optional(),
  heading: z.string().optional(),
  subtasks: z.array(subtaskPositionSchema).optional(),
  next_occurrence: nextOccurrencePositionSchema.optional(),
  changes: z.array(z.string()),
  advisories: z.array(z.string()).optional(),
  on_completion_applied: z.string().optional(),
}

export const updateTaskOutputSchema = z.object(updateTaskOutputShape)
