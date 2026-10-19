/** Shared types and helpers for tool group modules. */

import { z } from "zod"
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { SearchIndex } from "../../search/search-index.js"
import type { VaultConfig } from "../../config.js"
import type { Logger } from "../../../logger.js"
import type { LineWindow } from "../../obsidian-markdown/lines.js"
import type { ToolName } from "../tool-registry.js"
import type { ToolAvailability } from "../tool-availability.js"
import { describeErrorForLog, describeErrorRelativeTo } from "../../../utils/describe-error.js"
import { isTagsKey } from "../../obsidian-markdown/tags.js"
import {
  OverwriteBlockedError,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
} from "../../obsidian-markdown/frontmatter.js"

/** Registers one tool through the enabled-set gate. `createGatedRegisterTool`
 *  in tool-definitions.ts implements it:
 *  - It skips the tool silently when the config disables it.
 *  - It injects the registry's annotations so group modules never restate
 *    them; the config type carries no annotations key, so an inline block is
 *    a compile error.
 *  - It throws on a name missing from the registry, because a typo'd
 *    registration would otherwise be invisible forever.
 *  - It hands the SDK the object `createStrictInputObject` builds from the raw
 *    `inputSchema` shape, so the handler's args are typed from that object
 *    (`ToolInputObject`). inputSchema is required, as `{}` for a tool with no
 *    parameters, because the SDK validates nothing for a tool registered
 *    without one; `createStrictInputObject` decides which keys to reject. */
export type RegisterGatedTool = <InputShape extends z.ZodRawShape>(
  name: ToolName,
  config: { title: string; description: string; inputSchema: InputShape },
  handler: ToolCallback<ToolInputObject<InputShape>>,
) => void

/** The object type `createStrictInputObject` returns. It takes Zod's base
 *  object config rather than the strict one, so one type fits both the
 *  `z.object` an empty shape gets and the `z.strictObject` every other shape
 *  gets. */
export type ToolInputObject<Shape extends z.ZodRawShape> = z.ZodObject<
  Shape,
  z.core.$ZodObjectConfig
>

/** A Zod object that rejects keys its shape does not declare, where a plain
 *  `z.object` drops them and the call succeeds without the misspelled option.
 *  - The rejection names the unknown keys and the accepted ones, so the caller
 *    can correct the name in one retry.
 *  - An empty shape is the exception: it accepts and drops any key, and the
 *    JSON Schema clients see for it leaves out `additionalProperties: false`,
 *    so that schema and the server's check agree.
 *  - Every tool input object is built with it: the registerTool wrapper wraps
 *    each top-level shape, and nested objects are declared with it. */
export const createStrictInputObject = <Shape extends z.ZodRawShape>(
  shape: Shape,
): ToolInputObject<Shape> => {
  const acceptedKeys = Object.keys(shape)

  // A tool with no parameters has no option a caller could misspell, and some
  // clients send such tools a placeholder argument, so rejecting would break
  // those calls without catching any mistake
  if (acceptedKeys.length === 0) return z.object(shape)

  const acceptedKeysText = `accepted: ${acceptedKeys.join(", ")}`

  return z.strictObject(shape, {
    error: (issue) => {
      // Other issues raised by the object itself (a non-object value) keep
      // Zod's default message
      if (issue.code !== "unrecognized_keys") return undefined

      const keyNoun = issue.keys.length === 1 ? "key" : "keys"
      const quotedKeys = issue.keys.map((key) => `"${key}"`).join(", ")
      return `unrecognized ${keyNoun} ${quotedKeys} (${acceptedKeysText})`
    },
  })
}

export type ToolRegistrationContext = ToolAvailability &
  SafeHandlers & {
    registerTool: RegisterGatedTool
    vaultPath: string
    search: SearchIndex
    logger: Logger
    config: VaultConfig
  }

// NoteMetadata promotes five frontmatter keys to top-level fields, so
// additional_properties leaves them out instead of repeating them:
// - `title`, `type`, `created`, and `related` have one fixed spelling.
// - `tags` is spelled per note. The index reads the first key spelled `tags`
//   in any letter case (`tags`, `Tags`, `TAGS`), as Obsidian does, and that
//   key is left out. A later tags-spelled key, which the index ignores, stays
//   in additional_properties.
const FIXED_PROMOTED_KEYS = new Set(["title", "type", "created", "related"])

/** The promoted keys of one note: the fixed four plus the tags key its
 *  frontmatter spells, when it has one. */
const resolvePromotedKeys = (properties: Record<string, unknown>): ReadonlySet<string> => {
  const noteTagsKey = Object.keys(properties).find(isTagsKey)
  return noteTagsKey ? new Set([...FIXED_PROMOTED_KEYS, noteTagsKey]) : FIXED_PROMOTED_KEYS
}

/** Reshapes NoteMetadata for client responses: keeps all top-level fields,
 *  replaces `properties` (full frontmatter, mostly duplicated) with
 *  `additional_properties` (only unpromoted keys like topic, agent, date). */
export const formatNoteMetadata = (meta: {
  properties: Record<string, unknown>
  [key: string]: unknown
}): Record<string, unknown> => {
  const { properties, leading_callout: leadingCallout, ...fields } = meta

  const promotedKeys = resolvePromotedKeys(properties)
  const additional_properties = Object.fromEntries(
    Object.entries(properties).filter(([key]) => !promotedKeys.has(key)),
  )

  return {
    ...fields,
    // Drop a null `leading_callout` so notes without one don't carry the key;
    // keep it (the { type, title, body } block) when present
    ...(leadingCallout ? { leading_callout: leadingCallout } : {}),
    ...(Object.keys(additional_properties).length > 0 ? { additional_properties } : {}),
  }
}

