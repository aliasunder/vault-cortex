/** The committed wire-surface baseline: any byte drift in tool names, input
 *  schemas, descriptions, annotations, the prompt surface, or the server
 *  instructions fails here. Intentional changes regenerate the baseline via
 *  `npm run snapshot:update` and land as a reviewable diff in the same PR.
 *  The snapshot sees schemas and rendered text, not runtime response shapes —
 *  those stay enforced by the integration suite's exact assertions. */

import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  SURFACE_COMBOS,
  captureToolSurface,
  serializeSurfaceCapture,
} from "./tool-surface-capture.js"

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

  // Guards two gaps vitest's file snapshots leave open: an orphaned file
  // lingering after an axis change (nothing ever asserts it again), and a
  // locally auto-created file that never went through a deliberate regen.
  it("snapshot directory holds exactly one file per combo", () => {
    const snapshotDirectory = fileURLToPath(
      new URL("./__snapshots__/tool-surface/", import.meta.url),
    )
    const committedFiles = readdirSync(snapshotDirectory).toSorted()
    const expectedFiles = SURFACE_COMBOS.map(
      (combo) => `${combo.name}.json`,
    ).toSorted()
    expect(committedFiles).toEqual(expectedFiles)
  })
})
