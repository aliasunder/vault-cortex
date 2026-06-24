/** Search tool registrations — full-text, tag, property, folder, and graph queries. */

import { z } from "zod"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler, formatNoteMetadata } from "./tool-helpers.js"

const TOOL_NAMES = {
  VAULT_SEARCH: "vault_search",
  VAULT_SEARCH_BY_TAG: "vault_search_by_tag",
  VAULT_LIST_TAGS: "vault_list_tags",
  VAULT_RECENT_NOTES: "vault_recent_notes",
  VAULT_SEARCH_BY_FOLDER: "vault_search_by_folder",
  VAULT_LIST_PROPERTY_KEYS: "vault_list_property_keys",
  VAULT_LIST_PROPERTY_VALUES: "vault_list_property_values",
  VAULT_SEARCH_BY_PROPERTY: "vault_search_by_property",
  VAULT_GET_BACKLINKS: "vault_get_backlinks",
  VAULT_GET_OUTGOING_LINKS: "vault_get_outgoing_links",
  VAULT_FIND_ORPHANS: "vault_find_orphans",
} as const

export { TOOL_NAMES as SEARCH_TOOL_NAMES }

export const registerSearchTools = ({
  server,
  search,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  server.registerTool(
    TOOL_NAMES.VAULT_SEARCH,
    {
      title: "Search Notes",
      description: `Full-text search across all vault notes, ranked by relevance. Combine a text query with structured filters to narrow results by metadata — the "narrow by metadata, search by text" pattern. Unquoted terms use implicit AND with porter stemming; wrap in double quotes for exact phrases; punctuated terms (vault-cortex, deploy/local) are matched as exact adjacent-word phrases automatically.

Filters — all conditions AND-combine with each other and the text query:
- folder: path prefix (e.g. "Projects")
- tags: require all listed tags (AND)
- type: exact match on frontmatter type (e.g. "person", "session-log")
- related: require all listed related links (AND)
- properties: arbitrary frontmatter key-value pairs, supports string/number/boolean (e.g. { status: "active" })

Example: vault_search({ query: "kubernetes networking", filters: { tags: ["reference"] } })
Example: vault_search({ query: "meeting notes", filters: { type: "meeting", folder: "Work" } })
Example: vault_search({ query: "deployment", filters: { properties: { status: "active" } } })

When to use: The primary discovery tool for content-based queries, optionally constrained by metadata.
Prefer vault_search_by_tag for tag-only queries without text. Prefer vault_search_by_folder for browsing a folder. Prefer vault_search_by_property for metadata-only queries. Prefer vault_recent_notes for time-based browsing.

Errors:
- No matches returns { results: [], total: 0 }, not an error
- Malformed query syntax is sanitized automatically — the tool never throws a query syntax error

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, created, modified, bytes) and total count. created is omitted when null. bytes is the on-disk file size. With filters.include_leading_callout, each result also carries leading_callout ({ type, title, body }) when present.`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Search query text — unquoted terms use implicit AND with stemming; wrap in double quotes for exact phrases",
          ),
        filters: z
          .object({
            folder: z
              .string()
              .min(1)
              .optional()
              .describe('Restrict to a folder path prefix (e.g. "Projects")'),
            tags: z
              .array(z.string().min(1))
              .optional()
              .describe(
                "Require all listed tags (AND — every tag must be present)",
              ),
            related: z
              .array(z.string().min(1))
              .optional()
              .describe("Require all listed related links"),
            type: z
              .string()
              .min(1)
              .optional()
              .describe(
                'Match the frontmatter type field (exact match, e.g. "person", "meeting")',
              ),
            properties: z
              .record(
                z.string().min(1),
                z.union([z.string().min(1), z.number(), z.boolean()]),
              )
              .optional()
              .describe(
                'Match arbitrary frontmatter properties by key-value (e.g. { status: "active", priority: 1 })',
              ),
            limit: z.number().optional().describe("Max results (default 20)"),
            snippet_tokens: z
              .number()
              .optional()
              .describe("Snippet length in tokens (default 30)"),
            include_leading_callout: z
              .boolean()
              .optional()
              .describe(
                "If true, each result includes its leading_callout ({ type, title, body }) when present. Off by default to keep results lean.",
              ),
          })
          .optional()
          .describe(
            "Optional structured filters — all conditions AND-combine with each other and with the text query",
          ),
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
      reqLogger.info("tool_call", { query, ...(filters ? { filters } : {}) })
      return safeHandler(
        reqLogger,
        async () => search.fullTextSearch({ query, filters }, reqLogger),
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify({ results, total: results.length })
        },
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

Parameters:
- tag is the bare tag name without a leading "#" ("project", not "#project").
- exact (default false) does hierarchical prefix matching — the tag and all its children. Set true to match the exact tag only, excluding children.

Errors:
- An unknown tag or no matches returns an empty array, not an error — don't use as an existence check.

Returns: JSON array of up to 20 notes' metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted by most recently modified. bytes is the on-disk file size. Promoted keys are in top-level fields; additional_properties contains only unpromoted keys.`,
      inputSchema: {
        tag: z
          .string()
          .min(1)
          .describe(
            'Tag name without "#" prefix (e.g. "project", "session-log"). Hierarchical tags use "/" separators (e.g. "project/vault-cortex").',
          ),
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
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_TAGS,
    {
      title: "List Tags",
      description: `List all tags in the vault with their note counts, ordered by count descending. Only frontmatter tags are counted (inline #tags in note bodies are not indexed separately). Each tag is listed as its full string — a hierarchical tag like "project/vault-cortex" appears as one entry, not split into parent segments. Count is unique notes, not occurrences within a note.

Example: vault_list_tags() returns [{ tag: "session-log", count: 42 }, { tag: "project/vault-cortex", count: 8 }, ...]

When to use: Discovering what tags exist before searching by tag. Good first step for vault orientation.
Prefer vault_search_by_tag once you know which tag to query — it supports hierarchical prefix matching ("project" matches "project/*").

Errors:
- A vault with no tagged notes returns an empty array, not an error.

Returns: JSON array of { tag (string — without "#" prefix, e.g. "session-log"), count (number — unique notes with this tag) }, sorted by count descending.`,
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
        async () => search.listAllTags({}, reqLogger),
        (tags) => {
          reqLogger.info("tool_result", { resultCount: tags.length })
          return JSON.stringify(tags)
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_RECENT_NOTES,
    {
      title: "Recent Notes",
      description: `List recently modified or created notes, sorted by timestamp — a time-ordered window into the vault, not a date-range filter.

Example: vault_recent_notes({ sort_by: "modified", limit: 10 })
Example: vault_recent_notes({ sort_by: "created", limit: 5 })

When to use: Catching up on vault changes, finding recent work, or orienting after a break.
Prefer vault_search for content-based discovery. Prefer vault_search_by_folder for browsing a specific folder. Pair with vault_read_note to read a note you find here.

Behavior: "modified" (default) sorts by filesystem mtime — any file write counts (content edits, property changes, sync touches), so recently-synced notes appear recent even without user edits. "created" sorts by the frontmatter created property; notes without it sort last (not excluded), so a small limit may return only notes that have the property — increase limit or use "modified" for broader coverage.

Errors:
- An empty vault returns an empty array, not an error.

Returns: JSON array of { path (string), title (string), tags (string[]), related (string[]), folder (string), type (string|null), created (ISO string|null — null when the property is missing), modified (ISO string), bytes (number — on-disk file size), leading_callout? ({ type, title, body }), additional_properties (object) }, sorted descending by chosen timestamp.`,
      inputSchema: {
        sort_by: z
          .enum(["created", "modified"])
          .optional()
          .describe(
            '"created" or "modified" (default). "modified" uses filesystem mtime (any write, including sync, updates it). "created" uses the frontmatter created property — notes without it sort last; pair with a higher limit to include them.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            "Max results (default 20, no upper cap). Example: limit: 5 returns the top 5 by chosen timestamp.",
          ),
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
        (notes) => {
          reqLogger.info("tool_result", { resultCount: notes.length })
          return JSON.stringify(notes.map(formatNoteMetadata))
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
    {
      title: "Search by Folder",
      description: `Browse notes in a folder with full metadata (tags, type, related, created, modified) — unlike vault_list_notes, which returns paths only.

Example: vault_search_by_folder({ folder: "Projects" })${config.memoryEnabled ? ` or vault_search_by_folder({ folder: "${config.memoryDir}", recursive: false })` : ""}

When to use: Exploring a folder's contents with full context for vault orientation.
Prefer vault_list_notes when you only need paths. Prefer vault_search when you have a text query. Use vault_get_backlinks or vault_get_outgoing_links to explore how notes in a folder connect to the rest of the vault.

Parameters:
- folder is matched as a path prefix; pass it without a trailing slash ("Projects").
- recursive (default true) includes all nested subfolders; set false to list only the folder's top level.
- limit (default 20) caps results.

Errors:
- An empty or nonexistent folder returns an empty array, not an error.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted by most recently modified. bytes is the on-disk file size.`,
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .describe(
            `Folder path (e.g. "Projects"${config.memoryEnabled ? `, "${config.memoryDir}"` : ""})`,
          ),
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
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
    {
      title: "List Property Keys",
      description: `Discover all property keys in the vault with note counts and sample values. Lets you understand the vault's metadata schema without reading individual notes.

Example: vault_list_property_keys() returns [{ key: "tags", count: 342, sample_values: ["session-log", "project"] }, ...]

When to use: Discovering what properties exist before searching by property. Good first step for vault orientation alongside vault_list_tags.
Prefer vault_list_property_values when you need the full list of values for a specific key. Prefer vault_search_by_property to find notes matching a specific key-value pair.

Parameters:
- folder is matched as a path prefix and recurses into subfolders ("Projects" also covers "Projects/Archive"); omit it to scan the entire vault.

Returns: JSON array of { key, count, sample_values } sorted by count descending. sample_values shows the top 3 most common values per key for quick orientation.`,
      inputSchema: {
        folder: z
          .string()
          .min(1)
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
        (keys) => {
          reqLogger.info("tool_result", { resultCount: keys.length })
          return JSON.stringify(keys)
        },
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
          .min(1)
          .describe(
            'Property key name — use vault_list_property_keys to discover valid keys (e.g. "status", "type", "tags").',
          ),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to a folder prefix (e.g. "Projects")'),
        limit: z
          .number()
          .optional()
          .describe(
            "Max values to return (default 50). Increase for high-cardinality properties.",
          ),
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
        (values) => {
          reqLogger.info("tool_result", { resultCount: values.length })
          return JSON.stringify(values)
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
    {
      title: "Search by Property",
      description: `Find notes where a frontmatter property matches a value — metadata-only search, no text query needed. Handles both scalar properties (status: "active") and array properties (tags contains "project").

Example: vault_search_by_property({ key: "status", value: "in-progress" })
Example: vault_search_by_property({ key: "type", value: "session-log", folder: "Code Projects" })

When to use: Finding notes by metadata when you don't have a text query.
Prefer vault_search when you also have a text query (it supports property filters too). Prefer vault_search_by_tag for tag-specific queries (supports hierarchical prefix matching). Use vault_list_property_keys to discover valid keys and vault_list_property_values to see what values a key takes.

Errors:
- No matches returns an empty array, not an error.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted by most recently modified. bytes is the on-disk file size.`,
      inputSchema: {
        key: z
          .string()
          .min(1)
          .describe(
            'Property key name (e.g. "status", "type", "tags"). Use vault_list_property_keys to discover valid keys.',
          ),
        value: z
          .string()
          .min(1)
          .describe(
            'Value to match (exact, case-sensitive, e.g. "active", "session-log"). Use vault_list_property_values to discover valid values for a key.',
          ),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to a folder prefix (e.g. "Projects")'),
        limit: z
          .number()
          .optional()
          .describe(
            "Max results (default 20). Increase for broad metadata queries.",
          ),
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
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_GET_BACKLINKS,
    {
      title: "Get Backlinks",
      description: `Find all notes that link to a given note via incoming [[wikilinks]] or [markdown](links). Links inside code blocks are ignored; a note that links to itself appears in its own backlinks.

Example: vault_get_backlinks({ path: "Projects/vault-cortex.md" })

When to use: Understanding what references a note or assessing its connectivity.
For outgoing links (what a note links TO), use vault_get_outgoing_links. To find notes with no backlinks at all, use vault_find_orphans.

Errors:
- A note with no inbound links, or a path not in the index, returns an empty array (count 0), not an error — don't use this as an existence check.

Returns: JSON with path (the queried note), backlinks (array of { path, title, bytes }, sorted by title), and count. bytes is the on-disk file size.`,
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
        (backlinks) => {
          reqLogger.info("tool_result", { resultCount: backlinks.length })
          return JSON.stringify({ path, backlinks, count: backlinks.length })
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
    {
      title: "Get Outgoing Links",
      description: `Find all notes and assets a given note links to via outgoing [[wikilinks]] or [markdown](links). Each entry carries exists (boolean) and kind ("note"|"asset"): exists+note = readable via vault_read_note; exists+asset = non-markdown file (.canvas, image, PDF) in the vault; !exists+note = broken link. Links inside code blocks are ignored; self-links are included.

Example: vault_get_outgoing_links({ path: "Projects/vault-cortex.md" })

When to use: Seeing what a note references, navigating the graph forward, or finding broken links in one note.
For incoming links (what links TO a note), use vault_get_backlinks.

Errors:
- A note with no outbound links, or a path not in the index, returns an empty array (count 0), not an error.

Returns: JSON with path (the queried note), outgoing_links (array of { path, title, exists, kind, bytes }, sorted by target path), and count. kind is "note" or "asset". bytes is the on-disk file size (null for broken links and assets).`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Exact vault-relative path including .md extension (e.g. "Projects/vault-cortex.md"). Case-sensitive.',
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
        tool: TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        async () => search.getOutgoingLinks({ path }, reqLogger),
        (outgoingLinks) => {
          reqLogger.info("tool_result", { resultCount: outgoingLinks.length })
          return JSON.stringify({
            path,
            outgoing_links: outgoingLinks,
            count: outgoingLinks.length,
          })
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_FIND_ORPHANS,
    {
      title: "Find Orphans",
      description: `Find notes with no incoming links from other notes — orphans are disconnected from the knowledge graph and may be forgotten or need linking. A note that only links to itself still counts as an orphan (self-links are ignored).

Example: vault_find_orphans({ exclude_folders: ${JSON.stringify(config.orphanExcludeFolders)} })

When to use: Vault maintenance — surfacing notes to integrate into the graph. Link an orphan by mentioning it from a relevant note with vault_patch_note.
Prefer vault_get_backlinks to check the connectivity of one specific note rather than scanning the whole vault.

Parameters:
- exclude_folders replaces the defaults (${JSON.stringify(config.orphanExcludeFolders)}), it does not add to them — include the defaults yourself to keep them. Matched by folder prefix, recursing into subfolders ("Projects" also excludes "Projects/Archive").
- limit (default 50) caps results after sorting by most-recently-modified.

Errors:
- An empty array means no orphans were found (after exclusions), not an error.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted by most recently modified. bytes is the on-disk file size.`,
      inputSchema: {
        exclude_folders: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `Folders to exclude — replaces the defaults (${JSON.stringify(config.orphanExcludeFolders)}), not merged`,
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
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )
}
