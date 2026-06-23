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
} as const

export { TOOL_NAMES as MEMORY_TOOL_NAMES }

export const registerMemoryTools = ({
  server,
  vaultPath,
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
          const mode =
            file === undefined
              ? "all"
              : section === undefined
                ? "file"
                : "section"
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
      description: `Append a dated entry to a section of a ${config.memoryDir}/ memory file. The server prefixes the date automatically (format: "- **YYYY-MM-DD**: entry text") and inserts newest-first by default. Pass raw entry text without a date prefix.

Example: vault_update_memory({ file: "Opinions", section: "Code patterns (newest first)", entry: "Prefer immutable data structures" })

When to use: Recording a new preference, principle, opinion, or fact about the user. Call vault_list_memory_files first and reuse existing file and section names so entries stay grouped.
Prefer vault_write_note for creating non-memory notes.

Behavior: Append-only by design — existing entries are never overwritten, and repeat calls add duplicate entries. When a preference or fact changes, append a new dated entry (newest wins; older entries stay as history); delete (vault_delete_memory) is only for entries that were wrong when written. A missing file or section is created automatically; if the section name omits "(newest first)" the server appends it when creating a new section ("Design preferences" becomes "Design preferences (newest first)"); an existing section is matched with or without the suffix. Creating a brand-new file also seeds a placeholder scope callout — the confirmation message nudges you to fill in its Contains/Does NOT contain via vault_patch_note so other agents know what belongs in the file.

Parameters:
- options.date — ISO YYYY-MM-DD, defaults to today (server timezone).
- options.position — "top" (default, newest-first) inserts above existing entries; "bottom" appends below them.

Obsidian syntax: Entry text renders as Obsidian Flavored Markdown. Watch for: #word = tag, [[ = wikilink. Escape with backslash or backticks when unintentional.

Errors:
- "refusing memory write: … would shrink content from N to M bytes" — a safety guard blocked a write that would remove more than half of the existing file. An append should never shrink a file, so this signals the on-disk copy has diverged from what you expect (e.g. a stale/truncated server copy). Re-read with vault_get_memory or vault_read_note to confirm the current content before retrying.

Returns: Confirmation message.`,
      inputSchema: {
        file: z
          .string()
          .describe('Memory file name without .md (e.g. "Principles")'),
        section: z
          .string()
          .describe(
            'H2 section heading (e.g. "Decision heuristics (newest first)"). Matched case-insensitively, with or without the "(newest first)" suffix.',
          ),
        entry: z.string().min(1).describe("Entry text (no date prefix)"),
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
        // Append-only: entries are inserted, never overwritten or deleted
        // (see memoryStore.updateMemory) — additive, not destructive.
        destructiveHint: false,
        // Repeat calls add a duplicate dated entry, so not idempotent.
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
        (outcome) => {
          reqLogger.info("tool_result", { outcome })
          const confirmation = `Added entry to ${config.memoryDir}/${file}.md → ## ${section}`
          // Nudge the caller to author the scope callout the new file was
          // seeded with, so the file self-documents what belongs in it.
          return outcome === "created-file"
            ? `${confirmation}. Created a new memory file with a placeholder scope callout — fill in its "Contains"/"Does NOT contain" via vault_patch_note (operation "prepend", no heading) so other agents know what this file is for.`
            : confirmation
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    {
      title: "List Memory Files",
      description: `Discovery tool — lists ${config.memoryDir}/ memory files with their H1/H2 heading structure, per-section entry counts, and each file's leading callout (by convention a "Scope of this file" block describing what belongs in it). Does NOT return actual entries.

Example: vault_list_memory_files() returns file outlines with headings like "Decision heuristics (newest first)", entry counts, and the file's scope callout.

When to use: Discovering what memory files and sections exist — and what each file is for — BEFORE calling vault_get_memory, vault_update_memory, or vault_delete_memory. Always call this first to get valid file and section names.

Errors:
- An empty or nonexistent memory folder returns an empty array, not an error.

Returns: JSON array of file outlines, each { file, title, bytes, leading_callout, headings } — bytes is the on-disk file size; leading_callout is the file's top-of-file callout ({ type, title, body }), by convention a "Scope of this file" block, or null.`,
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

When to use: Removing an entry that was wrong when it was written — a mistake, a misattribution, or something never true. Memory is append-only by design, so do NOT delete to reflect a change: when a preference or fact has since evolved, append the new state via vault_update_memory (newest-first naturally supersedes). Call vault_get_memory(file, section) first to see exact entry text for matching.
Prefer vault_update_memory to supersede a changed entry; prefer vault_delete_note for deleting entire non-protected notes.

Errors:
- "no entry matching …" — no bullet matched the given date and entry text; verify exact text via vault_get_memory(file, section).
- "ambiguous: N entries match …" — more than one bullet matched; the entry text is not unique within the section.
- "refusing memory write: … would shrink content from N to M bytes" — a safety guard blocked a write that would remove more than half of the file. Removing a single entry should not halve a file with real content, so this signals the on-disk copy has diverged (e.g. a stale/truncated server copy). Re-read with vault_get_memory or vault_read_note to confirm current content before retrying.

Returns: Confirmation message.`,
      inputSchema: {
        file: z
          .string()
          .describe('Memory file name without .md (e.g. "Principles")'),
        section: z
          .string()
          .describe(
            'H2 section heading containing the entry. Matched case-insensitively, with or without the "(newest first)" suffix.',
          ),
        date: z.string().min(1).describe("ISO YYYY-MM-DD date of the entry"),
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
        () => {
          reqLogger.info("tool_result", { outcome: "entry_deleted" })
          return `Deleted entry from ${config.memoryDir}/${file}.md → ## ${section}`
        },
      )
    },
  )
}
