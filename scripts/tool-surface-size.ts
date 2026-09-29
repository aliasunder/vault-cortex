// Prints how many characters the MCP tool definitions take up (UTF-16 code
// units, not tokens), as a total per config combo and then one row per tool
// for the default combo. A config combo is one set of feature switches, such
// as read-only or memory-off, and each combo registers a different tool list.
//
// Clients that load every tool definition up front (claude.ai, Claude Desktop)
// spend this context in every conversation, so compare the output before and
// after editing a description. The per-tool rows show what the size cap in
// tool-surface-snapshot.test.ts can't, because the cap checks a combo's total
// and one tool can grow while another shrinks.
//
// Usage: npm run report:tool-surface-size

// tool-surface-capture.ts sits under __tests__/ but imports no test runner, so
// this script can load it.
import {
  SURFACE_COMBOS,
  captureToolSurface,
  measureToolDefinitionChars,
  measureToolListChars,
} from "../src/vault-mcp/mcp-core/__tests__/tool-surface-capture.js"

// The combo with no switch flipped, which registers every tool.
const DEFAULT_COMBO_NAME = "default"

const comboCaptures = await Promise.all(
  SURFACE_COMBOS.map(async (combo) => ({ combo, capture: await captureToolSurface(combo) })),
)

console.log("combo\ttools\ttotal chars\tavg chars per tool")
for (const { combo, capture } of comboCaptures) {
  const totalChars = measureToolListChars(capture.tools)
  const averageCharsPerTool = Math.round(totalChars / capture.tools.length)
  console.log(`${combo.name}\t${capture.tools.length}\t${totalChars}\t${averageCharsPerTool}`)
}

const defaultCapture = comboCaptures.find(({ combo }) => combo.name === DEFAULT_COMBO_NAME)?.capture

if (!defaultCapture) {
  throw new Error(`SURFACE_COMBOS has no "${DEFAULT_COMBO_NAME}" combo`)
}

const toolRows = defaultCapture.tools
  .map((tool) => ({ name: tool.name, ...measureToolDefinitionChars(tool) }))
  .toSorted((first, second) => second.totalChars - first.totalChars)

console.log("\ntool (default combo)\tdescription chars\tschema chars\ttotal chars")
for (const row of toolRows) {
  console.log(`${row.name}\t${row.descriptionChars}\t${row.inputSchemaChars}\t${row.totalChars}`)
}
