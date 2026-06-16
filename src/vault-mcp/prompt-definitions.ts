/** MCP prompt definitions — user-initiated guided workflows over the vault.
 *
 * Prompts are the counterpart to tools: tools are model-driven and cost tokens
 * on every request, while prompts are user-initiated (slash command / "+" menu),
 * cost nothing until invoked, and assemble live vault content at invocation time.
 * Each handler gathers from the same data layer the tools use, then returns a
 * single text message — no embedded procedure that can drift, just live content
 * plus thin, durable instruction. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { completable } from "@modelcontextprotocol/sdk/server/completable.js"
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { vaultFs } from "./vault-operations/vault-filesystem.js"
import {
  createMemoryStore,
  type MemoryFileOutline,
} from "./vault-operations/memory-store.js"
import { getDailyNote } from "./vault-operations/daily-notes.js"
import type { SearchIndex } from "./search/search-index.js"
import type { VaultConfig } from "./config.js"
import type { Logger } from "../logger.js"

export const PROMPT_NAMES = {
  VAULT_ORIENTATION: "vault-orientation",
  MEMORY_REVIEW: "memory-review",
  DAILY_REVIEW: "daily-review",
} as const

/** Matches strict YYYY-MM-DD date strings (no time component, no partial dates). */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

/** Matches a positive integer with no leading zero — the wire format for the
 *  optional max_chars prompt argument (MCP prompt args arrive as strings). */
const POSITIVE_INT_REGEX = /^[1-9]\d*$/

/** Shared description for the optional max_chars argument on content-embedding
 *  prompts. Omitted by default, which embeds the full content. */
const MAX_CHARS_DESCRIPTION =
  "Optional cap on embedded content length (characters); omit for full content"

// How many entries to show in the orientation survey before truncating — enough
// to convey the vault's conventions without flooding the prompt.
const ORIENTATION_TAG_LIMIT = 30
const ORIENTATION_PROPERTY_LIMIT = 30
const ORIENTATION_RECENT_LIMIT = 10
const DAILY_RECENT_LIMIT = 10

// ── Shared formatting helpers (pure) ─────────────────────────────

/** One bullet line for a note: path, plus title when it adds information. */
const formatNoteLine = (note: { path: string; title: string }): string =>
  note.title.length > 0 ? `- ${note.path} — ${note.title}` : `- ${note.path}`

/** Unique top-level folder segments across a set of vault-relative paths,
 *  sorted. Paths at the vault root (no slash) contribute no folder. */
const deriveFolders = (paths: readonly string[]): string[] => {
  const folders = paths.reduce<Set<string>>((accumulator, path) => {
    const firstSlash = path.indexOf("/")
    if (firstSlash > 0) accumulator.add(path.slice(0, firstSlash))
    return accumulator
  }, new Set<string>())
  return [...folders].sort()
}

/** Renders memory-file outlines as a nested list of files and their H2
 *  sections with entry counts — the same shape vault_list_memory_files returns. */
const formatMemoryOutline = (outlines: readonly MemoryFileOutline[]): string =>
  outlines
    .map((outline) => {
      const sections = outline.headings
        .filter((heading) => heading.level === 2)
        .map(
          (heading) =>
            `  - ${heading.text}${
              typeof heading.entryCount === "number"
                ? ` (${heading.entryCount})`
                : ""
            }`,
        )
      return [`- ${outline.file}`, ...sections].join("\n")
    })
    .join("\n")

/** Wraps assembled text as a single user-role prompt message. */
const textResult = (text: string): GetPromptResult => ({
  messages: [{ role: "user", content: { type: "text", text } }],
})

/** Opt-in safety cap for live content embedded in a prompt. When the caller
 *  passes a max (the max_chars argument) and the content exceeds it, truncate
 *  and append a marker pointing at the tool for the full content. When omitted
 *  (the default), content is returned in full — preserving review fidelity. */
