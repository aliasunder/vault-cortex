/** vault-orientation prompt — zero-arg survey of vault structure and health. */

import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import { createMemoryStore, type MemoryFileOutline } from "../../vault-operations/memory-store.js"
import { vaultFs } from "../../vault-operations/vault-filesystem.js"
import { resolveEffectiveOrphanExcludeFolders } from "../../vault-operations/vault-folder-config.js"
import { readDailyNotesConfig } from "../../vault-operations/daily-notes.js"
import { describeErrorForLog } from "../../../utils/describe-error.js"
import { compareByUtf8Bytes } from "../../../utils/compare-utf8-bytes.js"
import type { ToolName } from "../tool-registry.js"
import {
  type PromptRegistrationContext,
  describeErrorForPromptFallback,
  textResult,
  formatNoteLine,
  trackedPromptHandler,
} from "./prompt-helpers.js"

const PROMPT_NAMES = {
  VAULT_ORIENTATION: "vault-orientation",
} as const
export { PROMPT_NAMES as VAULT_ORIENTATION_PROMPT_NAMES }

// How many entries to show in the orientation survey before truncating — enough
// to convey the vault's conventions without flooding the prompt.
const ORIENTATION_TAG_LIMIT = 30
const ORIENTATION_PROPERTY_LIMIT = 30
const ORIENTATION_RECENT_LIMIT = 10
const ORIENTATION_ORPHAN_LIMIT = 5
const ORIENTATION_LOW_ADOPTION_THRESHOLD = 0.05

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
  return (
    [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      // Sort by UTF-8 byte order (matches SQLite BINARY collation for deterministic output).
      .toSorted((folderA, folderB) => compareByUtf8Bytes(folderA.name, folderB.name))
  )
}

/** Formats a single property key with its adoption rate, sample values, and
 *  a low-adoption flag when below the threshold. */
const formatPropertyLine = (
  propertyKey: { key: string; count: number; sample_values: string[] },
  totalNotes: number,
  lowAdoptionThreshold: number,
): string => {
  const percentage = totalNotes > 0 ? Math.round((propertyKey.count / totalNotes) * 100) : 0
  const displayPercentage = propertyKey.count > 0 && percentage === 0 ? "<1" : String(percentage)
  const samples =
    propertyKey.sample_values.length > 0 ? ` — e.g. ${propertyKey.sample_values.join(", ")}` : ""
  const isLowAdoption = totalNotes > 0 && propertyKey.count / totalNotes < lowAdoptionThreshold
  const lowAdoptionFlag = isLowAdoption ? " (low adoption)" : ""

  return `- ${propertyKey.key} (${propertyKey.count}/${totalNotes} — ${displayPercentage}%)${samples}${lowAdoptionFlag}`
}

/** Renders property keys with adoption rates relative to total notes. */
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
    .map((key) => formatPropertyLine(key, totalNotes, lowAdoptionThreshold))
    .join("\n")
}

/** Formats a single memory file as a bullet with its H2 section names. */
const formatMemoryOutlineEntry = (outline: MemoryFileOutline): string => {
  const sectionLines = outline.headings
    .filter((heading) => heading.level === 2)
    .map((heading) => {
      const entryCount = heading.entry_count != null ? ` (${heading.entry_count})` : ""
      return `  - ${heading.text}${entryCount}`
    })
  return [`- ${outline.file}`, ...sectionLines].join("\n")
}

/** Renders memory-file outlines as a nested list of files and their H2
 *  sections with entry counts — the same shape vault_list_memory_files returns. */
const formatMemoryOutline = (outlines: readonly MemoryFileOutline[]): string =>
  outlines.map(formatMemoryOutlineEntry).join("\n")

/** The "excludes N forward-refs to daily notes" note. */
const formatExcludedForwardRefs = (excludedCount: number): string => {
  const forwardReferenceLabel = excludedCount === 1 ? "forward-ref" : "forward-refs"
  return `excludes ${excludedCount} ${forwardReferenceLabel} to daily notes`
}

