/** Vault CRUD tool registrations — read, write, patch, replace, delete, move. */

import { z } from "zod"
import {
  vaultFs,
  toVaultRelativePath,
} from "../../vault-operations/vault-filesystem.js"
import { noteMover } from "../../vault-operations/note-mover.js"
import { vaultPatcher } from "../../vault-operations/vault-patcher.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler } from "./tool-helpers.js"

const TOOL_NAMES = {
  VAULT_READ_NOTE: "vault_read_note",
  VAULT_WRITE_NOTE: "vault_write_note",
  VAULT_PATCH_NOTE: "vault_patch_note",
  VAULT_REPLACE_IN_NOTE: "vault_replace_in_note",
  VAULT_DELETE_SPAN: "vault_delete_span",
  VAULT_LIST_NOTES: "vault_list_notes",
  VAULT_DELETE_NOTE: "vault_delete_note",
  VAULT_MOVE_NOTE: "vault_move_note",
  VAULT_UPDATE_PROPERTIES: "vault_update_properties",
} as const

export { TOOL_NAMES as VAULT_CRUD_TOOL_NAMES }

export const registerVaultCrudTools = ({
  server,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  server.registerTool(
    TOOL_NAMES.VAULT_READ_NOTE,
    {
      title: "Read Note",
      description: `Read a markdown note by its vault-relative path. By default returns the full raw content including properties; optional modes return just the properties, just the heading outline, or just one section — so large notes don't blow the token budget.

Example: vault_read_note({ path: "Projects/vault-cortex.md" })
Example: vault_read_note({ path: "Projects/vault-cortex.md", properties_only: true })
Example: vault_read_note({ path: "TASKS.md", outline: true })
Example: vault_read_note({ path: "TASKS.md", heading: "Active" })
Example: vault_read_note({ path: "TASKS.md", heading: "Done", heading_level: 2 }) // disambiguate when several "Done" headings exist

When to use: You know the exact path and need a specific note's content. For a large note (a long board or doc), use outline: true to see its headings, then heading: "..." to read just the one section you need — both far cheaper than pulling the whole file. Use properties_only: true when you only need properties.
Prefer vault_search when you don't know the path.${config.memoryEnabled ? ` Prefer vault_get_memory for ${config.memoryDir}/ files (returns content without properties).` : ""} To edit a section you've read, use vault_patch_note.

Section boundaries: a section spans from its heading to the next heading of the same or higher level (or EOF). Child headings are included in the parent section.

Modes are mutually exclusive — set at most one of properties_only, outline, or heading. heading_level only applies with heading.

Errors:
- "heading not found" — no heading matches the text; error lists available headings
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate
- "outline, heading, and properties_only are mutually exclusive" — only one mode per call

Returns: Raw markdown string (default); JSON object of properties (properties_only); JSON outline object (outline); raw markdown of the section, heading line included (heading).

Outline shape: { leading_callout?, headings } — headings is [{ level, text, bytes }]; leading_callout ({ type, title, body }) is the note's top-of-file callout, when present.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            `Vault-relative path to the note (e.g. "${config.memoryEnabled ? `${config.memoryDir}/Principles.md` : "Projects/plan.md"}")`,
          ),
        properties_only: z
          .boolean()
          .optional()
          .describe(
            "If true, returns parsed properties as JSON instead of full note content",
          ),
        outline: z
          .boolean()
          .optional()
          .describe(
            "If true, returns { leading_callout?, headings } as JSON instead of body content — a cheap structure fetch for large notes. headings: [{ level, text, bytes }]; leading_callout: { type, title, body } when the note has a top-of-file callout.",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Return only this section (heading line + body, through the next same-or-higher heading). Case-sensitive exact match.",
          ),
        heading_level: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe(
            "Heading level (1-6) for disambiguation when multiple headings share the same text; only applies with heading",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      { path, properties_only, outline, heading, heading_level },
      extra,
    ) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_READ_NOTE,
      })
      reqLogger.info("tool_call", {
        path,
        properties_only,
        outline,
        heading,
        heading_level,
      })

      const returnError = (
        message: string,
      ): { content: Array<{ type: "text"; text: string }>; isError: true } => {
        reqLogger.warn("tool_error", { error: message })
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true as const,
        }
      }

      // The read modes select different content; allowing more than one would
      // make the result ambiguous, so reject the combination up front. An empty
      // heading still counts as section mode (heading !== undefined) so it's
      // rejected here rather than silently falling through to a full read.
      const selectedModeCount = [
        properties_only === true,
        outline === true,
        heading !== undefined,
      ].filter(Boolean).length
      if (selectedModeCount > 1) {
        return returnError(
          "outline, heading, and properties_only are mutually exclusive — set at most one",
        )
      }

      // heading_level only disambiguates a heading; on its own it would be
      // silently ignored, so require its companion explicitly.
      if (heading_level !== undefined && heading === undefined) {
        return returnError("heading_level requires a heading")
      }

      if (properties_only) {
        return safeHandler(
          reqLogger,
          () => vaultFs.readNoteProperties({ vaultPath, path }, reqLogger),
          (properties) => {
            reqLogger.info("tool_result", { mode: "properties" })
            return JSON.stringify(properties, null, 2)
          },
        )
      }

      if (outline) {
        return safeHandler(
          reqLogger,
          () => vaultFs.readNoteOutline({ vaultPath, path }, reqLogger),
          (outline) => {
            reqLogger.info("tool_result", { mode: "outline" })
            return JSON.stringify(outline)
          },
        )
      }

      // A present heading selects section mode; its absence falls through to a
      // full read. The schema's min(1) already rejects an empty heading, so a
      // truthy check is sufficient.
      if (heading) {
        return safeHandler(
          reqLogger,
          () =>
            vaultFs.readNoteSection(
              { vaultPath, path, heading, headingLevel: heading_level },
              reqLogger,
            ),
          (text) => {
            reqLogger.info("tool_result", { mode: "section" })
            return text
          },
        )
      }

      return safeHandler(
        reqLogger,
        () => vaultFs.readNote({ vaultPath, path }, reqLogger),
        (text) => {
          reqLogger.info("tool_result", { mode: "full" })
          return text
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_WRITE_NOTE,
    {
      title: "Write Note",
      description: `Create or update a markdown note. Body replaces the entire note content — this is a full overwrite, not a partial edit. Properties are passed separately and merged with any existing properties (new keys added, matching keys overwritten, keys set to null removed, unmentioned keys preserved).

Example: vault_write_note({ path: "Projects/notes.md", body: "# Notes\\n\\nProject notes here.", properties: { tags: ["project"], type: "project" } })

When to use: Creating a new note or fully replacing an existing note's body.
Prefer vault_update_properties for property-only edits (no body round-trip).${config.memoryEnabled ? `\nPrefer vault_update_memory for appending dated entries to ${config.memoryDir}/ memory files.` : ""}

Limitation: Overwrites the entire body. Do not use for surgical edits to large files — existing content will be lost unless you include it in the body parameter.

Obsidian syntax: Body content is rendered as Obsidian Flavored Markdown with no escaping applied. Beyond standard Markdown, watch for Obsidian-specific patterns:
- #word (no space after #) = tag — escape with \\# or backticks
- [[ = wikilink, ![[ = embed — escape with \\[[
- %% = comment block (hidden in reading view)
Properties: quote wikilink values ("[[Note]]"), use YAML lists for tags ([tag1, tag2]), keep property types consistent across the vault (string/number/list mismatches cause silent query failures).

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path for the note"),
        body: z
          .string()
          .describe("Markdown body content (no frontmatter fences)"),
        properties: z
          .record(z.string().min(1), z.unknown())
          .optional()
          .describe(
            "Optional properties to merge. New keys are added; existing keys with matching names are overwritten; a null value deletes that key; unmentioned keys are preserved from the existing file.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, body, properties }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_WRITE_NOTE,
      })
      reqLogger.info("tool_call", {
        path,
        hasProperties: properties !== undefined,
      })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.writeNote({ vaultPath, path, body, properties }, reqLogger),
        () => {
          reqLogger.info("tool_result", { outcome: "written" })
          return `Wrote ${path}`
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_PATCH_NOTE,
    {
      title: "Patch Note",
      description: `Surgical edits to a markdown note — append, prepend, replace, or insert content by heading. Frontmatter values are preserved; YAML formatting may be normalized to block style on first edit.

Example: vault_patch_note({ path: "TASKS.md", operation: "append", heading: "Active", content: "- [ ] New task" })

Cross-section move (e.g. completing a task on a board):
1. vault_read_note to get current content and verify exact text
2. vault_replace_in_note({ path, old_text: "- [ ] Task text", new_text: "" }) to remove from source (for a large multi-line block, prefer vault_delete_span)
3. vault_patch_note({ path, operation: "append", heading: "Done", content: "- [x] Task text" }) to add at target

When to use: Modifying part of an existing note without overwriting the entire body.
Prefer vault_write_note for creating new notes or full rewrites. Prefer vault_replace_in_note for in-place text changes (typos, renaming) that stay in the same location.

Operations:
- append: add content at end of section (or end of file if no heading)
- prepend: add content after heading line (or at the top of the body, below frontmatter, if no heading — how you add a leading callout)
- replace: replace section body (heading preserved; requires heading)
- insert_before: insert content above the heading line (requires heading)

Heading-targeted ops keep the matched heading and write content verbatim — don't begin content with the target heading (it's rejected to avoid a duplicate).

Section boundaries: a section spans from its heading to the next heading of the same or higher level (or EOF). Child headings are included in the parent section.

Editing a leading callout: read it via vault_read_note(outline: true), then vault_replace_in_note the old block for the new one (a no-heading prepend would stack a second callout above it).

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "heading not found" — no heading matches the text; error lists available headings
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate, or rename a heading if they share the same level
- "operation requires a heading target" — replace and insert_before need a heading
- "content begins with the heading … which would duplicate it" — content's first line repeats the target heading; omit it (the matched heading is kept automatically)

Obsidian syntax: Content is rendered as Obsidian Flavored Markdown with no escaping applied. Beyond standard Markdown, watch for: #word (no space) = tag, [[ = wikilink, %% = comment block. Escape with \\# or \\[[ when unintentional.
Structural note: inserting heading-level content (e.g. ## New Section) changes the note's section structure — future patch calls targeting headings may resolve differently.
Table note: when prepending/appending a row to an existing markdown table, send only the data row (e.g. "| cell1 | cell2 |") — do not include the table header or separator row, which already exist. A duplicated header splits the table in two.

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
        operation: z
          .enum(["append", "prepend", "replace", "insert_before"])
          .describe("Patch operation to apply"),
        content: z
          .string()
          .min(1)
          .describe("Content to insert or replace with"),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target heading text (case-sensitive exact match). Required for replace and insert_before. Optional for append/prepend (omit for file-level operation).",
          ),
        heading_level: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe(
            "Heading level (1-6) for disambiguation when multiple headings share the same text",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, operation, content, heading, heading_level }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_PATCH_NOTE,
      })
      reqLogger.info("tool_call", { path, operation, heading, heading_level })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.patchNote(
            {
              vaultPath,
              path,
              operation,
              content,
              heading,
              headingLevel: heading_level,
            },
            reqLogger,
          ),
        (msg) => {
          reqLogger.info("tool_result", { outcome: "patched" })
          return msg
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
    {
      title: "Replace in Note",
      description: `Find and replace text in a markdown note's body. Matches exact text (case-sensitive). Properties are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only — properties must be edited via vault_update_properties or vault_write_note's properties parameter.

Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "TODO: write summary", new_text: "Summary complete." })

When to use: Targeted text changes within a single location — fixing typos, updating values, renaming terms, or removing a short line (new_text=""). Replaces text in place; does not move content across sections.
To delete a large multi-line block without re-quoting it, prefer vault_delete_span — it references the block by short anchors instead of echoing the full old_text.
To relocate content between headings, use vault_replace_in_note to remove from the source (new_text=""), then vault_patch_note to append at the target. Read the note first with vault_read_note to confirm exact text.

Limitation: Exact text match only (no regex). old_text must appear in the note body or an error is returned.

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "text not found" — old_text does not appear in the note body; verify exact text with vault_read_note
- "old_text cannot be empty" — old_text must be at least one character

Obsidian syntax: new_text is rendered as Obsidian Flavored Markdown with no escaping applied. Beyond standard Markdown, Obsidian-specific patterns (#word = tag, [[ = wikilink, %% = comment block) apply to replacement text. Verify replacements won't introduce unintended Obsidian rendering.

Returns: Confirmation message with replacement count.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
        old_text: z
          .string()
          .min(1)
          .describe("Exact text to find (case-sensitive, non-empty)"),
        new_text: z.string().describe("Replacement text"),
        replace_all_occurrences: z
          .boolean()
          .optional()
          .describe(
            "Replace all occurrences (default: false — replaces first occurrence only)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, old_text, new_text, replace_all_occurrences }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
      })
      reqLogger.info("tool_call", {
        path,
        isDeletion: new_text.length === 0,
        replace_all_occurrences,
      })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.replaceInNote(
            {
              vaultPath,
              path,
              oldText: old_text,
              newText: new_text,
              replaceAllOccurrences: replace_all_occurrences,
            },
            reqLogger,
          ),
        (result) => {
          reqLogger.info("tool_result", {
            outcome: "replaced",
            count: result.count,
          })
          return result.message
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_DELETE_SPAN,
    {
      title: "Delete Span",
      description: `Delete a contiguous block of whole lines from a note's body by naming it with short anchor substrings — without reproducing the block's text. More reliable than passing a large block as old_text to vault_replace_in_note: a short, unique fragment can't drift from the original the way a re-quoted multi-line block can, and you don't regenerate the whole block. Matches exact text (case-sensitive). Properties are preserved; operates on the body only.

Example: vault_delete_span({ path: "Tracker.md", start_anchor: "| 2024-03-02 | Acme" }) — deletes the one table row whose line contains that fragment.
Example: vault_delete_span({ path: "Notes/Plan.md", start_anchor: "> [!warning] Stale", end_anchor: "remove after launch" }) — deletes the multi-line block from the line containing the start anchor through the line containing the end anchor.

When to use: Removing a block you have already read — a single long line (e.g. a wide table row) or a multi-line block (a callout, a run of list items) — where reproducing it exactly as old_text would be error-prone or wasteful. Pick a short, unique fragment of the first line for start_anchor and, for a multi-line block, the last line for end_anchor; you never paste the block itself.
Prefer vault_replace_in_note for small in-place edits or renames where sending old_text is fine, and for replacing text (this tool only deletes). To replace a block, delete it here, then vault_patch_note (append/prepend by heading) to add the new content.

Anchoring: the span covers whole lines — from the line containing start_anchor through the line containing end_anchor (inclusive), or just that one line when end_anchor is omitted. An anchor only locates a line; the entire line is removed regardless of where in it the anchor matches — it never cuts mid-line (prefer vault_replace_in_note for character-precise, in-place edits).
Matching: end_anchor is searched at or after the start line, so the span can never run backward. By default each anchor must match exactly one line; on a tie, pass first_match to take the first. After deletion, runs of blank lines are collapsed so no gap is left. A trailing %% comment block (e.g. kanban:settings) is affected only if your anchors point into it.

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "start anchor not found" / "end anchor not found ... at or after the start anchor" — the fragment is not on any (qualifying) line; verify exact text with vault_read_note
- "ambiguous start anchor ... matches N lines" / "ambiguous end anchor ..." — the fragment is on more than one line; use a longer, unique fragment or set first_match: true
- "start_anchor cannot be empty" / "end_anchor cannot be empty"

Obsidian syntax: Anchors are matched as literal text against the Obsidian Flavored Markdown source, never as regex — match #tags, [[wikilinks|aliases]], and %% comments exactly as they appear in the note (verify with vault_read_note). This tool only removes content; it inserts none.

Returns: Confirmation message with the number of lines removed and a truncated preview of the deleted text.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
        start_anchor: z
          .string()
          .min(1)
          .describe(
            "Short, unique substring on the first line of the block to delete (case-sensitive). Pick a brief fragment — do not paste the whole block.",
          ),
        end_anchor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short, unique substring on the LAST line of the block, searched at or after the start_anchor line. Omit to delete just the single line containing start_anchor.",
          ),
        first_match: z
          .boolean()
          .optional()
          .describe(
            "If an anchor matches more than one line, delete using the first match instead of erroring (default: false — ambiguity is an error).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, start_anchor, end_anchor, first_match }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_DELETE_SPAN,
      })
      reqLogger.info("tool_call", {
        path,
        hasEndAnchor: end_anchor !== undefined,
        first_match,
      })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.deleteSpan(
            {
              vaultPath,
              path,
              startAnchor: start_anchor,
              endAnchor: end_anchor,
              firstMatch: first_match,
            },
            reqLogger,
          ),
        (msg) => {
          reqLogger.info("tool_result", { outcome: "span_deleted" })
          return msg
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_NOTES,
    {
      title: "List Notes",
      description: `List .md file paths in the vault, optionally filtered by folder and/or glob pattern. Returns paths only — not content or metadata.

Example: vault_list_notes({ folder: "Projects" }) or vault_list_notes({ glob: "**/*session-log*.md" })

When to use: Browsing what exists in a folder by filename, or finding notes matching a path pattern.
Prefer vault_search_by_folder when you need metadata (tags, type, related) along with paths. Prefer vault_search for content-based discovery.

Returns: JSON array of vault-relative paths.`,
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe(
            `Folder to list (e.g. ${config.memoryEnabled ? `"${config.memoryDir}", ` : ""}"Projects")`,
          ),
        glob: z
          .string()
          .optional()
          .describe(
            'Glob pattern to filter paths (e.g. "Projects/**/*.md", "*.md"). Supports * and ** wildcards.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, glob }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_LIST_NOTES,
      })
      reqLogger.info("tool_call", { folder, glob })
      return safeHandler(
        reqLogger,
        () => vaultFs.listNotes({ vaultPath, folder, glob }, reqLogger),
        (paths) => {
          reqLogger.info("tool_result", { resultCount: paths.length })
          return JSON.stringify(paths)
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_DELETE_NOTE,
    {
      title: "Delete Note",
      description: `Permanently delete a markdown note. The note is removed from disk directly (not moved to a trash folder), and this server has no undo — recovery depends on your own backups or sync history. After deletion it no longer appears in search results or backlinks, and links to it from other notes become broken (detectable via vault_get_outgoing_links). Protected paths (${config.protectedPaths.map((p) => p + "/").join(", ")}) are refused to prevent accidental loss of memory or daily notes.

Example: vault_delete_note({ path: "Scratch/temp.md" })
Example: vault_delete_note({ path: "Archive/2024/old.md", prune_empty_folders: true }) — also remove "Archive/2024" (and "Archive") if deleting the note empties them.

When to use: Removing a note you no longer need.${config.memoryEnabled ? `\nPrefer vault_delete_memory for removing individual dated entries from ${config.memoryDir}/ memory files.` : ""}

Behavior: With prune_empty_folders, pruning is best-effort and runs after the delete — it never fails the call, so the note is always removed even if a folder can't be.

Errors:
- "cannot delete protected path …" — the path sits under a protected folder${config.memoryEnabled ? "; use vault_delete_memory for memory entries" : ""}
- "path traversal blocked" — path escapes the vault root; use a vault-relative path
- note does not exist — verify the path with vault_list_notes before deleting

Returns: Confirmation message, noting how many empty folders were pruned when any were.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path of the note to delete"),
        prune_empty_folders: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, remove the note's parent folder(s) if deleting it leaves them empty, walking up to (but never including) the vault root. Default false matches Obsidian, which leaves empty folders in place. Only removes a folder with zero entries — a folder still holding any file, including a hidden one like .DS_Store, is left alone.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, prune_empty_folders: pruneEmptyFolders }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_DELETE_NOTE,
      })
      reqLogger.info("tool_call", { path, pruneEmptyFolders })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.deleteNote(
            {
              vaultPath,
              path,
              protectedPaths: config.protectedPaths,
              pruneEmptyFolders,
            },
            reqLogger,
          ),
        ({ prunedEmptyFolders }) => {
          reqLogger.info("tool_result", {
            outcome: "deleted",
            prunedEmptyFolders,
          })
          return prunedEmptyFolders > 0
            ? `Deleted ${path} (removed ${prunedEmptyFolders} empty folder${prunedEmptyFolders > 1 ? "s" : ""})`
            : `Deleted ${path}`
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_MOVE_NOTE,
    {
      title: "Move Note",
      description: `Move or rename a note and rewrite every link across the vault that points to it, like Obsidian's built-in rename. Incoming links in other notes — [[wikilinks]], [[wikilink|aliases]], [[wikilink#headings]], ![[embeds]], [markdown](links.md), and frontmatter links (e.g. related:) — are updated to the new path; the moved note's own relative links are fixed so they still resolve from the new folder. A link is only rewritten when leaving it unchanged would break it, so a short [[Note]] that stays unambiguous after a folder move is left alone. Without this tool a move silently breaks every backlink.

Example: vault_move_note({ old_path: "Inbox/Draft.md", new_path: "Inbox/Spec.md" }) — pure rename.
Example: vault_move_note({ old_path: "Inbox/Spec.md", new_path: "Projects/Spec.md" }) — move to another folder, updating links and the note's own relative links.
Example: vault_move_note({ old_path: "Inbox/Spec.md", new_path: "Projects/Spec.md", prune_empty_folders: true }) — also remove "Inbox" if the move empties it.

When to use: Renaming a note or relocating it to a different folder while keeping the link graph intact.
Prefer this over vault_write_note + vault_delete_note, which would orphan every backlink. To only change a note's body or properties, use vault_patch_note or vault_update_properties. Protected paths (${config.protectedPaths.map((p) => p + "/").join(", ")}) cannot be moved.

Errors:
- "destination exists: …" — a note already lives at new_path; this tool never overwrites. Pick a free path or delete the existing note first.
- "note not found: …" — old_path does not exist; verify it with vault_list_notes.
- "cannot move protected path …" / "cannot move into protected path …" — old_path or new_path sits under a protected folder.
- "only moves .md notes" — both paths must end in .md.
- "path traversal blocked" — a path escapes the vault root; use vault-relative paths.
- Mid-move I/O failure (rare, e.g. a permission or disk error while writing) — the move aborts and the original note is deleted only after the destination and all backlinks are written, so a failure never loses data. The error message names what failed and the resulting state: if a backlink write failed, new_path exists and the original is intact (re-run the move, deleting the partial new_path first, to finish); if the final delete failed, both old_path and new_path exist (delete old_path to finish).

Obsidian syntax: Link rewrites preserve each link's existing form — embed marker (!), heading anchor (#…), and alias (|…) are kept; a markdown link keeps its .md extension and link text. Only the target path is changed.

Returns: JSON with moved_to (the new path), links_updated (count of link occurrences rewritten), updated_notes (sorted paths of the other notes that were edited; the moved note is implied by moved_to), and pruned_empty_folders (count of source folders removed — 0 unless prune_empty_folders was set).`,
      inputSchema: {
        old_path: z
          .string()
          .min(1)
          .describe(
            'Current vault-relative path of the note to move (e.g. "Inbox/Draft.md"). Must end in .md.',
          ),
        new_path: z
          .string()
          .min(1)
          .describe(
            'Destination vault-relative path (e.g. "Projects/Spec.md"). Must end in .md and must not already exist; parent folders are created as needed.',
          ),
        prune_empty_folders: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, remove the source folder(s) if the move leaves them empty, walking up to (but never including) the vault root. Default false matches Obsidian, which leaves empty folders in place. Only removes a folder with zero entries — an in-place rename or a move into a subfolder of the source leaves it non-empty and prunes nothing.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (
      {
        old_path: oldPath,
        new_path: newPath,
        prune_empty_folders: pruneEmptyFolders,
      },
      extra,
    ) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_MOVE_NOTE,
      })
      reqLogger.info("tool_call", { oldPath, newPath, pruneEmptyFolders })
      return safeHandler(
        reqLogger,
        async () => {
          // Normalize to the canonical vault-relative form before the index
          // lookup so a non-canonical input (e.g. "A/../Note.md") still finds its
          // backlinks — the same normalization moveNote applies internally.
          const normalizedOldPath = toVaultRelativePath(oldPath)
          const normalizedNewPath = toVaultRelativePath(newPath)
          const backlinks = search.getBacklinks(
            { path: normalizedOldPath },
            reqLogger,
          )
          const allNotePaths = await vaultFs.listNotes({ vaultPath }, reqLogger)
          return noteMover.moveNote(
            {
              vaultPath,
              oldPath: normalizedOldPath,
              newPath: normalizedNewPath,
              protectedPaths: config.protectedPaths,
              backlinkSources: backlinks.map((backlink) => backlink.path),
              allNotePaths,
              pruneEmptyFolders,
              windowsBindMount: config.windowsBindMount,
            },
            reqLogger,
          )
        },
        (result) => {
          reqLogger.info("tool_result", {
            outcome: "moved",
            linksUpdated: result.links_updated,
            prunedEmptyFolders: result.pruned_empty_folders,
          })
          return JSON.stringify(result)
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
    {
      title: "Update Properties",
      description: `Update properties on a single note. Merges with existing properties — new keys are added, matching keys are overwritten, unmentioned keys are preserved. Pass null as a value to delete that key. Body content is never modified.

Example: vault_update_properties({ path: "Projects/todo.md", properties: { status: "active", draft: null } }) — sets status and deletes the draft key.

Read current properties first with vault_read_note({ properties_only: true }) — merge overwrites each key entirely (arrays are replaced, not appended to). Deleting the last remaining property removes the frontmatter block entirely.

When to use: Changing tags, status, type, or any property without reading/rewriting the full note body. Saves tokens on large notes.
Prefer vault_write_note when creating a new note or replacing the body.

Errors:
- "note not found" — path does not exist; create the note first with vault_write_note
- "path traversal blocked" — path escapes vault root

Obsidian syntax: Property values follow YAML conventions. Use arrays for multi-value fields (tags: [a, b]), quote wikilink values ("[[Note]]"), keep property types consistent across the vault (string/number/list mismatches cause silent query failures).

Returns: Confirmation message.`,
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path to the note"),
        properties: z
          .record(z.string().min(1), z.unknown())
          .describe(
            "Properties to merge. New keys are added; existing keys are overwritten; a null value deletes that key; unmentioned keys are preserved.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, properties }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
      })
      reqLogger.info("tool_call", { path })
      return safeHandler(
        reqLogger,
        () =>
          vaultFs.updateProperties({ vaultPath, path, properties }, reqLogger),
        () => {
          reqLogger.info("tool_result", { outcome: "properties_updated" })
          return `Updated properties on ${path}`
        },
      )
    },
  )
}
