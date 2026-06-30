/** memory-review prompt — reflect on the memory layer as an evolution.
 *
 *  The memory layer is append-with-dates, read as an EVOLUTION — never a
 *  "newest supersedes older" record. This prompt narrates the trajectory and
 *  proposes append-only changes; it deliberately does not hunt for "stale"
 *  entries to prune or frame evolving beliefs as contradictions to reconcile. */

import { completable } from "@modelcontextprotocol/sdk/server/completable.js"
import { z } from "zod"
import {
  createMemoryStore,
  type MemoryFileOutline,
} from "../../vault-operations/memory-store.js"
import { describeError } from "../../../utils/describe-error.js"
import {
  type PromptRegistrationContext,
  textResult,
  wrapWithDataMarkers,
  maxCharsArg,
} from "./prompt-helpers.js"

const PROMPT_NAMES = {
  MEMORY_REVIEW: "memory-review",
} as const
export { PROMPT_NAMES as MEMORY_REVIEW_PROMPT_NAMES }

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

export const registerMemoryReviewPrompt = ({
  server,
  vaultPath,
  logger: sessionLogger,
  config,
}: PromptRegistrationContext): void => {
  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })

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
        max_chars: maxCharsArg,
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
            ? wrapWithDataMarkers(
                trimmedMemory,
                {
                  source: args.file
                    ? `${config.memoryDir}/${args.file}`
                    : config.memoryDir,
                  type: "memory",
                },
                maxChars,
                "vault_get_memory",
              )
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
}
