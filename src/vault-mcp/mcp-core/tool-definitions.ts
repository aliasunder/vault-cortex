/** MCP tool definitions — computes the enabled tool set from the registry
 *  and orchestrates tool group registration through the gated wrapper. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { TOOL_REGISTRY, TOOL_REGISTRY_BY_NAME } from "./tool-registry.js"
import type { RegistryEntry, ToolGroup, ToolName } from "./tool-registry.js"
import { createToolAvailability } from "./tool-availability.js"
import type {
  RegisterGatedTool,
  ToolRegistrationContext,
} from "./tools/tool-helpers.js"
import { registerVaultCrudTools } from "./tools/vault-crud-tools.js"
import { registerSearchTools } from "./tools/search-tools.js"
import { registerMemoryTools } from "./tools/memory-tools.js"
import { registerDailyNoteTools } from "./tools/daily-note-tools.js"
import { registerTaskTools } from "./tools/task-tools.js"
import { registerAssetTools } from "./tools/asset-tools.js"

/** One AND-chain of independent predicates over the registry decides the
 *  tool surface. Each axis contributes one predicate: the flag-gated groups
 *  (memory, asset), read-only mode — which keeps exactly the tools whose own
 *  `readOnlyHint` annotation says they don't write — and the DISABLED_TOOLS
 *  per-tool list. Subtractive only: no predicate can re-enable a tool
 *  another predicate removed. */
const isEntryEnabled = (entry: RegistryEntry, config: VaultConfig): boolean => {
  if (entry.group === "memory" && !config.memoryEnabled) return false
  if (entry.group === "asset" && !config.fileToolsEnabled) return false
  if (config.readOnlyMode && !entry.annotations.readOnlyHint) return false
  if (config.disabledTools.has(entry.name)) return false
  return true
}

/** The set of tool names this config serves — shared by registration, the
 *  router's server metadata, and prompt gating so they cannot disagree. */
export const computeEnabledToolNames = (
  config: VaultConfig,
): ReadonlySet<ToolName> => {
  const enabledEntries = TOOL_REGISTRY.filter((entry) =>
    isEntryEnabled(entry, config),
  )
  return new Set(enabledEntries.map((entry) => entry.name))
}

/** Binds the SDK server and the enabled set into the gate every group module
 *  registers through. See RegisterGatedTool for the contract. */
const createGatedRegisterTool = (
  server: McpServer,
  enabledToolNames: ReadonlySet<ToolName>,
): RegisterGatedTool => {
  return (name, config, handler) => {
    const entry = TOOL_REGISTRY_BY_NAME.get(name)
    if (!entry) {
      throw new Error(`tool is not in the registry: ${name}`)
    }
    if (!enabledToolNames.has(name)) return
    server.registerTool(
      name,
      { ...config, annotations: entry.annotations },
      handler,
    )
  }
}

/** Group register functions, invoked in registration order. Groups whose
 *  tools are all disabled are skipped entirely, so a disabled group performs
 *  none of its per-group setup. */
const GROUP_REGISTRARS: readonly (readonly [
  ToolGroup,
  (context: ToolRegistrationContext) => void,
])[] = [
  ["vault-crud", registerVaultCrudTools],
  ["search", registerSearchTools],
  ["memory", registerMemoryTools],
  ["daily-note", registerDailyNoteTools],
  ["task", registerTaskTools],
  ["asset", registerAssetTools],
]

export const registerTools = (params: {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}): void => {
  const enabledToolNames = computeEnabledToolNames(params.config)
  const context: ToolRegistrationContext = {
    ...createToolAvailability(enabledToolNames),
    registerTool: createGatedRegisterTool(params.server, enabledToolNames),
    vaultPath: params.vaultPath,
    search: params.search,
    logger: params.logger,
    config: params.config,
  }

  const groupHasEnabledTools = (group: ToolGroup): boolean =>
    TOOL_REGISTRY.some(
      (entry) => entry.group === group && enabledToolNames.has(entry.name),
    )

  for (const [group, registerGroup] of GROUP_REGISTRARS) {
    if (groupHasEnabledTools(group)) {
      registerGroup(context)
    }
  }

  params.logger.info("registered tools", { count: enabledToolNames.size })
}
