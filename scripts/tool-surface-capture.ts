/** Captures the MCP wire surface — tool schemas, descriptions, annotations,
 *  prompts, server description, and server instructions — per config combo,
 *  over a real in-process server. It feeds `tool-surface-snapshot.test.ts` in
 *  `src/vault-mcp/mcp-core/__tests__/`, which pins the committed baseline and
 *  caps the tool list's size; `tool-surface-size.ts`, the size report; and
 *  `lobehub-manifest.ts`, which publishes the default combo's surface. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js"
import { loadConfig } from "../src/vault-mcp/config.js"
import { createSearchIndex } from "../src/vault-mcp/search/search-index.js"
import {
  computeEnabledToolNames,
  registerTools,
} from "../src/vault-mcp/mcp-core/tool-definitions.js"
import { registerPrompts } from "../src/vault-mcp/mcp-core/prompt-definitions.js"
import { buildServerMetadata } from "../src/vault-mcp/mcp-core/mcp-router.js"
import type { Logger } from "../src/logger.js"

type SurfaceAxis = {
  envVar: string
  /** The non-default value that changes the surface. */
  flippedValue: string
  /** Short label used in the combo's snapshot filename. */
  label: string
}

/** Boolean config axes that change which tools are registered or the text of
 *  several tools. The snapshot combos are the cross-product of this array — a
 *  new gating axis in config.ts must be added here, or its states go unpinned.
 *  A setting that changes one tool's text gets a single combo in
 *  SURFACE_COMBOS instead. */
const SURFACE_AXES: readonly SurfaceAxis[] = [
  { envVar: "READONLY_MODE", flippedValue: "true", label: "readonly" },
  { envVar: "MEMORY_ENABLED", flippedValue: "false", label: "memory-off" },
  {
    envVar: "FILE_TOOLS_ENABLED",
    flippedValue: "false",
    label: "file-tools-off",
  },
  {
    envVar: "EMBEDDING_ENABLED",
    flippedValue: "false",
    label: "embedding-off",
  },
]

export type SurfaceCombo = {
  /** Snapshot filename stem; multi-flip combos join axis labels with "+". */
  name: string
  env: Readonly<Record<string, string>>
}

/** All subsets of the axis list, built by extending every existing subset
 *  with and without each axis — 2^n subsets, the empty (default) one first. */
const axisSubsets = SURFACE_AXES.reduce<readonly (readonly SurfaceAxis[])[]>(
  (subsets, axis) => {
    const subsetsWithAxis = subsets.map((subset) => [...subset, axis])
    return [...subsets, ...subsetsWithAxis]
  },
  [[]],
)

const comboFromFlippedAxes = (flippedAxes: readonly SurfaceAxis[]): SurfaceCombo => {
  if (flippedAxes.length === 0) {
    return { name: "default", env: {} }
  }
  return {
    name: flippedAxes.map((axis) => axis.label).join("+"),
    env: Object.fromEntries(flippedAxes.map((axis) => [axis.envVar, axis.flippedValue])),
  }
}

/** The 16 axis combos plus two single-setting representatives:
 *  - Conjunction combos pin rendered states that exist only in multi-flip
 *    configs (several description clauses drop together).
 *  - disabled-tools: vault_patch_note is cross-referenced from other tools'
 *    descriptions, so its combo verifies those references disappear when the
 *    tool is disabled.
 *  - obsidian-sync: OBSIDIAN_SYNC changes only vault_delete_note's Errors
 *    list, so one combo pins it; crossing it with the axes would double the
 *    baseline without adding a rendered state. */
export const SURFACE_COMBOS: readonly SurfaceCombo[] = [
  ...axisSubsets.map(comboFromFlippedAxes),
  { name: "disabled-tools", env: { DISABLED_TOOLS: "vault_patch_note" } },
  { name: "obsidian-sync", env: { OBSIDIAN_SYNC: "true" } },
]

const noop = (): void => {}
/** Every consumer prints its own output, so registration's per-group summary
 *  lines stay quiet. */
const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => silentLogger,
}

/** Fails loudly if the SDK ever starts paginating these lists — a truncated
 *  capture would silently understate the surface in the baseline. */
