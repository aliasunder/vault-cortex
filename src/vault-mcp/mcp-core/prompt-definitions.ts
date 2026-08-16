/** MCP prompt definitions — orchestrates prompt group registration. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { computeEnabledToolNames } from "./tool-definitions.js"
import type { ToolName } from "./tool-registry.js"
import type { PromptRegistrationContext } from "./prompts/prompt-helpers.js"
import {
  VAULT_ORIENTATION_PROMPT_NAMES,
  registerVaultOrientationPrompt,
} from "./prompts/vault-orientation-prompt.js"
import {
  MEMORY_REVIEW_PROMPT_NAMES,
  registerMemoryReviewPrompt,
} from "./prompts/memory-review-prompt.js"
import {
  DAILY_REVIEW_PROMPT_NAMES,
  registerDailyReviewPrompt,
} from "./prompts/daily-review-prompt.js"

export const PROMPT_NAMES = {
  ...VAULT_ORIENTATION_PROMPT_NAMES,
  ...MEMORY_REVIEW_PROMPT_NAMES,
  ...DAILY_REVIEW_PROMPT_NAMES,
} as const

export const registerPrompts = (params: {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}): void => {
  const enabledToolNames = computeEnabledToolNames(params.config)
  const isToolEnabled = (name: ToolName): boolean => enabledToolNames.has(name)
  const context: PromptRegistrationContext = {
    ...params,
    isToolEnabled,
    whenToolEnabled: (name, text) => (isToolEnabled(name) ? text : ""),
  }

  registerVaultOrientationPrompt(context)
  // memory-review's whole purpose is proposing memory writes, so it follows
  // its write tool: hidden whenever vault_update_memory is — memory layer
  // off, read-only mode, or the tool individually disabled.
  const memoryReviewEnabled = isToolEnabled("vault_update_memory")
  if (memoryReviewEnabled) {
    registerMemoryReviewPrompt(context)
  }
  registerDailyReviewPrompt(context)

  const promptCount =
    Object.keys(VAULT_ORIENTATION_PROMPT_NAMES).length +
    (memoryReviewEnabled ? Object.keys(MEMORY_REVIEW_PROMPT_NAMES).length : 0) +
    Object.keys(DAILY_REVIEW_PROMPT_NAMES).length
  params.logger.info("registered prompts", { count: promptCount })
}
