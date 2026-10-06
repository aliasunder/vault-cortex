/** Pins the committed wire-surface baseline. Any byte drift in tool names, input
 *  schemas, descriptions, annotations, the prompt surface, or the server
 *  instructions fails here. Intentional changes regenerate the baseline via
 *  `npm run snapshot:update` and land as a reviewable diff in the same PR.
 *  The snapshot sees schemas and rendered text, not runtime response shapes —
 *  those stay enforced by the integration suite's exact assertions. */

import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  SIZE_CAPPED_COMBO_NAMES,
  SURFACE_COMBOS,
  captureToolSurface,
  measureToolListChars,
  serializeSurfaceCapture,
} from "../../../../scripts/tool-surface-capture.js"

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
   *  - The allowance is the default combo's average when it was set (3,983
   *    chars per tool) plus 2%, so only small growth passes.
   *  Raising the allowance is a deliberate change with its reason in the PR. */
  const CHARS_PER_TOOL_ALLOWANCE = 4063

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
