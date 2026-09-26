import { describe, it, expect, expectTypeOf } from "vitest"
import type { z } from "zod"
import {
  taskEntrySchema,
  listTasksOutputSchema,
  createTaskOutputSchema,
  updateTaskOutputSchema,
} from "../task-output-schemas.js"
import type { ListTasksResult, TaskEntry } from "../../../search/search-index.js"
import type {
  CreateTaskResult,
  UpdateTaskResult,
} from "../../../vault-operations/task-mutations.js"

/** toEqualTypeOf is the drift guard mutual assignability can't be: a schema
 *  missing an optional key stays mutually assignable with the data-layer
 *  type, but fails type equality. The build typechecks this file, so schema
 *  drift is a compile error, not a runtime surprise. */
describe("schema/type conformance (compile-time)", () => {
  it("taskEntrySchema infers exactly TaskEntry", () => {
    expectTypeOf<z.infer<typeof taskEntrySchema>>().toEqualTypeOf<TaskEntry>()
  })

  it("listTasksOutputSchema infers exactly ListTasksResult", () => {
    expectTypeOf<z.infer<typeof listTasksOutputSchema>>().toEqualTypeOf<ListTasksResult>()
  })

  it("createTaskOutputSchema infers exactly CreateTaskResult", () => {
    expectTypeOf<z.infer<typeof createTaskOutputSchema>>().toEqualTypeOf<CreateTaskResult>()
  })

  it("updateTaskOutputSchema infers exactly UpdateTaskResult", () => {
    expectTypeOf<z.infer<typeof updateTaskOutputSchema>>().toEqualTypeOf<UpdateTaskResult>()
  })
})

describe("runtime parse behavior", () => {
  it("accepts a result carrying only the required fields", () => {
    const minimalUpdateResult = {
      path: "TASKS.md",
      line: 12,
      description: "Fix login bug",
      changes: ["status: todo → in_progress"],
    }

    expect(updateTaskOutputSchema.parse(minimalUpdateResult)).toStrictEqual(minimalUpdateResult)
  })

  it("strips a key the schema does not declare", () => {
    const driftedCreateResult = {
      path: "TASKS.md",
      line: 5,
      description: "New card",
      block_id: "new-card",
      changes: [],
      drifted_key: "surprise",
    }

    expect(createTaskOutputSchema.parse(driftedCreateResult)).toStrictEqual({
      path: "TASKS.md",
      line: 5,
      description: "New card",
      block_id: "new-card",
      changes: [],
    })
  })

  it("rejects a result missing a required field", () => {
    const missingBlockId = {
      path: "TASKS.md",
      line: 5,
      description: "New card",
      changes: [],
    }

    const parseResult = createTaskOutputSchema.safeParse(missingBlockId)

    expect(parseResult.success).toBe(false)
  })
})
