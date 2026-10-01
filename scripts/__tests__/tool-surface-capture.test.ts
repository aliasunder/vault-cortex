import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it } from "vitest"
import { measureToolDefinitionChars, measureToolListChars } from "../tool-surface-capture.js"

// Serializes to {"type":"object","properties":{"path":{"type":"string"}}} — 57 chars.
const PATH_SCHEMA: Tool["inputSchema"] = {
  type: "object",
  properties: { path: { type: "string" } },
}

// Serializes to {"type":"object"} — 17 chars.
const EMPTY_SCHEMA: Tool["inputSchema"] = { type: "object" }

describe("measureToolDefinitionChars", () => {
  it("counts the description and the serialized input schema, not the name, title, or annotations", () => {
    const tool: Tool = {
      name: "vault_a_long_tool_name_left_out_of_the_measure",
      title: "A Title Left Out Of The Measure",
      description: "Read a note.",
      inputSchema: PATH_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false },
    }

    expect(measureToolDefinitionChars(tool)).toEqual({
      descriptionChars: 12,
      inputSchemaChars: 57,
      totalChars: 69,
    })
  })

  it("counts UTF-16 code units, not bytes or code points", () => {
    // "Plan — 😀": 13 UTF-8 bytes, 8 code points, 9 UTF-16 code units (the
    // emoji is a surrogate pair).
    const tool: Tool = { name: "vault_x", description: "Plan — 😀", inputSchema: EMPTY_SCHEMA }

    expect(measureToolDefinitionChars(tool)).toEqual({
      descriptionChars: 9,
      inputSchemaChars: 17,
      totalChars: 26,
    })
  })

  it("counts a missing description as zero", () => {
    const tool: Tool = { name: "vault_x", inputSchema: EMPTY_SCHEMA }

    expect(measureToolDefinitionChars(tool)).toEqual({
      descriptionChars: 0,
      inputSchemaChars: 17,
      totalChars: 17,
    })
  })
})

describe("measureToolListChars", () => {
  it("sums every tool's description and schema chars", () => {
    const tools: Tool[] = [
      { name: "vault_a", description: "Read a note.", inputSchema: PATH_SCHEMA },
      { name: "vault_b", description: "List.", inputSchema: EMPTY_SCHEMA },
    ]

    // (12 + 57) + (5 + 17)
    expect(measureToolListChars(tools)).toBe(91)
  })

  it("measures an empty tool list as zero", () => {
    expect(measureToolListChars([])).toBe(0)
  })
})
