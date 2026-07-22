/** MCP tool definitions — orchestrates tool group registration. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import {
  VAULT_CRUD_TOOL_NAMES,
  registerVaultCrudTools,
} from "./tools/vault-crud-tools.js"
import { SEARCH_TOOL_NAMES, registerSearchTools } from "./tools/search-tools.js"
import { MEMORY_TOOL_NAMES, registerMemoryTools } from "./tools/memory-tools.js"
import {
  DAILY_NOTE_TOOL_NAMES,
  registerDailyNoteTools,
} from "./tools/daily-note-tools.js"
import { TASK_TOOL_NAMES, registerTaskTools } from "./tools/task-tools.js"
import { FILE_TOOL_NAMES, registerAssetTools } from "./tools/asset-tools.js"

export const TOOL_NAMES = {
  ...VAULT_CRUD_TOOL_NAMES,
  ...SEARCH_TOOL_NAMES,
  ...MEMORY_TOOL_NAMES,
  ...DAILY_NOTE_TOOL_NAMES,
  ...TASK_TOOL_NAMES,
  ...FILE_TOOL_NAMES,
} as const

export const registerTools = (params: {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}): void => {
  registerVaultCrudTools(params)
  registerSearchTools(params)
  if (params.config.memoryEnabled) {
    registerMemoryTools(params)
  }
  registerDailyNoteTools(params)
  registerTaskTools(params)
  registerAssetTools(params)

  const registeredCount =
    Object.keys(VAULT_CRUD_TOOL_NAMES).length +
    Object.keys(SEARCH_TOOL_NAMES).length +
    (params.config.memoryEnabled ? Object.keys(MEMORY_TOOL_NAMES).length : 0) +
    Object.keys(DAILY_NOTE_TOOL_NAMES).length +
    Object.keys(TASK_TOOL_NAMES).length +
    Object.keys(FILE_TOOL_NAMES).length
  params.logger.info("registered tools", { count: registeredCount })
}
