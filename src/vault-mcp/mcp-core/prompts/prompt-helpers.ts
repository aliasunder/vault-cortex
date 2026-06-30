/** Shared types and helpers for prompt group modules. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { SearchIndex } from "../../search/search-index.js"
import type { VaultConfig } from "../../config.js"
import type { Logger } from "../../../logger.js"

export type PromptRegistrationContext = {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}

/** Matches a positive integer with no leading zero — the wire format for the
 *  optional max_chars prompt argument (MCP prompt args arrive as strings). */
export const POSITIVE_INT_REGEX = /^[1-9]\d*$/

/** Shared description for the optional max_chars argument on content-embedding
 *  prompts. Omitted by default, which embeds the full content. */
export const MAX_CHARS_DESCRIPTION =
  "Optional cap on embedded content length (characters); omit for full content"

/** Reusable Zod schema for the max_chars prompt argument — shared by
 *  memory-review and daily-review. */
export const maxCharsArg = z
  .string()
  .regex(POSITIVE_INT_REGEX, "must be a positive integer")
  .optional()
  .describe(MAX_CHARS_DESCRIPTION)

/** One bullet line for a note: path, plus title when it adds information. */
export const formatNoteLine = (note: {
  path: string
  title: string
}): string =>
  note.title.length > 0 ? `- ${note.path} — ${note.title}` : `- ${note.path}`

/** Wraps assembled text as a single user-role prompt message. */
export const textResult = (text: string): GetPromptResult => ({
  messages: [{ role: "user", content: { type: "text", text } }],
})

/** Opt-in safety cap for live content embedded in a prompt. When the caller
 *  passes a max (the max_chars argument) and the content exceeds it, truncate
 *  and append a marker pointing at the tool for the full content. When omitted
 *  (the default), content is returned in full — preserving review fidelity. */
export const capContent = (
  text: string,
  maxChars: number | undefined,
  toolHint: string,
): string =>
  maxChars !== undefined && text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n…(truncated at ${maxChars} characters — use ${toolHint} for the full content)`
    : text

/** Escapes any closing `</vault-content>` tag in the body so an attacker who
 *  controls vault content cannot break out of the data-marker boundary. The
 *  slash is HTML-entity-escaped (`&#x2F;`), preserving readability while making
 *  the closing tag syntactically inert to an LLM parsing XML structure. */
export const escapeVaultContentClosingTag = (text: string): string =>
  text.replace(/<\/vault-content\s*>/gi, "<&#x2F;vault-content>")

/** Wraps vault content in XML data markers so consuming LLMs treat it as data,
 *  not instruction — defense-in-depth for shared/synced vault scenarios. The cap
 *  (via capContent) is applied to the inner content; the opening and closing tags
 *  always survive truncation. Any `</vault-content>` in the body is escaped to
 *  prevent tag-breakout injection.
 *  @param content — raw vault text to wrap
 *  @param markerAttributes — key-value pairs rendered as XML attributes on the
 *    opening tag (source, type, date) to identify the content's origin
 *  @param maxChars — optional cap forwarded to capContent
 *  @param toolHint — tool name shown in the truncation message */
export const wrapWithDataMarkers = (
  content: string,
  markerAttributes: Record<string, string>,
  maxChars: number | undefined,
  toolHint: string,
): string => {
  const attributeString = Object.entries(markerAttributes)
    .map(
      ([key, value]) =>
        `${key}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
    )
    .join(" ")
  return [
    `<vault-content ${attributeString}>`,
    escapeVaultContentClosingTag(capContent(content, maxChars, toolHint)),
    "</vault-content>",
  ].join("\n")
}