const capContent = (
  text: string,
  maxChars: number | undefined,
  toolHint: string,
): string =>
  maxChars !== undefined && text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n…(truncated at ${maxChars} characters — use ${toolHint} for the full content)`
    : text

export const registerPrompts = (params: {
  server: McpServer
  vaultPath: string
  search: SearchIndex
  logger: Logger
  config: VaultConfig
}): void => {
  const { server, vaultPath, search, logger: sessionLogger, config } = params
  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })

  // ── vault-orientation ───────────────────────────────────────
  // Zero-arg: omit argsSchema entirely so the SDK calls back as (extra) =>.
  // An empty {} schema would be treated as "has schema" and break arg parsing.
  server.registerPrompt(
    PROMPT_NAMES.VAULT_ORIENTATION,
    {
      title: "Orient to this vault",
      description: `Survey this vault's actual conventions — folders, tags, property keys, recent notes, and the ${config.memoryDir}/ memory layer — so you can work with its structure instead of assuming generic markdown.`,
    },
    async (extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        prompt: PROMPT_NAMES.VAULT_ORIENTATION,
      })
      reqLogger.info("prompt_call")

      // A prompt must never hard-fail the client; degrade to a valid message
      // that still points at the tools if any data gathering throws.
      try {
        const tags = search.listAllTags(reqLogger)
        const propertyKeys = search.listPropertyKeys({}, reqLogger)
        const recent = search.recentNotes(
          { sort_by: "modified", limit: ORIENTATION_RECENT_LIMIT },
          reqLogger,
        )
        const [paths, memoryFiles] = await Promise.all([
          vaultFs.listNotes({ vaultPath }, reqLogger),
          memoryStore.listMemoryFiles({ vaultPath }, reqLogger),
        ])

        const folders = deriveFolders(paths)
        const foldersSection =
          folders.length > 0
            ? folders.map((folder) => `- ${folder}`).join("\n")
            : "No folders yet — notes live at the vault root."
        const tagsSection =
          tags.length > 0
            ? tags
                .slice(0, ORIENTATION_TAG_LIMIT)
                .map((tag) => `- #${tag.tag} (${tag.count})`)
                .join("\n")
            : "No tags yet."
        const propertyKeysSection =
          propertyKeys.length > 0
            ? propertyKeys
                .slice(0, ORIENTATION_PROPERTY_LIMIT)
                .map((key) => {
                  const samples =
                    key.sample_values.length > 0
                      ? ` — e.g. ${key.sample_values.join(", ")}`
                      : ""
                  return `- ${key.key} (${key.count})${samples}`
                })
                .join("\n")
            : "No frontmatter properties yet."
        const recentSection =
          recent.length > 0
            ? recent.map(formatNoteLine).join("\n")
            : "No notes yet."
        const memorySection =
          memoryFiles.length > 0
            ? formatMemoryOutline(memoryFiles)
            : `No memory files yet — the ${config.memoryDir}/ layer is empty. Use vault_update_memory to start it.`

        const text = [
          "# Vault orientation",
          "",
          "This vault is a structured, convention-driven Obsidian system. Survey its actual conventions below, then use the `vault_*` tools to go deeper.",
          "",
          "## Folders",
          foldersSection,
          "",
          "## Tags",
          tagsSection,
          "",
          "## Property keys",
          propertyKeysSection,
          "",
          "## Recently modified",
          recentSection,
          "",
          `## Memory (${config.memoryDir}/)`,
          memorySection,
          "",
          "---",
          "Go deeper with the vault tools: `vault_search` (full-text), `vault_search_by_tag`, `vault_list_property_values`, `vault_get_memory`, and `vault_read_note`.",
        ].join("\n")
        return textResult(text)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reqLogger.warn("prompt_error", { error: message })
        return textResult(
          `Could not fully survey the vault (${message}). You can still explore it directly with the vault tools — try vault_list_tags, vault_list_property_keys, and vault_list_memory_files.`,
        )
      }
    },
  )

  // ── memory-review ───────────────────────────────────────────
  // The memory layer is append-with-dates, read as an EVOLUTION — never a
  // "newest supersedes older" record. This prompt narrates the trajectory and
  // proposes append-only changes; it deliberately does not hunt for "stale"
  // entries to prune or frame evolving beliefs as contradictions to reconcile.
  server.registerPrompt(
    PROMPT_NAMES.MEMORY_REVIEW,
    {
      title: "Reflect on memory (read as an evolution)",
      description: `Reflect on the ${config.memoryDir}/ memory layer — read its dated entries as a timeline, surface scope-fit and backfill ideas, and propose append-only updates. Never prunes entries for being old.`,
      argsSchema: {
        file: completable(
          z
            .string()
            .optional()
            .describe(
              `Memory file to review (e.g. one from ${config.memoryDir}/); omit to review all`,
            ),
          // Autocomplete from the live set of memory file names (prefix match).
          // Uses the name-only lister (readdir, no parsing) because completion
          // fires per keystroke. No request context here, so use the session
          // logger; degrade to [] so completion never hard-fails.
          async (value) => {
            try {
              const names = await memoryStore.listMemoryFileNames(
                { vaultPath },
                sessionLogger,
              )
              const loweredValue = (value ?? "").toLowerCase()
              return names.filter((name) =>
                name.toLowerCase().startsWith(loweredValue),
              )
            } catch {
              return []
            }
          },
        ),
        max_chars: z
          .string()
          .regex(POSITIVE_INT_REGEX, "must be a positive integer")
          .optional()
          .describe(MAX_CHARS_DESCRIPTION),
      },
    },
    async (args, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        prompt: PROMPT_NAMES.MEMORY_REVIEW,
      })
      reqLogger.info("prompt_call", {
        file: args.file,
        maxChars: args.max_chars,
      })
      const maxChars = args.max_chars ? Number(args.max_chars) : undefined

      try {
        const outlines = await memoryStore.listMemoryFiles(
          { vaultPath },
          reqLogger,
        )

        // Empty memory is not an error — explain how the layer gets started.
        if (outlines.length === 0) {
          return textResult(
            `The ${config.memoryDir}/ memory layer is empty — there's nothing to review yet.\n\nMemory is built with vault_update_memory, which appends dated entries (newest-first) under H2 sections of files like Me, Principles, and Opinions. Once a few entries exist, run this prompt again to reflect on them.`,
          )
        }

        // A bad file name degrades to a friendly "valid names" message rather
        // than throwing through to the client.
        if (
          args.file &&
          !outlines.some((outline) => outline.file === args.file)
        ) {
          return textResult(
            `No memory file named "${args.file}" in ${config.memoryDir}/. Available files: ${outlines
              .map((outline) => outline.file)
              .join(", ")}.`,
          )
        }

        const memory = await memoryStore.getMemory(
          { vaultPath, file: args.file },
          reqLogger,
        )
        const scope = args.file
          ? `the ${config.memoryDir}/${args.file} memory file`
          : `the ${config.memoryDir}/ memory layer`

        const text = [
          `# Memory review — ${args.file ?? "all files"}`,
          "",
          `Below is the current content of ${scope}. It is an **append-with-dates, newest-first** record: each dated entry was true when it was written, and the timeline read top-to-bottom *is* the meaning.`,
          "",
          "## Current memory",
          "",
          memory.trim().length > 0
            ? capContent(memory.trim(), maxChars, "vault_get_memory")
            : "_(the selected memory is empty)_",
          "",
          "## How to reflect",
          "",
          '1. **Read it as an evolution.** Summarize the current picture (the newest entries) *and* the trajectory that led there. Earlier entries aren\'t wrong — they\'re how things got here. Do **not** treat a newer entry as "overriding" or "superseding" an older one, and do **not** flag beliefs that changed over time as contradictions to reconcile — that misreads the system.',
          "2. **Scope-fit.** Note any entry that seems to belong in a different file or section, based on each file's declared scope (respect a scope header if the file states one; don't assume one otherwise).",
          "3. **Backfill gaps.** Point out durable facts that are implied but not yet captured, and propose them as dated append entries (bullet + target file + section).",
          `4. **Corrections (rare, separate).** Only a fact that is mis-recorded or now genuinely incorrect — not one that simply changed over time — warrants a fix. Prefer an appended dated correction that preserves the old entry (history matters); reserve vault_delete_memory for genuinely wrong facts.`,
          "",
          "Propose every change as an explicit vault_update_memory call (newest-first; the server stamps the date) and **confirm with me before writing anything**. Never delete an entry just for being old.",
        ].join("\n")
        return textResult(text)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reqLogger.warn("prompt_error", { error: message })
        return textResult(
          `Could not load memory for review (${message}). Try vault_list_memory_files and vault_get_memory to inspect the ${config.memoryDir}/ layer directly.`,
        )
      }
    },
  )

  // ── daily-review ────────────────────────────────────────────
  // Daily notes are the journaling surface of the daily rhythm and they feed
  // the append-with-dates memory loop — so this prompt closes by inviting
  // durable facts up into the memory layer.
  server.registerPrompt(
    PROMPT_NAMES.DAILY_REVIEW,
    {
      title: "Daily review & reconciliation",
      description: `Review a day's daily note against recent activity — reconcile what happened, capture follow-ups, and surface durable facts worth saving to ${config.memoryDir}/ memory.`,
      argsSchema: {
        date: z
          .string()
          .regex(ISO_DATE_REGEX, "use YYYY-MM-DD")
          .optional()
          .describe("Day to review in YYYY-MM-DD format (defaults to today)"),
        max_chars: z
          .string()
          .regex(POSITIVE_INT_REGEX, "must be a positive integer")
          .optional()
          .describe(MAX_CHARS_DESCRIPTION),
      },
    },
    async (args, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        prompt: PROMPT_NAMES.DAILY_REVIEW,
      })
      reqLogger.info("prompt_call", {
        date: args.date,
        maxChars: args.max_chars,
      })
      const maxChars = args.max_chars ? Number(args.max_chars) : undefined

      try {
        // getDailyNote resolves the path via the vault's daily-notes config and
        // degrades to the documented Obsidian defaults when none is present.
        const [daily, recent] = await Promise.all([
          getDailyNote({ vaultPath, date: args.date }, reqLogger),
          Promise.resolve(
            search.recentNotes(
              { sort_by: "modified", limit: DAILY_RECENT_LIMIT },
              reqLogger,
            ),
          ),
        ])

        const dailySection =
          daily.exists && daily.content && daily.content.trim().length > 0
            ? capContent(daily.content.trim(), maxChars, "vault_get_daily_note")
            : `_No daily note exists at \`${daily.path}\` yet._`
        const recentSection =
          recent.length > 0
            ? recent.map(formatNoteLine).join("\n")
            : "No recent notes."

        const text = [
          "# Daily review",
          "",
          daily.exists
            ? `Daily note: \`${daily.path}\``
            : `No daily note found at \`${daily.path}\`. If you'd like one, create it at that path with vault_write_note.`,
          "",
          "## Daily note",
          "",
          dailySection,
          "",
          "## Recently modified notes",
          "",
          recentSection,
          "",
          "## How to review",
          "",
          "1. **Reconcile the day** — what got done, what's still open, what changed — cross-referencing the recent notes above.",
          "2. **Capture follow-ups** as concrete next actions; with my OK, append them to the daily note with vault_patch_note.",
          `3. **Surface durable facts** — any preference, decision, or fact worth remembering long-term — and propose saving it to ${config.memoryDir}/ memory via vault_update_memory (append-with-dates, newest-first). Confirm before writing.`,
        ].join("\n")
        return textResult(text)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reqLogger.warn("prompt_error", { error: message })
        return textResult(
          `Could not load the daily note (${message}). Try vault_get_daily_note to fetch it directly.`,
        )
      }
    },
  )

  sessionLogger.info("registered prompts", {
    count: Object.keys(PROMPT_NAMES).length,
  })
}
