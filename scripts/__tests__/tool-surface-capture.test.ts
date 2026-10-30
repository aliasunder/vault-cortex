import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it } from "vitest"
import {
  measureErrorsSectionChars,
  measureToolDefinitionChars,
  measureToolListChars,
} from "../tool-surface-capture.js"

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

describe("measureErrorsSectionChars", () => {
  const toolWith = (description: string): Tool => ({
    name: "vault_x",
    description,
    inputSchema: EMPTY_SCHEMA,
  })

  it("counts the Errors line and its bullets, each with its line break, and stops at the next section label", () => {
    // "Errors:\n" is 8, '- "a" — fix a\n' is 14, '- "b" — fix b\n' is 14
    const description = 'Read a note.\n\nErrors:\n- "a" — fix a\n- "b" — fix b\nReturns: the note.'

    expect(measureErrorsSectionChars(toolWith(description))).toBe(36)
  })

  it("keeps a bullet whose text holds a capitalized word and a colon inside the section", () => {
    // "Errors:\n" is 8, '- Note: "a" fails\n' is 18
    const description = 'Errors:\n- Note: "a" fails\nObsidian syntax: none.'

    expect(measureErrorsSectionChars(toolWith(description))).toBe(26)
  })

  it("counts to the end of the description when no section label follows", () => {
    // "Errors:\n" is 8, '- "a" — fix a' is 13 plus one for its line break
    expect(measureErrorsSectionChars(toolWith('Errors:\n- "a" — fix a'))).toBe(22)
  })

  it("measures a description without an Errors line as zero", () => {
    expect(measureErrorsSectionChars(toolWith("Read a note.\n\nReturns: the note."))).toBe(0)
  })

  it("measures a tool without a description as zero", () => {
    expect(measureErrorsSectionChars({ name: "vault_x", inputSchema: EMPTY_SCHEMA })).toBe(0)
  })
})
