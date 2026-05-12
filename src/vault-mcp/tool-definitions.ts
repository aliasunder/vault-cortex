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
  | "vault_search_by_folder"
  | "vault_list_tags"
  | "vault_recent_notes"
  | "vault_stats"
  | "vault_get_memory"
  | "vault_update_memory"
  | "vault_list_memory_files"
  | "vault_delete_memory"

// ── Response shaping ─────────────────────────────────────────────

// Frontmatter keys that are already top-level fields on NoteMetadata.
// These are stripped from `properties` before returning to clients
// so the response doesn't contain the same data twice.
const PROMOTED_KEYS = new Set(["title", "tags", "type", "created", "related"])

/** Replaces `properties` (full frontmatter) with `additional_properties`
 *  (only frontmatter keys not already in top-level fields like title, tags, type). */
const stripPromotedProperties = (meta: {
  properties: Record<string, unknown>
  [key: string]: unknown
}) => {
  const { properties, ...fields } = meta

  const additional_properties = Object.fromEntries(
    Object.entries(properties).filter(([key]) => !PROMOTED_KEYS.has(key)),
  )

  return {
    ...fields,
    ...(Object.keys(additional_properties).length > 0
      ? { additional_properties }
      : {}),
  }
}

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
      description: `Read a markdown note by its vault-relative path. Returns the full raw content including YAML frontmatter.

Example: vault_read_note({ path: "Projects/vault-cortex.md" })

When to use: You know the exact path and need the full content of a specific note.
Prefer vault_search when you don't know the path. Prefer vault_get_memory for About Me/ files (returns content without frontmatter).

Returns: Raw markdown string.`,
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
      description: `Create or update a markdown note. Body replaces the entire note content — this is a full overwrite, not a partial edit. Frontmatter is passed separately and merged with any existing frontmatter (new keys added, matching keys overwritten, unmentioned keys preserved).

Example: vault_write_note({ path: "Projects/notes.md", body: "# Notes\\n\\nProject notes here.", frontmatter: { tags: ["project"], type: "project" } })

When to use: Creating a new note or fully replacing an existing note's body.
Prefer vault_update_memory for appending dated entries to About Me/ memory files.

Limitation: Overwrites the entire body. Do not use for surgical edits to large files — existing content will be lost unless you include it in the body parameter.

Returns: Confirmation message.`,
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
      description: `List .md file paths in the vault, optionally filtered by folder and/or glob pattern. Returns paths only — not content or metadata.

Example: vault_list_notes({ folder: "Projects" }) or vault_list_notes({ glob: "**/*session-log*.md" })

When to use: Browsing what exists in a folder by filename, or finding notes matching a path pattern.
Prefer vault_search_by_folder when you need metadata (tags, type, related) along with paths. Prefer vault_search for content-based discovery.

Returns: JSON array of vault-relative paths.`,
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
      description: `Permanently delete a markdown note. Protected paths (About Me/, Daily Notes/) are refused to prevent accidental deletion of memory or daily notes.

Example: vault_delete_note({ path: "Scratch/temp.md" })

When to use: Removing a note you no longer need.
Prefer vault_delete_memory for removing individual dated entries from About Me/ memory files.

Returns: Confirmation message.`,
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
      description: `Full-text search across all vault notes, ranked by relevance. Supports filtering by folder, tags, type, and frontmatter properties. Wrap terms in double quotes for exact phrase matching (e.g. '"machine learning"'); unquoted terms use implicit AND with porter stemming.

Example: vault_search({ query: "kubernetes networking", filters: { tags: ["reference"] } })

When to use: Finding notes by content when you don't know the exact path. The primary discovery tool for content-based queries.
Prefer vault_search_by_tag for tag-only queries without text. Prefer vault_search_by_folder for browsing a folder without a search term. Prefer vault_recent_notes for time-based browsing.

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, created, mtime) and total count. created is omitted when null.`,
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
            snippet_tokens: z
              .number()
              .optional()
              .describe("Snippet length in tokens (default 30)"),
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
      description: `Find notes with a specific tag. By default uses hierarchical prefix matching — a parent tag matches all children (e.g. "project" matches "project/vault-cortex", "project/blog"). Set exact=true for exact match only.

Example: vault_search_by_tag({ tag: "project" }) returns all notes tagged project or project/*.

When to use: Exploring tag hierarchies or finding all notes with a specific tag, without needing a text query.
Prefer vault_search when you also need text-based relevance ranking. Use vault_list_tags first to discover available tags.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, mtime, additional_properties). Promoted frontmatter keys are in top-level fields; additional_properties contains only unpromoted keys.`,
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
        (results) => JSON.stringify(results.map(stripPromotedProperties)),
      )
    },
  )

  server.registerTool(
    "vault_list_tags",
    {
      title: "List Tags",
      description: `List all tags in the vault with their note counts, ordered by count descending.

Example: vault_list_tags() returns [{ tag: "session-log", count: 42 }, { tag: "project", count: 15 }, ...]

When to use: Discovering what tags exist in the vault before searching by tag. Good first step for vault orientation.
Prefer vault_search_by_tag once you know which tag to query.

Returns: JSON array of { tag, count } objects.`,
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
      description: `List recently modified or created notes, sorted by timestamp. Returns the most recent notes first — does not filter by date range.

Example: vault_recent_notes({ sort_by: "mtime", limit: 10 })

When to use: Catching up on vault changes or finding recent work.
Prefer vault_search for content-based discovery. Prefer vault_search_by_folder for browsing a specific folder.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, mtime, additional_properties), sorted by chosen timestamp.`,
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
        (notes) => JSON.stringify(notes.map(stripPromotedProperties)),
      )
    },
  )

  server.registerTool(
    "vault_search_by_folder",
    {
      title: "Search by Folder",
      description: `Browse notes in a folder with full metadata (tags, type, related, created, mtime). Unlike vault_list_notes which returns paths only, this returns rich metadata for each note.

Example: vault_search_by_folder({ folder: "Projects" }) or vault_search_by_folder({ folder: "About Me", recursive: false })

When to use: Exploring a folder's contents with full context — tags, type, relationships. Useful for vault orientation and understanding folder structure.
Prefer vault_list_notes when you only need paths. Prefer vault_search when you have a text query.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, mtime, additional_properties).`,
      inputSchema: {
        folder: z
          .string()
          .describe('Folder path (e.g. "Projects", "About Me")'),
        recursive: z
          .boolean()
          .optional()
          .describe("Include subfolders (default: true)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, recursive, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_search_by_folder",
      })
      reqLogger.info("tool_call", { folder, recursive })
      return safeHandler(
        reqLogger,
        async () =>
          search.searchByFolder({ folder, recursive, limit }, reqLogger),
        (results) => JSON.stringify(results.map(stripPromotedProperties)),
      )
    },
  )

  server.registerTool(
    "vault_stats",
    {
      title: "Vault Statistics",
      description: `Get vault statistics — note count, tag count, notes modified in last 7 days, and top 10 tags by frequency.

Example: vault_stats()

When to use: Quick vault orientation at the start of a session, or checking corpus size before planning queries.
Use vault_list_tags for the complete tag list — vault_stats returns only the top 10.

Returns: JSON with noteCount, tagCount, recentlyModified, and topTags array.`,
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
        tool: "vault_stats",
      })
      reqLogger.info("tool_call")
      return safeHandler(
        reqLogger,
        async () => search.getStats(reqLogger),
        (stats) => JSON.stringify(stats),
      )
    },
  )

  // ── Memory ──────────────────────────────────────────────────

  server.registerTool(
    "vault_get_memory",
    {
      title: "Get Memory",
      description: `Read semantic memory from About Me/ files. These are structured memory files containing dated bullet entries organized under H2 headings. With file: single file content. With file+section: just that H2 section's entries. No args: all files concatenated (frontmatter stripped) — can be large.

Example: vault_get_memory({ file: "Principles", section: "Decision heuristics (newest first)" })

When to use: Reading user preferences, principles, opinions, or other persistent context stored in About Me/ files. Call vault_list_memory_files first to discover valid file and section names.
Prefer vault_read_note for reading non-memory notes.

Returns: Raw markdown text.`,
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
      description: `Append a dated entry to a section of an About Me/ memory file. The server auto-prefixes today's date (format: "- **YYYY-MM-DD**: entry text"). Call vault_list_memory_files first to discover valid file and section names.

Example: vault_update_memory({ file: "Opinions", section: "Code patterns (newest first)", entry: "Prefer immutable data structures" })

When to use: Recording a new preference, principle, opinion, or fact about the user. Pass raw entry text without date prefix.
Prefer vault_write_note for creating entirely new notes (not memory entries).

Returns: Confirmation message.`,
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
      description: `Discovery tool — lists About Me/ memory files with their H1/H2 heading structure and per-section entry counts. Does NOT return actual entries.

Example: vault_list_memory_files() returns file outlines with headings like "Decision heuristics (newest first)" and entry counts.

When to use: Discovering what memory files and sections exist BEFORE calling vault_get_memory, vault_update_memory, or vault_delete_memory. Always call this first to get valid file and section names.

Returns: JSON array of file outlines.`,
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
      description: `Delete a single dated entry from an About Me/ memory file. Both date and entry text are required for exact matching — ensures only the intended entry is removed.

Example: vault_delete_memory({ file: "Opinions", section: "AI tooling & memory (newest first)", date: "2026-05-01", entry: "Prefer X over Y" })

When to use: Removing an outdated or incorrect entry from a memory file. Call vault_get_memory(file, section) first to see exact entry text for matching.
Prefer vault_delete_note for deleting entire non-protected notes.

Returns: Confirmation message.`,
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

  sessionLogger.info("registered tools", { count: 14 })
}
