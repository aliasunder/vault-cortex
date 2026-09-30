// Prints how many characters the MCP tool definitions take up (UTF-16 code
// units, not tokens), as a total per config combo and then one row per tool
// for each combo that the size cap in tool-surface-snapshot.test.ts checks. A
// config combo is one set of feature switches, such as read-only or
// memory-off, and each combo registers a different tool list.
//
// Clients that load every tool definition up front (claude.ai, Claude Desktop)
// spend this context in every conversation, so compare the output before and
// after editing a description. The per-tool rows show what that cap can't,
// because it checks a combo's total and one tool can grow while another
// shrinks.
//
// Run it with `npm run report:tool-surface-size`.

import {
  SIZE_CAPPED_COMBO_NAMES,
  SURFACE_COMBOS,
  captureToolSurface,
  measureToolDefinitionChars,
  measureToolListChars,
} from "./tool-surface-capture.js"

const comboCaptures = await Promise.all(
  SURFACE_COMBOS.map(async (combo) => ({ combo, capture: await captureToolSurface(combo) })),
)

console.log("combo\ttools\ttotal chars\tavg chars per tool")
for (const { combo, capture } of comboCaptures) {
  const totalChars = measureToolListChars(capture.tools)
  const averageCharsPerTool = Math.round(totalChars / capture.tools.length)
  console.log(`${combo.name}\t${capture.tools.length}\t${totalChars}\t${averageCharsPerTool}`)
}

// A tool's text can differ between the capped combos (the search tools render
// keyword-only text when embeddings are off), so each capped combo gets its
// own rows. A failing cap can then be traced to a tool in the combo that failed.
for (const comboName of SIZE_CAPPED_COMBO_NAMES) {
  const capture = comboCaptures.find(({ combo }) => combo.name === comboName)?.capture

  if (!capture) {
    throw new Error(`SURFACE_COMBOS has no "${comboName}" combo`)
  }

  const toolRows = capture.tools
    .map((tool) => ({ name: tool.name, ...measureToolDefinitionChars(tool) }))
    .toSorted((first, second) => second.totalChars - first.totalChars)

  console.log(`\ntool (${comboName} combo)\tdescription chars\tschema chars\ttotal chars`)
  for (const row of toolRows) {
    console.log(`${row.name}\t${row.descriptionChars}\t${row.inputSchemaChars}\t${row.totalChars}`)
  }
}
