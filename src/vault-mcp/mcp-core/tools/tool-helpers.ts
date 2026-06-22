/** Shared types and helpers for tool group modules. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../../search/search-index.js"
import type { VaultConfig } from "../../config.js"
import type { Logger } from "../../../logger.js"
import { describeError } from "../../../utils/describe-error.js"

export type ToolRegistrationContext = {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}

// Frontmatter keys that are already top-level fields on NoteMetadata.
// These are stripped from `properties` before returning to clients
// so the response doesn't contain the same data twice.
const PROMOTED_KEYS = new Set(["title", "tags", "type", "created", "related"])

/** Reshapes NoteMetadata for client responses: keeps all top-level fields,
 *  replaces `properties` (full frontmatter, mostly duplicated) with
 *  `additional_properties` (only unpromoted keys like topic, agent, date). */
export const formatNoteMetadata = (meta: {
  properties: Record<string, unknown>
  [key: string]: unknown
}): Record<string, unknown> => {
  // Drop a null `leading_callout` so notes without one don't carry the key;
  // keep it (the { type, title, body } block) when present.
  const { properties, leading_callout: leadingCallout, ...fields } = meta

  const additional_properties = Object.fromEntries(
    Object.entries(properties).filter(([key]) => !PROMOTED_KEYS.has(key)),
  )

  return {
    ...fields,
    ...(leadingCallout ? { leading_callout: leadingCallout } : {}),
    ...(Object.keys(additional_properties).length > 0
      ? { additional_properties }
      : {}),
  }
}

/** Wraps a handler with try/catch, returning isError on failure. */
export const safeHandler = async <T>(
  logger: Logger,
  fn: () => Promise<T>,
  format: (result: T) => string,
): Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: true
}> => {
  try {
    const result = await fn()
    return {
      content: [{ type: "text" as const, text: format(result) }],
    }
  } catch (err) {
    const message = describeError(err)
    logger.warn("tool_error", { error: message })
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true as const,
    }
  }
}
