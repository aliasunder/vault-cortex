/** Search tool registrations — hybrid (FTS + vector), tag, property, folder, task, and graph queries. */

import { z } from "zod"
import type { TaskEntry } from "../../search/search-index.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler, formatNoteMetadata } from "./tool-helpers.js"

const TOOL_NAMES = {
  VAULT_SEARCH: "vault_search",
  VAULT_SEARCH_BY_TAG: "vault_search_by_tag",
  VAULT_LIST_TAGS: "vault_list_tags",
  VAULT_RECENT_NOTES: "vault_recent_notes",
  VAULT_SEARCH_BY_FOLDER: "vault_search_by_folder",
  VAULT_LIST_TASKS: "vault_list_tasks",
  VAULT_LIST_PROPERTY_KEYS: "vault_list_property_keys",
  VAULT_LIST_PROPERTY_VALUES: "vault_list_property_values",
  VAULT_SEARCH_BY_PROPERTY: "vault_search_by_property",
  VAULT_GET_BACKLINKS: "vault_get_backlinks",
  VAULT_GET_OUTGOING_LINKS: "vault_get_outgoing_links",
  VAULT_FIND_ORPHANS: "vault_find_orphans",
} as const

export { TOOL_NAMES as SEARCH_TOOL_NAMES }

/** Drops null fields and empty arrays from a task entry so responses stay
 *  lean — most tasks carry only a few of the optional metadata fields, and
 *  a few hundred open tasks × 20 mostly-null fields is pure token waste. */
const formatTaskEntry = (entry: TaskEntry): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) =>
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0),
    ),
  )

