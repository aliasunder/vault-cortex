/** Search tool registrations — hybrid (FTS + vector), tag, property, folder, and graph queries. */

import { z } from "zod"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { readEffectiveOrphanExcludeFolders } from "../../vault-operations/vault-folder-config.js"
import { readDailyNotesConfig } from "../../vault-operations/daily-notes.js"
import {
  createStrictInputObject,
  describeNoteMetadataResult,
  formatNoteMetadata,
  dateFilterSchema,
  formatServedSentencesLine,
  INDEX_ENGINE_ERROR_ENTRY,
  INDEX_ERROR_ENTRY,
  INDEX_FOLDER_SCOPE_CLAUSE,
  INDEX_LAG_LEAD,
  LIMIT_TRUNCATION_CLAUSE,
} from "./tool-helpers.js"

/** The link-graph tools accept a canvas as well as a note. */
const LINK_GRAPH_EXTENSION_ERROR_ENTRY = '- "path must end in …" — add the .md or .canvas extension'

export const registerSearchTools = ({
  registerTool,
  safeHandler,
  formatEnabledToolList,
  isToolEnabled,
  whenToolEnabledText,
  search,
  vaultPath,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  // These parts read the same with or without embeddings, so both
  // vault_search description variants share them
  const searchSyntaxText = `Unquoted terms use implicit AND with stemming ("running" also matches "run"); wrap in double quotes for exact phrases; punctuated terms (vault-cortex, deploy/local) are matched as exact adjacent-word phrases.`

  // File-content search applies only the folder filter, so hybrid search
  // drops file results whenever any other filter is set
  const searchFiltersNoteOnlyClause = config.fileToolsEnabled
    ? "; any filter but folder returns notes only"
    : ""
  const searchFiltersSection = `Filters — all conditions AND-combine with each other and the text query${searchFiltersNoteOnlyClause}:
- folder: ${INDEX_FOLDER_SCOPE_CLAUSE}
- tags: every listed tag must match, in the tags property or as a #tag in the body, in any letter case; "project" also matches "project/a"
- type: the type property, matched exactly, letter case included
- related: every listed link must appear in the related property, written as it is there, brackets and alias included
- properties: keys and text values match exactly, letter case included; values compare by exact type — pass a number as a number, not "4". Exception: true and false compare as 1 and 0, so true or 1 matches a checked checkbox and the number 1. A list property matches when any element equals the value.
- created / modified: bounds compare whole calendar days in the server's time zone (returned created and modified values show its UTC offset). A note whose created property is missing or not an ISO date never matches a created filter`

  // Different tools edit the two tag fields, so every description that
  // returns notes says which field is which
  const tagsPropertyEditorClause = whenToolEnabledText(
    "vault_update_properties",
    "; vault_update_properties edits it",
  )
  const bodyTagsEditorClause = whenToolEnabledText(
    "vault_replace_in_note",
    "; vault_replace_in_note edits them",
  )
  const tagsFieldsText = `tags (the tags property${tagsPropertyEditorClause}), body_tags (#tags in the note's text, one per spelling${bodyTagsEditorClause}; absent when none)`

  const searchSharedExamples = `Example: vault_search({ query: "kubernetes networking", filters: { tags: ["reference"] } })
Example: vault_search({ query: "meeting notes", filters: { type: "meeting", folder: "Work" } })
Example: vault_search({ query: "decision", filters: { modified: { after: "2026-06-30" } } }) — matching notes touched in July or later`

  const searchAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_search_by_tag",
      "Prefer vault_search_by_tag for tag-only queries without text.",
    ),
    whenToolEnabledText(
      "vault_search_by_folder",
      "Prefer vault_search_by_folder for browsing a folder.",
    ),
    whenToolEnabledText(
      "vault_search_by_property",
      "Prefer vault_search_by_property for metadata-only queries.",
    ),
    whenToolEnabledText("vault_recent_notes", "Prefer vault_recent_notes for time-based browsing."),
  ])

  // File content is searched only while FILE_TOOLS_ENABLED is on, so the text
  // that mentions file results follows that setting, not any one tool
  const searchedContentText = config.fileToolsEnabled
    ? "vault notes and file content (canvas, PDF, and text files)"
    : "vault notes"
  const searchResultFieldsText = config.fileToolsEnabled
    ? `path, title, snippet, score, ${tagsFieldsText}, folder (a note's top-level folder; a file's full parent folder), type, kind, extension, created, modified, bytes`
    : `path, title, snippet, score, ${tagsFieldsText}, folder (top-level folder), type, kind, created, modified, bytes`
  const searchResultKindText = config.fileToolsEnabled
    ? `kind is "note" or, for non-markdown content, "file", which also carries extension (e.g. ".pdf").`
    : `kind is always "note".`
  const searchResultDetailsText = `${searchResultKindText} created is omitted, not null, when a result has none; type is null when the result has no type property; bytes is the on-disk size. With include_leading_callout, each result also carries leading_callout (the opening callout, { type, title, body }) when present.`

  // The vector leg embeds the raw query, so an all-operator query still
  // returns semantic neighbours while embeddings are on — unless the query
  // embedding fails, when only the keyword leg runs and finds nothing
  const emptiedQueryText = config.embeddingEnabled
    ? {
        stage: "keyword matching",
        outcome:
          'a query left with no terms is matched by meaning only, or finds nothing when only keyword matching ran (search_mode "fts")',
      }
    : {
        stage: "matching",
        outcome: "a query left with no terms returns no results",
      }

  // Every search leg keeps at most 100 rows (candidateLimit in hybridSearch). Each kind has a
  // keyword leg, and with embeddings a semantic leg too, so a fused result holds at most 200 of
  // each kind
  const keywordCapExtent = config.fileToolsEnabled ? "100 notes and 100 files" : "100 notes"
  const hybridCapExtent = config.fileToolsEnabled ? "200 notes and 200 files" : "200 notes"
  const resultCapSentence = config.embeddingEnabled
    ? `When only keyword matching ran (search_mode "fts"), at most ${keywordCapExtent} come back; with "hybrid", at most ${hybridCapExtent}.`
    : `At most ${keywordCapExtent} come back.`
  const searchLagLine = `Behavior: ${INDEX_LAG_LEAD}. No matches returns an empty results array with total 0, not an error. ${resultCapSentence}`
  const searchErrorsSection = `Errors:
- Malformed query syntax never throws: the words AND, OR, NOT and NEAR in any letter case, and punctuation such as *, ^, parentheses and colons, are dropped before ${emptiedQueryText.stage}; ${emptiedQueryText.outcome}
- "invalid created.on date: …" or "… is not a calendar date" (any created/modified bound) — pass a real calendar date in YYYY-MM-DD form
- "tag must not be empty …" — a tags entry is only "#"; pass the tag name
${INDEX_ERROR_ENTRY}`

  registerTool(
    TOOL_NAMES.VAULT_SEARCH,
    {
      title: "Search Notes",
      description: config.embeddingEnabled
        ? `Hybrid search across ${searchedContentText}, ranked by combined keyword and semantic relevance. Semantic matching finds notes even when exact keywords differ — "career aspirations" finds notes about "goals" and "targets". ${searchSyntaxText}

${searchFiltersSection}

Example: vault_search({ query: "how the server watches for file changes" })
${searchSharedExamples}

When to use: The primary discovery tool for content-based queries, optionally constrained by metadata.${searchAlternativesLine}

${searchLagLine}

${searchErrorsSection}

Returns: JSON with results array (${searchResultFieldsText}), total (results returned, not all matches), search_mode ("hybrid" when vector embeddings contributed, "fts" when only keyword matching ran), and reranked (true when a second ranking pass reordered the results). A higher score is more relevant. ${searchResultDetailsText}`
        : `Full-text search across ${searchedContentText}, ranked by relevance. ${searchSyntaxText}

${searchFiltersSection}

${searchSharedExamples}
Example: vault_search({ query: "deployment", filters: { properties: { status: "active" } } })

When to use: The primary discovery tool for content-based queries, optionally constrained by metadata.${searchAlternativesLine}

${searchLagLine}

${searchErrorsSection}

Returns: JSON with results array (${searchResultFieldsText}), total (results returned, not all matches), search_mode ("fts" — keyword-only ranking), and reranked (always false in keyword-only mode). A higher score is more relevant. ${searchResultDetailsText}`,
      inputSchema: {
        query: z.string().min(1).describe("Search query text"),
        filters: createStrictInputObject({
          folder: z.string().min(1).optional().describe('Restrict to a folder (e.g. "Projects")'),
          tags: z
            .array(z.string().min(1))
            .optional()
            .describe('Tags, "#" optional (e.g. ["reference"])'),
          related: z
            .array(z.string().min(1))
            .optional()
            .describe('Require all listed related links (e.g. "[[Projects/alpha|Alpha]]")'),
          type: z
            .string()
            .min(1)
            .optional()
            .describe('Match the type property (e.g. "person", "meeting")'),
          properties: z
            .record(z.string().min(1), z.union([z.string().min(1), z.number(), z.boolean()]))
            .optional()
            .describe(
              'Match arbitrary properties by key-value (e.g. { status: "active", priority: 1 })',
            ),
          created: dateFilterSchema.describe(
            'Created date bounds (YYYY-MM-DD) on the "created" property',
          ),
          modified: dateFilterSchema.describe(
            "Modified date bounds (YYYY-MM-DD) on filesystem modified time",
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
          .describe("Snippet length in words, not model tokens (default 30)"),
        include_leading_callout: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, include each result's leading callout."),
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
      description: `Find notes by tag, in the tags property or as a #tag in the body, ignoring letter case. Unless exact is true, a tag also matches every tag nested under it at any depth: "project" matches "project/vault-cortex" and "project/a/b". A nested tag continues with "/", so "project" never matches "projects" or "my-project".

Example: vault_search_by_tag({ tag: "project" })
Example: vault_search_by_tag({ tag: "project", exact: true, limit: 50 }) — notes tagged "project" itself, up to 50

When to use: Tag-only lookups, for one tag or a whole tag hierarchy, with no text query.${whenToolEnabledText("vault_list_tags", " Use vault_list_tags first to discover available tags.")}${whenToolEnabledText("vault_search", "\nPrefer vault_search when you need text-based relevance ranking.")}

Parameters:
- tag: a trailing slash matches nothing ("project/" matches neither "project" nor "project/a"), so pass the tag name without it.
- limit keeps the most recently modified notes; ${LIMIT_TRUNCATION_CLAUSE}.

Behavior: ${INDEX_LAG_LEAD}. An unknown tag or no matches returns an empty array, not an error.

Errors:
- "tag must not be empty …" — tag is "#" alone; pass the tag name.
${INDEX_ERROR_ENTRY}

Returns: ${describeNoteMetadataResult(tagsFieldsText)} Tags keep the note's letter case. Sorted by most recently modified, then by path.`,
      inputSchema: {
        tag: z
          .string()
          .min(1)
          .describe('Tag, "#" optional (e.g. "project", "session-log", "project/vault-cortex")'),
        exact: z
          .boolean()
          .optional()
          .default(false)
          .describe("Match only the tag itself (default: false)"),
        limit: z.number().int().min(1).optional().default(20).describe("Max results (default 20)"),
      },
    },
    async ({ tag, exact, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_SEARCH_BY_TAG,
      })
      reqLogger.info("tool_call", { tag, exact, limit })
      return safeHandler(
        reqLogger,
        async () => search.searchByTag({ tag, exact, limit }, reqLogger),
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )

  const listTagsAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_search_by_tag",
      "Prefer vault_search_by_tag once you know which tag to query.",
    ),
    whenToolEnabledText(
      "vault_list_property_values",
      'To count tags property values in one folder, or only the most-used ones, use vault_list_property_values({ key: "tags" }) with folder or limit; it does not count #tags in note bodies.',
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_LIST_TAGS,
    {
      title: "List Tags",
      description: `List all tags in the vault with note counts, ordered by count descending, then by tag name.

Example: vault_list_tags() returns [{ tag: "session-log", count: 42 }, { tag: "project/vault-cortex", count: 8 }, ...]

When to use: Discovering what tags exist before searching by tag. Good first step for vault orientation.${listTagsAlternativesLine}

Behavior: ${INDEX_LAG_LEAD}. A vault with no tagged notes returns an empty array, not an error.
- Tags in the tags property and #tags written in note bodies both count, and count is unique notes, not occurrences.
- Spellings that differ only in letter case are one tag, shown as the spelling written most often.
- Each hierarchical tag appears as one full entry, not split into segments.

Errors:
${INDEX_ENGINE_ERROR_ENTRY}

Returns: JSON array of { tag, count } holding every tag in the vault; tag omits the "#" prefix.`,
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

  const recentNotesAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_search",
      "Prefer vault_search for content-based discovery, including a text query limited to a date range (its created and modified filters).",
    ),
    whenToolEnabledText(
      "vault_search_by_folder",
      "Prefer vault_search_by_folder for browsing a specific folder.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_RECENT_NOTES,
    {
      title: "Recent Notes",
      description: `List recently modified or created notes, sorted by timestamp — a time-ordered window into the vault, not a date-range filter.

Example: vault_recent_notes({ limit: 10 })
Example: vault_recent_notes({ sort_by: "created", limit: 5 })

When to use: Catching up on vault changes, finding recent work, or orienting after a break.${recentNotesAlternativesLine}

Parameters:
- sort_by "modified" uses filesystem mtime. Any file write counts (content edits, property changes, sync touches), so recently-synced notes appear recent even without user edits.
- sort_by "created" uses the created property; notes where it is missing or not an ISO date sort after every dated note, so a small limit can leave them out — use "modified" to see them.

Behavior: ${INDEX_LAG_LEAD}. An empty vault returns an empty array, not an error.

Errors:
${INDEX_ERROR_ENTRY}

Returns: ${describeNoteMetadataResult(tagsFieldsText)} Newest first by the sort_by timestamp.`,
      inputSchema: {
        sort_by: z
          .enum(["created", "modified"])
          .optional()
          .default("modified")
          .describe('Timestamp to sort by (default "modified")'),
        limit: z.number().int().min(1).optional().default(20).describe("Max results (default 20)"),
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

  const folderLinkTools = formatEnabledToolList([
    TOOL_NAMES.VAULT_GET_BACKLINKS,
    TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
  ])
  const searchByFolderAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText("vault_list_notes", "Prefer vault_list_notes when you only need paths."),
    whenToolEnabledText("vault_search", "Prefer vault_search when you have a text query."),
    folderLinkTools
      ? `Use ${folderLinkTools} to explore how notes in a folder connect to the rest of the vault.`
      : "",
  ])

  registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
    {
      title: "Search by Folder",
      description: `Browse notes in a folder with full metadata.

Example: vault_search_by_folder({ folder: "Projects" })
Example: vault_search_by_folder({ folder: "${config.memoryEnabled ? config.memoryDir : "Projects/Archive"}", recursive: false, limit: 10 }) — the folder's own notes, 10 most recent

When to use: Exploring a folder's contents with full context for vault orientation.${searchByFolderAlternativesLine}

Parameters:
- folder names ${INDEX_FOLDER_SCOPE_CLAUSE}; a trailing slash is ignored. With recursive: false, only the folder's own notes are kept.
- limit keeps the most recently modified notes. There is no offset, and ${LIMIT_TRUNCATION_CLAUSE}.

Behavior: ${INDEX_LAG_LEAD}. An empty or nonexistent folder returns an empty array, not an error. Notes in hidden (dot-prefixed) folders never appear.

Errors:
${INDEX_ERROR_ENTRY}

Returns: ${describeNoteMetadataResult(tagsFieldsText)} Sorted by most recently modified, then by path.`,
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
          .describe("Include subfolders (default: true)"),
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

  const listPropertyKeysAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_list_property_values",
      "Prefer vault_list_property_values when you need the full list of values for a specific key.",
    ),
    whenToolEnabledText(
      "vault_search_by_property",
      "Prefer vault_search_by_property to find notes matching a specific key-value pair.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
    {
      title: "List Property Keys",
      description: `Discover all property keys in the vault with note counts and sample values, without reading individual notes.

Example: vault_list_property_keys() returns [{ key: "tags", count: 342, sample_values: ["session-log", "project"] }, ...]
Example: vault_list_property_keys({ folder: "Projects" }) — the keys used under Projects/ only

When to use: Discovering what properties exist before searching by property. Good first step for vault orientation${whenToolEnabledText("vault_list_tags", " alongside vault_list_tags")}.${listPropertyKeysAlternativesLine}

Parameters:
- folder names ${INDEX_FOLDER_SCOPE_CLAUSE}; omit it to scan the entire vault.

Behavior: ${INDEX_LAG_LEAD}. An empty vault or folder returns an empty array, not an error.
- Only properties count; inline Dataview fields (key:: value) are not listed.
- count is the number of notes that have the key, including notes where its value is empty (null).
- sample_values are the key's 3 most frequent values as text (a number as JavaScript prints it, so 1.0 lists as "1"; a checkbox as "1" or "0"), counting each array element separately; null values are skipped.

Errors:
${INDEX_ENGINE_ERROR_ENTRY}

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
Example: vault_list_property_values({ key: "tags", limit: 10 }) — the 10 most-used tags property values

When to use: Enumerating possible values for a property key${whenToolEnabledText("vault_search_by_property", " before calling vault_search_by_property")}.${whenToolEnabledText("vault_list_property_keys", " Call vault_list_property_keys first to discover valid key names.")}${whenToolEnabledText("vault_search_by_property", ` A value listed here can be passed straight to vault_search_by_property, which matches text exactly and a complete number numerically too, so value "1" finds the number 1, the text "1", and a checked checkbox.`)}

Parameters:
- key is case-sensitive and must match exactly${whenToolEnabledText("vault_list_property_keys", " as returned by vault_list_property_keys")}.
- folder names ${INDEX_FOLDER_SCOPE_CLAUSE}.
- limit keeps the most-used values; ${LIMIT_TRUNCATION_CLAUSE}.

Behavior: ${INDEX_LAG_LEAD}. An unknown key or empty folder returns an empty array, not an error.
- Array elements (tags: ["a", "b"]) are counted individually, so the sum of counts may exceed the note count.
- Each value is listed as text, and values with the same text share one row with combined occurrence counts: number 1 and text "1" count together, while text "1.0" stays separate.
- Checkbox true and false come back as "1" and "0", counted with the numbers 1 and 0.
- null values are skipped.

Errors:
${INDEX_ENGINE_ERROR_ENTRY}

Returns: JSON array of { value, count } sorted by count descending, then by value in binary text order ("10" before "2").`,
      inputSchema: {
        key: z.string().min(1).describe('Property key name (e.g. "status", "type", "tags").'),
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

  // The two discovery tools share one "Use … and …" sentence, so each clause
  // joins it only while its tool is served.
  const propertyDiscoveryTools = [
    whenToolEnabledText(
      "vault_list_property_keys",
      "vault_list_property_keys to discover valid keys",
    ),
    whenToolEnabledText(
      "vault_list_property_values",
      "vault_list_property_values to see what values a key takes",
    ),
  ]
    .filter(Boolean)
    .join(" and ")
  const propertyDiscoverySentence = propertyDiscoveryTools ? `Use ${propertyDiscoveryTools}.` : ""

  const searchByPropertyAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_search",
      "Prefer vault_search when you also have a text query (it supports property filters too).",
    ),
    whenToolEnabledText(
      "vault_search_by_tag",
      'Prefer vault_search_by_tag for tag-specific queries (it matches nested tags and #tags in note bodies; key "tags" here matches only the tags property).',
    ),
    propertyDiscoverySentence,
  ])

  registerTool(
    TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
    {
      title: "Search by Property",
      description: `Find notes where a property matches a value.

Example: vault_search_by_property({ key: "status", value: "in-progress" })
Example: vault_search_by_property({ key: "type", value: "session-log", folder: "Code Projects" })

When to use: Finding notes by metadata when you don't have a text query.${searchByPropertyAlternativesLine}

Parameters:
- key and value both match exactly and case-sensitively, with no partial matching or globbing; value matches a stored text value as written.
- A value written as a complete, finite YAML 1.2 core number (-4, 04, .5, 4., 1e3, 0x1F, 0o17) also matches stored numbers numerically: "04" and "4.0" match number 4 and their own literal text, but not text "4". Anything else ("4abc", " 4", 0b binary) matches only as text.
- A checkbox matches only as text: pass "1" (checked) or "0" (unchecked); "1.0" and "true" do not match.
- A list property matches when an element equals value in full: "blog" matches tags: ["blog", "draft"] but not tags: ["my-blog"].
- folder names ${INDEX_FOLDER_SCOPE_CLAUSE}; omit it to search the entire vault.
- limit keeps the most recently modified matches; ${LIMIT_TRUNCATION_CLAUSE}.

Behavior: ${INDEX_LAG_LEAD}. An unknown key or unmatched value returns an empty array, not an error.

Errors:
${INDEX_ERROR_ENTRY}

Returns: ${describeNoteMetadataResult(tagsFieldsText)} Sorted by most recently modified (any file write, so a recently-synced note can sort ahead of an older edit), then by path.`,
      inputSchema: {
        key: z.string().min(1).describe('Property key name (e.g. "status", "type", "tags").'),
        value: z.string().min(1).describe('Value to match (e.g. "active", "4", "1e-7").'),
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

  // Both link tools return an empty result for a path the index does not hold.
  // Every path-finding tool can be dropped via DISABLED_TOOLS, so the remedy
  // falls back to checking the path itself when none is served.
  const linkPathFinders = formatEnabledToolList([
    TOOL_NAMES.VAULT_SEARCH,
    TOOL_NAMES.VAULT_LIST_NOTES,
    TOOL_NAMES.VAULT_LIST_FILES,
  ])
  const linkEmptyResultRemedy = linkPathFinders
    ? `find valid paths with ${linkPathFinders}`
    : "check the path's spelling and letter case"

  const backlinksAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_get_outgoing_links",
      "For outgoing links (what a note links TO), use vault_get_outgoing_links.",
    ),
    whenToolEnabledText(
      "vault_find_orphans",
      "To find notes nothing else links to, use vault_find_orphans.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_GET_BACKLINKS,
    {
      title: "Get Backlinks",
      description: `Find all notes and canvases that link to a given note or canvas — captures [[wikilinks]], [markdown](links), ![[embeds]], wikilinks inside properties (e.g. related:), and canvas cards that embed the file. Heading anchors ([[note#heading]]) and aliases ([[note|alias]]) resolve as backlinks to the base note. Links inside code blocks are ignored; a note linking to itself appears in its own backlinks.

Example: vault_get_backlinks({ path: "Projects/vault-cortex.md" })
Example: vault_get_backlinks({ path: "Diagrams/architecture.canvas" })

When to use: Understanding what references a note or canvas, assessing its connectivity before editing or deleting, or finding related notes via the graph.${backlinksAlternativesLine}

Parameters:
- path: pass the target's own path, never a link's text: a link written as [[Note]], as a relative ../Note.md, or as a full path counts toward the note it resolves to.

Behavior: ${INDEX_LAG_LEAD}. A path nothing links to returns an empty result (count 0), not an error; if you expected links, ${linkEmptyResultRemedy}.

Returns: JSON with path (the queried note or canvas), backlinks (every linking note and canvas, as { path, title, bytes } sorted by title; bytes is the source's on-disk size), and count.

Errors:
${LINK_GRAPH_EXTENSION_ERROR_ENTRY}
${INDEX_ENGINE_ERROR_ENTRY}`,
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
    ", not the delivery cost: vault_read_file downscales a large image to fit response limits",
  )
  const outgoingLinksAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_get_backlinks",
      "For incoming links (what links TO a note), use vault_get_backlinks.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
    {
      title: "Get Outgoing Links",
      description: `Find all notes and files a given note or canvas links to. For notes: [[wikilinks]], [markdown](links), ![[embeds]], and wikilinks inside properties (e.g. related:). For canvas files: file nodes, not links inside text cards. Links inside code blocks are ignored; self-links are included. Each target is listed once, however often the note links to it.

Example: vault_get_outgoing_links({ path: "Projects/vault-cortex.md" })
Example: vault_get_outgoing_links({ path: "Diagrams/architecture.canvas" })

When to use: Navigating the graph forward, auditing broken links in one note or canvas, or checking dependencies before editing.${outgoingLinksAlternativesLine}

Behavior: ${INDEX_LAG_LEAD}. A path that does not exist, or one in a dot-prefixed folder, returns an empty result (count 0), not an error, just as a note with no outbound links does; if you expected links, ${linkEmptyResultRemedy}.

Returns: JSON with path, outgoing_links (every link target, as { path, title, exists, kind, bytes, daily_note_forward_ref } sorted by target path), and count. A target's path is the vault-relative path the link resolved to; a broken link's path is its target text without any #heading or |alias, with a markdown link's %-escapes decoded. When exists is true, kind "note" is a markdown note${whenToolEnabledText("vault_read_note", " readable via vault_read_note")} and kind "file" a non-markdown file (.canvas, image, PDF)${fileReadableClause}; when exists is false the link is broken and kind is "note" even for a path like "diagram.png". title is null for files and broken links. daily_note_forward_ref is true on a broken link into the daily notes folder (a daily note not yet created, not breakage) and false otherwise, including when Obsidian's Daily Notes folder setting is the vault root or blank. bytes is the on-disk size (null for broken links)${fileBytesClause}.

Errors:
${LINK_GRAPH_EXTENSION_ERROR_ENTRY}
${INDEX_ENGINE_ERROR_ENTRY}`,
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
            { path, dailyNotesFolder: dailyNotesConfig.dedicatedFolder },
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

  // An override list may not include the daily notes folder, so the sentence
  // about that folder accompanies only the built-in defaults.
  const orphanDefaultsText = config.orphanExcludeFoldersOverride
    ? {
        folders: JSON.stringify(config.orphanExcludeFoldersOverride),
        dailyFolderLine: "",
      }
    : {
        folders: `the daily notes folder (none when Obsidian's Daily Notes folder setting is the vault root or blank), "Templates", ${JSON.stringify(config.memoryDir)}`,
        dailyFolderLine: isToolEnabled("vault_get_daily_note")
          ? " To keep the daily notes folder excluded, list it yourself: the folder vault_get_daily_note's path starts with."
          : "",
      }

  const findOrphansAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_get_backlinks",
      "Prefer vault_get_backlinks to check the connectivity of one specific note rather than scanning the whole vault.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_FIND_ORPHANS,
    {
      title: "Find Orphans",
      description: `Find notes with no incoming links from other notes or canvases. A note that only links to itself still counts as an orphan.

Example: vault_find_orphans({})
Example: vault_find_orphans({ exclude_folders: ["Templates", "Archive"], limit: 20 })

When to use: Vault maintenance — surfacing notes to integrate into the graph.${whenToolEnabledText("vault_patch_note", " Link an orphan by mentioning it from a relevant note with vault_patch_note.")}${findOrphansAlternativesLine}

Parameters:
- exclude_folders replaces the defaults, it does not add to them — list a default yourself to keep it. Pass [] for no exclusions. Each entry names ${INDEX_FOLDER_SCOPE_CLAUSE}. Excluded notes are left out of the results; links from them still count as incoming links.${orphanDefaultsText.dailyFolderLine}
- limit applies after exclusions and sorting; ${LIMIT_TRUNCATION_CLAUSE}.

Behavior: ${INDEX_LAG_LEAD}. An empty array means no orphans were found (after exclusions), not an error.

Errors:
- "too many excluded folders" — pass at most 994 exclude_folders entries, then retry.
${INDEX_ERROR_ENTRY}

Returns: ${describeNoteMetadataResult(tagsFieldsText)} Sorted by most recently modified.`,
      inputSchema: {
        exclude_folders: z
          .array(z.string().min(1))
          .optional()
          .describe(
            `Folder paths to exclude (e.g. Projects; default: ${orphanDefaultsText.folders})`,
          ),
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
          const excludeFolders =
            exclude_folders ??
            (await readEffectiveOrphanExcludeFolders({ config, vaultPath }, reqLogger))
          return search.findOrphans({ excludeFolders, limit }, reqLogger)
        },
        (results) => {
          reqLogger.info("tool_result", { resultCount: results.length })
          return JSON.stringify(results.map(formatNoteMetadata))
        },
      )
    },
  )
}
