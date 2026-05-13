/** MCP tool definitions — registers all vault-cortex tools with Zod schemas. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { vaultFs } from "./vault-filesystem.js"
import { vaultPatcher } from "./vault-patcher.js"
import { memoryStore } from "./memory-store.js"
import { getDailyNote } from "./daily-notes.js"
import type { SearchIndex } from "./search-index.js"
import type { Logger } from "../logger.js"

export type ToolName =
  | "vault_read_note"
  | "vault_write_note"
  | "vault_patch_note"
  | "vault_replace_in_note"
  | "vault_list_notes"
  | "vault_delete_note"
  | "vault_search"
  | "vault_search_by_tag"
  | "vault_search_by_folder"
  | "vault_list_tags"
  | "vault_recent_notes"
  | "vault_get_memory"
  | "vault_update_memory"
  | "vault_list_memory_files"
  | "vault_delete_memory"
  | "vault_get_daily_note"
  | "vault_list_property_keys"
  | "vault_list_property_values"
  | "vault_search_by_property"
  | "vault_get_backlinks"
  | "vault_get_outgoing_links"
  | "vault_find_orphans"

// ── Response shaping ─────────────────────────────────────────────

// Frontmatter keys that are already top-level fields on NoteMetadata.
// These are stripped from `properties` before returning to clients
// so the response doesn't contain the same data twice.
const PROMOTED_KEYS = new Set(["title", "tags", "type", "created", "related"])

/** Reshapes NoteMetadata for client responses: keeps all top-level fields,
 *  replaces `properties` (full frontmatter, mostly duplicated) with
 *  `additional_properties` (only unpromoted keys like topic, agent, date). */
const formatNoteMetadata = (meta: {
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
const safeHandler = async <T>(
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
    const message = err instanceof Error ? err.message : String(err)
    logger.warn("tool_error", { error: message })
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true as const,
    }
  }
}

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
    "vault_patch_note",
    {
      title: "Patch Note",
      description: `Surgical edits to a markdown note — append, prepend, replace, or insert content by heading. Frontmatter values are preserved; YAML formatting may be normalized to block style on first edit.

Example: vault_patch_note({ path: "TASKS.md", operation: "append", heading: "Active", content: "- [ ] New task" })

When to use: Modifying part of an existing note without overwriting the entire body.
Prefer vault_write_note for creating new notes or full rewrites. Prefer vault_replace_in_note for find-and-replace edits.

Operations:
- append: add content at end of section (or end of file if no heading)
- prepend: add content after heading line (or after frontmatter if no heading)
- replace: replace section body (heading preserved; requires heading)
- insert_before: insert content above the heading line (requires heading)

Section boundaries: a section spans from its heading to the next heading of the same or higher level (or EOF). Child headings are included in the parent section.

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "heading not found" — no heading matches the text; error lists available headings
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate, or rename a heading if they share the same level
- "operation requires a heading target" — replace and insert_before need a heading

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().describe("Vault-relative path to the note"),
        operation: z
          .enum(["append", "prepend", "replace", "insert_before"])
          .describe("Patch operation to apply"),
        content: z.string().describe("Content to insert or replace with"),
        heading: z
          .string()
          .optional()
          .describe(
            "Target heading text (case-sensitive exact match). Required for replace and insert_before. Optional for append/prepend (omit for file-level operation).",
          ),
        heading_level: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe(
            "Heading level (1-6) for disambiguation when multiple headings share the same text",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, operation, content, heading, heading_level }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_patch_note",
      })
      reqLogger.info("tool_call", { path, operation, heading })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.patchNote(
            {
              vaultPath,
              path,
              operation,
              content,
              heading,
              headingLevel: heading_level,
            },
            reqLogger,
          ),
        (msg) => msg,
      )
    },
  )

  server.registerTool(
    "vault_replace_in_note",
    {
      title: "Replace in Note",
      description: `Find and replace text in a markdown note's body. Matches exact text (case-sensitive). Frontmatter values are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only — frontmatter fields must be edited via vault_write_note's frontmatter parameter.

Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "TODO: write summary", new_text: "Summary complete." })

When to use: Targeted text changes — fixing typos, updating values, renaming terms in the note body.
Prefer vault_patch_note for heading-targeted structural edits.

Limitation: Exact text match only (no regex). old_text must appear in the note body or an error is returned.

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "text not found" — old_text does not appear in the note body; verify exact text with vault_read_note
- "old_text cannot be empty" — old_text must be at least one character

