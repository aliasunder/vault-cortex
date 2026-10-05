/** Vault CRUD tool registrations — read, write, patch, replace, delete, move. */

import { z } from "zod"
import type { VaultConfig } from "../../config.js"
import { vaultFs, resolveVaultRelativePath } from "../../vault-operations/vault-filesystem.js"
import { noteMover } from "../../vault-operations/note-mover.js"
import { resolveEffectiveProtectedPaths } from "../../vault-operations/vault-folder-config.js"
import { readTrashConfig } from "../../vault-operations/trash-config.js"
import { vaultPatcher } from "../../vault-operations/vault-patcher.js"
import type { DisplacedLeadingContent } from "../../vault-operations/vault-patcher.js"
import { pageTextByLines } from "../../obsidian-markdown/lines.js"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { describeTextWindow, safeHandler, safeHandlerContent } from "./tool-helpers.js"

/** Advisory sentence for a no-heading prepend that nested pre-existing content
 *  inside the heading it inserted. Names the remedy as a vault_patch_note
 *  operation — routing guidance is the tool layer's job, so the data layer
 *  returns the facts and this composes them. The heading is named by its bare
 *  text, which is what the `heading` param matches; the level rides along so an
 *  ambiguous-heading retry has what it needs. */
const describeDisplacedLeadingContent = ({
  bytes,
  firstHeading,
}: DisplacedLeadingContent): string => {
  if (!firstHeading) {
    return `The note's entire pre-existing body (${bytes} bytes) is now nested under the inserted heading — the note has no other headings to end the new section. To add a section below existing content instead, use operation "append".`
  }
  return `The ${bytes} bytes of pre-existing content above the note's first heading are now nested under the inserted heading. To add a section above the first heading without pulling existing content into it, use operation "insert_before" with heading "${firstHeading.text}" (H${firstHeading.level}).`
}

/** Protected-path list for tool descriptions. Descriptions are built once at
 *  registration and the daily notes folder is resolved per call, so the text
 *  names that folder's sources, not its value ("Daily Notes" restates the
 *  fallback in daily-notes.ts). */
const describeProtectedPaths = (config: VaultConfig): string => {
  if (config.protectedPathsOverride) {
    // loadConfig strips trailing slashes from override entries.
    return config.protectedPathsOverride.map((protectedPath) => protectedPath + "/").join(", ")
  }
  return `${config.memoryDir}/ and the daily notes folder (read from DAILY_NOTES_FOLDER or .obsidian/daily-notes.json, defaulting to Daily Notes/)`
}

