/** Pins the committed wire-surface baseline. Any byte drift in tool names, input
 *  schemas, descriptions, annotations, the prompt surface, or the server
 *  instructions fails here. Intentional changes regenerate the baseline via
 *  `npm run snapshot:update` and land as a reviewable diff in the same PR.
 *  The snapshot sees schemas and rendered text, not runtime response shapes —
 *  those stay enforced by the integration suite's exact assertions. */

import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import {
  SIZE_CAPPED_COMBO_NAMES,
  SURFACE_COMBOS,
  captureToolSurface,
  measureToolListChars,
  serializeSurfaceCapture,
} from "../../../../scripts/tool-surface-capture.js"

type ObjectSchemaNode = { path: string; declaresParameters: boolean; rejectsUnknownKeys: boolean }

const isJsonRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A record (`z.record`) has no properties map, so it is not collected. */
const collectObjectSchemaNodes = (schemaNode: unknown, path: string): ObjectSchemaNode[] => {
  if (Array.isArray(schemaNode)) {
    return schemaNode.flatMap((element, index) => {
      return collectObjectSchemaNodes(element, `${path}/${index}`)
    })
  }
  if (!isJsonRecord(schemaNode)) return []

  const childNodes = Object.entries(schemaNode).flatMap(([key, value]) => {
    return collectObjectSchemaNodes(value, `${path}/${key}`)
  })
  const { properties } = schemaNode
  // Compared with the string "object", so a properties map holding a
  // parameter named `type` is not mistaken for an object schema
  const isObjectSchema = schemaNode.type === "object" && isJsonRecord(properties)

  if (!isObjectSchema) return childNodes

  const objectNode = {
    path,
    declaresParameters: Object.keys(properties).length > 0,
    rejectsUnknownKeys: schemaNode.additionalProperties === false,
  }
  return [objectNode, ...childNodes]
}

/** Paths of the objects that break the rule: an object that declares
 *  parameters rejects unknown keys, and one that declares none accepts them. */
const listObjectSchemasBreakingStrictness = (tool: Tool): string[] => {
  return collectObjectSchemaNodes(tool.inputSchema, `${tool.name}.inputSchema`)
    .filter((objectNode) => objectNode.rejectsUnknownKeys !== objectNode.declaresParameters)
    .map((objectNode) => objectNode.path)
}

describe("tool surface baseline", () => {
  it.each(SURFACE_COMBOS.map((combo) => [combo.name, combo] as const))(
    "combo %s matches the committed baseline",
    async (comboName, combo) => {
      const capture = await captureToolSurface(combo)
      await expect(serializeSurfaceCapture(capture)).toMatchFileSnapshot(
        `__snapshots__/tool-surface/${comboName}.json`,
      )
    },
  )

  /** Clients such as claude.ai and Claude Desktop load every tool definition
   *  into each conversation, so the definitions' total size is a per-chat
   *  context cost. A checked combo's cap is this per-tool allowance times its
   *  tool count, so a new tool adds one allowance. The cap has two blind spots:
   *  - It checks a combo's total, so one tool can grow while another shrinks;
   *    `npm run report:tool-surface-size` shows the per-tool sizes.
   *  - The allowance sits just above the default combo's average, so only
   *    small growth passes.
   *  Raising the allowance is a deliberate change with its reason in the PR. */
  const CHARS_PER_TOOL_ALLOWANCE = 4220

  it.each(SIZE_CAPPED_COMBO_NAMES)(
    "combo %s stays within the average per-tool size allowance",
    async (comboName) => {
      const combo = SURFACE_COMBOS.find((surfaceCombo) => surfaceCombo.name === comboName)

      if (!combo) {
        throw new Error(`no surface combo named ${comboName}`)
      }

      const capture = await captureToolSurface(combo)
      const totalChars = measureToolListChars(capture.tools)
      expect(
        totalChars,
        "tool definitions exceed the size cap; run npm run report:tool-surface-size for per-tool sizes",
      ).toBeLessThanOrEqual(CHARS_PER_TOOL_ALLOWANCE * capture.tools.length)
    },
  )

  it.each(SURFACE_COMBOS.map((combo) => [combo.name, combo] as const))(
    "combo %s rejects unknown keys on every input object that declares parameters",
    async (_comboName, combo) => {
      const capture = await captureToolSurface(combo)
      const pathsBreakingStrictness = capture.tools.flatMap(listObjectSchemasBreakingStrictness)
      expect(pathsBreakingStrictness).toEqual([])
    },
  )

  it("leaves the input objects of tools without parameters open", async () => {
    const defaultCombo = SURFACE_COMBOS.find((surfaceCombo) => surfaceCombo.name === "default")
    const capture = defaultCombo ? await captureToolSurface(defaultCombo) : undefined

    if (!capture) {
      throw new Error("no surface combo named default")
    }

    const parameterlessObjects = capture.tools
      .flatMap((tool) => collectObjectSchemaNodes(tool.inputSchema, `${tool.name}.inputSchema`))
      .filter((objectNode) => !objectNode.declaresParameters)
    expect(parameterlessObjects).toEqual([
      {
        path: "vault_list_memory_files.inputSchema",
        declaresParameters: false,
        rejectsUnknownKeys: false,
      },
      { path: "vault_list_tags.inputSchema", declaresParameters: false, rejectsUnknownKeys: false },
    ])
  })

  // Without this, the per-combo strictness check would also pass if the walk
  // never left the top level of each schema
  it("finds the nested object schemas inside vault_search's filters", async () => {
    const defaultCombo = SURFACE_COMBOS.find((surfaceCombo) => surfaceCombo.name === "default")
    const capture = defaultCombo ? await captureToolSurface(defaultCombo) : undefined
    const searchTool = capture?.tools.find((tool) => tool.name === "vault_search")

    if (!searchTool) {
      throw new Error("the default combo serves no vault_search")
    }

    const objectPaths = collectObjectSchemaNodes(searchTool.inputSchema, "inputSchema").map(
      (objectNode) => objectNode.path,
    )
    expect(objectPaths).toEqual([
      "inputSchema",
      "inputSchema/properties/filters",
      "inputSchema/properties/filters/properties/created",
      "inputSchema/properties/filters/properties/modified",
    ])
  })

  // Guards two gaps vitest's file snapshots leave open: an orphaned file
  // lingering after an axis change (nothing ever asserts it again), and a
  // locally auto-created file that never went through a deliberate regen.
  it("snapshot directory holds exactly one file per combo", () => {
    const snapshotDirectory = fileURLToPath(
      new URL("./__snapshots__/tool-surface/", import.meta.url),
    )
    const committedFiles = readdirSync(snapshotDirectory).toSorted()
    const expectedFiles = SURFACE_COMBOS.map((combo) => `${combo.name}.json`).toSorted()
    expect(committedFiles).toEqual(expectedFiles)
  })
})
