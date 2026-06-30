/** vault-orientation prompt — zero-arg survey of vault structure and health. */

import {
  createMemoryStore,
  type MemoryFileOutline,
} from "../../vault-operations/memory-store.js"
import { vaultFs } from "../../vault-operations/vault-filesystem.js"
import { describeError } from "../../../utils/describe-error.js"
import {
  type PromptRegistrationContext,
  textResult,
  formatNoteLine,
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

export const registerVaultOrientationPrompt = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: PromptRegistrationContext): void => {
  const memoryStore = config.memoryEnabled
    ? createMemoryStore({ memoryDir: config.memoryDir })
    : undefined

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
        const tags = search.listAllTags({}, reqLogger)
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
        const brokenLinkResult = search.brokenLinkCount({}, reqLogger)
        const stats = search.vaultStats({}, reqLogger)

        const folderCounts = deriveFolderCounts(paths)
        const {
          count: brokenCount,
          excludedFolder,
          excludedCount,
        } = brokenLinkResult
        const excludedNote =
          excludedCount > 0
            ? `excludes ${excludedCount} forward-ref${excludedCount === 1 ? "" : "s"} in ${excludedFolder}/`
            : ""
        const brokenLinkSegment =
          brokenCount > 0 || excludedNote.length > 0
            ? `${brokenCount} broken link${brokenCount === 1 ? "" : "s"}${excludedNote.length > 0 ? ` (${excludedNote})` : ""}.`
            : ""
        const statsLine = [
          `${stats.totalNotes} notes across ${folderCounts.length} folders, ${tags.length} tags, ${propertyKeys.length} property keys.`,
          stats.untaggedNotes > 0 ? `${stats.untaggedNotes} untagged.` : "",
          stats.noPropertiesNotes > 0
            ? `${stats.noPropertiesNotes} without properties.`
            : "",
          brokenLinkSegment,
        ]
          .filter(Boolean)
          .join(" ")

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

        const orphanTools =
          orphans.length > 0
            ? "- `vault_find_orphans` — full orphan list with exclusion control"
            : ""
        const memoryTools = config.memoryEnabled
          ? "- `vault_get_memory` — read memory files in detail"
          : ""
        const goDeeper = [
          "- `vault_search` — full-text search across all notes",
          "- `vault_search_by_tag` — explore notes by tag",
          "- `vault_list_property_values` — explore values for any property key",
          orphanTools,
          memoryTools,
          "- `vault_read_note` — read any note's full content",
        ]
          .filter(Boolean)
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
}
