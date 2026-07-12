/** Memory tool registrations — read, update, list, and delete About Me/ entries. */

import { z } from "zod"
import { createMemoryStore } from "../../vault-operations/memory-store.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler } from "./tool-helpers.js"

const TOOL_NAMES = {
  VAULT_GET_MEMORY: "vault_get_memory",
  VAULT_UPDATE_MEMORY: "vault_update_memory",
  VAULT_LIST_MEMORY_FILES: "vault_list_memory_files",
  VAULT_DELETE_MEMORY: "vault_delete_memory",
  VAULT_MEMORY_RECALL: "vault_memory_recall",
} as const

export { TOOL_NAMES as MEMORY_TOOL_NAMES }

export const registerMemoryTools = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })

  server.registerTool(
    TOOL_NAMES.VAULT_GET_MEMORY,
    {
      title: "Get Memory",
      description: `Read semantic memory from ${config.memoryDir}/ files. These are structured memory files containing dated bullet entries organized under H2 headings. With file: single file content. With file+section: just that H2 section's entries. No args: all files concatenated (frontmatter stripped) — can be large. Returns empty string when no memory files exist yet.

Example: vault_get_memory({ file: "Principles", section: "Decision heuristics (newest first)" })

When to use: Reading user preferences, principles, opinions, or other persistent context stored in ${config.memoryDir}/ files. Call vault_list_memory_files first to discover valid file and section names.
Prefer vault_read_note for reading non-memory notes.

Errors:
- "section requires a file" — section was provided without file; pass both or just file
- "memory file not found" — file does not exist in ${config.memoryDir}/; call vault_list_memory_files to discover valid names

Returns: Raw markdown text.`,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Memory file name without .md (e.g. "Principles", "Opinions")',
          ),
        section: z
          .string()
          .min(1)
          .optional()
          .describe(
            'H2 section heading (e.g. "Decision heuristics (newest first)"). Matched case-insensitively, with or without the "(newest first)" suffix. Call vault_list_memory_files first to discover valid names.',
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

      if (section !== undefined && file === undefined) {
        reqLogger.warn("tool_error", {
          error: "section requires a file",
        })
        return {
          content: [{ type: "text" as const, text: "section requires a file" }],
          isError: true as const,
        }
      }

      return safeHandler(
        reqLogger,
        () => memoryStore.getMemory({ vaultPath, file, section }, reqLogger),
        (text) => {
          const mode = !file ? "all" : !section ? "file" : "section"
          reqLogger.info("tool_result", { mode })
          return text
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_UPDATE_MEMORY,
    {
      title: "Update Memory",
      description: `Append a dated entry to a section of a ${config.memoryDir}/ memory file. The server prefixes the date automatically ("- **YYYY-MM-DD**: entry text") and inserts newest-first by default. Idempotent — an exact duplicate (same date + text in the same section) is a no-op, so retrying a timed-out call is safe. Memory files are append-only by default: when a preference changes, append the new state (newest wins) rather than deleting the old one. A file may declare \`entry-policy: living\` in frontmatter (surfaced by vault_list_memory_files) — a current-state file where pruning expired entries is expected maintenance rather than a violation.

Example: vault_update_memory({ file: "Opinions", section: "Code patterns (newest first)", entry: "Prefer immutable data structures" })

When to use: Recording a new preference, principle, opinion, or fact about the user. Call vault_list_memory_files first and reuse existing file and section names so entries stay grouped.
Prefer vault_write_note for creating non-memory notes. A missing file or section is created automatically (new sections get "(newest first)" appended; new files get a placeholder scope callout to fill in via vault_replace_in_note).

Parameters:
- options.date — ISO YYYY-MM-DD, defaults to today (server timezone).
- options.position — "top" (default, newest-first) inserts above existing entries; "bottom" appends below them.

Obsidian syntax: Entry text is Obsidian Flavored Markdown. Watch for: #word = tag, [[ = wikilink. Escape with \\# or backticks when unintentional.

Errors:
- "refusing memory write: … would shrink content" — safety guard for diverged on-disk content. Re-read with vault_get_memory before retrying.
- "entry must be a single line" — memory entries are single dated bullets; collapse newlines or append multiple entries.
- "section must be a single line" — section names become H2 headings; remove line breaks.
- "date must be a real ISO calendar date" — options.date only accepts an existing calendar date in bare YYYY-MM-DD form (e.g. "2026-07-02"), not a timestamp.

Returns: Confirmation message (notes when an identical entry already existed and nothing was written).`,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('Memory file name without .md (e.g. "Principles")'),
        section: z
          .string()
          .min(1)
          .describe(
            'H2 section heading (e.g. "Decision heuristics (newest first)"). Matched case-insensitively, with or without the "(newest first)" suffix.',
          ),
        entry: z
          .string()
          .min(1)
          .describe(
            'Raw entry text — a single line (newlines are rejected); the server prepends "- **YYYY-MM-DD**: " automatically. Do not include the date or bullet prefix.',
          ),
        options: z
          .object({
            date: z
              .string()
              .min(1)
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
        // Append-only: entries are inserted, never overwritten or deleted
        // (see memoryStore.updateMemory) — additive, not destructive.
        destructiveHint: false,
        // An exact duplicate (same date + text in the same section) is a
        // no-op, so replayed calls are safe. Nuance: `date` defaults to
        // today, so identical args replayed across a date boundary append a
        // second, differently-dated entry — real client retries happen
        // within seconds, so the hint reflects the retry-safety contract.
        idempotentHint: true,
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
        (outcome) => {
          reqLogger.info("tool_result", { outcome })
          if (outcome === "unchanged") {
            return `Entry already exists in ${config.memoryDir}/${file}.md → ## ${section} — nothing was written.`
          }
          const confirmation = `Added entry to ${config.memoryDir}/${file}.md → ## ${section}`
          // Nudge the caller to author the scope callout the new file was
          // seeded with, so the file self-documents what belongs in it.
          return outcome === "created-file"
            ? `${confirmation}. Created a new memory file with a placeholder scope callout — use vault_replace_in_note to replace its "(describe what belongs in this file — and what doesn't)" placeholder with what the file contains, so other agents know what it is for.`
            : confirmation
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    {
      title: "List Memory Files",
      description: `Discovery tool — lists ${config.memoryDir}/ memory files with their H1/H2 heading structure, per-section entry counts, entry policy, and each file's leading callout (by convention a "Scope of this file" block describing what belongs in it). Does NOT return actual entries.

Example: vault_list_memory_files() returns file outlines with headings like "Decision heuristics (newest first)", entry counts, each file's entry policy, and its scope callout.

When to use: Discovering what memory files and sections exist — and what each file is for — BEFORE calling vault_get_memory, vault_update_memory, or vault_delete_memory. Always call this first to get valid file and section names, and to check a file's entry policy before pruning entries.

Errors:
- An empty or nonexistent memory folder returns an empty array, not an error.

Returns: JSON array of file outlines, each { file, title, bytes, entry_policy, leading_callout, headings } — bytes is the on-disk file size; entry_policy is "append-only" (the default — entries are never edited or deleted) or "living" (a current-state file whose expired entries may be pruned; declared via \`entry-policy\` frontmatter); leading_callout is the file's top-of-file callout ({ type, title, body }), by convention a "Scope of this file" block, or null.`,
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
        (outlines) => {
          reqLogger.info("tool_result", { resultCount: outlines.length })
          return JSON.stringify(outlines)
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_DELETE_MEMORY,
    {
      title: "Delete Memory Entry",
      description: `Delete a single dated entry from a ${config.memoryDir}/ memory file. Both date and entry text are required for exact matching — ensures only the intended entry is removed.

Example: vault_delete_memory({ file: "Opinions", section: "AI tooling & memory (newest first)", date: "2026-05-01", entry: "Prefer X over Y" })

When to use: Removing an entry that was wrong when it was written — a mistake, a misattribution, or something never true. Memory files are append-only by default, so do NOT delete to reflect a change: when a preference or fact has since evolved, append the new state via vault_update_memory (newest-first naturally supersedes). The exception is a file whose frontmatter declares \`entry-policy: living\` (check via vault_list_memory_files) — a current-state file where deleting an expired entry is the intended maintenance. Call vault_get_memory(file, section) first to see exact entry text for matching.
Prefer vault_update_memory to supersede a changed entry; prefer vault_delete_note for deleting entire non-protected notes.

Parameters:
- date + entry together uniquely identify the bullet line within the given section. If multiple entries share the same date and text, deletion fails as ambiguous.
- section scopes the match — an identical entry under a different heading is not found. Section matching is case-insensitive, with or without the "(newest first)" suffix.

Errors:
- "date must be a real ISO calendar date" — date only accepts an existing calendar date in bare YYYY-MM-DD form. A hand-edited bullet carrying an impossible date cannot be targeted by this tool — remove it with vault_delete_span or a manual edit.
- "no entry matching …" — no bullet matched the given date and entry text; verify exact text via vault_get_memory(file, section).
- "ambiguous: N entries match …" — more than one identical bullet exists in the section (e.g. from hand edits, sync conflicts, or entries predating duplicate protection; vault_update_memory refuses to write exact duplicates). Remove the extra copy with vault_delete_span (pass first_match: true — identical lines make every anchor ambiguous) or a manual edit, then retry.
- "refusing memory write: … would shrink content" — safety guard blocked a write that would remove more than half the file. Re-read with vault_get_memory to confirm current content before retrying.

Returns: Confirmation message.`,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('Memory file name without .md (e.g. "Principles")'),
        section: z
          .string()
          .min(1)
          .describe(
            'H2 section heading containing the entry. Matched case-insensitively, with or without the "(newest first)" suffix.',
          ),
        date: z
          .string()
          .min(1)
          .describe(
            'ISO YYYY-MM-DD date of the entry (e.g. "2026-05-01"). Must match the date shown by vault_get_memory.',
          ),
        entry: z
          .string()
          .describe(
            'Exact entry text as shown by vault_get_memory — without the "- **YYYY-MM-DD**: " prefix or bullet. Both date and entry must match for deletion.',
          ),
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
        () => {
          reqLogger.info("tool_result", { outcome: "entry_deleted" })
          return `Deleted entry from ${config.memoryDir}/${file}.md → ## ${section}`
        },
      )
    },
  )

  // The recall description leads with its matching mode — hybrid semantic
  // matching is the tool's core promise, so keyword-only deployments
  // (EMBEDDING_ENABLED=false) get an honest variant with a synonym-requery
  // workaround instead of an overclaim.
  const memoryRecallDescription = config.embeddingEnabled
    ? `Recall memory entries about a topic — entry-granular hybrid (keyword + semantic) retrieval across ALL ${config.memoryDir}/ files and ALL time. Returns every relevant dated entry sorted oldest-first, so the full evolution of a preference, opinion, or fact is visible — semantic matching finds early entries even when their phrasing differs from the query. Tuned for recall over precision: expect some marginal entries and judge relevance yourself when synthesizing an answer. Content-word queries ("testing philosophy", "sustainable pacing") rank best; a meta-framed query ("opinions on testing") whose relevance cut would come back empty degrades to relaxed any-term keyword matching instead of returning nothing.

Example: vault_memory_recall({ query: "working hours and pacing" })
Example: vault_memory_recall({ query: "opinions on testing", file: "Opinions" })

When to use: Answering "what does my memory say about X?" or "how has my view on Y evolved?" — topic-based recall across memory files. Prefer vault_get_memory to read a known file or section verbatim; prefer vault_search for notes outside the memory layer.

Errors:
- No matching entries returns { entries: [], total: 0 }, not an error
- An unknown file returns empty results — call vault_list_memory_files to discover valid names

Returns: JSON { entries, total, truncated, search_mode, reranked }. Each entry is { file, section, date, text } — text is the raw entry markdown (wikilinks intact, continuation lines included); file and section feed directly into vault_get_memory or vault_delete_memory. entries ascend by date (oldest first). total counts all matched entries; truncated=true means max_results dropped the least-relevant matches — never a date range — so raise max_results or narrow the query for the complete set. search_mode is "hybrid" when vector matching contributed, "fts" when the entries came from keyword matching alone — including the any-term fallback that rescues a would-be-empty result; reranked is true when the cross-encoder relevance cut was applied.`
    : `Recall memory entries about a topic — entry-granular keyword retrieval across ALL ${config.memoryDir}/ files and ALL time. Returns every matching dated entry sorted oldest-first, so the evolution of a preference, opinion, or fact reads in order. Matching is stemmed keywords only (semantic matching is off — EMBEDDING_ENABLED=false), and phrasing drifts across months, so re-query with synonyms to cover a topic fully (e.g. "pacing", then "recovery", then "sustainable hours"). A multi-word query whose terms never co-occur in one entry degrades to any-term matching before returning empty.

Example: vault_memory_recall({ query: "working hours and pacing" })
Example: vault_memory_recall({ query: "opinions on testing", file: "Opinions" })

When to use: Answering "what does my memory say about X?" or "how has my view on Y evolved?" — topic-based recall across memory files. Prefer vault_get_memory to read a known file or section verbatim; prefer vault_search for notes outside the memory layer.

Errors:
- No matching entries returns { entries: [], total: 0 }, not an error
- An unknown file returns empty results — call vault_list_memory_files to discover valid names

Returns: JSON { entries, total, truncated, search_mode, reranked }. Each entry is { file, section, date, text } — text is the raw entry markdown (wikilinks intact, continuation lines included); file and section feed directly into vault_get_memory or vault_delete_memory. entries ascend by date (oldest first). total counts all matched entries; truncated=true means max_results dropped the least-relevant matches — never a date range. search_mode is always "fts" and reranked always false in keyword-only mode.`

  server.registerTool(
    TOOL_NAMES.VAULT_MEMORY_RECALL,
    {
      title: "Memory Recall",
      description: memoryRecallDescription,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            config.embeddingEnabled
              ? 'Topic to recall — natural language works best (semantic matching bridges phrasing drift across months); content words about the topic rank better than meta framing ("testing philosophy" over "opinions on testing")'
              : "Topic to recall — use specific keywords (semantic matching is off; re-query with synonyms to cover vocabulary drift)",
          ),
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional: restrict to one memory file, name without .md (e.g. "Opinions"). Omit for cross-file recall — the default and usual choice.',
          ),
        max_results: z
          .number()
          .optional()
          .describe(
            "Cap on returned entries (default 50). When more match, the least-relevant are dropped and truncated=true — never a date range.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, file, max_results }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_MEMORY_RECALL,
      })
      reqLogger.info("tool_call", {
        query,
        ...(file !== undefined ? { file } : {}),
        ...(max_results !== undefined ? { max_results } : {}),
      })
      return safeHandler(
        reqLogger,
        () =>
          search.memoryRecall(
            { query, file, maxResults: max_results },
            reqLogger,
          ),
        (recallResult) => {
          reqLogger.info("tool_result", {
            resultCount: recallResult.entries.length,
            total: recallResult.total,
            truncated: recallResult.truncated,
            searchMode: recallResult.search_mode,
            reranked: recallResult.reranked,
          })
          return JSON.stringify(recallResult)
        },
      )
    },
  )
}
