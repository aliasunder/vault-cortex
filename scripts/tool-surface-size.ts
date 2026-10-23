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
  measureErrorsSectionChars,
  measureToolDefinitionChars,
  measureToolListChars,
} from "./tool-surface-capture.js"

/** A share as a percentage with one decimal, the precision the per-tool
 *  `Errors:` targets are stated in. */
const formatPercent = (part: number, whole: number): string => {
  return whole === 0 ? "0.0%" : `${((100 * part) / whole).toFixed(1)}%`
}

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
    .map((tool) => ({
      name: tool.name,
      ...measureToolDefinitionChars(tool),
      errorsChars: measureErrorsSectionChars(tool),
    }))
    .toSorted((first, second) => second.totalChars - first.totalChars)

  console.log(
    `\ntool (${comboName} combo)\tdescription chars\tschema chars\ttotal chars\terrors chars\terrors % of description\terrors % of definition`,
  )
  for (const row of toolRows) {
    const descriptionShare = formatPercent(row.errorsChars, row.descriptionChars)
    const definitionShare = formatPercent(row.errorsChars, row.totalChars)
    console.log(
      `${row.name}\t${row.descriptionChars}\t${row.inputSchemaChars}\t${row.totalChars}\t${row.errorsChars}\t${descriptionShare}\t${definitionShare}`,
    )
  }

  // The Errors sections' share of the whole list, the measure the
  // error-prose work is judged by
  const errorsTotal = toolRows.reduce((sum, row) => sum + row.errorsChars, 0)
  const descriptionTotal = toolRows.reduce((sum, row) => sum + row.descriptionChars, 0)
  const definitionTotal = toolRows.reduce((sum, row) => sum + row.totalChars, 0)
  console.log(
    `errors total (${comboName} combo)\t${errorsTotal}\t${formatPercent(errorsTotal, descriptionTotal)} of descriptions\t${formatPercent(errorsTotal, definitionTotal)} of definitions`,
  )
}