/** Shared schema for one task date filter ({ before, on, after }). */
const taskDateFilterSchema = z
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
      description: config.embeddingEnabled
        ? `Hybrid search across all vault notes, ranked by combined keyword and semantic relevance using Reciprocal Rank Fusion (RRF) — combining FTS5 keyword matching with vector similarity. Results are refined by a cross-encoder reranker using position-aware score blending when available. Semantic matching finds notes even when exact keywords differ — "career aspirations" finds notes about "goals" and "targets". Falls back to keyword-only (FTS5 BM25) transparently while embeddings are being built. Combine a text query with structured filters to narrow results by metadata — the "narrow by metadata, search by text" pattern. Unquoted terms use implicit AND with porter stemming; wrap in double quotes for exact phrases; punctuated terms (vault-cortex, deploy/local) are matched as exact adjacent-word phrases automatically.

Filters — all conditions AND-combine with each other and the text query:
- folder: path prefix (e.g. "Projects")
- tags: require all listed tags (AND)
- type: exact match on frontmatter type (e.g. "person", "session-log")
- related: require all listed related links (AND)
- properties: arbitrary frontmatter key-value pairs, supports string/number/boolean (e.g. { status: "active" })

Example: vault_search({ query: "kubernetes networking", filters: { tags: ["reference"] } })
Example: vault_search({ query: "meeting notes", filters: { type: "meeting", folder: "Work" } })
Example: vault_search({ query: "how the server watches for file changes" }) — semantic: finds notes about chokidar and file watchers even without those exact terms

When to use: The primary discovery tool for content-based queries, optionally constrained by metadata. Semantic matching bridges vocabulary gaps — try natural-language queries, not just keywords.
Prefer vault_search_by_tag for tag-only queries without text. Prefer vault_search_by_folder for browsing a folder. Prefer vault_search_by_property for metadata-only queries. Prefer vault_recent_notes for time-based browsing.

Errors:
- No matches returns { results: [], total: 0 }, not an error
- Malformed query syntax is sanitized automatically — the tool never throws a query syntax error

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, created, modified, bytes), total count, search_mode ("hybrid" or "fts"), and reranked (boolean — true when cross-encoder reranking refined the ordering). search_mode indicates which ranking was used — "hybrid" when vector embeddings contributed, "fts" when only keyword matching was available. score reflects combined relevance (higher = more relevant). created is omitted when null. bytes is the on-disk file size. With filters.include_leading_callout, each result also carries leading_callout ({ type, title, body }) when present.`
        : `Full-text search across all vault notes, ranked by relevance. Combine a text query with structured filters to narrow results by metadata — the "narrow by metadata, search by text" pattern. Unquoted terms use implicit AND with porter stemming; wrap in double quotes for exact phrases; punctuated terms (vault-cortex, deploy/local) are matched as exact adjacent-word phrases automatically.

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

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, created, modified, bytes), total count, search_mode ("fts" — keyword-only ranking), and reranked (always false in keyword-only mode). created is omitted when null. bytes is the on-disk file size. With filters.include_leading_callout, each result also carries leading_callout ({ type, title, body }) when present.`,
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
        async () => search.hybridSearch({ query, filters }, reqLogger),
        (searchResult) => {
          reqLogger.info("tool_result", {
            resultCount: searchResult.results.length,
            searchMode: searchResult.search_mode,
            reranked: searchResult.reranked,
          })
          return JSON.stringify({
            ...searchResult,
            total: searchResult.results.length,
          })
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
- tag is the bare tag name without a leading "#" ("project", not "#project"). Hierarchical tags use "/" separators ("project/vault-cortex").
- tag + exact interact: with exact=false (default), "project" matches "project", "project/vault-cortex", "project/blog" — the match is prefix-based on the "/" separator, so "project" does NOT match "my-project" or "projects". Set exact=true to match only the literal tag, excluding children.

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
      description: `List all tags in the vault with note counts, ordered by count descending. Only frontmatter tags are counted (inline #tags in note bodies are not indexed). Each hierarchical tag (e.g. "project/vault-cortex") appears as one full entry, not split into segments. Count is unique notes, not occurrences. A vault with no tagged notes returns an empty array.

Example: vault_list_tags() returns [{ tag: "session-log", count: 42 }, { tag: "project/vault-cortex", count: 8 }, ...]

When to use: Discovering what tags exist before searching by tag. Good first step for vault orientation.
Prefer vault_search_by_tag once you know which tag to query — it supports hierarchical prefix matching ("project" matches "project/*").

Returns: JSON array of { tag, count } sorted by count descending. tag omits the "#" prefix; count is unique notes with this tag.`,
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
Prefer vault_search for content-based discovery. Prefer vault_search_by_folder for browsing a specific folder.

Parameters:
- sort_by + limit interact: "modified" (default) uses filesystem mtime, so every note has a value and limit works predictably. "created" uses the frontmatter created property — notes without it sort last (not excluded), so a small limit may return only notes that have the property; increase limit or use "modified" for broader coverage.
- "modified" includes any file write (content edits, property changes, sync touches), so recently-synced notes appear recent even without user edits.

Errors:
- An empty vault returns an empty array, not an error.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted descending by chosen timestamp. created is null when the property is missing; bytes is on-disk file size.`,
      inputSchema: {
        sort_by: z
          .enum(["created", "modified"])
          .optional()
          .describe('Sort order (default "modified")'),
        limit: z
          .number()
          .optional()
          .describe("Max results (default 20, no upper cap)"),
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

When to use: Enumerating possible values for a property key before calling vault_search_by_property. Handles both scalar properties (status: "active") and array properties (tags: ["a", "b"]) — array elements are unpacked and counted individually, so the sum of counts may exceed the note count. An unknown key or empty folder returns an empty array, not an error. Call vault_list_property_keys first to discover valid key names.

Parameters:
- key is case-sensitive and must match exactly as returned by vault_list_property_keys. Values are always strings — numeric and boolean properties are stringified for counting.
- folder + key interact: folder restricts counting to a subtree, so the same key can return different value distributions depending on folder scope.
- limit (default 50) applies after sorting by count descending, so you always get the most-used values first. Increase for high-cardinality keys like "title" or "created".

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
      description: `Find notes where a frontmatter property matches a value — metadata-only search, no text query needed. Handles both scalar properties (status: "active") and array properties (tags, related): for arrays, matches if any element equals the value (contains check, not exact array match). Matching is exact and case-sensitive; an unknown key or unmatched value returns an empty array, not an error.

Example: vault_search_by_property({ key: "status", value: "in-progress" })
Example: vault_search_by_property({ key: "type", value: "session-log", folder: "Code Projects" })

When to use: Finding notes by metadata when you don't have a text query.
Prefer vault_search when you also have a text query (it supports property filters too). Prefer vault_search_by_tag for tag-specific queries (supports hierarchical prefix matching). Use vault_list_property_keys to discover valid keys and vault_list_property_values to see what values a key takes.

Parameters:
- key + value are both exact and case-sensitive — no partial matching or globbing. All property values are compared as strings, so numeric or boolean properties must be passed as their string representation.
- For array properties (tags, related), value is tested against each element individually (contains check) — "blog" matches a note with tags: ["blog", "draft"] but not tags: ["my-blog"].
- folder narrows results to a subtree; omit for vault-wide search. Combined with key+value, this lets you check how a property is used within a specific area.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted by filesystem mtime descending — recently-synced notes may sort ahead of older content edits.`,
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
      description: `Find all notes that link to a given note — captures [[wikilinks]], [markdown](links), ![[embeds]], and wikilinks inside frontmatter properties (e.g. related:). Heading anchors ([[note#heading]]) and aliases ([[note|alias]]) resolve as backlinks to the base note. Links inside code blocks are ignored; a note linking to itself appears in its own backlinks.

Example: vault_get_backlinks({ path: "Projects/vault-cortex.md" })

When to use: Understanding what references a note, assessing its connectivity before editing or deleting, or finding related notes via the graph.
For outgoing links (what a note links TO), use vault_get_outgoing_links. To find notes with no backlinks at all, use vault_find_orphans.

Parameters:
- path: exact vault-relative path including .md extension, case-sensitive. A non-indexed path returns an empty result (count 0), not an error — use vault_list_notes or vault_search to discover valid paths.

Returns: JSON with path (the queried note), backlinks (array of { path, title, bytes } sorted by title), and count.`,
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
      description: `Find all notes and assets a given note links to via outgoing [[wikilinks]] or [markdown](links). Links inside code blocks are ignored; self-links are included.

Example: vault_get_outgoing_links({ path: "Projects/vault-cortex.md" })

When to use: Navigating the graph forward, auditing broken links in one note, or checking dependencies before editing.
For incoming links (what links TO a note), use vault_get_backlinks.

Parameters:
- path is matched against the search index, so the note must be indexed (file watcher processes new/moved files within seconds). A path not in the index returns an empty result (count 0), not an error — indistinguishable from a note with no outbound links.

Returns: JSON with path, outgoing_links (array of { path, title, exists, kind, bytes } sorted by target path), and count. Each link carries exists (boolean) and kind ("note"|"asset"): exists+note = readable via vault_read_note; exists+asset = non-markdown file (.canvas, image, PDF); !exists+note = broken link. bytes is null for broken links and assets.`,
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

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_TASKS,
    {
      title: "List Tasks",
      description: `List checkbox tasks across the whole vault with structured filters — the Tasks-plugin data model over MCP. Both task metadata formats are indexed: emoji signifiers (📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled, 🔺⏫🔼🔽⏬ priority, 🔁 recurrence, 🆔/⛔ dependencies) and Dataview inline fields ([due:: 2026-07-04], [priority:: high], ...). Every result carries its full attribution — note path, folder, nearest heading (the lane on a Kanban board), and line number — so no follow-up reads are needed to locate a task. Task lines inside fenced code blocks and %% %% comment blocks are not indexed.

Example: vault_list_tasks({ due: { before: "2026-07-04" } }) — overdue triage; the default status (not_done) and sort (due ascending) make this the "what's overdue?" call
Example: vault_list_tasks({ path: "Code Projects/vault-cortex/TASKS.md", heading: ["Active", "Up Next", "Waiting On"], sort_by: "position" }) — actionable Kanban lanes in board order; position is the natural sort for boards (file path then line number, preserving card arrangement)
Example: vault_list_tasks({ folder: "Code Projects/vault-cortex" }) — all open tasks across a project tree (TASKS.md + task-notes/ subdirectories); folder is a recursive prefix match
Example: vault_list_tasks({ status: "done", done: { after: "2026-06-26" } }) — what got completed this week
Example: vault_list_tasks({ status: ["todo", "in_progress"] }) — explicit equivalent of "not_done"
Example: vault_list_tasks({ priority: ["highest", "high"], sort_by: "priority" }) — most urgent open work first

When to use: Any vault-wide task triage question — "what's overdue?", "what's open per project?", "what did I finish this week?" — in one call instead of per-board reads.
Prefer vault_read_note (heading mode) to read one specific board lane verbatim. Prefer vault_search for full-text queries over note content.

Parameters:
- status: a single value or an array of values, OR-combined (default "not_done"). Values: "not_done" (todo + in_progress, excludes done AND cancelled), "todo", "in_progress", "done", "cancelled", "all". Virtual values expand in arrays: ["not_done", "done"] matches todo + in_progress + done. Checkbox chars map to statuses the way the Tasks plugin maps them: " " todo, "/" in_progress, "x"/"X" done, "-" cancelled, any other char todo.
- due / scheduled / start / done / created / cancelled: date filters, each { before, on, after } in YYYY-MM-DD — before/after are exclusive, on is exact. A date filter only matches tasks that HAVE that date.
- priority: array of "highest" | "high" | "medium" | "low" | "lowest" | "none", OR-combined ("none" = tasks with no priority signifier).
- folder: recursive note-path prefix — includes all notes under the folder and its subdirectories (e.g. "Code Projects/vault-cortex" matches TASKS.md and task-notes/*.md). Use path for a single board file. tag: bare inline-task-tag name; a parent tag matches children ("errand" matches "errand/groceries"). heading: exact heading text or array of headings, case-sensitive, OR-combined (e.g. ["Active", "Up Next"] returns tasks under either heading — useful for querying multiple Kanban lanes at once). path: one note, must end in ".md".
- sort_by: "due" (default) | "scheduled" | "start" | "created" | "done" | "priority" | "note_mtime" | "position". Date sorts put dateless tasks last in both directions and cascade through related dates when the primary is absent — due falls through to scheduled → start → created; scheduled, start, and created cascade similarly through the remaining date fields. Each cascade step uses its own natural direction (due/scheduled ascending, start/created descending), so a task with no due date but a created date sorts newest-first rather than inheriting due's ascending order. An explicit sort_direction overrides all cascade steps uniformly. "done" does not cascade — it sorts by done date alone, with a modified-time tiebreaker for undated tasks. Fully dateless tasks tie-break by note modified time (most recent first), then file position. Priority sorts highest→lowest with unprioritized between medium and low. "position" sorts by file path then line number — the natural order for Kanban boards where card position IS priority.
- limit: max results (default 50). The total field always reports the full match count, so "50 of 338" is distinguishable from "all 50".

Errors:
- A malformed or calendar-invalid date filter throws with remediation text ("Use YYYY-MM-DD")
- path without the ".md" extension is rejected
- No matches returns { total: 0, tasks: [] }, not an error — don't use as an existence check

Returns: JSON { total, tasks }. Each task carries: path, line (1-based file line number), status, status_char (raw checkbox character, for custom-status vaults), description (inline #tags kept in the text), folder (the note's full parent folder), heading (nearest heading above the task — on a Kanban board this is the lane name, null-omitted above the first heading), plus whichever metadata the task has: created/scheduled/start/due/done/cancelled dates, priority, recurrence (rule text — parsed, never executed), on_completion, task_id, depends_on, tags (bare inline tag names), block_id, is_kanban_task (true when the task's parent note has kanban-plugin frontmatter — present only when true, omitted for regular tasks; when true, heading carries the Kanban lane name and completing the task requires a lane move, not just a checkbox toggle). Null fields, false booleans, and empty arrays are omitted to keep responses lean.`,
      inputSchema: {
        status: z
          .union([
            z.enum([
              "not_done",
              "todo",
              "in_progress",
              "done",
              "cancelled",
              "all",
            ]),
            z
              .array(
                z.enum([
                  "not_done",
                  "todo",
                  "in_progress",
                  "done",
                  "cancelled",
                  "all",
                ]),
              )
              .min(1),
          ])
          .optional()
          .describe(
            'Status filter, OR-combined (default "not_done" = todo + in_progress, excluding done and cancelled). Virtual values expand in arrays: "not_done" adds todo + in_progress, "all" includes every status.',
          ),
        due: taskDateFilterSchema.describe("Due date (📅 / [due:: ]) bounds"),
        scheduled: taskDateFilterSchema.describe(
          "Scheduled date (⏳ / [scheduled:: ]) bounds",
        ),
        start: taskDateFilterSchema.describe(
          "Start date (🛫 / [start:: ]) bounds",
        ),
        done: taskDateFilterSchema.describe(
          "Done date (✅ / [completion:: ]) bounds",
        ),
        created: taskDateFilterSchema.describe(
          "Created date (➕ / [created:: ]) bounds",
        ),
        cancelled: taskDateFilterSchema.describe(
          "Cancelled date (❌ / [cancelled:: ]) bounds",
        ),
        priority: z
          .array(z.enum(["highest", "high", "medium", "low", "lowest", "none"]))
          .optional()
          .describe(
            'Priority levels, OR-combined; "none" selects tasks with no priority signifier',
          ),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Restrict to a note-path prefix (e.g. "Code Projects/vault-cortex")',
          ),
        tag: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Inline task tag, bare name without "#"; parent tags match children',
          ),
        heading: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe(
            'Exact heading text or array of headings, OR-combined, case-sensitive (e.g. "Active" or ["Active", "Up Next"])',
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to one note (vault-relative path ending ".md")'),
        limit: z.number().optional().describe("Max results (default 50)"),
        sort_by: z
          .enum([
            "due",
            "scheduled",
            "start",
            "created",
            "done",
            "priority",
            "note_mtime",
            "position",
          ])
          .optional()
          .describe(
            'Sort key (default "due"). Date sorts cascade through related fields when the primary is absent; each fallback uses its own natural direction. "position" sorts by file path then line number — the natural order for Kanban boards.',
          ),
        sort_direction: z
          .enum(["asc", "desc"])
          .optional()
          .describe(
            'Sort direction. Default per field: "asc" for due/scheduled/priority/position, "desc" for start/created/done/note_mtime. Within a date cascade, each fallback uses its own default; an explicit value overrides all fields uniformly.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      {
        status,
        due,
        scheduled,
        start,
        done,
        created,
        cancelled,
        priority,
        folder,
        tag,
        heading,
        path,
        limit,
        sort_by,
        sort_direction,
      },
      extra,
    ) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_LIST_TASKS,
      })
      reqLogger.info("tool_call", {
        status,
        due,
        scheduled,
        start,
        done,
        created,
        cancelled,
        priority,
        folder,
        tag,
        heading,
        path,
        limit,
        sortBy: sort_by,
        sortDirection: sort_direction,
      })
      return safeHandler(
        reqLogger,
        async () =>
          search.listTasks(
            {
              status,
              due,
              scheduled,
              start,
              done,
              created,
              cancelled,
              priority,
              folder,
              tag,
              heading,
              path,
              limit,
              sortBy: sort_by,
              sortDirection: sort_direction,
            },
            reqLogger,
          ),
        (result) => {
          reqLogger.info("tool_result", {
            resultCount: result.tasks.length,
            total: result.total,
          })
          return JSON.stringify({
            total: result.total,
            tasks: result.tasks.map(formatTaskEntry),
          })
        },
      )
    },
  )
}
