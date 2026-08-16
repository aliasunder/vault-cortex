/** Shared types and helpers for tool group modules. */

import { z } from "zod"
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { SearchIndex } from "../../search/search-index.js"
import type { VaultConfig } from "../../config.js"
import type { Logger } from "../../../logger.js"
import type { LineWindow } from "../../obsidian-markdown/lines.js"
import type { ToolName } from "../tool-registry.js"
import { describeError } from "../../../utils/describe-error.js"

/** Registers one tool through the enabled-set gate: skips silently when the
 *  config disables the tool, and injects the registry's annotations so group
 *  modules never restate them — the config type carries no annotations key,
 *  making an inline block a compile error. Throws on a name missing from the
 *  registry (a typo'd registration would otherwise be invisible forever). */
export type RegisterGatedTool = <
  InputArgs extends undefined | ZodRawShapeCompat = undefined,
>(
  name: ToolName,
  config: { title: string; description: string; inputSchema?: InputArgs },
  handler: ToolCallback<InputArgs>,
) => void

export type ToolRegistrationContext = {
  registerTool: RegisterGatedTool
  /** True when the config serves the named tool. Description builders key
   *  cross-references on this instead of on config flags, so a reference
   *  disappears whenever its target does — for any reason, including axes
   *  added later. */
  isToolEnabled: (name: ToolName) => boolean
  /** The text when the named tool is enabled, "" otherwise — the building
   *  block for availability-keyed description cross-references. */
  whenToolEnabled: (name: ToolName, text: string) => string
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

/** Shared Zod schema for one date filter ({ before, on, after }) — used by
 *  vault_list_tasks' task date filters and vault_search's created/modified. */
export const dateFilterSchema = z
  .object({
    before: z
      .string()
      .min(1)
      .optional()
      .describe("Exclusive upper bound (YYYY-MM-DD) — strictly earlier dates"),
    on: z.string().min(1).optional().describe("Exact date match (YYYY-MM-DD)"),
    after: z
      .string()
      .min(1)
      .optional()
      .describe("Exclusive lower bound (YYYY-MM-DD) — strictly later dates"),
  })
  .optional()

/** One-line, model-facing summary of a paged text read: the window served,
 *  the rendition's total line count, and the next start_line when more
 *  remains — shared by vault_read_note and vault_read_file. */
export const describeTextWindow = (
  path: string,
  lineWindow: LineWindow,
): string => {
  const { startLine, endLine, totalLines } = lineWindow

  if (totalLines === 0) return `${path} — 0 lines (end of file)`

  const isLastWindow = endLine >= totalLines
  const continuation = isLastWindow
    ? "(end of file)"
    : `(continue with start_line: ${endLine + 1})`

  return `${path} — lines ${startLine}–${endLine} of ${totalLines} ${continuation}`
}

/** Wraps a handler with try/catch, returning isError on failure. The format
 *  callback produces the full content-block array — text, image, or mixed
 *  (the SDK union) — for tools whose results aren't a single text block. */
export const safeHandlerContent = async <T>(
  logger: Logger,
  fn: () => Promise<T>,
  format: (result: T) => CallToolResult["content"],
): Promise<{
  content: CallToolResult["content"]
  isError?: true
}> => {
  try {
    const result = await fn()
    return { content: format(result) }
  } catch (err) {
    const message = describeError(err)
    logger.warn("tool_error", { error: message })
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true as const,
    }
  }
}

/** Wraps a handler with try/catch, returning isError on failure — the common
 *  single-text-block case. Delegates to safeHandlerContent so the error
 *  contract (describeError, tool_error log, isError) has exactly one home. */
export const safeHandler = <T>(
  logger: Logger,
  fn: () => Promise<T>,
  format: (result: T) => string,
): Promise<{
  content: CallToolResult["content"]
  isError?: true
}> =>
  safeHandlerContent(logger, fn, (result) => [
    { type: "text" as const, text: format(result) },
  ])