/** Formats the broken-link count for the stats line, including excluded
 *  forward-refs when present. Returns "" when both counts are zero. */
const formatBrokenLinkSegment = (result: { count: number; excludedCount: number }): string => {
  const { count, excludedCount } = result

  if (count === 0 && excludedCount === 0) return ""

  const linkCount = `${count} broken link${count === 1 ? "" : "s"}`
  const parenthetical = excludedCount > 0 ? ` (${formatExcludedForwardRefs(excludedCount)})` : ""
  return `${linkCount}${parenthetical}.`
}

export const registerVaultOrientationPrompt = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
  isToolEnabled,
  whenToolEnabledText,
  formatEnabledToolList,
}: PromptRegistrationContext): void => {
  const memoryStore = config.memoryEnabled
    ? createMemoryStore({ memoryDir: config.memoryDir })
    : undefined

  // This prompt takes no arguments, so it omits argsSchema entirely and the SDK
  // calls back as (extra) =>; an empty {} schema would count as a schema and
  // break arg parsing. With no argsSchema to infer from, the explicit type
  // argument keeps the callback passed to trackedPromptHandler typed.
  server.registerPrompt<ZodRawShapeCompat>(
    PROMPT_NAMES.VAULT_ORIENTATION,
    {
      title: "Orient to this vault",
      description: config.memoryEnabled
        ? `Survey this vault's structure and health — stats, folders, tags, properties (with adoption rates), orphans, recent notes, and the ${config.memoryDir}/ memory layer.`
        : `Survey this vault's structure and health — stats, folders, tags, properties (with adoption rates), orphans, and recent notes.`,
    },
    trackedPromptHandler(search, async (extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        prompt: PROMPT_NAMES.VAULT_ORIENTATION,
      })
      reqLogger.info("prompt_call")

      // A prompt must never hard-fail the client; degrade to a valid message
      // that still points at the tools if any data gathering throws.
      try {
        const tags = search.listAllTags({}, reqLogger)
        const propertyKeys = search.listPropertyKeys({}, reqLogger)
        const recent = search.recentNotes(
          { sort_by: "modified", limit: ORIENTATION_RECENT_LIMIT },
          reqLogger,
        )
        const paths = await vaultFs.listNotes({ vaultPath }, reqLogger)
        const memoryFiles = memoryStore
          ? await memoryStore.listMemoryFiles({ vaultPath }, reqLogger)
          : []
        // Read the daily-notes settings here rather than through
        // readEffectiveOrphanExcludeFolders, which reads them itself, because
        // the broken-link count below needs the same settings.
        const dailyNotesConfig = await readDailyNotesConfig(
          {
            vaultPath,
            envSettings: { folder: config.dailyNotesFolder, format: config.dailyNotesFormat },
          },
          reqLogger,
        )
        const orphanResults = search.findOrphans(
          {
            excludeFolders: resolveEffectiveOrphanExcludeFolders({
              orphanExcludeFoldersOverride: config.orphanExcludeFoldersOverride,
              memoryDir: config.memoryDir,
              dailyNotesFolder: dailyNotesConfig.dedicatedFolder,
            }),
            limit: ORIENTATION_ORPHAN_LIMIT + 1,
          },
          reqLogger,
        )
        const hasMoreOrphans = orphanResults.length > ORIENTATION_ORPHAN_LIMIT
        const orphans = orphanResults.slice(0, ORIENTATION_ORPHAN_LIMIT)
        const brokenLinkResult = search.brokenLinkCount(
          {
            dailyNotesFolder: dailyNotesConfig.dedicatedFolder,
            dailyNotesFormat: dailyNotesConfig.format,
          },
          reqLogger,
        )
        const stats = search.vaultStats({}, reqLogger)

        const folderCounts = deriveFolderCounts(paths)

        // ── Format each section ──────────────────────────────────

        const brokenLinkSegment = formatBrokenLinkSegment(brokenLinkResult)
        const statsLine = [
          `${stats.totalNotes} notes across ${folderCounts.length} folders, ${tags.length} tags, ${propertyKeys.length} property keys.`,
          stats.untaggedNotes > 0 ? `${stats.untaggedNotes} untagged.` : "",
          stats.noPropertiesNotes > 0 ? `${stats.noPropertiesNotes} without properties.` : "",
          brokenLinkSegment,
        ]
          .filter(Boolean)
          .join(" ")

        const foldersSection =
          folderCounts.length > 0
            ? folderCounts.map((folder) => `- ${folder.name} (${folder.count})`).join("\n")
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
          recent.length > 0 ? recent.map(formatNoteLine).join("\n") : "No notes yet."

        const orphanCountLabel = `${orphans.length}${hasMoreOrphans ? "+" : ""}`
        const orphanSection =
          orphans.length > 0
            ? [
                `${orphanCountLabel} orphan notes (no incoming links):`,
                ...orphans.map(formatNoteLine),
              ].join("\n")
            : "No orphans found after folder exclusions."

        const memorySectionContent =
          memoryFiles.length > 0
            ? formatMemoryOutline(memoryFiles)
            : `No memory files yet — the ${config.memoryDir}/ layer is empty.${whenToolEnabledText("vault_update_memory", " Use vault_update_memory to start it.")}`
        const memorySection = config.memoryEnabled ? memorySectionContent : ""

        // The "go deeper" menu is a list of calls to make, so every line is
        // keyed on its own tool being served — a suggestion the client cannot
        // act on is worse than a shorter menu. The orphan line additionally
        // requires orphans to exist.
        // Each entry is [toolName, markdownLine, show?] — show defaults to
        // undefined; `show !== false` below lets both true and undefined pass.
        const goDeeperEntries: ReadonlyArray<
          readonly [name: ToolName, line: string, show?: boolean]
        > = [
          [
            "vault_search",
            `- \`vault_search\` — ${config.embeddingEnabled ? "hybrid" : "full-text"} search across all notes`,
          ],
          ["vault_search_by_tag", "- `vault_search_by_tag` — explore notes by tag"],
          [
            "vault_list_property_values",
            "- `vault_list_property_values` — explore values for any property key",
          ],
          [
            "vault_find_orphans",
            "- `vault_find_orphans` — full orphan list with exclusion control",
            orphans.length > 0,
          ],
          ["vault_get_memory", "- `vault_get_memory` — read memory files in detail"],
          ["vault_read_note", "- `vault_read_note` — read any note's full content"],
          [
            "vault_list_files",
            "- `vault_list_files` — browse non-markdown files (images, canvases, data files)",
          ],
        ]
        const goDeeper = goDeeperEntries
          .filter(([name, , show]) => isToolEnabled(name) && show !== false)
          .map(([, line]) => line)
          .join("\n")

        const memorySectionBlock = config.memoryEnabled
          ? `\n## Memory (${config.memoryDir}/)\n${memorySection}`
          : undefined

        const orientationSurvey = [
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
          memorySectionBlock,
          "",
          "---",
          "Go deeper with the vault tools:",
          goDeeper,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
        reqLogger.info("prompt_result", {
          outcome: "ok",
          chars: orientationSurvey.length,
          memoryFiles: memoryFiles.length,
          orphanCount: orphans.length,
          brokenLinks: brokenLinkResult.count,
        })
        return textResult(orientationSurvey)
      } catch (error) {
        // The prompt takes no arguments, so a failure caught here is the
        // server's own and logs at error, not warn
        reqLogger.error("prompt_error", describeErrorForLog(error))
        const clientMessage = describeErrorForPromptFallback({ error, vaultPath })
        const fallbackTools = formatEnabledToolList([
          "vault_list_tags",
          "vault_list_property_keys",
          "vault_find_orphans",
          ...(config.memoryEnabled ? (["vault_list_memory_files"] as const) : []),
        ])
        const fallbackHint = fallbackTools
          ? ` You can still explore it directly with the vault tools — try ${fallbackTools}.`
          : ""
        return textResult(`Could not fully survey the vault (${clientMessage}).${fallbackHint}`)
      }
    }),
  )
}
