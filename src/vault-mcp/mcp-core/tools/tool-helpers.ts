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
  OverwriteBlockedError,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
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
  SafeHandlers & {
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
 *  from the enabled tool set, because the repair steps they add for a
 *  refused properties block name tools a server may not serve. */
type SafeHandlers = {
  /** Wraps a handler with try/catch. A throw is logged as `tool_error` and
   *  returned as an isError result whose text is describeError's
   *  `[ErrorName]: message`, plus how to fix a properties-block refusal, so
   *  the error's cause and stack never reach the client. The format callback
   *  produces the full content-block array — text, image, or mixed (the SDK
   *  union) — for tools whose results aren't a single text block. */
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

/** The tools each kind's repair steps name: a raw read and a whole-block
 *  replace, plus a body edit to put prose back for the kinds that often hold
 *  it. Keep each list in step with the text describePropertiesBlockRepair
 *  returns for that kind. */
const REPAIR_TOOLS_BY_KIND = {
  "explicit-tag": ["vault_read_note", "vault_update_properties"],
  "invalid-yaml": ["vault_read_note", "vault_update_properties", "vault_patch_note"],
  "not-key-value": ["vault_read_note", "vault_update_properties", "vault_patch_note"],
} as const satisfies Record<UnsupportedPropertiesBlockError["kind"], readonly ToolName[]>

/** How an agent repairs a properties block the server refuses, by the kind
 *  of block. A server missing any tool the steps name points at Obsidian
 *  instead, so the error never names a tool the client cannot call. */
const describePropertiesBlockRepair = (params: {
  kind: UnsupportedPropertiesBlockError["kind"]
  isToolEnabled: (name: ToolName) => boolean
}): string => {
  const repairToolsServed = REPAIR_TOOLS_BY_KIND[params.kind].every(params.isToolEnabled)

  if (!repairToolsServed) return "Fix the properties block in Obsidian."

  switch (params.kind) {
    case "explicit-tag":
      return "To repair it, read the note in full with vault_read_note, then call vault_update_properties with replace: true and the complete corrected properties (leave out a key to remove it; null keeps it with an empty value). The tag cannot be kept; write the value without it."
    // replace drops the whole block, and a block of invalid YAML, a list or a
    // single value is often prose written as body text, so that text has to
    // be copied before the replace and put back after it
    case "invalid-yaml":
    case "not-key-value":
      return "To repair it: 1. read the note in full with vault_read_note; 2. copy any text between the --- lines that is not a property; 3. call vault_update_properties with replace: true and the complete corrected properties (leave out a key to remove it; null keeps it with an empty value); 4. add the copied text back to the body with vault_patch_note, without the --- lines."
  }
}

/** The tools an overwrite's repair names: a raw read to see the broken
 *  block, and a whole-block replace before the overwrite runs again. */
const OVERWRITE_REPAIR_TOOLS = [
  "vault_read_note",
  "vault_update_properties",
] as const satisfies readonly ToolName[]

/** How to finish an overwrite refused for the note's existing block. The
 *  overwrite replaces the body, so no prose needs carrying over. */
const describeOverwriteRepair = (isToolEnabled: (name: ToolName) => boolean): string => {
  const repairToolsServed = OVERWRITE_REPAIR_TOOLS.every(isToolEnabled)

  if (!repairToolsServed) return "Fix the properties block in Obsidian."
  return "To overwrite it, read the note in full with vault_read_note, call vault_update_properties with replace: true and the properties to keep ({} for none), then run this write again."
}

/** A property makes the server's own block come first, and text above the
 *  `---` lines or their removal stops the note opening with them. The
 *  sentence names no tool, so it needs no gating. */
const OPENING_BLOCK_REMEDY =
  "To write it, give the note at least one property, put a line of text above the --- lines, or remove those lines."

/** The Errors entry of every tool whose write can leave `---` lines at the
 *  top of a note with no properties. The error carries the ways around it. */
export const OPENING_BLOCK_ERROR_ENTRY =
  '- "the note would open with a properties block …" — the edit would leave --- lines at the top of a note with no properties, around text that can\'t be kept as properties; the error says how to avoid it'

/** The Errors entry of every tool that rewrites a note, led by when the tool
 *  rewrites it for tools that do so only sometimes. The error itself carries
 *  the repair steps, so the entry points at them and names no tool. */
export const describePropertiesBlockErrorEntry = (rewriteCondition?: string): string => {
  const conditionClause = rewriteCondition ? `${rewriteCondition}, ` : ""
  return `- "properties block …" — ${conditionClause}the note's properties block can't be read, or a rewrite would lose it; the error says how to repair it`
}

export const createSafeHandlers = (isToolEnabled: (name: ToolName) => boolean): SafeHandlers => {
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
    // Checked before its parent class, whose repair steps carry prose over
    if (error instanceof OverwriteBlockedError) {
      return `${message}${separator}${describeOverwriteRepair(isToolEnabled)}`
    }
    if (!(error instanceof UnsupportedPropertiesBlockError)) return message

    const repair = describePropertiesBlockRepair({ kind: error.kind, isToolEnabled })
    return `${message}${separator}${repair}`
  }

  const safeHandlerContent: SafeHandlers["safeHandlerContent"] = async (logger, fn, format) => {
    try {
      const result = await fn()
      return { content: format(result) }
    } catch (error) {
      // The log keeps the bare message; the repair steps are for the client
      logger.warn("tool_error", { error: describeError(error) })
      return {
        content: [{ type: "text" as const, text: describeToolError(error) }],
        isError: true as const,
      }
    }
  }

  const safeHandler: SafeHandlers["safeHandler"] = (logger, fn, format) => {
    return safeHandlerContent(logger, fn, (result) => [
      { type: "text" as const, text: format(result) },
    ])
  }

  return { safeHandlerContent, safeHandler }
}
