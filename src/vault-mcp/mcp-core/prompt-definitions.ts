/** MCP prompt definitions — orchestrates prompt group registration. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
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
  registerVaultOrientationPrompt(params)
  // memory-review's whole purpose is proposing memory writes, so it needs
  // both the memory layer and a writable server.
  const memoryReviewEnabled =
    params.config.memoryEnabled && !params.config.readOnlyMode
  if (memoryReviewEnabled) {
    registerMemoryReviewPrompt(params)
  }
  registerDailyReviewPrompt(params)

  const promptCount =
    Object.keys(VAULT_ORIENTATION_PROMPT_NAMES).length +
    (memoryReviewEnabled ? Object.keys(MEMORY_REVIEW_PROMPT_NAMES).length : 0) +
    Object.keys(DAILY_REVIEW_PROMPT_NAMES).length
  params.logger.info("registered prompts", { count: promptCount })
}
