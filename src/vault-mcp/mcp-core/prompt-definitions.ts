/** MCP prompt definitions — user-initiated guided workflows over the vault.
 *
 * Prompts are the counterpart to tools: tools are model-driven, while prompts
 * are user-initiated — the client surfaces them as slash commands, a "+" menu,
 * or similar — and assemble live vault content at invocation time. Each handler
 * gathers from the same data layer the tools use, then returns a single text
 * message — no embedded procedure that can drift, just live content plus thin,
 * durable instruction. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { completable } from "@modelcontextprotocol/sdk/server/completable.js"
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js"
import { DateTime } from "luxon"
import { z } from "zod"
import { vaultFs } from "../vault-operations/vault-filesystem.js"
import {
  createMemoryStore,
  type MemoryFileOutline,
} from "../vault-operations/memory-store.js"
import { getDailyNote } from "../vault-operations/daily-notes.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"

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
const ORIENTATION_ORPHAN_LIMIT = 5
const ORIENTATION_LOW_ADOPTION_THRESHOLD = 0.05
const DAILY_RECENT_LIMIT = 10

// ── Shared formatting helpers (pure) ─────────────────────────────

/** One bullet line for a note: path, plus title when it adds information. */
const formatNoteLine = (note: { path: string; title: string }): string =>
  note.title.length > 0 ? `- ${note.path} — ${note.title}` : `- ${note.path}`

type FolderCount = { name: string; count: number }

/** Top-level folder segments with per-folder note counts, sorted by name.
 *  Paths at the vault root (no slash) contribute no folder. */