export const registerVaultCrudTools = ({
  registerTool,
  isToolEnabled,
  whenToolEnabledText,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  registerTool(
    TOOL_NAMES.VAULT_READ_NOTE,
    {
      title: "Read Note",
      description: `Read a markdown note by its vault-relative path. By default returns the full raw content including properties; optional modes return just the properties, just the heading outline, or just one section — so large notes don't blow the token budget.

Example: vault_read_note({ path: "Projects/vault-cortex.md" })
Example: vault_read_note({ path: "Projects/vault-cortex.md", properties_only: true })
Example: vault_read_note({ path: "TASKS.md", outline: true })
Example: vault_read_note({ path: "TASKS.md", heading: "Active" })
Example: vault_read_note({ path: "TASKS.md", heading: "Done", heading_level: 2 }) // disambiguate when several "Done" headings exist
Example: vault_read_note({ path: "TASKS.md", heading: "Done", start_line: 1, limit: 20 }) // first 20 lines of an oversized section

When to use: You know the exact path and need a specific note's content. For a large note (a long board or doc), use outline: true to see its headings and any text sitting above them, then heading: "..." to read just the one section you need — both far cheaper than pulling the whole file. Use properties_only: true when you only need properties. For an oversized note or section, page it with start_line and limit to read a window at a time. To check a note's or section's line count, request start_line: 1 with limit: 1 — one line plus the total.
Prefer vault_search when you don't know the path.${whenToolEnabledText("vault_list_tasks", " For task status or order on a board, prefer vault_list_tasks; heading mode returns a lane's verbatim Markdown.")}${whenToolEnabledText("vault_get_memory", ` Prefer vault_get_memory for ${config.memoryDir}/ files (returns content without properties).`)}${whenToolEnabledText("vault_patch_note", " To edit a section you've read, use vault_patch_note.")} To explore what links to this note or what it links to, use vault_get_backlinks and vault_get_outgoing_links.

Section boundaries: a section spans from its heading to the next heading of the same or higher level (or EOF). Child headings are included. Modes are mutually exclusive — set at most one of properties_only, outline, or heading. Paged reads normalize line endings to LF; unpaged reads stay byte-identical.

Errors:
- "note not found" — no note exists at this path; verify it with vault_list_notes
- "heading not found" — no heading matches the text; error lists available headings
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate, or read the full note (omit heading) when headings share the same level
- "outline, heading, and properties_only are mutually exclusive" — only one mode per call
- "heading_level requires a heading" — heading_level only disambiguates a heading; pass heading with it
- "heading cannot be empty" — heading is whitespace only; pass the heading's text
- "line paging is not available in outline mode" / "... properties_only mode" — start_line/limit only work on text renditions (full read or heading section)
- "start line past the end" — start_line exceeds the rendition's line count; error states the total
- 'path must end in ".md"' — the path names a non-markdown file${whenToolEnabledText("vault_read_file", "; read files (images, .canvas, data files) with vault_read_file instead")}
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it

Returns: Raw markdown string (default); JSON object of properties (properties_only); JSON outline object, shaped as the outline parameter describes (outline); raw markdown of the section, heading line included (heading). When start_line or limit is given, the result is preceded by a window-metadata text block ("path — lines 1–20 of 250 (continue with start_line: 21)").

Outline: bytes at the root is the whole file's on-disk size and modified is its filesystem modification time; each heading's bytes is the exact UTF-8 byte length of the text that heading mode returns for that section. Empty headings ("##" with no text) appear with text: "" — they act as section boundaries but cannot be targeted by the heading parameter; read the parent section (which includes child headings) or the full note${whenToolEnabledText("vault_replace_in_note", ", and edit via vault_replace_in_note")}.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            `Vault-relative path to the note, including the ".md" extension (e.g. "${config.memoryEnabled ? `${config.memoryDir}/Principles.md` : "Projects/plan.md"}"). Use the exact letter case.`,
          ),
        properties_only: z
          .boolean()
          .optional()
          .describe("If true, returns parsed properties as JSON instead of full note content"),
        outline: z
          .boolean()
          .optional()
          .describe(
            "If true, returns { bytes, modified, leading_callout?, leading_content?, headings } as JSON instead of body content — a cheap structure fetch for large notes. headings: [{ level, text, bytes }]; leading_callout: { type, title, body } when the note has a top-of-file callout; leading_content: the rest of the body text above the first heading (callout lines excluded) when the note has any.",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe("Return only this section. Case-sensitive exact match."),
        heading_level: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe(
            "Heading level (1-6) for disambiguation when multiple headings share the same text; only applies with heading",
          ),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "First line to return, 1-based (default 1). Pages the text output (full body or a heading section). Not valid for outline or properties_only (JSON modes).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum lines returned (default: all remaining)."),
      },
    },
    async (
      { path, properties_only, outline, heading, heading_level, start_line, limit },
      extra,
    ) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_READ_NOTE,
      })
      reqLogger.info("tool_call", {
        path,
        propertiesOnly: properties_only,
        outline,
        heading,
        headingLevel: heading_level,
        startLine: start_line,
        limit,
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

      const isPagedRead = start_line !== undefined || limit !== undefined

      if (isPagedRead && outline) {
        return returnError("line paging is not available in outline mode")
      }
      if (isPagedRead && properties_only) {
        return returnError("line paging is not available in properties_only mode")
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
        if (isPagedRead) {
          return safeHandlerContent(
            reqLogger,
            () =>
              vaultFs.readNoteSection(
                { vaultPath, path, heading, headingLevel: heading_level },
                reqLogger,
              ),
            (text) => {
              const { text: windowText, lineWindow } = pageTextByLines({
                text,
                path,
                startLine: start_line,
                limit,
              })
              reqLogger.info("tool_result", { mode: "section", lineWindow })
              return [
                {
                  type: "text" as const,
                  text: describeTextWindow(path, lineWindow),
                },
                { type: "text" as const, text: windowText },
              ]
            },
          )
        }
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

      if (isPagedRead) {
        return safeHandlerContent(
          reqLogger,
          () => vaultFs.readNote({ vaultPath, path }, reqLogger),
          (text) => {
            const { text: windowText, lineWindow } = pageTextByLines({
              text,
              path,
              startLine: start_line,
              limit,
            })
            reqLogger.info("tool_result", { mode: "full", lineWindow })
            return [
              {
                type: "text" as const,
                text: describeTextWindow(path, lineWindow),
              },
              { type: "text" as const, text: windowText },
            ]
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

  registerTool(
    TOOL_NAMES.VAULT_LIST_NOTES,
    {
      title: "List Notes",
      description: `List .md file paths in the vault, optionally filtered by folder and/or glob pattern. Returns paths only — not content or metadata.

Example: vault_list_notes({ folder: "Projects" })
Example: vault_list_notes({ glob: "**/*session-log*.md" })
Example: vault_list_notes({ folder: "Projects", glob: "*.md" }) — the folder's top-level notes only

When to use: Browsing what exists in a folder by filename, or finding notes matching a path pattern.
Prefer vault_search_by_folder when you need metadata (tags, type, related) along with paths. Prefer vault_search for content-based discovery. Use vault_read_note to read a note from the results.

Parameters:
- folder names a whole folder and includes its subfolders: "Projects" covers "Projects/Archive" but not "ProjectsOld/". This tool reads the filesystem rather than the search index, so use the folder's exact letter case, as other results show it; on a case-sensitive filesystem a different case finds nothing.
- glob matches each note's path inside folder (its vault-relative path when folder is omitted), case-sensitively. * stays within one folder level and ** spans any depth: with folder "Projects", "*.md" lists the folder's top-level notes and "**/*.md" every note under it. Returned paths are always vault-relative.

Behavior: Paths come back sorted by vault-relative path, uppercase before lowercase. Hidden (dot-prefixed) notes and folders are never listed, matching Obsidian; symlinked notes are included.

Errors:
- A nonexistent folder or no glob matches returns an empty array, not an error.
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — the folder starts at the filesystem root, escapes the vault or names the vault root itself (e.g. "."), or is hidden like ".obsidian"; use a vault-relative folder outside hidden folders, and omit folder to list the whole vault.

Returns: JSON array of vault-relative path strings (e.g. ["Notes/idea.md", "Projects/plan.md"]).`,
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .optional()
          .describe(
            `Vault-relative folder to list (e.g. ${config.memoryEnabled ? `"${config.memoryDir}", ` : ""}"Projects").`,
          ),
        glob: z
          .string()
          .min(1)
          .optional()
          .describe('Glob pattern for note paths (e.g. "**/*session-log*.md").'),
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

  registerTool(
    TOOL_NAMES.VAULT_WRITE_NOTE,
    {
      title: "Write Note",
      description: `Create a markdown note. Errors if a note already exists at the path unless overwrite is set. Body replaces the entire note content: existing content will be lost unless you include it in body, so do not use this tool for surgical edits to large files. Properties are passed separately and merged with any existing properties when overwriting (new keys added, matching keys overwritten, keys set to null removed, unmentioned keys preserved); overwriting without properties keeps the existing property values.

Example: vault_write_note({ path: "Projects/notes.md", body: "# Notes\\n\\nProject notes here.", properties: { tags: ["project"], type: "project" } })
Example: vault_write_note({ path: "Projects/notes.md", body: "Updated content.", overwrite: true })

When to use: Creating a new note. Set overwrite: true only when you intend to replace an existing note's body.
Prefer vault_update_properties for property-only edits (no body round-trip).${whenToolEnabledText("vault_update_memory", `\nPrefer vault_update_memory for appending dated entries to ${config.memoryDir}/ memory files.`)}

Errors:
- "note already exists" — a note already lives at this path; set overwrite: true to replace it, or use ${whenToolEnabledText("vault_patch_note", "vault_patch_note / ")}vault_replace_in_note for partial edits
- "path must end in …" — add the .md extension
- "cannot write note …: that path is not a file" — a folder already has this name; choose another path
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry
- "body contains a control character" — body includes a non-printable control byte; remove it before writing

Obsidian syntax: Body is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag (escape with \\#), [[ = wikilink, %% = comment block. In properties: quote wikilink values ("[[Note]]"), use YAML lists for tags, keep property types consistent (string/number/list mismatches cause silent query failures).

Returns: Confirmation message.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path including the ".md" extension (e.g. "Projects/notes.md"). Parent folders are created as needed. Use the exact letter case; a different case can create a duplicate note or folder.',
          ),
        body: z
          .string()
          .describe(
            "Markdown body content — do not include frontmatter fences (---); use the properties parameter instead.",
          ),
        properties: z
          .record(z.string().min(1), z.unknown())
          .optional()
          .describe("Optional properties to merge; a null value deletes that key."),
        overwrite: z
          .boolean()
          .optional()
          .default(false)
          .describe("Allow overwriting an existing note (default: false — errors if file exists)."),
      },
    },
    async ({ path, body, properties, overwrite }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_WRITE_NOTE,
      })
      reqLogger.info("tool_call", {
        path,
        hasProperties: Boolean(properties),
        overwrite,
      })
      return safeHandler(
        reqLogger,
        () => vaultFs.writeNote({ vaultPath, path, body, properties, overwrite }, reqLogger),
        () => {
          reqLogger.info("tool_result", { outcome: "written" })
          return `Wrote ${path}`
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_PATCH_NOTE,
    {
      title: "Patch Note",
      description: `Surgical edits to a markdown note — append, prepend, replace, or insert content by heading. Frontmatter values are preserved; YAML formatting may be normalized to block style on first edit.

Example: vault_patch_note({ path: "TASKS.md", operation: "append", heading: "Active", content: "- [ ] New task" })

Cross-section move (e.g. completing a task on a board):
1. vault_read_note to get current content and verify exact text
2. vault_patch_note({ path, operation: "append", heading: "Done", content: "- [x] Task text" }) to add at target
3. vault_replace_in_note({ path, old_text: "- [ ] Task text\\n", new_text: "" }) to remove from source (for a large multi-line block, prefer vault_delete_span); on error, re-read and retry until the source copy is gone
Add at the target before deleting from the source — the two writes are not atomic, so this order can briefly duplicate the moved block on a failure but never lose it.

When to use: Modifying part of an existing note without overwriting the entire body.
Prefer vault_write_note for creating new notes, or full rewrites (with overwrite: true). Prefer vault_replace_in_note for in-place text changes (typos, renaming) that stay in the same location.

Operations:
- append: add content at end of section (or end of file if no heading)
- prepend: add content after heading line (or at the top of the body, below frontmatter, if no heading — how you add a leading callout). To start a new section above the note's current first heading, use insert_before on that heading, not a no-heading prepend.
- replace: replace section body (heading preserved; requires heading; errors if the target has child headings unless include_children is set)
- insert_before: insert content above the heading line (requires heading)

Heading-targeted ops keep the matched heading and write content verbatim. No separator is added around the content — end it with a newline to leave a blank line after the inserted block.

Limitation: A no-heading prepend inserts at body line 0. If the note has content above its first heading and your content starts with a heading, the pre-existing content becomes the new section's body. The write still succeeds and the confirmation says so — use insert_before on the first heading to place a section above it instead.

Section boundaries: a section spans from its heading to the next heading of the same or higher level (or EOF), so it includes its child headings. Empty headings ("##" with no text) act as boundaries but cannot be targeted — edit their content via vault_replace_in_note instead.

Editing a leading callout: read it via vault_read_note(outline: true), then vault_replace_in_note the old block for the new one (a no-heading prepend would stack a second callout above it).

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "path must end in …" — add the .md extension
- "heading not found" — no heading matches the text; error lists available headings
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate, or${whenToolEnabledText("vault_replace_in_note", " use vault_replace_in_note to")} target by text content when headings share the same level
- "operation … requires a heading target" — replace and insert_before need a heading
- "heading cannot be empty" — heading is whitespace only; pass the heading's text
- "content begins with the heading … which would duplicate it" — content's first line repeats the target heading; omit it (the matched heading is kept automatically)
- "section … has N child headings …" — the target section contains child headings that replace would destroy; pass include_children: true to confirm, or target the child heading directly
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry
- "content contains a control character" — content includes a non-printable control byte; remove it before writing

Obsidian syntax: Content is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block. Inserting heading-level content (## New Section) changes the note's structure — future heading-targeted ops may resolve differently.
Table rows: send only the data row ("| cell1 | cell2 |"), not the header or separator — duplicating them splits the table.

Returns: Confirmation message — "Applied <operation> to <path> → <target>", where target is the matched heading (e.g. "## Active") or "file body" for a no-heading append/prepend. A no-heading prepend that nested existing content under an inserted heading adds a sentence naming the content's size and the call that would have avoided it.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "TASKS.md", "Projects/plan.md"). Use the exact letter case.',
          ),
        operation: z
          .enum(["append", "prepend", "replace", "insert_before"])
          .describe("append | prepend | replace | insert_before."),
        content: z
          .string()
          .min(1)
          .describe(
            "Markdown content to insert. Must not begin with the target heading text (it would duplicate the heading, which is kept automatically).",
          ),
        heading: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target heading text (case-sensitive exact match). Omit for a file-level append or prepend.",
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
        include_children: z
          .boolean()
          .optional()
          .describe(
            "When true, allows replace to overwrite a section that contains child headings. " +
              "Without this, replace errors if children exist — preventing silent data loss.",
          ),
      },
    },
    async ({ path, operation, content, heading, heading_level, include_children }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_PATCH_NOTE,
      })
      reqLogger.info("tool_call", {
        path,
        operation,
        heading,
        headingLevel: heading_level,
        includeChildren: include_children,
      })
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
              includeChildren: include_children,
            },
            reqLogger,
          ),
        (result) => {
          reqLogger.info("tool_result", {
            outcome: "patched",
            displaced: result.displacedLeadingContent !== null,
          })
          if (!result.displacedLeadingContent) return result.message
          return `${result.message}. ${describeDisplacedLeadingContent(result.displacedLeadingContent)}`
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
    {
      title: "Replace in Note",
      description: `Find and replace text in a markdown note's body. Matches exact text (case-sensitive). Properties are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only — properties must be edited via vault_update_properties or vault_write_note's properties parameter.

Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "TODO: write summary", new_text: "Summary complete." })
Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "- [ ] draft outline\\n", new_text: "" }) — removes the whole line, line break included.

