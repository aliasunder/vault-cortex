/** Memory tool registrations — read, update, list, and delete About Me/ entries. */

import { z } from "zod"
import { createMemoryStore } from "../../vault-operations/memory-store.js"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import {
  createStrictInputObject,
  FILESYSTEM_ERROR_ENTRY,
  INDEX_ENGINE_ERROR_ENTRY,
  toolInputErrorResult,
} from "./tool-helpers.js"

/** One entry for the bare-name checks every tool taking a memory file name
 *  runs, so the three descriptions cannot drift apart. */
const MEMORY_FILE_NAME_ERROR_ENTRY =
  '- "memory file must not start with a dot" / "memory file must be a bare name without path separators" / "memory file must be named without .md" — each message names the part of the name to drop'

/** The memory store names a folder standing where the file would go. That
 *  folder is the vault owner's, so the caller picks another name instead of
 *  removing it. */
const MEMORY_FILE_IS_FOLDER_ERROR_ENTRY =
  '- "cannot write memory file …: that path is not a file" — a folder already has this name; choose another file name'

/** The memory store wraps the folder's mkdir failure, since the folder is
 *  server configuration and a file at its path is the vault owner's to move. */
const MEMORY_FOLDER_ERROR_ENTRY =
  '- "cannot create memory folder …" — a file sits where the memory folder belongs; ask the vault\'s owner to move it'

/** The memory store wraps a failed read without the Node error's code, so the
 *  filesystem-error entry's code names never match this message. */
const MEMORY_FILE_READ_ERROR_ENTRY =
  "- \"cannot read memory file …\" — the file can't be read: check file against vault_list_memory_files (a name longer than the filesystem allows fails here); otherwise ask the vault's owner to fix its permissions"

/** A memory write keeps the file's properties block, so it refuses only a
 *  file with no block whose opening lines would become one once saved:
 *  - two leading BOMs before `---`, of which the save drops one;
 *  - a first line `---\r\r\n`, which the save writes as `---\r\n`. */
const MEMORY_OPENING_BLOCK_ERROR_ENTRY =
  "- \"memory file …: the note would open with a properties block …\" — saving would turn the file's opening lines into a properties block the server can't keep; the error says how to avoid it"

