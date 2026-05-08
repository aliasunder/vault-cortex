/** MCP tool definitions — registers all 12 vault-cortex tools with Zod schemas. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { vaultFs } from "./vault-filesystem.js"
import { memoryStore } from "./memory-store.js"
import type { SearchIndex } from "./search-index.js"
import type { Logger } from "../logger.js"

export type ToolName =
  | "vault_read_note"
  | "vault_write_note"
  | "vault_list_notes"
  | "vault_delete_note"
  | "vault_search"
  | "vault_search_by_tag"
  | "vault_list_tags"
  | "vault_recent_notes"
  | "vault_get_memory"
  | "vault_update_memory"
  | "vault_list_memory_files"
  | "vault_delete_memory"

/** Wraps a handler with try/catch, returning isError on failure. */
const safeHandler = <T>(
  logger: Logger,
  fn: () => Promise<T>,
  format: (result: T) => string,
): Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: true
}> =>
  fn().then(
    (result) => ({
      content: [{ type: "text" as const, text: format(result) }],
    }),
    (err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn("tool_error", { error: message })
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      }
    },
  )

export const registerTools = (params: {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
}): void => {
  const { server, vaultPath, search, logger: sessionLogger } = params

  // ── Vault CRUD ──────────────────────────────────────────────

  server.registerTool(
    "vault_read_note",
    {
      title: "Read Note",
      description:
        "Read a markdown note by its vault-relative path. Returns the full raw content including YAML frontmatter.\n\nReturns: Raw markdown string.",
      inputSchema: {
        path: z
          .string()
          .describe(
            'Vault-relative path to the note (e.g. "About Me/Principles.md")',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_read_note",
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () => vaultFs.readNote({ vaultPath, path }, reqLogger),
        (text) => text,
      )
    },
  )

  server.registerTool(
    "vault_write_note",
    {
      title: "Write Note",
      description:
        "Create or update a markdown note. Body is markdown only — frontmatter is passed separately and merged with any existing frontmatter.\n\nReturns: Confirmation message.",
      inputSchema: {
        path: z.string().describe("Vault-relative path for the note"),
        body: z
          .string()
          .describe("Markdown body content (no frontmatter fences)"),
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe(
            "Optional YAML frontmatter properties. New keys are added; existing keys with matching names are overwritten; unmentioned keys are preserved from the existing file.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, body, frontmatter }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_write_note",
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.writeNote({ vaultPath, path, body, frontmatter }, reqLogger),
        () => `Wrote ${path}`,
      )
    },
  )

  server.registerTool(
    "vault_list_notes",
    {
      title: "List Notes",
      description:
        "List .md files in the vault, optionally filtered by folder and/or glob pattern.\n\nReturns: JSON array of vault-relative paths.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Folder to list (e.g. "About Me", "Projects")'),
        glob: z
          .string()
          .optional()
          .describe(
            'Glob pattern to filter paths (e.g. "Projects/**/*.md", "*.md"). Supports * and ** wildcards.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, glob }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_list_notes",
      })
      reqLogger.info("tool_call", { folder, glob })
      return safeHandler(
        reqLogger,
        () => vaultFs.listNotes({ vaultPath, folder, glob }, reqLogger),
        (paths) => JSON.stringify(paths),
      )
    },
  )

  server.registerTool(
    "vault_delete_note",
    {
      title: "Delete Note",
      description:
        'Delete a markdown note. Refuses paths under "About Me/" or "Daily Notes/" — use vault_delete_memory for individual memory entries.\n\nReturns: Confirmation message.',
      inputSchema: {
        path: z.string().describe("Vault-relative path of the note to delete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_delete_note",
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () => vaultFs.deleteNote({ vaultPath, path }, reqLogger),
        () => `Deleted ${path}`,
      )
    },
  )

  // ── Search ──────────────────────────────────────────────────

  server.registerTool(
    "vault_search",
    {
      title: "Search Notes",
      description:
        "Full-text search across all vault notes. Results are ranked by relevance and include highlighted snippets. Supports filtering by folder, tags, type, and frontmatter properties.\n\nReturns: JSON with results array (path, title, snippet, score, tags, folder) and total count.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        filters: z
          .object({
            folder: z.string().optional().describe("Restrict to folder"),
            tags: z
              .array(z.string())
              .optional()
              .describe("Require all listed tags"),
            related: z
              .array(z.string())
              .optional()
              .describe("Require all listed related links"),
            type: z
              .string()
              .optional()
              .describe("Frontmatter type field value"),
            properties: z
              .record(z.union([z.string(), z.number(), z.boolean()]))
              .optional()
              .describe("Arbitrary frontmatter key-value filters"),
            limit: z.number().optional().describe("Max results (default 20)"),
          })
          .optional()
          .describe("Optional search filters"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, filters }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_search",
      })
      reqLogger.info("tool_call", { query })
      return safeHandler(
        reqLogger,
        async () => search.fullTextSearch({ query, filters }, reqLogger),
        (results) => JSON.stringify({ results, total: results.length }),
      )
    },
  )

  server.registerTool(
    "vault_search_by_tag",
    {
      title: "Search by Tag",
      description:
        "Find notes with a specific tag. By default uses prefix matching (parent tag matches children, e.g. 'project' matches 'project/vault-cortex'). Set exact=true for exact match only.\n\nReturns: JSON array of note metadata.",
      inputSchema: {
        tag: z.string().describe("Tag to search for"),
        exact: z
          .boolean()
          .optional()
          .describe("Exact match only (default: false, prefix match)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tag, exact }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_search_by_tag",
      })
      reqLogger.info("tool_call", { tag, exact })
      return safeHandler(
        reqLogger,
        async () => search.searchByTag({ tag, exactMatch: exact }, reqLogger),
        (results) => JSON.stringify(results),
      )
    },
  )

  server.registerTool(
    "vault_list_tags",
    {
      title: "List Tags",
      description:
        "List all tags in the vault with their note counts, ordered by count descending.\n\nReturns: JSON array of { tag, count } objects.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_list_tags",
      })
      reqLogger.info("tool_call")
      return safeHandler(
        reqLogger,
        async () => search.listAllTags(reqLogger),
        (tags) => JSON.stringify(tags),
      )
    },
  )

  server.registerTool(
    "vault_recent_notes",
    {
      title: "Recent Notes",
      description:
        "List recently modified or created notes.\n\nReturns: JSON array of note metadata, sorted by chosen timestamp.",
      inputSchema: {
        sort_by: z
          .enum(["created", "mtime"])
          .optional()
          .describe('Sort field: "created" or "mtime" (default "mtime")'),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sort_by, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_recent_notes",
      })
      reqLogger.info("tool_call", { sort_by, limit })
      return safeHandler(
        reqLogger,
        async () => search.recentNotes({ sort_by, limit }, reqLogger),
        (notes) => JSON.stringify(notes),
      )
    },
  )

  // ── Memory ──────────────────────────────────────────────────

  server.registerTool(
    "vault_get_memory",
    {
      title: "Get Memory",
      description:
        "Read semantic memory from About Me/ files. No args: all files concatenated (frontmatter stripped). With file: single file content. With file+section: just that H2 section's entries.\n\nReturns: Raw markdown text.",
      inputSchema: {
        file: z
          .string()
          .optional()
          .describe(
            'Memory file name without .md (e.g. "Principles", "Opinions")',
          ),
        section: z
          .string()
          .optional()
          .describe(
            'H2 section heading (e.g. "Decision heuristics (newest first)"). Call vault_list_memory_files first to discover valid names.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file, section }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_get_memory",
      })
      reqLogger.info("tool_call", { file, section })
      return safeHandler(
        reqLogger,
        () => memoryStore.getMemory({ vaultPath, file, section }, reqLogger),
        (text) => text,
      )
    },
  )

  server.registerTool(
    "vault_update_memory",
    {
      title: "Update Memory",
      description:
        "Append a dated entry to a section of an About Me/ memory file. The server prefixes the date — pass raw entry text only. Call vault_list_memory_files first to discover valid file and section names.\n\nReturns: Confirmation message.",
      inputSchema: {
        file: z
          .string()
          .describe('Memory file name without .md (e.g. "Principles")'),
        section: z
          .string()
          .describe(
            'H2 section heading (e.g. "Decision heuristics (newest first)")',
          ),
        entry: z.string().describe("Entry text (no date prefix)"),
        options: z
          .object({
            date: z
              .string()
              .optional()
              .describe("ISO YYYY-MM-DD date (defaults to today)"),
            position: z
              .enum(["top", "bottom"])
              .optional()
              .describe('Insert position (default "top" = newest first)'),
          })
          .optional()
          .describe("Optional date and position overrides"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file, section, entry, options }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_update_memory",
      })
      reqLogger.info("tool_call", { file, section })
      return safeHandler(
        reqLogger,
        () =>
          memoryStore.updateMemory(
            {
              vaultPath,
              file,
              section,
              entry,
              date: options?.date,
              position: options?.position,
            },
            reqLogger,
          ),
        () => `Added entry to About Me/${file}.md → ## ${section}`,
      )
    },
  )

  server.registerTool(
    "vault_list_memory_files",
    {
      title: "List Memory Files",
      description:
        "Discovery tool — lists About Me/ files with their H1/H2 heading structure and per-section entry counts. Does NOT return actual entries. Call this before vault_get_memory, vault_update_memory, or vault_delete_memory to discover valid file and section names.\n\nReturns: JSON array of file outlines.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_list_memory_files",
      })
      reqLogger.info("tool_call")
      return safeHandler(
        reqLogger,
        () => memoryStore.listMemoryFiles({ vaultPath }, reqLogger),
        (outlines) => JSON.stringify(outlines),
      )
    },
  )

  server.registerTool(
    "vault_delete_memory",
    {
      title: "Delete Memory Entry",
      description:
        "Delete a single dated entry from an About Me/ memory file. Both date and entry text are required for exact matching. Call vault_get_memory(file, section) first to see exact entry text.\n\nReturns: Confirmation message.",
      inputSchema: {
        file: z
          .string()
          .describe('Memory file name without .md (e.g. "Principles")'),
        section: z.string().describe("H2 section heading containing the entry"),
        date: z.string().describe("ISO YYYY-MM-DD date of the entry"),
        entry: z
          .string()
          .describe("Exact entry text (no date prefix or bullet)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file, section, date, entry }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_delete_memory",
      })
      reqLogger.info("tool_call", { file, section, date })
      return safeHandler(
        reqLogger,
        () =>
          memoryStore.deleteMemory(
            { vaultPath, file, section, date, entry },
            reqLogger,
          ),
        () => `Deleted entry from About Me/${file}.md → ## ${section}`,
      )
    },
  )

  sessionLogger.info("registered tools", { count: 12 })
}