When to use: Targeted text changes within a single location — fixing typos, updating values, renaming terms, or removing a short line (new_text=""). Replaces text in place; does not move content across sections.
To delete a large multi-line block, prefer vault_delete_span (short anchors instead of full old_text).${whenToolEnabledText("vault_replace_span", " To replace a large block by anchors instead of reproducing the full old_text, use vault_replace_span.")}${whenToolEnabledText("vault_patch_note", ' To relocate content between headings, use vault_patch_note to add at the target first, then remove from source (new_text="") — add-before-delete, so a failure duplicates the block instead of losing it.')}

Parameters:
- old_text: include enough surrounding context to ensure uniqueness when the target text appears in multiple places. No regex.
- new_text: non-empty new_text replaces the match exactly. A deletion (new_text="") of a match that starts and ends at a line boundary joins the empty lines above and below it into one gap that keeps the larger of the two counts (only at the end of the note, the count above drops by one); where matches empty their lines, the gap keeps at least one blank line unless it ends the note, so include the line break in old_text to remove the line. Any other deletion, such as text inside a line or a line break that joins two lines, is written exactly as asked. Blank lines outside the joined gaps never change.
- replace_all_occurrences: replacing only the first match is a safety default for when old_text appears in multiple places. Set true for deliberate bulk renames or term replacements.

