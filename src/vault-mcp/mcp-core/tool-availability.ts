/** How generated text talks about tools, given the set this config serves.
 *
 *  Descriptions, prompt steps, and server metadata all name sibling tools, and
 *  every one of those references has to disappear when its target does — for
 *  any gating reason, including axes added after the text was written. That
 *  makes "is this tool served?" a question three surfaces ask, so the answer
 *  lives here rather than being rebuilt beside each of them. */

import type { ToolName } from "./tool-registry.js"

// Renders alternatives the way the surrounding prose reads them: "A",
// "A or B", "A, B, or C". Stateless, so it is built once.
const TOOL_LIST_FORMAT = new Intl.ListFormat("en", {
  style: "long",
  type: "disjunction",
})

/** The availability view handed to tool and prompt group modules. Both group
 *  surfaces take this same shape, so a reference reads identically wherever
 *  it appears. */
export type ToolAvailability = {
  /** True when the config serves the named tool. */
  isToolEnabled: (name: ToolName) => boolean
  /** The text when the named tool is enabled, "" otherwise — the building
   *  block for availability-keyed cross-references. */
  whenToolEnabled: (name: ToolName, text: string) => string
  /** The served subset of `names`, rendered as a prose alternatives list.
   *  Empty when none is served, so a sentence built around it must handle
   *  that case rather than trailing off — every tool in a list can be
   *  removed individually via DISABLED_TOOLS. */
  formatEnabledToolList: (names: readonly ToolName[]) => string
}

/** Binds the enabled set into the availability view its consumers share. */
export const createToolAvailability = (
  enabledToolNames: ReadonlySet<ToolName>,
): ToolAvailability => {
  const isToolEnabled = (name: ToolName): boolean => enabledToolNames.has(name)
  return {
    isToolEnabled,
    whenToolEnabled: (name, text) => (isToolEnabled(name) ? text : ""),
    formatEnabledToolList: (names) =>
      TOOL_LIST_FORMAT.format(names.filter(isToolEnabled)),
  }
}
