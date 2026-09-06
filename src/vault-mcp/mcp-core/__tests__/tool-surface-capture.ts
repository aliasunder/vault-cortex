/** Captures the MCP wire surface — tool schemas, descriptions, annotations,
 *  prompts, and server instructions — per config combo, over a real in-process
 *  server. Feeds the committed baseline in __snapshots__/tool-surface/. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js"
import { loadConfig } from "../../config.js"
import { createSearchIndex } from "../../search/search-index.js"
import { computeEnabledToolNames, registerTools } from "../tool-definitions.js"
import { registerPrompts } from "../prompt-definitions.js"
import { buildServerMetadata } from "../mcp-router.js"
import type { Logger } from "../../../logger.js"

type SurfaceAxis = {
  envVar: string
  /** The non-default value that changes the surface. */
  flippedValue: string
  /** Short label used in the combo's snapshot filename. */
  label: string
}

/** Boolean config axes that change the registered tool surface or its rendered
 *  text. The snapshot combos are the cross-product of this array — a new
 *  gating axis in config.ts must be added here, or its states go unpinned. */
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

const comboFromFlippedAxes = (
  flippedAxes: readonly SurfaceAxis[],
): SurfaceCombo => {
  if (flippedAxes.length === 0) {
    return { name: "default", env: {} }
  }
  return {
    name: flippedAxes.map((axis) => axis.label).join("+"),
    env: Object.fromEntries(
      flippedAxes.map((axis) => [axis.envVar, axis.flippedValue]),
    ),
  }
}

/** The 16 axis combos plus one DISABLED_TOOLS representative:
 *  - vault_patch_note is cross-referenced from other tools' descriptions, so
 *    its combo verifies those references disappear when the tool is disabled.
 *  - Conjunction combos pin rendered states that exist only in multi-flip
 *    configs (several description clauses drop together). */
export const SURFACE_COMBOS: readonly SurfaceCombo[] = [
  ...axisSubsets.map(comboFromFlippedAxes),
  { name: "disabled-tools", env: { DISABLED_TOOLS: "vault_patch_note" } },
]

const noop = (): void => {}
/** The drift test's assertion output is the report, so registration's
 *  per-group summary lines stay quiet. */
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
const sortByName = <T extends { name: string }>(items: readonly T[]): T[] =>
  items.toSorted((first, second) => (first.name < second.name ? -1 : 1))

export type SurfaceCapture = {
  env: Readonly<Record<string, string>>
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
export const captureToolSurface = async (
  combo: SurfaceCombo,
): Promise<SurfaceCapture> => {
  const config = loadConfig(combo.env)
  const { instructions } = buildServerMetadata(
    config,
    computeEnabledToolNames(config),
  )
  const server = new McpServer(
    { name: "vault-cortex", version: "0.0.0" },
    { instructions },
  )
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

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "tool-surface-capture", version: "0.0.0" })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  const toolsResult = await client.listTools()
  const promptsResult = await client.listPrompts()
  const capturedInstructions = client.getInstructions()
  await client.close()

  assertSinglePage("tools/list", toolsResult.nextCursor)
  assertSinglePage("prompts/list", promptsResult.nextCursor)
  if (!capturedInstructions) {
    throw new Error(
      "server sent no instructions; buildServerMetadata always provides them",
    )
  }

  return {
    env: combo.env,
    instructions: capturedInstructions,
    tools: sortByName(toolsResult.tools),
    prompts: sortByName(promptsResult.prompts),
  }
}

/** Byte-exact committed form: pre-serialized so vitest writes the file
 *  verbatim (the snapshot directory is prettier-ignored to keep it that way). */
export const serializeSurfaceCapture = (capture: SurfaceCapture): string =>
  `${JSON.stringify(capture, null, 2)}\n`