Errors:
- "note not found" — path does not exist; check vault_list_notes for valid paths
- "path must end in …" — add the .md extension
- "text not found" — old_text does not appear in the note body; verify exact text with vault_read_note
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry
- "new_text contains a control character" — new_text includes a non-printable control byte; remove it before writing

Obsidian syntax: new_text is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block in replacement text.

Returns: Confirmation message with replacement count (number of occurrences replaced).`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "Projects/plan.md"). Use the exact letter case.',
          ),
        old_text: z
          .string()
          .min(1)
          .describe(
            "Exact text to find (case-sensitive). Matches in the body only — text inside frontmatter properties is not searched.",
          ),
        new_text: z
          .string()
          .describe('Replacement text. Empty string ("") deletes the matched text.'),
        replace_all_occurrences: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace all occurrences (default: false — replaces first occurrence only)"),
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
        replaceAllOccurrences: replace_all_occurrences,
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

  const replaceBlockAdvice = isToolEnabled("vault_replace_span")
    ? "use vault_replace_span (one atomic step)"
    : `delete it here${whenToolEnabledText("vault_patch_note", ", then vault_patch_note to add the new content")}`

  registerTool(
    TOOL_NAMES.VAULT_DELETE_SPAN,
    {
      title: "Delete Span",
      description: `Delete a contiguous block of whole lines from a note's body by referencing short anchor substrings instead of reproducing the full block text. Each anchor locates a full line — the entire line is selected, not just the matching substring. Case-sensitive matching. Properties are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only.

Example: vault_delete_span({ path: "Tracker.md", start_anchor: "| 2024-03-02 | Acme" }) — deletes the one table row whose line contains that fragment.
Example: vault_delete_span({ path: "Notes/Plan.md", start_anchor: "> [!warning] Stale", end_anchor: "remove after launch" }) — deletes from the start anchor line through the end anchor line.