/** Shared Zod schema for one date filter ({ before, on, after }) — used by
 *  vault_list_tasks' task date filters and vault_search's created/modified. */
export const dateFilterSchema = createStrictInputObject({
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
}).optional()

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

/** The try/catch wrappers every tool handler runs inside, built per server
 *  from two inputs:
 *  - the enabled tool set, because the repair steps they add for a refused
 *    properties block name tools a server may not serve;
 *  - the vault path, which a Node error's text must not show. */
type SafeHandlers = {
  /** Wraps a handler with try/catch. A throw is logged as `tool_error` and
   *  returned as an isError result that holds only text, so the error's
   *  cause and stack never reach the client. The text is:
   *  - `[ErrorName]: message`, with a Node error's paths made vault-relative;
   *  - then how to fix it, for a properties-block refusal.
   *
   *  The format callback produces the full content-block array — text, image,
   *  or mixed (the SDK union) — for tools whose results aren't a single text
   *  block. */
  safeHandlerContent: <T>(
    logger: Logger,
    fn: () => Promise<T>,
    format: (result: T) => CallToolResult["content"],
  ) => Promise<ToolHandlerResult>
  /** The common single-text-block case. Delegates to safeHandlerContent so
   *  the error contract (error text, tool_error log, isError) has exactly
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

/** When a note has properties, the server writes its own properties block at
 *  the top, so the `---` lines in the body are no longer at the top of the
 *  note; text above them or their removal has the same effect. The sentence
 *  names no tool, so it needs no gating. */
const OPENING_BLOCK_REMEDY =
  "To write it, give the note at least one property, put a line of text above the --- lines, or remove those lines."

/** The Errors entry of every tool whose write can leave `---` lines at the
 *  top of a note with no properties. The error carries the ways around it. */
export const OPENING_BLOCK_ERROR_ENTRY =
  '- "the note would open with a properties block …" — the edit would leave --- lines at the top of a note with no properties, around text that can\'t be kept as properties; the error says how to avoid it'

/** The Errors entry of a tool that saves a note, for a file the server
 *  cannot read or write; the message is Node's, with the path made
 *  vault-relative.
 *  - One bullet names each remedy: the caller shortens a too-long name, and
 *    the vault's owner fixes permissions or the disk.
 *  - A save first writes a temp file named after the note plus
 *    ".<UUID>.tmp", 41 bytes longer (1 for the dot, 36 for the UUID, 4 for
 *    ".tmp"), so a note can read fine and still fail to save. A rename
 *    writes that temp file beside the new name too, which is why the bullet
 *    asks for a name at least 41 bytes shorter.
 *  - A write that fails after the file is open (a full disk) gets a Node
 *    message with no path, so the bullet says the file is usually named.
 *  - Every tool that saves a note can raise these errors, but each lists the
 *    bullet only when its own description is next revised, because
 *    tool-definition graders such as Glama's re-score every description
 *    whose text changes. */
export const describeFilesystemErrorEntry = (
  whenToolEnabledText: ToolRegistrationContext["whenToolEnabledText"],
): string => {
  const renameToolClause = whenToolEnabledText("vault_move_note", " with vault_move_note")

  return `- "ENAMETOOLONG: …", "EACCES: …" or another filesystem error code — the message names the cause and usually the file. A name too long for the filesystem needs a shorter one: a quoted name ending in ".tmp" means the note exists but saving it needs a temp file name 41 bytes longer, so rename it at least 41 bytes shorter${renameToolClause}. Permissions or a full or read-only disk need the vault's owner`
}

/** The Errors entry of every tool that rewrites a note. A tool that rewrites
 *  the note only in one mode passes that mode as rewriteCondition
 *  (`"with overwrite: true"`), and the entry opens with it. The error itself
 *  carries the repair steps, so the entry points at them and names no tool. */
export const describePropertiesBlockErrorEntry = (rewriteCondition?: string): string => {
  const conditionClause = rewriteCondition ? `${rewriteCondition}, ` : ""
  return `- "properties block …" — ${conditionClause}the note's properties block can't be read, or a rewrite would lose it; the error says how to repair it`
}

export const createSafeHandlers = (params: {
  isToolEnabled: (name: ToolName) => boolean
  vaultPath: string
}): SafeHandlers => {
  const { isToolEnabled, vaultPath } = params

  /** The error's text with a Node error's paths made vault-relative, plus how
   *  to fix a properties-block failure: repair steps for a block already in
   *  the vault, or a way around `---` lines a write would leave at the top of
   *  the note. */
  const describeToolError = (error: unknown): string => {
    const message = describeErrorRelativeTo({ error, directory: vaultPath })
    // A move abort's properties-block message already ends with a period
    // ("Nothing was written."), so the repair steps follow after a space
    const separator = message.endsWith(".") ? " " : ". "

    if (error instanceof UnkeepableOpeningBlockError) {
      return `${message}${separator}${OPENING_BLOCK_REMEDY}`
    }
    // Checked before its parent class, whose repair steps carry prose over.
    // OverwriteBlockedError extends UnsupportedPropertiesBlockError, while
    // UnkeepableOpeningBlockError extends Error directly, so its order is free.
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
      // The log keeps the full message and the cause a wrapped error carries;
      // the vault-relative paths and repair steps are for the client
      logger.warn("tool_error", describeErrorForLog(error))
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
