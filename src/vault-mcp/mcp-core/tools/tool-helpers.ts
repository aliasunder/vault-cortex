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
import type { ToolAvailability } from "../tool-availability.js"
import { describeError } from "../../../utils/describe-error.js"
import {
  UnkeepableOpeningBlockError,
  UnreadablePropertiesError,
} from "../../obsidian-markdown/frontmatter.js"

/** Registers one tool through the enabled-set gate: skips silently when the
 *  config disables the tool, and injects the registry's annotations so group
 *  modules never restate them — the config type carries no annotations key,
 *  making an inline block a compile error. Throws on a name missing from the
 *  registry (a typo'd registration would otherwise be invisible forever). */
export type RegisterGatedTool = <InputArgs extends undefined | ZodRawShapeCompat = undefined>(
  name: ToolName,
  config: { title: string; description: string; inputSchema?: InputArgs },
  handler: ToolCallback<InputArgs>,
) => void

export type ToolRegistrationContext = ToolAvailability &
  ToolErrorHandlers & {
    registerTool: RegisterGatedTool
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
    ...(Object.keys(additional_properties).length > 0 ? { additional_properties } : {}),
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
export const describeTextWindow = (path: string, lineWindow: LineWindow): string => {
  const { startLine, endLine, totalLines } = lineWindow

  if (totalLines === 0) return `${path} — 0 lines (end of file)`

  const isLastWindow = endLine >= totalLines
  const continuation = isLastWindow ? "(end of file)" : `(continue with start_line: ${endLine + 1})`

  return `${path} — lines ${startLine}–${endLine} of ${totalLines} ${continuation}`
}

type ToolHandlerResult = {
  content: CallToolResult["content"]
  isError?: true
}

/** The try/catch wrappers every tool handler runs inside. Built per server
 *  from the enabled tool set, because the repair steps they add to an
 *  unreadable properties block name tools a server may not serve. */
type ToolErrorHandlers = {
  /** Wraps a handler with try/catch. A throw is logged as `tool_error` and
   *  returned as an isError result whose text is describeError's
   *  `[ErrorName]: message`, so the error's cause and stack never reach the
   *  client. The format callback produces the full content-block array —
   *  text, image, or mixed (the SDK union) — for tools whose results aren't a
   *  single text block. */
  safeHandlerContent: <T>(
    logger: Logger,
    fn: () => Promise<T>,
    format: (result: T) => CallToolResult["content"],
  ) => Promise<ToolHandlerResult>
  /** The common single-text-block case. Delegates to safeHandlerContent so
   *  the error contract (describeError, tool_error log, isError) has exactly
   *  one home. */
  safeHandler: <T>(
    logger: Logger,
    fn: () => Promise<T>,
    format: (result: T) => string,
  ) => Promise<ToolHandlerResult>
}

/** The tools an unreadable-properties repair walks through: a raw read, a
 *  whole-block replace, and a body edit to put prose back. */
const REPAIR_TOOL_NAMES = [
  "vault_read_note",
  "vault_update_properties",
  "vault_patch_note",
] as const satisfies readonly ToolName[]

/** How an agent repairs an unreadable properties block, by the kind of
 *  block. The steps need a raw read, a whole-block replace and a body edit;
 *  without all three, the note can only be fixed in Obsidian. */
const describeUnreadablePropertiesRepair = (params: {
  kind: UnreadablePropertiesError["kind"]
  repairToolsServed: boolean
}): string => {
  if (!params.repairToolsServed) return "Fix the properties block in Obsidian."

  const replaceStep =
    "To repair it, read the note in full with vault_read_note, then call vault_update_properties with replace: true and the complete corrected properties."

  if (params.kind === "explicit-tag") {
    return `${replaceStep} The tag cannot be kept; write the value without it.`
  }
  // replace drops the whole block, and a block that fails to parse is often
  // prose written as body text, so that text has to be carried over
  return `${replaceStep} replace removes everything between the --- lines, so first copy any text there that is not a property, then add it back to the body with vault_patch_note, without the --- lines.`
}

/** A property makes the server's own block come first, and text above the
 *  `---` lines or their removal stops the note opening with them. The
 *  sentence names no tool, so it needs no gating. */
const OPENING_BLOCK_REMEDY =
  "To write it, give the note at least one property, put a line of text above the --- lines, or remove those lines."

/** Builds the tool error handlers for one server's enabled tool set. */
export const createToolErrorHandlers = (
  isToolEnabled: (name: ToolName) => boolean,
): ToolErrorHandlers => {
  const repairToolsServed = REPAIR_TOOL_NAMES.every(isToolEnabled)

  /** describeError's text, plus how to fix a properties-block failure:
   *  repair steps for a block already in the vault, or a way around `---`
   *  lines a write would leave at the top of the note. */
  const describeToolError = (error: unknown): string => {
    const message = describeError(error)
    // A move abort's message already ends with a sentence
    const separator = message.endsWith(".") ? " " : ". "

    if (error instanceof UnkeepableOpeningBlockError) {
      return `${message}${separator}${OPENING_BLOCK_REMEDY}`
    }
    if (!(error instanceof UnreadablePropertiesError)) return message

    const repair = describeUnreadablePropertiesRepair({ kind: error.kind, repairToolsServed })
    return `${message}${separator}${repair}`
  }

  const safeHandlerContent: ToolErrorHandlers["safeHandlerContent"] = async (
    logger,
    fn,
    format,
  ) => {
    try {
      const result = await fn()
      return { content: format(result) }
    } catch (err) {
      // The log keeps the bare message; the repair steps are for the client
      logger.warn("tool_error", { error: describeError(err) })
      return {
        content: [{ type: "text" as const, text: describeToolError(err) }],
        isError: true as const,
      }
    }
  }

  const safeHandler: ToolErrorHandlers["safeHandler"] = (logger, fn, format) => {
    return safeHandlerContent(logger, fn, (result) => [
      { type: "text" as const, text: format(result) },
    ])
  }

  return { safeHandlerContent, safeHandler }
}