When to use: Removing a block you have already read — a table row, callout, or run of list items — where reproducing it exactly as old_text would be error-prone. Pick a short, unique fragment of the first line for start_anchor and, for a multi-line block, the last line for end_anchor.
${whenToolEnabledText("vault_replace_in_note", "Prefer vault_replace_in_note for small in-place edits (this tool only deletes). ")}To replace a block, ${replaceBlockAdvice}.

Parameters:
- start_anchor + end_anchor define a line range, not a text range (never cuts mid-line). Omit end_anchor for a single-line delete. The empty lines above and below the removed lines join into one gap that keeps the larger of the two counts (only at the end of the note, the count above drops by one); no other blank line in the note changes.
- end_anchor is searched at or after the start line, so the span can never run backward; it must be unique among those lines. If both match the same line, only that one line is deleted.
- first_match applies to both anchors independently — when an anchor matches multiple lines, takes the first instead of erroring.

Errors:
- "note not found" — verify path with vault_list_notes
- "path must end in …" — add the .md extension
- "start anchor not found" / "end anchor not found" — no line contains the fragment (for end_anchor, none at or after the start line); verify with vault_read_note
- "ambiguous start anchor …" / "ambiguous end anchor …" — the anchor matches multiple lines; use a longer fragment or set first_match: true
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry

