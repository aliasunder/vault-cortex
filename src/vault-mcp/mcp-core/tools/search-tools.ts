/** Search tool registrations — hybrid (FTS + vector), tag, property, folder, and graph queries. */

import { z } from "zod"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { readDailyNotesConfig } from "../../vault-operations/daily-notes.js"
import { safeHandler, formatNoteMetadata, dateFilterSchema } from "./tool-helpers.js"

export const registerSearchTools = ({
  registerTool,
  whenToolEnabledText,
  search,
  vaultPath,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  registerTool(
    TOOL_NAMES.VAULT_SEARCH,
    {
      title: "Search Notes",
      description: config.embeddingEnabled
        ? `Hybrid search across all vault notes, ranked by combined keyword and semantic relevance using Reciprocal Rank Fusion (RRF) — combining FTS5 keyword matching with vector similarity. Results are refined by a cross-encoder reranker using position-aware score blending when available. Semantic matching finds notes even when exact keywords differ — "career aspirations" finds notes about "goals" and "targets". Falls back to keyword-only (FTS5 BM25) transparently while embeddings are being built. Combine a text query with structured filters to narrow results by metadata — the "narrow by metadata, search by text" pattern. Unquoted terms use implicit AND with porter stemming; wrap in double quotes for exact phrases; punctuated terms (vault-cortex, deploy/local) are matched as exact adjacent-word phrases automatically.

Filters — all conditions AND-combine with each other and the text query:
- folder: a whole folder, subfolders included — "Projects" covers "Projects/Archive" but not "ProjectsOld/"; ignores ASCII letter case
- properties: arbitrary frontmatter key-value pairs, supports string/number/boolean (e.g. { status: "active" }). Values compare by exact type — pass a number as a number, not "4". Exception: checkbox values are stored as 1 and 0, so pass true to match 1 and false to match 0. A list property matches when any element equals the value.
- created / modified: bounds compare whole calendar days, server-local, so on matches anywhere within the day. Notes without a parseable created property never match a created filter

Example: vault_search({ query: "kubernetes networking", filters: { tags: ["reference"] } })
Example: vault_search({ query: "meeting notes", filters: { type: "meeting", folder: "Work" } })
Example: vault_search({ query: "decision", filters: { modified: { after: "2026-06-30" } } }) — matching notes touched in July or later
Example: vault_search({ query: "how the server watches for file changes" }) — semantic: finds notes about chokidar and file watchers even without those exact terms

When to use: The primary discovery tool for content-based queries, optionally constrained by metadata. Semantic matching bridges vocabulary gaps — try natural-language queries, not just keywords.
Prefer vault_search_by_tag for tag-only queries without text. Prefer vault_search_by_folder for browsing a folder. Prefer vault_search_by_property for metadata-only queries. Prefer vault_recent_notes for time-based browsing.

Errors:
- No matches returns { results: [], total: 0 }, not an error
- Malformed query syntax is sanitized automatically — the tool never throws a query syntax error
- A malformed or calendar-invalid created/modified date filter throws with remediation text ("Use YYYY-MM-DD")

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, kind, extension, created, modified, bytes), total (results returned, not all matches), search_mode ("hybrid" or "fts"), and reranked (boolean — true when cross-encoder reranking refined the ordering). search_mode indicates which ranking was used — "hybrid" when vector embeddings contributed, "fts" when only keyword matching was available. score reflects combined relevance (higher = more relevant). kind is "note" for markdown notes or "file" for non-markdown content (canvas, PDF, and text files — .txt, .csv, .json, .xml, .svg, .log, .yaml, .yml, .base); file results also carry extension (e.g. ".canvas", ".pdf", ".txt"). created is omitted when null. bytes is the on-disk file size. With include_leading_callout, each result also carries leading_callout ({ type, title, body }) when present.`
        : `Full-text search across all vault notes, ranked by relevance. Combine a text query with structured filters to narrow results by metadata — the "narrow by metadata, search by text" pattern. Unquoted terms use implicit AND with porter stemming; wrap in double quotes for exact phrases; punctuated terms (vault-cortex, deploy/local) are matched as exact adjacent-word phrases automatically.

Filters — all conditions AND-combine with each other and the text query:
- folder: a whole folder, subfolders included — "Projects" covers "Projects/Archive" but not "ProjectsOld/"; ignores ASCII letter case
- properties: arbitrary frontmatter key-value pairs, supports string/number/boolean (e.g. { status: "active" }). Values compare by exact type — pass a number as a number, not "4". Exception: checkbox values are stored as 1 and 0, so pass true to match 1 and false to match 0. A list property matches when any element equals the value.
- created / modified: bounds compare whole calendar days, server-local, so on matches anywhere within the day. Notes without a parseable created property never match a created filter

Example: vault_search({ query: "kubernetes networking", filters: { tags: ["reference"] } })
Example: vault_search({ query: "meeting notes", filters: { type: "meeting", folder: "Work" } })
Example: vault_search({ query: "decision", filters: { modified: { after: "2026-06-30" } } }) — matching notes touched in July or later
Example: vault_search({ query: "deployment", filters: { properties: { status: "active" } } })

When to use: The primary discovery tool for content-based queries, optionally constrained by metadata.
Prefer vault_search_by_tag for tag-only queries without text. Prefer vault_search_by_folder for browsing a folder. Prefer vault_search_by_property for metadata-only queries. Prefer vault_recent_notes for time-based browsing.

Errors:
- No matches returns { results: [], total: 0 }, not an error
- Malformed query syntax is sanitized automatically — the tool never throws a query syntax error
- A malformed or calendar-invalid created/modified date filter throws with remediation text ("Use YYYY-MM-DD")

Returns: JSON with results array (path, title, snippet, score, tags, folder, type, kind, extension, created, modified, bytes), total (results returned, not all matches), search_mode ("fts" — keyword-only ranking), and reranked (always false in keyword-only mode). kind is "note" for markdown notes or "file" for non-markdown content (canvas, PDF, and text files — .txt, .csv, .json, .xml, .svg, .log, .yaml, .yml, .base); file results also carry extension (e.g. ".canvas", ".pdf", ".txt"). created is omitted when null. bytes is the on-disk file size. With include_leading_callout, each result also carries leading_callout ({ type, title, body }) when present.`,
      inputSchema: {
        query: z.string().min(1).describe("Search query text"),
        filters: z
          .object({
            folder: z.string().min(1).optional().describe('Restrict to a folder (e.g. "Projects")'),
            tags: z
              .array(z.string().min(1))
              .optional()
              .describe("Require all listed tags (AND — every tag must be present)"),
            related: z
              .array(z.string().min(1))
              .optional()
              .describe("Require all listed related links"),
            type: z
              .string()
              .min(1)
              .optional()
              .describe('Match the frontmatter type field (exact match, e.g. "person", "meeting")'),
            properties: z
              .record(z.string().min(1), z.union([z.string().min(1), z.number(), z.boolean()]))
              .optional()
              .describe(
                'Match arbitrary frontmatter properties by key-value (e.g. { status: "active", priority: 1 })',
              ),
            created: dateFilterSchema.describe(
              'Created date bounds (YYYY-MM-DD) on the frontmatter "created" property',
            ),
            modified: dateFilterSchema.describe(
              "Modified date bounds (YYYY-MM-DD) on filesystem modified time, server-local day boundaries",
            ),
          })
          .optional()
          .describe("Optional structured filters"),
        limit: z.number().int().min(1).optional().default(20).describe("Max results (default 20)"),
        snippet_tokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(30)
          .describe("Snippet length in words (default 30)"),
        include_leading_callout: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, include each result's leading callout. Off by default to keep results lean.",
          ),
      },
    },
    async ({ query, filters, limit, snippet_tokens, include_leading_callout }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_SEARCH,
      })
      reqLogger.info("tool_call", {
        query,
        filters,
        limit,
        snippet_tokens,
        include_leading_callout,
      })
      return safeHandler(
        reqLogger,
        async () => {
          return search.hybridSearch(
            { query, filters, limit, snippet_tokens, include_leading_callout },
            reqLogger,
          )
        },
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

  registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_TAG,
    {
      title: "Search by Tag",
      description: `Find notes with a specific tag. By default uses hierarchical prefix matching — a parent tag matches all children (e.g. "project" matches "project/vault-cortex", "project/blog"). Set exact=true for exact match only.

Example: vault_search_by_tag({ tag: "project" })

When to use: Tag-only lookups, for one tag or a whole tag hierarchy, with no text query.
Prefer vault_search when you also need text-based relevance ranking. Use vault_list_tags first to discover available tags.

Parameters:
- tag + exact interact: the prefix match follows the "/" separator, so "project" matches itself and its children but does NOT match "my-project" or "projects". exact=true matches only the literal tag, excluding children.

Errors:
- An unknown tag or no matches returns an empty array, not an error — don't use as an existence check.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties?), sorted by most recently modified and capped at 20, with no truncation signal: exactly 20 results may mean more exist. bytes is the on-disk file size. Promoted keys are in top-level fields; additional_properties contains only unpromoted keys.`,
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
          .default(false)
          .describe("Exact match only (default: false, prefix match)"),
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

  registerTool(
    TOOL_NAMES.VAULT_LIST_TAGS,
    {
      title: "List Tags",
      description: `List all tags in the vault with note counts, ordered by count descending. Only frontmatter tags are counted (inline #tags in note bodies are not indexed). Each hierarchical tag (e.g. "project/vault-cortex") appears as one full entry, not split into segments. Count is unique notes, not occurrences.

Example: vault_list_tags() returns [{ tag: "session-log", count: 42 }, { tag: "project/vault-cortex", count: 8 }, ...]

When to use: Discovering what tags exist before searching by tag. Good first step for vault orientation.
Prefer vault_search_by_tag once you know which tag to query — it supports hierarchical prefix matching ("project" matches "project/*").

Errors:
- A vault with no tagged notes returns an empty array, not an error.

Returns: JSON array of { tag, count }; tag omits the "#" prefix.`,
      inputSchema: {},
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

  registerTool(
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
          .default("modified")
          .describe('Sort order (default "modified")'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(20)
          .describe("Max results (default 20, no upper cap)"),
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

  registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
    {
      title: "Search by Folder",
      description: `Browse notes in a folder with full metadata (tags, type, related, created, modified) — unlike vault_list_notes, which returns paths only.

Example: vault_search_by_folder({ folder: "Projects" })${config.memoryEnabled ? ` or vault_search_by_folder({ folder: "${config.memoryDir}", recursive: false })` : ""}

When to use: Exploring a folder's contents with full context for vault orientation.
Prefer vault_list_notes when you only need paths. Prefer vault_search when you have a text query. Use vault_get_backlinks or vault_get_outgoing_links to explore how notes in a folder connect to the rest of the vault.

Parameters:
- folder names a whole folder, not a text prefix: "Projects" matches notes under "Projects/" but not "ProjectsOld/". Matching ignores ASCII letter case, and a trailing slash is ignored.
- limit applies after sorting, so you get the most recently modified notes. Nothing in the response signals truncation: exactly limit results may mean more exist, so raise limit to check.

Behavior: Reads the search index, which picks up a file change within a few seconds, so a note written moments ago may not appear yet. Notes in hidden (dot-prefixed) folders are never indexed, so never appear.

Errors:
- An empty or nonexistent folder returns an empty array, not an error.

Returns: JSON array of note metadata sorted by most recently modified, then by path: path, title, tags, related, folder, type, created (frontmatter; null when missing), modified (file time), bytes (on-disk size), plus, when present, leading_callout (the note's opening callout, { type, title, body }) and additional_properties (other frontmatter keys).`,
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
          .default(true)
          .describe("Include subfolders (default: true); false lists only the folder's top level"),
        limit: z.number().int().min(1).optional().default(20).describe("Max results (default 20)"),
      },
    },
    async ({ folder, recursive, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
      })
      reqLogger.info("tool_call", { folder, recursive, limit })
      return safeHandler(
        reqLogger,
        async () => search.searchByFolder({ folder, recursive, limit }, reqLogger),
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
    {
      title: "List Property Keys",
      description: `Discover all property keys in the vault with note counts and sample values. Lets you understand the vault's metadata schema without reading individual notes.

Example: vault_list_property_keys() returns [{ key: "tags", count: 342, sample_values: ["session-log", "project"] }, ...]

When to use: Discovering what properties exist before searching by property. Good first step for vault orientation alongside vault_list_tags.
Prefer vault_list_property_values when you need the full list of values for a specific key. Prefer vault_search_by_property to find notes matching a specific key-value pair.

Parameters:
- folder names a whole folder and includes its subfolders: "Projects" covers "Projects/Archive" but not "ProjectsOld/". Matching ignores ASCII letter case; omit folder to scan the entire vault.

Behavior:
- Only frontmatter properties count; inline Dataview fields (key:: value) are not listed.
- count is the number of notes that have the key, including notes where its value is empty (null).
- sample_values are the key's 3 most frequent displayed strings. Values with the same string are grouped before choosing samples, counting each array element separately; ties use binary text order.
- Checkbox values appear as "1" and "0"; null values are skipped.

Errors:
- An empty vault or folder returns an empty array, not an error.

Returns: JSON array of { key, count, sample_values } sorted by count descending, then by key.`,
      inputSchema: {
        folder: z.string().min(1).optional().describe('Restrict to a folder (e.g. "Projects")'),
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

  registerTool(
    TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
    {
      title: "List Property Values",
      description: `List distinct values for a specific property key with how often each occurs.

Example: vault_list_property_values({ key: "status" }) returns [{ value: "done", count: 211 }, { value: "active", count: 47 }, ...]

When to use: Enumerating possible values for a property key before calling vault_search_by_property. Call vault_list_property_keys first to discover valid key names.

Parameters:
- key is case-sensitive and must match exactly as returned by vault_list_property_keys.
- folder names a whole folder and includes its subfolders: "Projects" covers "Projects/Archive" but not "ProjectsOld/". Matching ignores ASCII letter case.
- limit applies after sorting by count descending, so you always get the most-used values first. Nothing in the response signals truncation: exactly limit values may mean more exist, which is common for keys with many distinct values like "title" or "created"; raise limit to check.

Behavior:
- Handles both scalar properties (status: "active") and array properties (tags: ["a", "b"]). Array elements are unpacked and counted individually, so the sum of counts may exceed the note count.
- Values with the same displayed string share one row with combined occurrence counts: number 1 and text "1" count together, while text "1.0" stays separate. Grouping happens before limit.
- Checkbox values are stored as 1 and 0, so true and false come back as "1" and "0", counted with the numbers 1 and 0.${whenToolEnabledText("vault_search_by_property", `\n- vault_search_by_property matches stored numbers numerically and text exactly; value "1" matches the number 1, the text "1", and a checked checkbox.`)}
- null values are skipped.

Errors:
- An unknown key or empty folder returns an empty array, not an error.

Returns: JSON array of { value, count } sorted by count descending, then by value in binary text order ("10" before "2").`,
      inputSchema: {
        key: z
          .string()
          .min(1)
          .describe(
            'Property key name — use vault_list_property_keys to discover valid keys (e.g. "status", "type", "tags").',
          ),
        folder: z.string().min(1).optional().describe('Restrict to a folder (e.g. "Projects")'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe("Max values to return (default 50)."),
      },
    },
    async ({ key, folder, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
      })
      reqLogger.info("tool_call", { key, folder, limit })
      return safeHandler(
        reqLogger,
        async () => search.listPropertyValues({ key, folder, limit }, reqLogger),
        (values) => {
          reqLogger.info("tool_result", { resultCount: values.length })
          return JSON.stringify(values)
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
    {
      title: "Search by Property",
      description: `Find notes where a frontmatter property matches a value — metadata-only search, no text query needed. Handles both scalar properties (status: "active") and array properties (tags, related): for arrays, matches if any element equals the value (contains check, not exact array match).

Example: vault_search_by_property({ key: "status", value: "in-progress" })
Example: vault_search_by_property({ key: "type", value: "session-log", folder: "Code Projects" })

When to use: Finding notes by metadata when you don't have a text query.
Prefer vault_search when you also have a text query (it supports property filters too). Prefer vault_search_by_tag for tag-specific queries (supports hierarchical prefix matching). Use vault_list_property_keys to discover valid keys and vault_list_property_values to see what values a key takes.

Parameters:
- key is exact and case-sensitive. Text values match exactly and case-sensitively, with no partial matching or globbing. Stored numbers also match numerically: "04" and "4.0" match number 4 and their own literal text, but not text "4".
- Numeric matching accepts complete finite YAML core numeric forms: signed decimals, leading-zero decimals, .5, 4., exponents, 0x hexadecimal and 0o octal. Whitespace, final line breaks, prefixes like "4abc", comments, expressions, 0b binary, separators, non-finite values and overflow match only literal text.
- Numeric equality uses stored number precision: large integers can round to the same value, and underflow such as "1e-999" matches stored zero.
- Pass a checkbox as "1" or "0" (true is stored as 1, false as 0); "1.0" does not match a checked checkbox.
- An array element must equal value in full: "blog" matches tags: ["blog", "draft"] but not tags: ["my-blog"].
- folder names a whole folder and includes its subfolders: "Projects" covers "Projects/Archive" but not "ProjectsOld/". Matching ignores ASCII letter case; omit folder to search the entire vault.
- limit applies after sorting. Nothing in the response signals truncation: exactly limit results may mean more exist, so raise limit to check.

Errors:
- An unknown key or unmatched value returns an empty array, not an error.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties), sorted by filesystem mtime descending — recently-synced notes may sort ahead of older content edits.
- leading_callout appears only when the note has a leading callout.
- additional_properties appears only when frontmatter has keys outside title, tags, type, created, and related.`,
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
            'Value to match (e.g. "active", "4", "1e-7"). Use vault_list_property_values to discover valid values for a key.',
          ),
        folder: z.string().min(1).optional().describe('Restrict to a folder (e.g. "Projects")'),
        limit: z.number().int().min(1).optional().default(20).describe("Max results (default 20)"),
      },
    },
    async ({ key, value, folder, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
      })
      reqLogger.info("tool_call", { key, value, folder, limit })
      return safeHandler(
        reqLogger,
        async () => search.searchByProperty({ key, value, folder, limit }, reqLogger),
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_GET_BACKLINKS,
    {
      title: "Get Backlinks",
      description: `Find all notes and files that link to a given note or canvas — captures [[wikilinks]], [markdown](links), ![[embeds]], wikilinks inside frontmatter properties (e.g. related:), and canvas file-node references. Heading anchors ([[note#heading]]) and aliases ([[note|alias]]) resolve as backlinks to the base note. Links inside code blocks are ignored; a note linking to itself appears in its own backlinks.

Example: vault_get_backlinks({ path: "Projects/vault-cortex.md" })
Example: vault_get_backlinks({ path: "Diagrams/architecture.canvas" })

When to use: Understanding what references a note or canvas, assessing its connectivity before editing or deleting, or finding related notes via the graph.
For outgoing links (what a note links TO), use vault_get_outgoing_links. To find notes with no backlinks at all, use vault_find_orphans.

Parameters:
- path: exact vault-relative path including .md or .canvas extension, case-sensitive.

Returns: JSON with path (the queried note or canvas), backlinks (array of { path, title, bytes } sorted by title), and count. Backlink sources may be notes (.md) or canvas files (.canvas).

Errors: Rejects paths that don't end in .md or .canvas. A non-indexed path returns an empty result (count 0), not an error — use vault_list_notes or vault_search to discover valid paths.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Exact vault-relative path including .md or .canvas extension (e.g. "Projects/vault-cortex.md"). Case-sensitive.',
          ),
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

  const fileReadableClause = whenToolEnabledText("vault_read_file", " readable via vault_read_file")
  const fileBytesClause = whenToolEnabledText(
    "vault_read_file",
    " — not the delivery cost: vault_read_file downscales images to fit response limits, so a large image is still cheap to read",
  )
  registerTool(
    TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
    {
      title: "Get Outgoing Links",
      description: `Find all notes and files a given note or canvas links to. For notes: outgoing [[wikilinks]] and [markdown](links). For canvas files: file-node references (vault-relative paths embedded in the canvas). Links inside code blocks are ignored; self-links are included.

Example: vault_get_outgoing_links({ path: "Projects/vault-cortex.md" })
Example: vault_get_outgoing_links({ path: "Diagrams/architecture.canvas" })

When to use: Navigating the graph forward, auditing broken links in one note or canvas, or checking dependencies before editing.
For incoming links (what links TO a note), use vault_get_backlinks.

Parameters:
- path: exact vault-relative path including .md or .canvas extension, case-sensitive. Matched against the search index, so the note or canvas must be indexed (file watcher processes new/moved files within seconds).

Returns: JSON with path, outgoing_links (array of { path, title, exists, kind, bytes, daily_note_forward_ref } sorted by target path), and count. Each link carries exists (boolean) and kind ("note"|"file"). When exists is true: kind "note" is a markdown note${whenToolEnabledText("vault_read_note", " readable via vault_read_note")}; kind "file" is a non-markdown file (.canvas, image, PDF)${fileReadableClause}. When exists is false the link is broken (kind is always "note"). daily_note_forward_ref is true on broken links into the vault's daily notes folder — expected "create on click" navigation to a daily note that doesn't exist yet, not genuine breakage. bytes is the on-disk size of a note or file (null for broken links)${fileBytesClause}.

Errors:
- "path must end in …" — add the .md or .canvas extension
- A path not in the index returns an empty result (count 0), not an error — indistinguishable from a note with no outbound links.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Exact vault-relative path including .md or .canvas extension (e.g. "Projects/vault-cortex.md"). Case-sensitive.',
          ),
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
        async () => {
          const dailyNotesConfig = await readDailyNotesConfig(
            {
              vaultPath,
              envSettings: { folder: config.dailyNotesFolder, format: config.dailyNotesFormat },
            },
            reqLogger,
          )
          return search.getOutgoingLinks(
            { path, dailyNotesFolder: dailyNotesConfig.folder },
            reqLogger,
          )
        },
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

  registerTool(
    TOOL_NAMES.VAULT_FIND_ORPHANS,
    {
      title: "Find Orphans",
      description: `Find notes with no incoming links from other notes — orphans are disconnected from the knowledge graph and may be forgotten or need linking. A note that only links to itself still counts as an orphan (self-links are ignored).

Example: vault_find_orphans({ exclude_folders: ${JSON.stringify(config.orphanExcludeFolders)} })

When to use: Vault maintenance — surfacing notes to integrate into the graph.${whenToolEnabledText("vault_patch_note", " Link an orphan by mentioning it from a relevant note with vault_patch_note.")}
Prefer vault_get_backlinks to check the connectivity of one specific note rather than scanning the whole vault.

Parameters:
- exclude_folders replaces the defaults, it does not add to them — include the defaults yourself to keep them. Each entry names a whole folder, subfolders included ("Projects" also excludes "Projects/Archive" but not "ProjectsOld/"), ignoring ASCII letter case.
- limit (default 50) applies after sorting by most recently modified. Nothing in the response signals truncation: exactly limit results may mean more exist, so raise limit to check.

Errors:
- An empty array means no orphans were found (after exclusions), not an error.

Returns: JSON array of note metadata (path, title, tags, related, folder, type, created, modified, bytes, leading_callout?, additional_properties?), sorted by most recently modified. bytes is the on-disk file size.`,
      inputSchema: {
        exclude_folders: z
          .array(z.string().min(1))
          .optional()
          .describe(`Folders to exclude (default ${JSON.stringify(config.orphanExcludeFolders)})`),
        limit: z.number().int().min(1).optional().default(50).describe("Max results (default 50)"),
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
        async () => {
          return search.findOrphans(
            {
              excludeFolders: exclude_folders ?? [...config.orphanExcludeFolders],
              limit,
            },
            reqLogger,
          )
        },
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )
}