Returns: Confirmation message with replacement count.`,
      inputSchema: {
        path: z.string().describe("Vault-relative path to the note"),
        old_text: z
          .string()
          .min(1)
          .describe("Exact text to find (case-sensitive, non-empty)"),
        new_text: z.string().describe("Replacement text"),
        replace_all_occurrences: z
          .boolean()
          .optional()
          .describe(
            "Replace all occurrences (default: false — replaces first occurrence only)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, old_text, new_text, replace_all_occurrences }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_replace_in_note",
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.replaceInNote(
            {
              vaultPath,
              path,
              oldText: old_text,
              newText: new_text,
              replaceAllOccurrences: replace_all_occurrences,
            },
            reqLogger,
          ),
        (msg) => msg,
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

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, created, modified) and total count. created is omitted when null.`,
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

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties). Promoted frontmatter keys are in top-level fields; additional_properties contains only unpromoted keys.`,
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
        (results) => JSON.stringify(results.map(formatNoteMetadata)),
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

Example: vault_recent_notes({ sort_by: "modified", limit: 10 })

When to use: Catching up on vault changes or finding recent work.
Prefer vault_search for content-based discovery. Prefer vault_search_by_folder for browsing a specific folder.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties), sorted by chosen timestamp.`,
      inputSchema: {
        sort_by: z
          .enum(["created", "modified"])
          .optional()
          .describe('Sort field: "created" or "modified" (default "modified")'),
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
        (notes) => JSON.stringify(notes.map(formatNoteMetadata)),
      )
    },
  )

  server.registerTool(
    "vault_search_by_folder",
    {
      title: "Search by Folder",
      description: `Browse notes in a folder with full metadata (tags, type, related, created, modified). Unlike vault_list_notes which returns paths only, this returns rich metadata for each note.

Example: vault_search_by_folder({ folder: "Projects" }) or vault_search_by_folder({ folder: "About Me", recursive: false })

When to use: Exploring a folder's contents with full context — tags, type, relationships. Useful for vault orientation and understanding folder structure.
Prefer vault_list_notes when you only need paths. Prefer vault_search when you have a text query.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties).`,
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
        (results) => JSON.stringify(results.map(formatNoteMetadata)),
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

  // ── Daily Notes ────────────────────────────────────────────

  server.registerTool(
    "vault_get_daily_note",
    {
      title: "Get Daily Note",
      description: `Read a daily note by date, using the vault's configured Daily Notes folder and date format (from .obsidian/daily-notes.json). Defaults to today if no date is provided.

Example: vault_get_daily_note({ date: "2026-05-13" })

When to use: When you need today's or a specific date's daily note. Handles path resolution automatically using the vault's Obsidian config — you don't need to know the folder name or filename format. To append content to a daily note section, use the returned path with vault_patch_note.

Errors:
- "invalid date" — use YYYY-MM-DD format (e.g. "2026-05-13")

Returns: JSON with path (resolved vault-relative path), content (note body or null), and exists (boolean). When exists is false, use vault_write_note with the returned path to create the note.`,
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe(
            "Date in YYYY-MM-DD format (defaults to today in server timezone)",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ date }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_get_daily_note",
      })
      reqLogger.info("tool_call", { date })
      return safeHandler(
        reqLogger,
        () => getDailyNote({ vaultPath, date }, reqLogger),
        (result) => JSON.stringify(result),
      )
    },
  )

  // ── Property Discovery ────────────────────────────────────

  server.registerTool(
    "vault_list_property_keys",
    {
      title: "List Property Keys",
      description: `Discover all frontmatter property keys in the vault with note counts and sample values. Lets you understand the vault's metadata schema without reading individual notes.

Example: vault_list_property_keys() returns [{ key: "tags", count: 342, sample_values: ["session-log", "project"] }, ...]

When to use: Discovering what frontmatter properties exist before searching by property. Good first step for vault orientation alongside vault_list_tags.
Prefer vault_list_property_values when you need the full list of values for a specific key. Prefer vault_search_by_property to find notes matching a specific key-value pair.

Returns: JSON array of { key, count, sample_values } sorted by count descending. sample_values shows the top 3 most common values for quick orientation.`,
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Restrict to a folder (e.g. "Projects")'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_list_property_keys",
      })
      reqLogger.info("tool_call", { folder })
      return safeHandler(
        reqLogger,
        async () => search.listPropertyKeys({ folder }, reqLogger),
        (keys) => JSON.stringify(keys),
      )
    },
  )

  server.registerTool(
    "vault_list_property_values",
    {
      title: "List Property Values",
      description: `List distinct values for a specific frontmatter property key with note counts. Useful for discovering the range of values a property takes before searching.

Example: vault_list_property_values({ key: "status" }) returns [{ value: "active", count: 47 }, { value: "done", count: 211 }, ...]

When to use: Enumerating possible values for a property key before calling vault_search_by_property. Handles both scalar properties (status: "active") and array properties (tags: ["a", "b"]) — array elements are enumerated individually.
Call vault_list_property_keys first to discover valid key names.

Returns: JSON array of { value, count } sorted by count descending.`,
      inputSchema: {
        key: z
          .string()
          .describe('Property key name (e.g. "status", "type", "tags")'),
        folder: z.string().optional().describe("Restrict to a folder"),
        limit: z
          .number()
          .optional()
          .describe("Max values to return (default 50)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key, folder, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_list_property_values",
      })
      reqLogger.info("tool_call", { key, folder })
      return safeHandler(
        reqLogger,
        async () =>
          search.listPropertyValues({ key, folder, limit }, reqLogger),
        (values) => JSON.stringify(values),
      )
    },
  )

  server.registerTool(
    "vault_search_by_property",
    {
      title: "Search by Property",
      description: `Find notes where a frontmatter property matches a value (exact match). Unlike vault_search, this does not require a text query — it searches by metadata only. Handles both scalar properties (status: "active") and array properties (tags contains "project").

Example: vault_search_by_property({ key: "status", value: "in-progress" })

When to use: Finding notes by metadata when you don't have a text query. Fills the gap where vault_search requires search text.
Prefer vault_search when you also have a text query (it supports property filters too). Prefer vault_search_by_tag for tag-specific queries (supports hierarchical prefix matching).

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties).`,
      inputSchema: {
        key: z.string().describe("Property key name"),
        value: z.string().describe("Value to match (exact, case-sensitive)"),
        folder: z.string().optional().describe("Restrict to a folder"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key, value, folder, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_search_by_property",
      })
      reqLogger.info("tool_call", { key, value, folder })
      return safeHandler(
        reqLogger,
        async () =>
          search.searchByProperty({ key, value, folder, limit }, reqLogger),
        (results) => JSON.stringify(results.map(formatNoteMetadata)),
      )
    },
  )

  // ── Links ──────────────────────────────────────────────────

  server.registerTool(
    "vault_get_backlinks",
    {
      title: "Get Backlinks",
      description: `Find all notes that link to a given note (incoming wikilinks and markdown links). Shows which notes reference the target — useful for understanding a note's context and importance in the vault's knowledge graph.

Example: vault_get_backlinks({ path: "Projects/vault-cortex.md" })

When to use: When you need to understand what references a note, find related context, or assess a note's connectivity. Core Obsidian concept — backlinks are invisible without a database query.
For outgoing links (what a note links TO), use vault_get_outgoing_links. For orphan detection, use vault_find_orphans.

Errors:
- No error if the note has zero backlinks — returns an empty array.

Returns: JSON with path (the queried note), backlinks (array of { path, title }), and count.`,
      inputSchema: {
        path: z
          .string()
          .describe(
            'Vault-relative path to the note (e.g. "Projects/vault-cortex.md")',
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
        tool: "vault_get_backlinks",
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        async () => search.getBacklinks({ path }, reqLogger),
        (backlinks) =>
          JSON.stringify({ path, backlinks, count: backlinks.length }),
      )
    },
  )

  server.registerTool(
    "vault_get_outgoing_links",
    {
      title: "Get Outgoing Links",
      description: `Find all notes that a given note links to (outgoing wikilinks and markdown links). Each link includes an exists flag — false means the target note doesn't exist (broken link).

Example: vault_get_outgoing_links({ path: "Projects/vault-cortex.md" })

When to use: When you need to see what a note references, navigate the knowledge graph forward, or detect broken links in a specific note.
For incoming links (what links TO a note), use vault_get_backlinks.

Errors:
- No error if the note has zero outgoing links — returns an empty array.

Returns: JSON with path (the queried note), outgoing_links (array of { path, title, exists }), and count.`,
      inputSchema: {
        path: z.string().describe("Vault-relative path to the note"),
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
        tool: "vault_get_outgoing_links",
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        async () => search.getOutgoingLinks({ path }, reqLogger),
        (outgoingLinks) =>
          JSON.stringify({
            path,
            outgoing_links: outgoingLinks,
            count: outgoingLinks.length,
          }),
      )
    },
  )

  server.registerTool(
    "vault_find_orphans",
    {
      title: "Find Orphans",
      description: `Find notes with no incoming links from other notes. Orphan notes are disconnected from the vault's knowledge graph — they may be forgotten or need linking from relevant notes.

Example: vault_find_orphans() or vault_find_orphans({ exclude_folders: ["Daily Notes", "Templates", "About Me"] })

When to use: Vault maintenance and organization. Helps identify notes that might be forgotten or need integration into the knowledge graph. Daily Notes, Templates, and About Me folders are excluded by default since those are standalone by design.
To add links to an orphan, use vault_patch_note to mention it from a relevant note.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties), sorted by most recently modified.`,
      inputSchema: {
        exclude_folders: z
          .array(z.string())
          .optional()
          .describe(
            'Folders to exclude (default: ["Daily Notes", "Templates", "About Me"])',
          ),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ exclude_folders, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: "vault_find_orphans",
      })
      reqLogger.info("tool_call", { exclude_folders, limit })
      return safeHandler(
        reqLogger,
        async () =>
          search.findOrphans(
            { excludeFolders: exclude_folders, limit },
            reqLogger,
          ),
        (results) => JSON.stringify(results.map(formatNoteMetadata)),
      )
    },
  )

  sessionLogger.info("registered tools", { count: 22 })
}
