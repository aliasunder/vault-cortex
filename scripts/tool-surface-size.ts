// Prints the context cost of the MCP tool definitions: a total per config
// combo, then one row per tool for the default combo. Clients that load every
// tool definition up front (claude.ai, Claude Desktop) pay this cost in every
// conversation, so compare the output before and after editing a description.
//
// The per-tool rows show what the size cap in tool-surface-snapshot.test.ts
// can't: that cap checks a combo's total, so one tool can grow while another
// shrinks.
//
// Usage: npm run report:tool-surface-size

import {
  SURFACE_COMBOS,
  captureToolSurface,
  measureToolDefinitionChars,
} from "../src/vault-mcp/mcp-core/__tests__/tool-surface-capture.js"

const comboCaptures = await Promise.all(
  SURFACE_COMBOS.map(async (combo) => ({ combo, capture: await captureToolSurface(combo) })),
)

console.log("combo\ttools\ttotal chars\tchars per tool")
for (const { combo, capture } of comboCaptures) {
  const totalChars = capture.tools
    .map(measureToolDefinitionChars)
    .reduce((sum, toolChars) => sum + toolChars, 0)
  const charsPerTool = Math.round(totalChars / capture.tools.length)
  console.log(`${combo.name}\t${capture.tools.length}\t${totalChars}\t${charsPerTool}`)
}

const defaultCapture = comboCaptures.find(({ combo }) => combo.name === "default")?.capture

if (!defaultCapture) {
  throw new Error("SURFACE_COMBOS has no default combo")
}

const toolRows = defaultCapture.tools
  .map((tool) => ({
    name: tool.name,
    descriptionChars: tool.description?.length ?? 0,
    totalChars: measureToolDefinitionChars(tool),
  }))
  .toSorted((first, second) => second.totalChars - first.totalChars)

console.log("\ntool (default combo)\tdescription chars\tschema chars\ttotal chars")
for (const row of toolRows) {
  const schemaChars = row.totalChars - row.descriptionChars
  console.log(`${row.name}\t${row.descriptionChars}\t${schemaChars}\t${row.totalChars}`)
}