const deriveFolderCounts = (paths: readonly string[]): FolderCount[] => {
  // Mutable map: counting occurrences is inherently sequential accumulation
  const counts = new Map<string, number>()
  for (const path of paths) {
    const firstSlash = path.indexOf("/")
    if (firstSlash > 0) {
      const folder = path.slice(0, firstSlash)
      counts.set(folder, (counts.get(folder) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Renders property keys with adoption rates relative to total notes.
 *  Properties below the threshold get a "(low adoption)" suffix. */
const formatPropertyAdoption = (
  propertyKeys: ReadonlyArray<{
    key: string
    count: number
    sample_values: string[]
  }>,
  totalNotes: number,
  limit: number,
  lowAdoptionThreshold: number,
): string => {
  if (propertyKeys.length === 0) return "No frontmatter properties yet."

  return propertyKeys
    .slice(0, limit)
    .map((propertyKey) => {
      const percentage =
        totalNotes > 0 ? Math.round((propertyKey.count / totalNotes) * 100) : 0
      const displayPercentage =
        propertyKey.count > 0 && percentage === 0 ? "<1" : String(percentage)
      const samples =
        propertyKey.sample_values.length > 0
          ? ` — e.g. ${propertyKey.sample_values.join(", ")}`
          : ""
      const lowAdoption =
        totalNotes > 0 && propertyKey.count / totalNotes < lowAdoptionThreshold
          ? " (low adoption)"
          : ""
      return `- ${propertyKey.key} (${propertyKey.count}/${totalNotes} — ${displayPercentage}%)${samples}${lowAdoption}`
    })
    .join("\n")
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

/** Renders a structural overview of memory files: file count, scope callouts,
 *  section names with entry counts, and file sizes. Shown before the raw
 *  content in memory-review so the LLM has structural context. */
const formatMemoryStructuralOverview = (
  outlines: readonly MemoryFileOutline[],
  memoryDir: string,
): string => {
  const fileCount = outlines.length
  const header = `${fileCount} memory file${fileCount === 1 ? "" : "s"} in ${memoryDir}/:`

  const fileDetails = outlines
    .map((outline) => {
      const scopeLines = outline.leading_callout?.body
        ? outline.leading_callout.body.split("\n").map((line) => `  ${line}`)
        : []
      const sections = outline.headings
        .filter((heading) => heading.level === 2)
        .map(
          (heading) =>
            `  - ${heading.text}${
              typeof heading.entryCount === "number"
                ? ` (${heading.entryCount} entries)`
                : ""
            }`,
        )
      return [
        `- **${outline.file}** (${outline.bytes} bytes)`,
        ...scopeLines,
        ...sections,
      ].join("\n")
    })
    .join("\n")

  return [header, "", fileDetails].join("\n")
}

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
  const memoryStore = config.memoryEnabled
    ? createMemoryStore({ memoryDir: config.memoryDir })
    : undefined

  // ── vault-orientation ───────────────────────────────────────
  // Zero-arg: omit argsSchema entirely so the SDK calls back as (extra) =>.
  // An empty {} schema would be treated as "has schema" and break arg parsing.
  server.registerPrompt(
    PROMPT_NAMES.VAULT_ORIENTATION,
    {
      title: "Orient to this vault",
      description: config.memoryEnabled
        ? `Survey this vault's structure and health — stats, folders, tags, properties (with adoption rates), orphans, recent notes, and the ${config.memoryDir}/ memory layer.`
        : `Survey this vault's structure and health — stats, folders, tags, properties (with adoption rates), orphans, and recent notes.`,
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
        const paths = await vaultFs.listNotes({ vaultPath }, reqLogger)
        const memoryFiles =
          config.memoryEnabled && memoryStore
            ? await memoryStore.listMemoryFiles({ vaultPath }, reqLogger)
            : []
        const orphanResults = search.findOrphans(
          {
            excludeFolders: [...config.orphanExcludeFolders],
            limit: ORIENTATION_ORPHAN_LIMIT + 1,
          },
          reqLogger,
        )
        const hasMoreOrphans = orphanResults.length > ORIENTATION_ORPHAN_LIMIT
        const orphans = orphanResults.slice(0, ORIENTATION_ORPHAN_LIMIT)
        const brokenLinks = search.brokenLinkCount(reqLogger)
        const stats = search.vaultStats(reqLogger)

        const folderCounts = deriveFolderCounts(paths)
        const statsLine = [
          `${stats.totalNotes} notes across ${folderCounts.length} folders, ${tags.length} tags, ${propertyKeys.length} property keys.`,
          ...(stats.untaggedNotes > 0
            ? [`${stats.untaggedNotes} untagged.`]
            : []),
          ...(stats.noPropertiesNotes > 0
            ? [`${stats.noPropertiesNotes} without properties.`]
            : []),
          ...(brokenLinks > 0
            ? [`${brokenLinks} broken link${brokenLinks === 1 ? "" : "s"}.`]
            : []),
        ].join(" ")

        const foldersSection =
          folderCounts.length > 0
            ? folderCounts
                .map((folder) => `- ${folder.name} (${folder.count})`)
                .join("\n")
            : "No folders yet — notes live at the vault root."
        const tagsSection =
          tags.length > 0
            ? tags
                .slice(0, ORIENTATION_TAG_LIMIT)
                .map((tag) => `- #${tag.tag} (${tag.count})`)
                .join("\n")
            : "No tags yet."
        const propertyKeysSection = formatPropertyAdoption(
          propertyKeys,
          stats.totalNotes,
          ORIENTATION_PROPERTY_LIMIT,
          ORIENTATION_LOW_ADOPTION_THRESHOLD,
        )
        const recentSection =
          recent.length > 0
            ? recent.map(formatNoteLine).join("\n")
            : "No notes yet."
        const orphanSection =
          orphans.length > 0
            ? [
                `${orphans.length}${hasMoreOrphans ? "+" : ""} orphan notes (no incoming links):`,
                ...orphans.map(formatNoteLine),
              ].join("\n")
            : "No orphans found — every note has at least one incoming link."
        const memorySection = config.memoryEnabled
          ? memoryFiles.length > 0
            ? formatMemoryOutline(memoryFiles)
            : `No memory files yet — the ${config.memoryDir}/ layer is empty. Use vault_update_memory to start it.`
          : ""

        const goDeeper = [
          "- `vault_search` — full-text search across all notes",
          "- `vault_search_by_tag` — explore notes by tag",
          "- `vault_list_property_values` — explore values for any property key",
          ...(orphans.length > 0
            ? [
                "- `vault_find_orphans` — full orphan list with exclusion control",
              ]
            : []),
          ...(config.memoryEnabled
            ? ["- `vault_get_memory` — read memory files in detail"]
            : []),
          "- `vault_read_note` — read any note's full content",
        ].join("\n")

        const text = [
          "# Vault orientation",
          "",
          "This vault is a structured, convention-driven Obsidian system. Survey its structure and health below, then use the vault tools to go deeper.",
          "",
          "## Vault stats",
          statsLine,
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
          "## Orphans",
          orphanSection,
          ...(config.memoryEnabled
            ? ["", `## Memory (${config.memoryDir}/)`, memorySection]
            : []),
          "",
          "---",
          "Go deeper with the vault tools:",
          goDeeper,
        ].join("\n")
        reqLogger.info("prompt_result", {
          outcome: "ok",
          chars: text.length,
          memoryFiles: memoryFiles.length,
          orphanCount: orphans.length,
          brokenLinks,
        })
        return textResult(text)
      } catch (err) {
        const message = describeError(err)
        reqLogger.error("prompt_error", { error: message })
        return textResult(
          config.memoryEnabled
            ? `Could not fully survey the vault (${message}). You can still explore it directly with the vault tools — try vault_list_tags, vault_list_property_keys, vault_find_orphans, and vault_list_memory_files.`
            : `Could not fully survey the vault (${message}). You can still explore it directly with the vault tools — try vault_list_tags, vault_list_property_keys, and vault_find_orphans.`,
        )
      }
    },
  )

  // ── memory-review ───────────────────────────────────────────
  // The memory layer is append-with-dates, read as an EVOLUTION — never a
  // "newest supersedes older" record. This prompt narrates the trajectory and
  // proposes append-only changes; it deliberately does not hunt for "stale"
  // entries to prune or frame evolving beliefs as contradictions to reconcile.
  if (config.memoryEnabled && memoryStore) {
    server.registerPrompt(
      PROMPT_NAMES.MEMORY_REVIEW,
      {
        title: "Reflect on memory (read as an evolution)",
        description: `Reflect on the ${config.memoryDir}/ memory layer — review its structure and scopes, read dated entries as a timeline, surface scope-fit issues and coverage gaps, and propose append-only updates. Never prunes entries for being old.`,
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
              } catch (err) {
                // Recoverable and high-frequency (fires per keystroke), so warn
                // rather than error — but never swallow it silently.
                sessionLogger.warn("prompt_completion_failed", {
                  prompt: PROMPT_NAMES.MEMORY_REVIEW,
                  error: describeError(err),
                })
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
            reqLogger.info("prompt_result", { outcome: "empty_memory" })
            return textResult(
              `The ${config.memoryDir}/ memory layer is empty — there's nothing to review yet.\n\nMemory is built with vault_update_memory, which appends dated entries (newest-first) under H2 sections of files like Me, Principles, and Opinions. Once a few entries exist, run this prompt again to reflect on them.`,
            )
          }

          // A bad file name degrades to a friendly "valid names" message rather
          // than throwing through to the client. Bad client input → warn.
          if (
            args.file &&
            !outlines.some((outline) => outline.file === args.file)
          ) {
            reqLogger.warn("prompt_bad_argument", {
              argument: "file",
              value: args.file,
            })
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
          const trimmedMemory = memory.trim()
          const truncated =
            maxChars !== undefined && trimmedMemory.length > maxChars
          const scope = args.file
            ? `the ${config.memoryDir}/${args.file} memory file`
            : `the ${config.memoryDir}/ memory layer`

          const structuralOverview = formatMemoryStructuralOverview(
            args.file
              ? outlines.filter((outline) => outline.file === args.file)
              : outlines,
            config.memoryDir,
          )

          const text = [
            `# Memory review — ${args.file ?? "all files"}`,
            "",
            `Below is the current content of ${scope}. It is an **append-with-dates, newest-first** record: each dated entry was true when it was written, and the timeline read top-to-bottom *is* the meaning.`,
            "",
            "## Structure",
            "",
            structuralOverview,
            "",
            "## Current memory",
            "",
            trimmedMemory.length > 0
              ? capContent(trimmedMemory, maxChars, "vault_get_memory")
              : "_(the selected memory is empty)_",
            "",
            "## How to reflect",
            "",
            '1. **Read it as an evolution.** Summarize the current picture (the newest entries) *and* the trajectory that led there. Earlier entries aren\'t wrong — they\'re how things got here. Do **not** treat a newer entry as "overriding" or "superseding" an older one, and do **not** flag beliefs that changed over time as contradictions to reconcile — that misreads the system.',
            "2. **Scope-fit.** Using the scopes shown in the Structure section above, note any entry that seems to belong in a different file or section — does the entry match the file's declared Contains/Does NOT contain scope?",
            "3. **Backfill gaps.** Point out durable facts that are implied but not yet captured, and propose them as dated append entries (bullet + target file + section).",
            `4. **Corrections (rare, separate).** Only a fact that is mis-recorded or now genuinely incorrect — not one that simply changed over time — warrants a fix. Prefer an appended dated correction that preserves the old entry (history matters); reserve vault_delete_memory for genuinely wrong facts.`,
            "5. **Coverage analysis.** What areas of the user's life, work, or preferences are NOT yet represented? Use the file scopes and section names above to identify gaps worth filling.",
            "",
            "Propose every change as an explicit vault_update_memory call (newest-first; the server stamps the date) and **confirm with me before writing anything**. Never delete an entry just for being old.",
          ].join("\n")
          reqLogger.info("prompt_result", {
            outcome: "ok",
            file: args.file ?? null,
            files: outlines.length,
            chars: text.length,
            truncated,
          })
          return textResult(text)
        } catch (err) {
          const message = describeError(err)
          reqLogger.error("prompt_error", { error: message })
          return textResult(
            `Could not load memory for review (${message}). Try vault_list_memory_files and vault_get_memory to inspect the ${config.memoryDir}/ layer directly.`,
          )
        }
      },
    )
  } // end memory-review guard

  // ── daily-review ────────────────────────────────────────────
  // Daily notes are the journaling surface of the daily rhythm and they feed
  // the append-with-dates memory loop — so this prompt closes by inviting
  // durable facts up into the memory layer.
  server.registerPrompt(
    PROMPT_NAMES.DAILY_REVIEW,
    {
      title: "Daily review & reconciliation",
      description: config.memoryEnabled
        ? `Review a day's daily note — its content, outgoing links (with broken-link detection), backlinks, and date-specific activity — reconcile what happened, extract tasks, and surface durable facts worth saving to ${config.memoryDir}/ memory.`
        : `Review a day's daily note — its content, outgoing links (with broken-link detection), backlinks, and date-specific activity — reconcile what happened and extract tasks.`,
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
        const daily = await getDailyNote(
          { vaultPath, date: args.date },
          reqLogger,
        )
        const dateArg = args.date ?? DateTime.now().toISODate()!
        const modifiedOnDate = search.modifiedOnDate(
          { date: dateArg, limit: DAILY_RECENT_LIMIT },
          reqLogger,
        )
        const outgoingLinks = daily.exists
          ? search.getOutgoingLinks({ path: daily.path }, reqLogger)
          : []
        const backlinks = daily.exists
          ? search.getBacklinks({ path: daily.path }, reqLogger)
          : []

        const trimmedDaily = daily.content?.trim() ?? ""
        const truncated =
          maxChars !== undefined && trimmedDaily.length > maxChars
        const dailySection =
          daily.exists && trimmedDaily.length > 0
            ? capContent(trimmedDaily, maxChars, "vault_get_daily_note")
            : `_No daily note exists at \`${daily.path}\` yet._`

        const brokenLinks = outgoingLinks.filter((link) => !link.exists)
        const outgoingSection =
          daily.exists && outgoingLinks.length > 0
            ? [
                ...outgoingLinks.map((link) =>
                  link.exists
                    ? `- ${link.path}${link.title ? ` — ${link.title}` : ""}`
                    : `- ${link.path} (**broken** — target does not exist)`,
                ),
                ...(brokenLinks.length > 0
                  ? [
                      "",
                      `${brokenLinks.length} broken link${brokenLinks.length === 1 ? "" : "s"} — the target note${brokenLinks.length === 1 ? " does" : "s do"} not exist yet.`,
                    ]
                  : []),
              ].join("\n")
            : daily.exists
              ? "No outgoing links in this daily note."
              : "_Daily note does not exist — no link analysis available._"
        const backlinksSection =
          daily.exists && backlinks.length > 0
            ? backlinks.map(formatNoteLine).join("\n")
            : daily.exists
              ? "No other notes link to this daily note."
              : "_Daily note does not exist — no link analysis available._"
        const modifiedSection =
          modifiedOnDate.length > 0
            ? modifiedOnDate.map(formatNoteLine).join("\n")
            : `No notes were modified on ${dateArg}.`

        const reviewSteps = [
          "**Reconcile the day** — what got done, what's still open, what changed — cross-referencing the notes and links above.",
          "**Capture follow-ups** as concrete next actions; with my OK, append them to the daily note with vault_patch_note.",
          ...(config.memoryEnabled
            ? [
                `**Surface durable facts** — any preference, decision, or fact worth remembering long-term — and propose saving it to ${config.memoryDir}/ memory via vault_update_memory (append-with-dates, newest-first). Confirm before writing.`,
              ]
            : []),
          ...(daily.exists
            ? [
                "**Task extraction** — identify any incomplete tasks (`- [ ]`) in the daily note. Are any overdue or blocked?",
                "**Follow the links** — read linked notes (see outgoing links above) for full context on what was referenced today.",
                "**Pattern recognition** — look for recurring themes, repeated tasks, or persistent concerns across this note and recent activity.",
              ]
            : []),
        ]
        const reviewSection = reviewSteps
          .map((step, index) => `${index + 1}. ${step}`)
          .join("\n")

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
          "## Outgoing links",
          "",
          outgoingSection,
          "",
          "## Backlinks",
          "",
          backlinksSection,
          "",
          `## Notes modified on ${dateArg}`,
          "",
          modifiedSection,
          "",
          "## How to review",
          "",
          reviewSection,
        ].join("\n")
        reqLogger.info("prompt_result", {
          outcome: daily.exists ? "ok" : "no_note",
          chars: text.length,
          truncated,
          outgoingLinks: outgoingLinks.length,
          brokenLinks: brokenLinks.length,
          backlinks: backlinks.length,
        })
        return textResult(text)
      } catch (err) {
        const message = describeError(err)
        reqLogger.error("prompt_error", { error: message })
        return textResult(
          `Could not load the daily note (${message}). Try vault_get_daily_note to fetch it directly.`,
        )
      }
    },
  )

  const promptCount =
    Object.keys(PROMPT_NAMES).length - (config.memoryEnabled ? 0 : 1)
  sessionLogger.info("registered prompts", { count: promptCount })
}