const assertSinglePage = (listName: string, nextCursor?: string): void => {
  if (nextCursor) {
    throw new Error(
      `${listName} returned a paginated response; the surface capture reads one page only`,
    )
  }
}

/** Bytewise name sort so registration-order refactors don't churn the
 *  baseline — list order is not part of the stability contract. */
const sortByName = <T extends { name: string }>(items: readonly T[]): T[] => {
  return items.toSorted((first, second) => (first.name < second.name ? -1 : 1))
}

export type SurfaceCapture = {
  env: Readonly<Record<string, string>>
  description: string
  instructions: string
  tools: readonly Tool[]
  prompts: readonly Prompt[]
}

/**
 * Boots the real registration path for one combo and reads the surface a
 * connected client sees — the SDK's own schema serialization, not a re-derived
 * copy. The search index is an empty in-memory database and the vault path is
 * never read: registration only declares metadata, and no tool handler runs.
 */
export const captureToolSurface = async (combo: SurfaceCombo): Promise<SurfaceCapture> => {
  const config = loadConfig(combo.env)
  const { instructions, description } = buildServerMetadata(config, computeEnabledToolNames(config))
  const server = new McpServer({ name: "vault-cortex", version: "0.0.0" }, { instructions })
  const registrationContext = {
    server,
    vaultPath: "/vault",
    search: createSearchIndex(":memory:", undefined, undefined, {
      memoryDir: config.memoryDir,
    }),
    logger: silentLogger,
    config,
  }
  registerTools(registrationContext)
  registerPrompts(registrationContext)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "tool-surface-capture", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const toolsResult = await client.listTools()
  const promptsResult = await client.listPrompts()
  const capturedInstructions = client.getInstructions()
  await client.close()

  assertSinglePage("tools/list", toolsResult.nextCursor)
  assertSinglePage("prompts/list", promptsResult.nextCursor)
  if (!capturedInstructions) {
    throw new Error("server sent no instructions; buildServerMetadata always provides them")
  }

  return {
    env: combo.env,
    description,
    instructions: capturedInstructions,
    tools: sortByName(toolsResult.tools),
    prompts: sortByName(promptsResult.prompts),
  }
}

type ToolDefinitionChars = Readonly<{
  descriptionChars: number
  inputSchemaChars: number
  totalChars: number
}>

/** Measures the context a client spends on one tool definition, in UTF-16 code
 *  units (JavaScript string length): the description plus the JSON-serialized
 *  input schema. The name, title, and annotations are left out because they are
 *  short and change only when a tool is added. The size cap in
 *  `tool-surface-snapshot.test.ts` and `npm run report:tool-surface-size` both
 *  use this measure. */
export const measureToolDefinitionChars = (tool: Tool): ToolDefinitionChars => {
  const descriptionChars = tool.description?.length ?? 0
  const inputSchemaChars = JSON.stringify(tool.inputSchema).length

  return { descriptionChars, inputSchemaChars, totalChars: descriptionChars + inputSchemaChars }
}

export const measureToolListChars = (tools: readonly Tool[]): number => {
  const toolTotals = tools.map((tool) => measureToolDefinitionChars(tool).totalChars)
  return toolTotals.reduce((sum, toolChars) => sum + toolChars, 0)
}

/** The combos the size cap in `tool-surface-snapshot.test.ts` checks, which
 *  hold the two largest tool lists:
 *  - default registers every tool.
 *  - embedding-off renders the search tools' keyword-only text, which default
 *    never shows.
 *
 *  Every other combo drops tools, cross-references, or Errors entries from one
 *  of these two, so its total is smaller than a checked total. Its average per
 *  tool can still exceed that cap's `CHARS_PER_TOOL_ALLOWANCE` (memory-off
 *  drops five small tools), so the allowance bounds the two checked lists, not
 *  every combo's average. */
export const SIZE_CAPPED_COMBO_NAMES = ["default", "embedding-off"] as const

/** Byte-exact committed form: pre-serialized so vitest writes the file
 *  verbatim (the snapshot directory is prettier-ignored to keep it that way). */
export const serializeSurfaceCapture = (capture: SurfaceCapture): string => {
  return `${JSON.stringify(capture, null, 2)}\n`
}
