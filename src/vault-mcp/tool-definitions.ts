/** MCP tool definitions — registers all vault-cortex tools with Zod schemas. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { vaultFs } from "./vault-operations/vault-filesystem.js"
import { vaultPatcher } from "./vault-operations/vault-patcher.js"
import { createMemoryStore } from "./vault-operations/memory-store.js"
import { getDailyNote } from "./vault-operations/daily-notes.js"
import type { SearchIndex } from "./search/search-index.js"
import type { VaultConfig } from "./config.js"
import type { Logger } from "../logger.js"

export const TOOL_NAMES = {
  VAULT_READ_NOTE: "vault_read_note",
  VAULT_WRITE_NOTE: "vault_write_note",
  VAULT_PATCH_NOTE: "vault_patch_note",
  VAULT_REPLACE_IN_NOTE: "vault_replace_in_note",
  VAULT_LIST_NOTES: "vault_list_notes",
  VAULT_DELETE_NOTE: "vault_delete_note",
  VAULT_SEARCH: "vault_search",
  VAULT_SEARCH_BY_TAG: "vault_search_by_tag",
  VAULT_SEARCH_BY_FOLDER: "vault_search_by_folder",
  VAULT_LIST_TAGS: "vault_list_tags",
  VAULT_RECENT_NOTES: "vault_recent_notes",
  VAULT_GET_MEMORY: "vault_get_memory",
  VAULT_UPDATE_MEMORY: "vault_update_memory",
  VAULT_LIST_MEMORY_FILES: "vault_list_memory_files",
  VAULT_DELETE_MEMORY: "vault_delete_memory",
  VAULT_GET_DAILY_NOTE: "vault_get_daily_note",
  VAULT_LIST_PROPERTY_KEYS: "vault_list_property_keys",
  VAULT_LIST_PROPERTY_VALUES: "vault_list_property_values",
  VAULT_SEARCH_BY_PROPERTY: "vault_search_by_property",
  VAULT_GET_BACKLINKS: "vault_get_backlinks",
  VAULT_GET_OUTGOING_LINKS: "vault_get_outgoing_links",
  VAULT_FIND_ORPHANS: "vault_find_orphans",
  VAULT_UPDATE_PROPERTIES: "vault_update_properties",
} as const

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
  config: VaultConfig
}): void => {
  const { server, vaultPath, search, logger: sessionLogger, config } = params
  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })

  // ── Vault CRUD ──────────────────────────────────────────────

  server.registerTool(
    TOOL_NAMES.VAULT_READ_NOTE,
    {
      title: "Read Note",
      description: `Read a markdown note by its vault-relative path. Returns the full raw content including properties, or just the parsed properties when properties_only is set.

Example: vault_read_note({ path: "Projects/vault-cortex.md" })
Example: vault_read_note({ path: "Projects/vault-cortex.md", properties_only: true })

When to use: You know the exact path and need the full content of a specific note. Use properties_only: true when you only need properties (saves tokens on large notes).
Prefer vault_search when you don't know the path. Prefer vault_get_memory for ${config.memoryDir}/ files (returns content without properties).

Returns: Raw markdown string (default), or JSON object of properties (when properties_only: true).`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            `Vault-relative path to the note (e.g. "${config.memoryDir}/Principles.md")`,
          ),
        properties_only: z
          .boolean()
          .optional()
          .describe(
            "If true, returns parsed properties as JSON instead of full note content",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, properties_only }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_READ_NOTE,
      })
      reqLogger.info("tool_call", { path, properties_only })

      if (properties_only) {
        return safeHandler(
          reqLogger,
          () => vaultFs.readNoteProperties({ vaultPath, path }, reqLogger),
          (properties) => JSON.stringify(properties, null, 2),
        )
      }

      return safeHandler(
        reqLogger,
        () => vaultFs.readNote({ vaultPath, path }, reqLogger),
        (text) => text,
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_WRITE_NOTE,
    {
      title: "Write Note",
      description: `Create or update a markdown note. Body replaces the entire note content — this is a full overwrite, not a partial edit. Properties are passed separately and merged with any existing properties (new keys added, matching keys overwritten, unmentioned keys preserved).

Example: vault_write_note({ path: "Projects/notes.md", body: "# Notes\\n\\nProject notes here.", properties: { tags: ["project"], type: "project" } })

When to use: Creating a new note or fully replacing an existing note's body.
Prefer vault_update_properties for property-only edits (no body round-trip).
Prefer vault_update_memory for appending dated entries to ${config.memoryDir}/ memory files.

Limitation: Overwrites the entire body. Do not use for surgical edits to large files — existing content will be lost unless you include it in the body parameter.

Obsidian syntax: Body content is rendered as Obsidian Flavored Markdown with no escaping applied. Beyond standard Markdown, watch for Obsidian-specific patterns:
- #word (no space after #) = tag — escape with \\# or backticks
- [[ = wikilink, ![[ = embed — escape with \\[[
- %% = comment block (hidden in reading view)
Properties: quote wikilink values ("[[Note]]"), use YAML lists for tags ([tag1, tag2]), keep property types consistent across the vault (string/number/list mismatches cause silent query failures).

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path for the note"),
        body: z
          .string()
          .describe("Markdown body content (no frontmatter fences)"),
        properties: z
          .record(z.string().min(1), z.unknown())
          .optional()
          .describe(
            "Optional properties to merge. New keys are added; existing keys with matching names are overwritten; unmentioned keys are preserved from the existing file.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, body, properties }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_WRITE_NOTE,
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.writeNote({ vaultPath, path, body, properties }, reqLogger),
        () => `Wrote ${path}`,
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_PATCH_NOTE,
    {
      title: "Patch Note",
      description: `Surgical edits to a markdown note — append, prepend, replace, or insert content by heading. Frontmatter values are preserved; YAML formatting may be normalized to block style on first edit.

Example: vault_patch_note({ path: "TASKS.md", operation: "append", heading: "Active", content: "- [ ] New task" })

Cross-section move (e.g. completing a task on a board):
1. vault_read_note to get current content and verify exact text
2. vault_replace_in_note({ path, old_text: "- [ ] Task text", new_text: "" }) to remove from source
3. vault_patch_note({ path, operation: "append", heading: "Done", content: "- [x] Task text" }) to add at target

When to use: Modifying part of an existing note without overwriting the entire body.
Prefer vault_write_note for creating new notes or full rewrites. Prefer vault_replace_in_note for in-place text changes (typos, renaming) that stay in the same location.

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

Obsidian syntax: Content is rendered as Obsidian Flavored Markdown with no escaping applied. Beyond standard Markdown, watch for: #word (no space) = tag, [[ = wikilink, %% = comment block. Escape with \\# or \\[[ when unintentional.
Structural note: inserting heading-level content (e.g. ## New Section) changes the note's section structure — future patch calls targeting headings may resolve differently.

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
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
        tool: TOOL_NAMES.VAULT_PATCH_NOTE,
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
    TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
    {
      title: "Replace in Note",
      description: `Find and replace text in a markdown note's body. Matches exact text (case-sensitive). Properties are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only — properties must be edited via vault_update_properties or vault_write_note's properties parameter.

Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "TODO: write summary", new_text: "Summary complete." })

When to use: Targeted text changes within a single location — fixing typos, updating values, renaming terms, or removing a specific line (new_text=""). Replaces text in place; does not move content across sections.
To relocate content between headings, use vault_replace_in_note to remove from the source (new_text=""), then vault_patch_note to append at the target. Read the note first with vault_read_note to confirm exact text.

Limitation: Exact text match only (no regex). old_text must appear in the note body or an error is returned.

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "text not found" — old_text does not appear in the note body; verify exact text with vault_read_note
- "old_text cannot be empty" — old_text must be at least one character

Obsidian syntax: new_text is rendered as Obsidian Flavored Markdown with no escaping applied. Beyond standard Markdown, Obsidian-specific patterns (#word = tag, [[ = wikilink, %% = comment block) apply to replacement text. Verify replacements won't introduce unintended Obsidian rendering.

Returns: Confirmation message with replacement count.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
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
        tool: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
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
    TOOL_NAMES.VAULT_LIST_NOTES,
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
          .describe(`Folder to list (e.g. "${config.memoryDir}", "Projects")`),
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
        tool: TOOL_NAMES.VAULT_LIST_NOTES,
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
    TOOL_NAMES.VAULT_DELETE_NOTE,
    {
      title: "Delete Note",
      description: `Permanently delete a markdown note. Protected paths (${config.protectedPaths.map((p) => p + "/").join(", ")}) are refused to prevent accidental deletion of memory or daily notes.

Example: vault_delete_note({ path: "Scratch/temp.md" })

When to use: Removing a note you no longer need.
Prefer vault_delete_memory for removing individual dated entries from ${config.memoryDir}/ memory files.

Returns: Confirmation message.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path of the note to delete"),
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
        tool: TOOL_NAMES.VAULT_DELETE_NOTE,
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.deleteNote(
            { vaultPath, path, protectedPaths: config.protectedPaths },
            reqLogger,
          ),
        () => `Deleted ${path}`,
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
    {
      title: "Update Properties",
      description: `Update properties on a single note. Merges with existing properties — new keys are added, matching keys are overwritten, unmentioned keys are preserved. Body content is never modified.

Example: vault_update_properties({ path: "Projects/todo.md", properties: { status: "active", priority: 1 } })

When to use: Changing tags, status, type, or any property without reading/rewriting the full note body. Saves tokens on large notes.
Prefer vault_write_note when creating a new note or replacing the body.

Errors:
- "note not found" — path does not exist; create the note first with vault_write_note
- "path traversal blocked" — path escapes vault root

Obsidian syntax: Property values follow YAML conventions. Use arrays for multi-value fields (tags: [a, b]), quote wikilink values ("[[Note]]"), keep property types consistent across the vault (string/number/list mismatches cause silent query failures).

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
        properties: z
          .record(z.string().min(1), z.unknown())
          .describe(
            "Properties to merge. New keys are added; existing keys are overwritten; unmentioned keys are preserved.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, properties }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.updateProperties({ vaultPath, path, properties }, reqLogger),
        () => `Updated properties on ${path}`,
      )
    },
  )

  // ── Search ──────────────────────────────────────────────────

  server.registerTool(
    TOOL_NAMES.VAULT_SEARCH,
    {
      title: "Search Notes",
      description: `Full-text search across all vault notes, ranked by relevance. Supports filtering by folder, tags, type, and properties. Wrap terms in double quotes for exact phrase matching (e.g. '"machine learning"'); unquoted terms use implicit AND with porter stemming.

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
              .record(
                z.string(),
                z.union([z.string(), z.number(), z.boolean()]),
              )
              .optional()
              .describe("Arbitrary property key-value filters"),
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
        tool: TOOL_NAMES.VAULT_SEARCH,
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
    TOOL_NAMES.VAULT_SEARCH_BY_TAG,
    {
      title: "Search by Tag",
      description: `Find notes with a specific tag. By default uses hierarchical prefix matching — a parent tag matches all children (e.g. "project" matches "project/vault-cortex", "project/blog"). Set exact=true for exact match only.

Example: vault_search_by_tag({ tag: "project" }) returns all notes tagged project or project/*.

When to use: Exploring tag hierarchies or finding all notes with a specific tag, without needing a text query.
Prefer vault_search when you also need text-based relevance ranking. Use vault_list_tags first to discover available tags.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties), sorted by most recently modified. Promoted keys are in top-level fields; additional_properties contains only unpromoted keys.`,
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
        tool: TOOL_NAMES.VAULT_SEARCH_BY_TAG,
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
    TOOL_NAMES.VAULT_LIST_TAGS,
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
        tool: TOOL_NAMES.VAULT_LIST_TAGS,
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
    TOOL_NAMES.VAULT_RECENT_NOTES,
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
        tool: TOOL_NAMES.VAULT_RECENT_NOTES,
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
    TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
    {
      title: "Search by Folder",
      description: `Browse notes in a folder with full metadata (tags, type, related, created, modified). Unlike vault_list_notes which returns paths only, this returns rich metadata for each note.

Example: vault_search_by_folder({ folder: "Projects" }) or vault_search_by_folder({ folder: "${config.memoryDir}", recursive: false })

When to use: Exploring a folder's contents with full context — tags, type, relationships. Useful for vault orientation and understanding folder structure.
Prefer vault_list_notes when you only need paths. Prefer vault_search when you have a text query.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties), sorted by most recently modified.`,
      inputSchema: {
        folder: z
          .string()
          .describe(`Folder path (e.g. "Projects", "${config.memoryDir}")`),
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
        tool: TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
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
    TOOL_NAMES.VAULT_GET_MEMORY,
    {
      title: "Get Memory",
      description: `Read semantic memory from ${config.memoryDir}/ files. These are structured memory files containing dated bullet entries organized under H2 headings. With file: single file content. With file+section: just that H2 section's entries. No args: all files concatenated (frontmatter stripped) — can be large. Returns empty string when no memory files exist yet.

Example: vault_get_memory({ file: "Principles", section: "Decision heuristics (newest first)" })

When to use: Reading user preferences, principles, opinions, or other persistent context stored in ${config.memoryDir}/ files. Call vault_list_memory_files first to discover valid file and section names.
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
        tool: TOOL_NAMES.VAULT_GET_MEMORY,
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
    TOOL_NAMES.VAULT_UPDATE_MEMORY,
    {
      title: "Update Memory",
      description: `Append a dated entry to a section of a ${config.memoryDir}/ memory file. The server auto-prefixes today's date (format: "- **YYYY-MM-DD**: entry text"). Call vault_list_memory_files first to discover valid file and section names.

Example: vault_update_memory({ file: "Opinions", section: "Code patterns (newest first)", entry: "Prefer immutable data structures" })

When to use: Recording a new preference, principle, opinion, or fact about the user. Pass raw entry text without date prefix. Always call vault_list_memory_files first to discover existing files and sections, and use matching names to keep entries organized alongside existing content.
Auto-creates: If the file or section does not exist, it is created automatically. If the section name does not already include "(newest first)", the server appends it (e.g. "Design preferences" becomes "Design preferences (newest first)"). Use the full heading name in subsequent vault_get_memory calls, or call vault_list_memory_files to discover the actual heading names. Use existing file and section names from vault_list_memory_files when available.
Prefer vault_write_note for creating entirely new notes (not memory entries).

Obsidian syntax: Entry text is rendered inline as Obsidian Flavored Markdown. Watch for: #word = tag, [[ = wikilink. Escape with backslash or backticks when unintentional.

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
        tool: TOOL_NAMES.VAULT_UPDATE_MEMORY,
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
        () => `Added entry to ${config.memoryDir}/${file}.md → ## ${section}`,
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    {
      title: "List Memory Files",
      description: `Discovery tool — lists ${config.memoryDir}/ memory files with their H1/H2 heading structure and per-section entry counts. Does NOT return actual entries.

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
        tool: TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
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
    TOOL_NAMES.VAULT_DELETE_MEMORY,
    {
      title: "Delete Memory Entry",
      description: `Delete a single dated entry from a ${config.memoryDir}/ memory file. Both date and entry text are required for exact matching — ensures only the intended entry is removed.

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
        tool: TOOL_NAMES.VAULT_DELETE_MEMORY,
      })
      reqLogger.info("tool_call", { file, section, date })
      return safeHandler(
        reqLogger,
        () =>
          memoryStore.deleteMemory(
            { vaultPath, file, section, date, entry },
            reqLogger,
          ),
        () =>
          `Deleted entry from ${config.memoryDir}/${file}.md → ## ${section}`,
      )
    },
  )

  // ── Daily Notes ────────────────────────────────────────────

  server.registerTool(
    TOOL_NAMES.VAULT_GET_DAILY_NOTE,
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
        tool: TOOL_NAMES.VAULT_GET_DAILY_NOTE,
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
    TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
    {
      title: "List Property Keys",
      description: `Discover all property keys in the vault with note counts and sample values. Lets you understand the vault's metadata schema without reading individual notes.

Example: vault_list_property_keys() returns [{ key: "tags", count: 342, sample_values: ["session-log", "project"] }, ...]

When to use: Discovering what properties exist before searching by property. Good first step for vault orientation alongside vault_list_tags.
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
        tool: TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
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
    TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
    {
      title: "List Property Values",
      description: `List distinct values for a specific property key with note counts. Useful for discovering the range of values a property takes before searching.

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
        tool: TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
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
    TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
    {
      title: "Search by Property",
      description: `Find notes where a property matches a value (exact match). Unlike vault_search, this does not require a text query — it searches by metadata only. Handles both scalar properties (status: "active") and array properties (tags contains "project").

Example: vault_search_by_property({ key: "status", value: "in-progress" })

When to use: Finding notes by metadata when you don't have a text query. Fills the gap where vault_search requires search text.
Prefer vault_search when you also have a text query (it supports property filters too). Prefer vault_search_by_tag for tag-specific queries (supports hierarchical prefix matching).

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties), sorted by most recently modified.`,
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
        tool: TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
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
    TOOL_NAMES.VAULT_GET_BACKLINKS,
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
          .min(1)
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
        tool: TOOL_NAMES.VAULT_GET_BACKLINKS,
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
    TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
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
        path: z.string().min(1).describe("Vault-relative path to the note"),
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
        tool: TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
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
    TOOL_NAMES.VAULT_FIND_ORPHANS,
    {
      title: "Find Orphans",
      description: `Find notes with no incoming links from other notes. Orphan notes are disconnected from the vault's knowledge graph — they may be forgotten or need linking from relevant notes.

Example: vault_find_orphans() or vault_find_orphans({ exclude_folders: ${JSON.stringify(config.orphanExcludeFolders)} })

When to use: Vault maintenance and organization. Helps identify notes that might be forgotten or need integration into the knowledge graph. ${config.orphanExcludeFolders.join(", ")} folders are excluded by default since those are standalone by design.
To add links to an orphan, use vault_patch_note to mention it from a relevant note.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, additional_properties), sorted by most recently modified.`,
      inputSchema: {
        exclude_folders: z
          .array(z.string())
          .optional()
          .describe(
            `Folders to exclude (default: ${JSON.stringify(config.orphanExcludeFolders)})`,
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
        tool: TOOL_NAMES.VAULT_FIND_ORPHANS,
      })
      reqLogger.info("tool_call", { exclude_folders, limit })
      return safeHandler(
        reqLogger,
        async () =>
          search.findOrphans(
            {
              excludeFolders: exclude_folders ?? [
                ...config.orphanExcludeFolders,
              ],
              limit,
            },
            reqLogger,
          ),
        (results) => JSON.stringify(results.map(formatNoteMetadata)),
      )
    },
  )

  sessionLogger.info("registered tools", {
    count: Object.keys(TOOL_NAMES).length,
  })
}