export const registerMemoryTools = ({
  registerTool,
  safeHandler,
  formatEnabledToolList,
  whenToolEnabledText,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })

  // Tools a reader follows vault_list_memory_files with. Every one of them —
  // the read tool included — can be dropped individually via DISABLED_TOOLS,
  // so the purpose sentence falls back to the discovery value alone rather
  // than rendering a dangling "BEFORE calling .".
  const discoveryFollowUpTools = formatEnabledToolList([
    TOOL_NAMES.VAULT_GET_MEMORY,
    TOOL_NAMES.VAULT_UPDATE_MEMORY,
    TOOL_NAMES.VAULT_DELETE_MEMORY,
  ])
  const discoveryPurpose = discoveryFollowUpTools
    ? `Discovering what memory files and sections exist — and what each file is for — BEFORE calling ${discoveryFollowUpTools}; it gives the valid file and section names`
    : "Discovering what memory files and sections exist — and what each file is for"

  // The tools a recall entry's file/section fields feed into. Rendered as a
  // trailing clause (semicolon included) so the surrounding sentence keeps its
  // punctuation when neither consumer is served.
  const recallConsumerTools = formatEnabledToolList([
    TOOL_NAMES.VAULT_GET_MEMORY,
    TOOL_NAMES.VAULT_DELETE_MEMORY,
  ])
  const recallConsumerClause = recallConsumerTools
    ? `; file and section feed directly into ${recallConsumerTools}`
    : ""

  registerTool(
    TOOL_NAMES.VAULT_GET_MEMORY,
    {
      title: "Get Memory",
      description: `Read semantic memory from ${config.memoryDir}/ files. These are structured memory files containing dated bullet entries organized under H2 headings. With file: that file's content, properties block stripped. With file+section: just that H2 section's entries. No args: every file's content, properties block stripped, joined by --- lines — can be large. Returns empty string when no memory files exist yet.

With file+on_or_after: only the entries dated on or after that date (inclusive), in document order (newest first when new entries go at the top, their default position). Add section to scope to one H2 section; omit it to read every H2 section's entries in the file, each keeping its section attribution.

Example: vault_get_memory({ file: "Principles" }) — the whole file
Example: vault_get_memory({ file: "Principles", section: "Decision heuristics (newest first)" })
Example: vault_get_memory({ file: "Opinions", section: "Code patterns", on_or_after: "2026-09-01" })
Example: vault_get_memory({ file: "Opinions", on_or_after: "2026-09-01" }) — every section's entries since the date

When to use: Reading user preferences, principles, opinions, or other persistent context stored in ${config.memoryDir}/ files. Call vault_list_memory_files first to discover valid file and section names.
Prefer vault_read_note for reading non-memory notes.${whenToolEnabledText("vault_memory_recall", " To find entries by topic across every file, use vault_memory_recall.")}

Errors:
- "section requires a file" / "on_or_after requires a file" — add file
- "memory file not found" — call vault_list_memory_files to discover valid names
${MEMORY_FILE_NAME_ERROR_ENTRY}
- "section not found: …" — no H2 heading matches; the message lists the file's sections
- "date must be a real ISO calendar date" — on_or_after must be a valid YYYY-MM-DD date
- "cannot read memory file …" / "cannot list memory folder …" — a memory file, or the ${config.memoryDir}/ folder itself on a call without file, can't be read: check file against vault_list_memory_files (a name longer than the filesystem allows fails here); otherwise ask the vault's owner to check the folder

Returns: Without on_or_after, raw markdown text. With on_or_after, JSON { entries, total, on_or_after } where each entry is { file, section, date, text } — text is the full raw entry markdown (bullet + continuation lines, wikilinks intact). An empty match returns { entries: [], total: 0, on_or_after }.`,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Memory file name without .md (e.g. "Principles", "Opinions"). Use the exact letter case.',
          ),
        section: z
          .string()
          .min(1)
          .optional()
          .describe(
            'H2 section heading (e.g. "Decision heuristics (newest first)"). Matched case-insensitively, with or without the "(newest first)" suffix. Omit to read the whole file.',
          ),
        on_or_after: z.string().min(1).optional().describe("Inclusive date filter (YYYY-MM-DD)."),
      },
    },
    async ({ file, section, on_or_after: onOrAfter }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_GET_MEMORY,
      })
      reqLogger.info("tool_call", { file, section, onOrAfter })

      const returnError = (message: string) => toolInputErrorResult({ message, logger: reqLogger })

      if (onOrAfter) {
        if (!file) return returnError("on_or_after requires a file")

        return safeHandler(
          reqLogger,
          () => {
            return memoryStore.getMemoryEntries({ vaultPath, file, section, onOrAfter }, reqLogger)
          },
          (entries) => {
            reqLogger.info("tool_result", {
              mode: "entries",
              total: entries.length,
              onOrAfter,
            })
            const wireEntries = entries.map((entry) => ({
              file,
              section: entry.section,
              date: entry.date,
              text: entry.text,
            }))
            return JSON.stringify({
              entries: wireEntries,
              total: wireEntries.length,
              on_or_after: onOrAfter,
            })
          },
        )
      }

      if (section && !file) return returnError("section requires a file")

      return safeHandler(
        reqLogger,
        () => memoryStore.getMemory({ vaultPath, file, section }, reqLogger),
        (text) => {
          // Three read modes: "all" (no file), "file" (file only), "section" (file + section).
          const modeWithinFile = section ? "section" : "file"
          const mode = file ? modeWithinFile : "all"
          reqLogger.info("tool_result", { mode })
          return text
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    {
      title: "List Memory Files",
      description: `Discovery tool — lists ${config.memoryDir}/ memory files with each file's heading outline, per-section entry counts, and leading callout. An entry is a dated bullet line ("- **YYYY-MM-DD**: text"). Does NOT return actual entries.

Example: vault_list_memory_files() returns [{ file: "Principles", title: "Principles", bytes: 2048, entry_policy: "append-only", leading_callout: null, headings: [{ level: 2, text: "Decision heuristics (newest first)", entry_count: 12 }] }, ...]

When to use: ${discoveryPurpose}${whenToolEnabledText("vault_delete_memory", ", and each file's entry_policy to check before pruning entries")}.${whenToolEnabledText("vault_memory_recall", " To find entries by topic instead, use vault_memory_recall.")}

Behavior: Lists every .md file directly inside ${config.memoryDir}/, sorted by file name, whether or not it has frontmatter or a scope callout. Subfolders are not read, and hidden (dot-prefixed) files and names ending in .md.md (such as Opinions.md.md) are skipped.

Errors:
- An empty or nonexistent memory folder returns an empty array, not an error.
- "cannot list memory folder …" — a file stands at the memory folder's path, or its permissions block the server; ask the vault's owner to fix it
- "cannot read memory file …" — one listed file can't be read, which fails the whole listing; retry once, then ask the vault's owner to check that file

Returns: JSON array of file outlines, each { file, title, bytes, entry_policy, leading_callout, headings } — file is the name the other memory tools take as file (no .md); title is the title property, or file when there is none; bytes is the on-disk file size; headings lists H1 and H2 headings in order, with entry_count on H2s; leading_callout is the top-of-file callout ({ type, title, body }; by convention a "Scope of this file" block describing what belongs in the file), or null; entry_policy is "append-only" (the default: by convention, entries are never edited or deleted) or "living" (a current-state file whose expired entries may be pruned; declared via \`entry-policy\` frontmatter). The server does not enforce either policy.`,
      inputSchema: {},
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

  // These parts read the same with or without embeddings, so both
  // vault_memory_recall description variants share them
  const recallUsageSections = `Example: vault_memory_recall({ query: "working hours and pacing" })
Example: vault_memory_recall({ query: "testing philosophy", file: "Opinions" })

When to use: Answering "what does my memory say about X?" or "how has my view on Y evolved?" — topic-based recall across memory files. Prefer vault_get_memory to read a known file or section verbatim; prefer vault_search for notes outside the memory layer.

Behavior: A memory file change takes a few seconds to appear here, so an entry written moments ago may not be recalled yet.

Errors:
- No matching entries returns { entries: [], total: 0, truncated: false, search_mode, reranked }, not an error
- An unknown file returns empty results — call vault_list_memory_files to discover valid names
${INDEX_ENGINE_ERROR_ENTRY}`
  const recallReturnsLead = `Returns: JSON { entries, total, truncated, search_mode, reranked }. Each entry is { file, section, date, text } — text is the raw entry markdown (wikilinks intact, continuation lines included)${recallConsumerClause}. The total counts every matched entry; truncated=true means limit dropped the least-relevant matches, whatever their dates, so raise limit or narrow the query for the complete set. The file filter is applied before limit, so limit keeps the most relevant matches from that file.`

  // The recall description leads with its matching mode — hybrid semantic
  // matching is the tool's core promise, so keyword-only deployments
  // (EMBEDDING_ENABLED=false) get an honest variant with a synonym-requery
  // workaround instead of an overclaim.
  const memoryRecallDescription = config.embeddingEnabled
    ? `Recall memory entries about a topic — entry-granular hybrid (keyword + semantic) retrieval across ALL ${config.memoryDir}/ files and ALL time. Returns the relevant dated entries, up to limit, sorted oldest-first, so the full evolution of a preference, opinion, or fact is visible — semantic matching finds early entries even when their phrasing differs from the query. Tuned for recall over precision: expect some marginal entries and judge relevance yourself when synthesizing an answer. Content-word queries ("testing philosophy", "sustainable pacing") rank best. When reranking runs, a meta-framed query ("opinions on testing") that scores below the relevance threshold degrades to relaxed any-term keyword matching instead of returning nothing.

${recallUsageSections}

${recallReturnsLead} The search_mode value is "hybrid" when vector matching contributed and "fts" when the entries came from keyword matching alone — including the any-term fallback; reranked is true when the reranker's relevance cut was applied.`
    : `Recall memory entries about a topic — entry-granular keyword retrieval across ALL ${config.memoryDir}/ files and ALL time. Returns the matching dated entries, up to limit, sorted oldest-first, so the evolution of a preference, opinion, or fact reads in order. Matching is stemmed keywords only (semantic matching is off), and phrasing drifts across months, so re-query with synonyms to cover a topic fully (e.g. "pacing", then "recovery", then "sustainable hours"). A multi-word query whose terms never co-occur in one entry degrades to any-term matching instead of returning nothing.

${recallUsageSections}

${recallReturnsLead} In keyword-only mode search_mode is always "fts" and reranked always false.`

  registerTool(
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
              ? "Topic to recall, in natural language."
              : "Topic to recall — use specific keywords.",
          ),
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional: restrict to one memory file, name without .md (e.g. "Opinions"), in its exact letter case. Omit for cross-file recall — the default and usual choice.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe("Cap on returned entries (default 50)."),
      },
    },
    async ({ query, file, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_MEMORY_RECALL,
      })
      reqLogger.info("tool_call", {
        query,
        ...(file ? { file } : {}),
        limit,
      })
      return safeHandler(
        reqLogger,
        () => search.memoryRecall({ query, file, limit }, reqLogger),
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
  registerTool(
    TOOL_NAMES.VAULT_UPDATE_MEMORY,
    {
      title: "Update Memory",
      description: `Append a dated entry to a section of a memory file in ${config.memoryDir}/. Idempotent — an exact duplicate (same date + text in the same section) is a no-op, so retrying a timed-out call is safe. Memory files are append-only by default: when a preference changes, append the new state (newest wins) rather than deleting the old one. A file may declare \`entry-policy: living\` in frontmatter (surfaced by vault_list_memory_files) — a current-state file where pruning expired entries${whenToolEnabledText("vault_delete_memory", " with vault_delete_memory")} is expected maintenance rather than a violation.

Example: vault_update_memory({ file: "Opinions", section: "Code patterns (newest first)", entry: "Prefer immutable data structures" })
Example: vault_update_memory({ file: "Routines", section: "Daily/weekly rhythm (newest first)", entry: "Gym Mon/Wed at 6am", options: { date: "2026-10-01", position: "bottom" } }) — a backdated entry placed below the existing ones

When to use: Recording a new preference, principle, opinion, or fact about the user. Call vault_list_memory_files first and reuse existing file and section names so entries stay grouped.
Prefer vault_write_note for creating non-memory notes. A missing file or section is created automatically (new sections get "(newest first)" appended; new files get a placeholder scope callout to fill in via vault_replace_in_note).

Parameters:
- options.date only sets the bullet's date; placement follows options.position, never the date.

Obsidian syntax: Entry text is Obsidian Flavored Markdown. Watch for: #word = tag, [[ = wikilink. Escape with \\# or backticks when unintentional.

Errors:
- "entry must be a single line" — the message names the two fixes.
- "section must be a single line" — the message names the fix.
- "date must be a real ISO calendar date" — options.date only accepts an existing calendar date in bare YYYY-MM-DD form (e.g. "2026-07-02"), not a timestamp.
- "entry contains a control character" / "section contains a control character" — remove the character the message names.
${MEMORY_FILE_NAME_ERROR_ENTRY}
- "section not created: … is nearly identical to existing section …" — the name differs from an existing heading only by an HTML-entity slip, a typo, or spacing; pass the exact existing heading (listed in the error) to append there, or choose a clearly different name for a genuinely new section. Names differing only in digits (e.g. "2025" vs "2026") count as different.
${MEMORY_FILE_READ_ERROR_ENTRY}
${MEMORY_FILE_IS_FOLDER_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
${MEMORY_FOLDER_ERROR_ENTRY}
${MEMORY_OPENING_BLOCK_ERROR_ENTRY}

Returns: "Added entry to ${config.memoryDir}/<file>.md → ## <section>", plus a note to fill in the placeholder scope callout when the file is new; an exact duplicate returns "Entry already exists in ${config.memoryDir}/<file>.md → ## <section> — nothing was written."`,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe(
            'Memory file name without .md (e.g. "Principles"). Use the exact letter case; a different case can create a second file.',
          ),
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
            'Raw entry text — a single line; the server prepends "- **YYYY-MM-DD**: " automatically. Do not include the date or bullet prefix.',
          ),
        options: createStrictInputObject({
          date: z
            .string()
            .min(1)
            .optional()
            .describe("ISO YYYY-MM-DD date (defaults to today, server timezone)"),
          position: z
            .enum(["top", "bottom"])
            .optional()
            .default("top")
            .describe('Insert position (default "top" = newest first)'),
        })
          .optional()
          .describe("Optional date and position overrides"),
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
        () => {
          return memoryStore.updateMemory(
            {
              vaultPath,
              file,
              section,
              entry,
              date: options?.date,
              position: options?.position,
            },
            reqLogger,
          )
        },
        (outcome) => {
          reqLogger.info("tool_result", { outcome })
          const confirmation = `Added entry to ${config.memoryDir}/${file}.md → ## ${section}`

          switch (outcome) {
            case "unchanged":
              return `Entry already exists in ${config.memoryDir}/${file}.md → ## ${section} — nothing was written.`
            // Nudge the caller to author the scope callout the new file was
            // seeded with, so the file self-documents what belongs in it.
            case "created-file":
              return `${confirmation}. Created a new memory file with a placeholder scope callout — use vault_replace_in_note to replace its "(describe what belongs in this file — and what doesn't)" placeholder with what the file contains, so other agents know what it is for.`
            case "created-section":
            case "appended":
              return confirmation
          }
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_DELETE_MEMORY,
    {
      title: "Delete Memory Entry",
      description: `Delete a single dated entry from a memory file in ${config.memoryDir}/.

Example: vault_delete_memory({ file: "Opinions", section: "Tools and workflows (newest first)", date: "2026-05-01", entry: "Prefer X over Y" })
Example: vault_delete_memory({ file: "Routines", section: "Daily/weekly rhythm (newest first)", date: "2026-03-10", entry: "Gym Tue/Thu at 7am" }) — prune an expired entry from an entry-policy: living file

When to use: Removing an entry that was wrong when it was written — a mistake, a misattribution, or something never true. Memory files are append-only by default, so do NOT delete to reflect a change: append the new state via vault_update_memory instead (newest-first naturally supersedes). The exception is a file whose frontmatter declares \`entry-policy: living\` (check via vault_list_memory_files) — a current-state file where deleting an expired entry is the intended maintenance. Call vault_get_memory(file, section) first to see exact entry text for matching.
${whenToolEnabledText("vault_delete_note", "Prefer vault_delete_note for deleting whole notes; vault_delete_note refuses protected paths.\n")}
Parameters:
- date + entry together pick the bullet line within the given section; identical copies make the match ambiguous. The entry text matches the bullet's first line only, and the delete also removes the lines that continue that entry.
- section scopes the match — an identical entry under a different heading is not found.

Errors:
- "memory file not found" — call vault_list_memory_files to discover valid names.
${MEMORY_FILE_NAME_ERROR_ENTRY}
- "date must be YYYY-MM-DD" — pass the entry's date exactly as the file shows it, zero-padded.
- "section not found: …" — no H2 heading matches; the message lists the file's sections
- "no entry matching …" — verify the exact text with vault_get_memory(file, section).
- "ambiguous: N entries match …" — remove the extra copy with ${whenToolEnabledText("vault_delete_span", "vault_delete_span (first_match: true, since identical lines make every anchor ambiguous) or ")}a manual edit, then retry.
- "refusing memory write: … would shrink content" — the delete would remove more than half the file; re-read it with vault_get_memory, and remove an entry that really is that large with ${whenToolEnabledText("vault_delete_span", "vault_delete_span or ")}a manual edit.
${MEMORY_FILE_READ_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
${MEMORY_OPENING_BLOCK_ERROR_ENTRY}

Returns: "Deleted entry from ${config.memoryDir}/<file>.md → ## <section>".`,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('Memory file name without .md (e.g. "Principles"). Use the exact letter case.'),
        section: z
          .string()
          .min(1)
          .describe(
            'H2 section heading containing the entry. Matched case-insensitively, with or without the "(newest first)" suffix.',
          ),
        date: z.string().min(1).describe('ISO YYYY-MM-DD date of the entry (e.g. "2026-05-01").'),
        entry: z
          .string()
          .min(1)
          .describe('Exact entry text, without the "- **YYYY-MM-DD**: " prefix or bullet.'),
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
        () => {
          return memoryStore.deleteMemory({ vaultPath, file, section, date, entry }, reqLogger)
        },
        () => {
          reqLogger.info("tool_result", { outcome: "entry_deleted" })
          return `Deleted entry from ${config.memoryDir}/${file}.md → ## ${section}`
        },
      )
    },
  )
}
