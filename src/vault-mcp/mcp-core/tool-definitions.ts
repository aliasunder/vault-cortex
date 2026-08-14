/** MCP tool definitions — orchestrates tool group registration. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import {
  VAULT_CRUD_TOOL_NAMES,
  VAULT_CRUD_READ_TOOL_NAMES,
  VAULT_CRUD_WRITE_TOOL_NAMES,
  registerVaultCrudReadTools,
  registerVaultCrudWriteTools,
} from "./tools/vault-crud-tools.js"
import { SEARCH_TOOL_NAMES, registerSearchTools } from "./tools/search-tools.js"
import {
  MEMORY_TOOL_NAMES,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  registerMemoryReadTools,
  registerMemoryWriteTools,
} from "./tools/memory-tools.js"
import {
  DAILY_NOTE_TOOL_NAMES,
  registerDailyNoteTools,
} from "./tools/daily-note-tools.js"
import {
  TASK_TOOL_NAMES,
  TASK_READ_TOOL_NAMES,
  TASK_WRITE_TOOL_NAMES,
  registerTaskReadTools,
  registerTaskWriteTools,
} from "./tools/task-tools.js"
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

  const countNames = (names: Record<string, string>): number =>
    Object.keys(names).length
  const registeredCount =
    countNames(VAULT_CRUD_READ_TOOL_NAMES) +
    (writeToolsEnabled ? countNames(VAULT_CRUD_WRITE_TOOL_NAMES) : 0) +
    countNames(SEARCH_TOOL_NAMES) +
    (params.config.memoryEnabled
      ? countNames(MEMORY_READ_TOOL_NAMES) +
        (writeToolsEnabled ? countNames(MEMORY_WRITE_TOOL_NAMES) : 0)
      : 0) +
    countNames(DAILY_NOTE_TOOL_NAMES) +
    countNames(TASK_READ_TOOL_NAMES) +
    (writeToolsEnabled ? countNames(TASK_WRITE_TOOL_NAMES) : 0) +
    (params.config.fileToolsEnabled ? countNames(FILE_TOOL_NAMES) : 0)
  params.logger.info("registered tools", { count: registeredCount })
}