Returns: Confirmation with the number of lines the span covered and a preview of them, cut at 80 characters.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "Tracker.md", "Notes/Plan.md"). Use the exact letter case.',
          ),
        start_anchor: z
          .string()
          .min(1)
          .describe(
            "Short, unique substring that identifies the first line of the block (case-sensitive). The entire line is selected, not just the substring. Pick a brief fragment — do not paste the whole block.",
          ),
        end_anchor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short substring that identifies the LAST line of the block. The entire line is selected. Omit to delete just the single line containing start_anchor.",
          ),
        first_match: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If an anchor matches more than one line, delete using the first match instead of erroring (default: false — ambiguity is an error).",
          ),
      },
    },
    async ({ path, start_anchor, end_anchor, first_match }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_DELETE_SPAN,
      })
      reqLogger.info("tool_call", {
        path,
        hasEndAnchor: Boolean(end_anchor),
        firstMatch: first_match,
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

  registerTool(
    TOOL_NAMES.VAULT_REPLACE_SPAN,
    {
      title: "Replace Span",
      description: `Replace a contiguous block of whole lines in a note's body with new content, identified by short anchor substrings instead of the block's full text. Each anchor locates a full line — the entire line is selected, not just the matching substring. Case-sensitive matching. Properties are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only.

Example: vault_replace_span({ path: "Tracker.md", start_anchor: "| 2024-03-02 | Acme", content: "| 2024-03-02 | Acme Corp | Updated |" }) — replaces the one table row whose line contains that fragment.
Example: vault_replace_span({ path: "Notes/Plan.md", start_anchor: "> [!warning] Stale", end_anchor: "remove after launch", content: "> [!info] Current\\n> Updated for v2." }) — replaces the callout block with a new one.

When to use: Replacing a block you have already read — a table row, callout, or run of list items — where reproducing it exactly as old_text would be error-prone. Pick a short, unique fragment of the first line for start_anchor and, for a multi-line block, the last line for end_anchor.
${whenToolEnabledText("vault_replace_in_note", "Prefer vault_replace_in_note for small in-place text changes (typos, renaming).")}${whenToolEnabledText("vault_delete_span", " Prefer vault_delete_span when removing without replacement.")}

Parameters:
- end_anchor is searched at or after the start line, so the span can never run backward; it must be unique among those lines. If both match the same line, only that one line is replaced.
- content: empty lines at its start and end join the empty lines around the replaced lines, and each joined gap keeps the larger of the two counts (only at the end of the note, the count above drops by one). So content can widen a gap but not narrow it: a trailing newline leaves at least one blank line after the new block unless the block ends the note. Content made only of blank lines joins both sides into one gap. Blank lines inside content are written as given, and no other blank line in the note changes.
- first_match applies to both anchors independently.

Errors:
- "note not found" — verify path with vault_list_notes
- "path must end in …" — add the .md extension
- "start anchor not found" / "end anchor not found" — no line contains the fragment (for end_anchor, none at or after the start line); verify with vault_read_note
- "ambiguous start anchor …" / "ambiguous end anchor …" — the anchor matches multiple lines; use a longer fragment or set first_match: true
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry
- "content contains a control character" — content includes a non-printable control byte; remove it before writing

Obsidian syntax: content is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block.

Returns: Confirmation message "Replaced <N> lines with <M> lines in <path>" — N counts the lines the span covered, M the line breaks in content plus one.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "Tracker.md", "Notes/Plan.md"). Use the exact letter case.',
          ),
        start_anchor: z
          .string()
          .min(1)
          .describe(
            "Short, unique substring that identifies the first line of the block (case-sensitive). The entire line is selected, not just the substring. Pick a brief fragment — do not paste the whole block.",
          ),
        end_anchor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short substring that identifies the LAST line of the block. The entire line is selected. Omit to replace just the single line containing start_anchor.",
          ),
        content: z
          .string()
          .min(1)
          .describe(
            "Replacement content (one or more lines) — replaces every line of the matched span. Must be non-empty.",
          ),
        first_match: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If an anchor matches more than one line, use the first match instead of erroring (default: false — ambiguity is an error).",
          ),
      },
    },
    async ({ path, start_anchor, end_anchor, content, first_match }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_REPLACE_SPAN,
      })
      reqLogger.info("tool_call", {
        path,
        hasEndAnchor: Boolean(end_anchor),
        firstMatch: first_match,
      })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.replaceSpan(
            {
              vaultPath,
              path,
              startAnchor: start_anchor,
              endAnchor: end_anchor,
              content,
              firstMatch: first_match,
            },
            reqLogger,
          ),
        (confirmation) => {
          reqLogger.info("tool_result", { outcome: "span_replaced" })
          return confirmation
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
    {
      title: "Insert at Anchor",
      description: `Insert content as whole lines before or after a specific line identified by a short anchor substring. Case-sensitive matching; an anchor matching more than one line is an error unless first_match is set.${whenToolEnabledText("vault_delete_span", " Same anchor resolution as vault_delete_span.")} Properties are preserved; YAML formatting may be normalized to block style on first edit. Operates on the body only.

Example: vault_insert_at_anchor({ path: "Tracker.md", anchor: "| 2024-03-02 | Acme", position: "after", content: "| 2024-03-03 | Beta Corp | New entry |" }) — inserts a new table row after the matched row.
Example: vault_insert_at_anchor({ path: "Notes/Plan.md", anchor: "## Phase 2", position: "before", content: "> [!note] Phase 1 must close before this starts.\\n" }) — inserts a callout and a blank line above the Phase 2 heading.

When to use: Adding content at a precise location identified by a nearby line's text, without needing to know the heading structure. Good for inserting rows into tables, adding items into lists at a specific position, or placing content relative to a known landmark line.
${whenToolEnabledText("vault_patch_note", "Prefer vault_patch_note for heading-targeted inserts (append/prepend to a section).")}${whenToolEnabledText("vault_replace_span", " Prefer vault_replace_span when replacing a block rather than inserting next to it.")}

Parameters:
- anchor locates a full line — the insert never splits a line.
- content is inserted verbatim — blank lines inside it are kept, and a trailing newline adds a blank line after the inserted block.

Errors:
- "note not found" — verify path with vault_list_notes
- "path must end in …" — add the .md extension
- "anchor not found" — fragment not on any line; verify with vault_read_note
- "ambiguous anchor …" — the anchor matches multiple lines; use a longer fragment or set first_match: true
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry
- "content contains a control character" — content includes a non-printable control byte; remove it before writing

Obsidian syntax: content is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block.

Returns: Confirmation message "Inserted <N> lines <before|after> anchor in <path>" — N counts the lines content supplied.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "Notes/Plan.md", "Tracker.md"). Use the exact letter case.',
          ),
        anchor: z
          .string()
          .min(1)
          .describe(
            "Short, unique substring on the line to insert next to (case-sensitive). Pick a brief fragment — do not paste the whole line.",
          ),
        position: z
          .enum(["before", "after"])
          .describe(
            '"before" places the content on the lines above the anchor line; "after" places it on the lines below. The anchor line itself is never changed.',
          ),
        content: z.string().min(1).describe("Content to insert (one or more lines)."),
        first_match: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If the anchor matches more than one line, use the first match instead of erroring (default: false — ambiguity is an error).",
          ),
      },
    },
    async ({ path, anchor, position, content, first_match }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
      })
      reqLogger.info("tool_call", {
        path,
        position,
        firstMatch: first_match,
      })
      return safeHandler(
        reqLogger,
        () =>
          vaultPatcher.insertAtAnchor(
            {
              vaultPath,
              path,
              anchor,
              position,
              content,
              firstMatch: first_match,
            },
            reqLogger,
          ),
        (confirmation) => {
          reqLogger.info("tool_result", { outcome: "inserted_at_anchor" })
          return confirmation
        },
      )
    },
  )

  // Under Obsidian Sync a delete never reads the "Deleted files" setting or
  // touches .trash/, so the errors those two produce cannot occur.
  const trashMoveErrorEntries = config.obsidianSyncEnabled
    ? ""
    : `
- "cannot move to trash … — 100 collisions in .trash/" — .trash/ already holds this name and its numbered copies ("Plan 1.md" … "Plan 100.md"); clear old trash copies, then retry
- any other "cannot move to trash …" — the .trash/ move failed (e.g. a plain file blocks a needed folder); the note stays put; fix .trash/, then retry`
  const trashConfigErrorEntry = config.obsidianSyncEnabled
    ? ""
    : `
- "cannot read trash config from .obsidian/app.json" — the file exists but is unreadable; the delete is blocked because a guessed setting could let the retention sweep remove a note set to be kept forever; repair the file, then retry`

  registerTool(
    TOOL_NAMES.VAULT_DELETE_NOTE,
    {
      title: "Delete Note",
      description: `Delete a markdown note, moving it to the vault's .trash/ folder or removing it for good as the vault's Obsidian "Deleted files" setting directs.

Example: vault_delete_note({ path: "Scratch/temp.md" })
Example: vault_delete_note({ path: "Archive/2024/old.md", prune_empty_folders: true }) — also remove "Archive/2024" (and "Archive") if deleting the note empties them.

When to use: Removing a note you no longer need.${whenToolEnabledText("vault_delete_memory", `\nPrefer vault_delete_memory for removing individual dated entries from ${config.memoryDir}/ memory files.`)}${whenToolEnabledText("vault_move_note", "\nTo relocate a note, use vault_move_note instead.")}${whenToolEnabledText("vault_write_note", "\nTo replace a note's content, use vault_write_note with overwrite: true instead.")}

Behavior:
- Unless the server syncs through Obsidian Sync, the "Deleted files" setting (\`trashOption\` in \`.obsidian/app.json\`) decides the outcome:
  - "Move to system trash" (\`system\`, also what an absent setting means) moves the note to \`.trash/\`, since the server has no system trash. The server deletes its own copies there after its TRASH_RETENTION_DAYS setting (default 30 days, or never when set to none), never touching notes Obsidian trashed.
  - "Move to Obsidian trash" (\`local\`) moves the note to \`.trash/\` and keeps it forever.
  - "Permanently delete" (\`none\`) removes the note for good.
- When the server syncs through Obsidian Sync, the setting is bypassed and the note is always deleted for good; recover it from Sync's version history (1 month on Standard, 12 months on Plus).
- The caller can't choose or see the outcome in advance; the returned message says which happened.
- Links to the note from other notes become broken${whenToolEnabledText("vault_get_backlinks", " (detectable via vault_get_backlinks)")}. Protected paths (${describeProtectedPaths(config)}) are refused.

Parameters:
- prune_empty_folders removes each parent folder the delete leaves with zero entries, up to but never including the vault root; a folder holding any file, even a hidden .DS_Store, is kept. Pruning runs after the delete or trash move and is best-effort: a folder that can't be removed never fails the call. Without it, empty folders stay, matching Obsidian.

Errors:
- "cannot delete protected path" — the path sits under a protected folder${whenToolEnabledText("vault_delete_memory", "; use vault_delete_memory for memory entries")}
- "path must end in …" — add the .md extension
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; retry
- "note not found: …" — the note does not exist${whenToolEnabledText("vault_list_notes", "; verify the path with vault_list_notes before deleting")}${trashMoveErrorEntries}
- any other "cannot delete …" — the permanent delete failed (e.g. permissions); the note stays put; fix the cause, then retry${trashConfigErrorEntry}
- "cannot read daily notes config from .obsidian/daily-notes.json" — the file exists but is unreadable, so the daily notes folder to protect is unknown; repair it, or set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry

Returns: Confirmation message naming the outcome — "Deleted <path>" for permanent removal, "Moved <path> to trash (<trash path>)" when the note landed in .trash/. Notes how many empty folders were pruned when any were.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path of the note to delete, including the ".md" extension. Use the exact letter case.',
          ),
        prune_empty_folders: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, also remove parent folders the delete leaves empty. Default false.",
          ),
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
        async () => {
          const protectedPaths = await resolveEffectiveProtectedPaths(
            { config, vaultPath },
            reqLogger,
          )

          // Under Obsidian Sync the setting is skipped and the note is deleted
          // for good ("none", since "system" would land in .trash/): a
          // server-side .trash/ never syncs back, and Sync's version history
          // is the recovery path.
          const trashOption = config.obsidianSyncEnabled
            ? "none"
            : await readTrashConfig(vaultPath, reqLogger)

          return vaultFs.deleteNote(
            {
              vaultPath,
              path,
              protectedPaths,
              pruneEmptyFolders,
              trashOption,
              // Only "system" moves are swept later, so only they are recorded;
              // "local" is the user's keep-forever trash.
              recordTrashEntry: trashOption === "system" ? search.recordTrashEntry : undefined,
              // Always passed. If an earlier delete left a row for this .trash/
              // path (the user emptied .trash/ by hand), the sweep would still
              // remove whatever lands there, including a "local" note meant
              // to be kept.
              clearStaleTrashEntry: search.deleteTrashEntry,
            },
            reqLogger,
          )
        },
        ({ prunedFolderCount, trashLocation }) => {
          const outcome = trashLocation ? "trashed" : "deleted"
          reqLogger.info("tool_result", {
            outcome,
            prunedFolderCount,
            ...(trashLocation ? { trashLocation } : {}),
          })

          const folderLabel = prunedFolderCount > 1 ? "folders" : "folder"
          const pruneSuffix =
            prunedFolderCount > 0 ? ` (removed ${prunedFolderCount} empty ${folderLabel})` : ""
          return trashLocation
            ? `Moved ${path} to trash (${trashLocation})${pruneSuffix}`
            : `Deleted ${path}${pruneSuffix}`
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_MOVE_NOTE,
    {
      title: "Move Note",
      description: `Move or rename a note and rewrite every link across the vault that points to it, like Obsidian's built-in rename. Incoming links in other notes — [[wikilinks]], [[wikilink|aliases]], [[wikilink#headings]], ![[embeds]], [markdown](links.md), and frontmatter links (e.g. related:) — are updated to the new path; the moved note's own relative links are fixed so they still resolve from the new folder, including relative links to attachments (e.g. ![[../assets/photo.png]], ![img](../assets/photo.png)). A link is only rewritten when leaving it unchanged would break it, so a short [[Note]] that stays unambiguous after a folder move is left alone. Moving a note any other way can silently break its backlinks.

Example: vault_move_note({ old_path: "Inbox/Draft.md", new_path: "Inbox/Spec.md" }) — pure rename.
Example: vault_move_note({ old_path: "Inbox/spec.md", new_path: "Inbox/Spec.md" }) — case-only rename; works even where the filesystem treats both spellings as one file.
Example: vault_move_note({ old_path: "Inbox/Spec.md", new_path: "Projects/Spec.md" }) — move to another folder, updating links and the note's own relative links.
Example: vault_move_note({ old_path: "Inbox/Spec.md", new_path: "Projects/Spec.md", prune_empty_folders: true }) — also remove "Inbox" if the move empties it.

When to use: Renaming a note or relocating it to a different folder while keeping the link graph intact.
Prefer this over vault_write_note + vault_delete_note, which would orphan every backlink. To only change a note's body or properties, use ${whenToolEnabledText("vault_patch_note", "vault_patch_note or ")}vault_update_properties. Protected paths (${describeProtectedPaths(config)}) cannot be moved.

Parameters:
- prune_empty_folders removes each parent folder of old_path that the move leaves with zero entries, up to but never including the vault root; a folder holding any file, even a hidden .DS_Store, is kept. An in-place rename or a move into a subfolder of the source prunes nothing. Pruning is best-effort: a folder that can't be removed never fails the call. Without it, empty folders stay, matching Obsidian.

Errors:
- "destination exists: …" — a note already lives at new_path; this tool never overwrites. Pick a free path or delete the existing note first.
- "note not found: …" — old_path does not exist; verify it with vault_list_notes.
- "source and destination are the same path" — old_path and new_path name the same note, so there is nothing to move.
- "cannot move protected path …" / "cannot move into protected path …" — old_path or new_path sits under a protected folder.
- "cannot read daily notes config from .obsidian/daily-notes.json" — the file exists but is unreadable, so the daily notes folder to protect is unknown; repair it, or set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry.
- "path must end in …" — both old_path and new_path must end in .md.
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use vault-relative paths with no hidden (dot-prefixed) file or folder in them (notes cannot move from or into hidden paths, matching Obsidian).
- "concurrent write in progress" — a write is in flight on the note, the destination, or one of its backlink sources (the move locks all of them as one unit); retry the move.
- "backlink set did not stabilize" — the vault was modified during the move and new backlink sources kept appearing across retries; nothing was written; retry the move.
- An ordinary move that fails partway (rare: a permission or disk error) — no data is lost, and the error names what failed and the resulting state. The original is deleted last, after the destination and every backlink are written. If a backlink write failed: new_path exists and old_path is intact, so delete the partial new_path, then re-run the move. If the final delete failed: both paths exist, so delete old_path to finish.
- A case-only rename that fails partway — the note is renamed in place first. If the rename failed: nothing was written. If a later link write failed: the note already lives at new_path and old_path is gone, so fix the remaining links in place (the error names the note whose update failed) instead of re-running the move.

Obsidian syntax: Link rewrites preserve each link's existing form — embed marker (!), heading anchor (#…), and alias (|…) are kept; a markdown link keeps its original extension and link text. Only the target path is changed.

Returns: JSON with moved_to (the new path), links_updated (count of link occurrences rewritten, including the moved note's own relative links), updated_notes (sorted paths of the other notes that were edited; the moved note is implied by moved_to), and pruned_empty_folders (count of empty parent folders removed — 0 unless prune_empty_folders was set).`,
      inputSchema: {
        old_path: z
          .string()
          .min(1)
          .describe(
            'Current vault-relative path of the note to move (e.g. "Inbox/Draft.md"). Must end in .md. Use the exact letter case.',
          ),
        new_path: z
          .string()
          .min(1)
          .describe(
            'Destination vault-relative path (e.g. "Projects/Spec.md"). Must end in .md and must not already exist; parent folders are created as needed. Use the exact letter case of existing folders; a different case can create a second folder.',
          ),
        prune_empty_folders: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, also remove parent folders of old_path that the move leaves empty. Default false.",
          ),
      },
    },
    async (
      { old_path: oldPath, new_path: newPath, prune_empty_folders: pruneEmptyFolders },
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
          // Canonicalize before the index lookup so an aliased input (e.g.
          // "A/../Note.md") still finds its backlinks; absolute input throws
          // here. moveNote re-canonicalizes internally (idempotent on
          // canonical input) — this call serves the backlinks lookup only.
          const normalizedOldPath = resolveVaultRelativePath({
            vaultPath,
            notePath: oldPath,
          })
          const normalizedNewPath = resolveVaultRelativePath({
            vaultPath,
            notePath: newPath,
          })
          const backlinks = search.getBacklinks({ path: normalizedOldPath }, reqLogger)
          const [allNotePaths, allAssetPaths, protectedPaths] = await Promise.all([
            vaultFs.listNotes({ vaultPath }, reqLogger),
            vaultFs.listAssets({ vaultPath }, reqLogger),
            resolveEffectiveProtectedPaths({ config, vaultPath }, reqLogger),
          ])
          return noteMover.moveNote(
            {
              vaultPath,
              oldPath: normalizedOldPath,
              newPath: normalizedNewPath,
              protectedPaths,
              backlinkSources: backlinks.map((backlink) => backlink.path),
              allNotePaths,
              allAssetPaths,
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
            prunedFolderCount: result.pruned_empty_folders,
          })
          return JSON.stringify(result)
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
    {
      title: "Update Properties",
      description: `Update a note's frontmatter properties via shallow merge — new keys added, matching keys overwritten, null deletes a key, unmentioned keys preserved. Body is never modified.

Example: vault_update_properties({ path: "Projects/todo.md", properties: { status: "active", draft: null } })

When to use: Changing tags, status, type, or any property without reading/rewriting the full note body.
Prefer vault_write_note when creating a new note, or replacing the body (with overwrite: true). Read current properties first with vault_read_note({ properties_only: true }) — arrays are replaced entirely, not appended to.

Errors:
- "note not found" — path does not exist; create the note first with vault_write_note
- "path must end in …" — add the .md extension
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it
- "concurrent write in progress" — another write to this note is in flight; re-read the note and retry

Obsidian syntax: Use arrays for multi-value fields (tags: [a, b]), quote wikilinks ("[[Note]]"), keep types consistent (mismatches cause silent query failures).

Returns: Confirmation message.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension. Use the exact letter case.',
          ),
        properties: z
          .record(z.string().min(1), z.unknown())
          .describe("Properties to merge; a null value deletes that key."),
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
        () => vaultFs.updateProperties({ vaultPath, path, properties }, reqLogger),
        () => {
          reqLogger.info("tool_result", { outcome: "properties_updated" })
          return `Updated properties on ${path}`
        },
      )
    },
  )
}
