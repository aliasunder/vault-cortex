/** MCP tool definitions — computes the enabled tool set from the registry
 *  and orchestrates tool group registration. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { TOOL_REGISTRY } from "./tool-registry.js"
import type { RegistryEntry, ToolName } from "./tool-registry.js"
import {
  registerVaultCrudReadTools,
  registerVaultCrudWriteTools,
} from "./tools/vault-crud-tools.js"
import { registerSearchTools } from "./tools/search-tools.js"
import {
  registerMemoryReadTools,
  registerMemoryWriteTools,
} from "./tools/memory-tools.js"
import { registerDailyNoteTools } from "./tools/daily-note-tools.js"
import {
  registerTaskReadTools,
  registerTaskWriteTools,
} from "./tools/task-tools.js"
import { registerAssetTools } from "./tools/asset-tools.js"

/** One AND-chain of independent predicates over the registry decides the
 *  tool surface. Each axis contributes one predicate: the flag-gated groups
 *  (memory, asset), then read-only mode — which keeps exactly the tools whose
 *  own `readOnlyHint` annotation says they don't write. Subtractive only: no
 *  predicate can re-enable a tool another predicate removed. */
const isToolEnabled = (entry: RegistryEntry, config: VaultConfig): boolean => {
  if (entry.group === "memory" && !config.memoryEnabled) return false
  if (entry.group === "asset" && !config.fileToolsEnabled) return false
  if (config.readOnlyMode && !entry.annotations.readOnlyHint) return false
  return true
}

/** The set of tool names this config serves — shared by registration, the
 *  router's server metadata, and prompt gating so they cannot disagree. */
export const computeEnabledToolNames = (
  config: VaultConfig,
): ReadonlySet<ToolName> => {
  const enabledEntries = TOOL_REGISTRY.filter((entry) =>
    isToolEnabled(entry, config),
  )
  return new Set(enabledEntries.map((entry) => entry.name))
}

export const registerTools = (params: {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}): void => {
  const enabledToolNames = computeEnabledToolNames(params.config)

  // Read-only mode gates each mixed group's write half; the memory group is
  // additionally gated as a whole (reads included) by memoryEnabled.
  const writeToolsEnabled = !params.config.readOnlyMode
  registerVaultCrudReadTools(params)
  if (writeToolsEnabled) {
    registerVaultCrudWriteTools(params)
  }
  registerSearchTools(params)
  if (params.config.memoryEnabled) {
    registerMemoryReadTools(params)
    if (writeToolsEnabled) {
      registerMemoryWriteTools(params)
    }
  }
  registerDailyNoteTools(params)
  registerTaskReadTools(params)
  if (writeToolsEnabled) {
    registerTaskWriteTools(params)
  }
  if (params.config.fileToolsEnabled) {
    registerAssetTools(params)
  }

  params.logger.info("registered tools", { count: enabledToolNames.size })
}
