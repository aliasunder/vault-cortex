/** Vault CRUD tool registrations — read, write, patch, replace, delete, move. */

import { z } from "zod"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { VaultConfig } from "../../config.js"
import { vaultFs, resolveVaultRelativePath } from "../../vault-operations/vault-filesystem.js"
import { DEFAULT_DAILY_NOTES_FOLDER } from "../../vault-operations/daily-notes.js"
import { noteMover } from "../../vault-operations/note-mover.js"
import { resolveEffectiveProtectedPaths } from "../../vault-operations/vault-folder-config.js"
import { readTrashConfig } from "../../vault-operations/trash-config.js"
import { vaultPatcher } from "../../vault-operations/vault-patcher.js"
import type { DisplacedLeadingContent } from "../../vault-operations/vault-patcher.js"
import { pageTextByLines } from "../../obsidian-markdown/lines.js"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import {
  BLANK_LINES_NEVER_DOUBLE_CLAUSE,
  CONCURRENT_WRITE_RETRY_ERROR_ENTRY,
  EDIT_SAVE_RULES_SENTENCE,
  FILESYSTEM_ERROR_ENTRY,
  LISTING_FILESYSTEM_ERROR_ENTRY,
  NOTE_END_BLANK_LINES_SENTENCE,
  RETRY_REREAD_CLAUSE,
  WHITESPACE_ONLY_LINE_CLAUSE,
  describePropertiesBlockErrorEntry,
  describeTextWindow,
  formatServedSentencesLine,
  NOTE_EXTENSION_ERROR_ENTRY,
  OPENING_BLOCK_ERROR_ENTRY,
  PATH_SAFETY_ERROR_ENTRY,
  toolInputErrorResult,
} from "./tool-helpers.js"

// Errors entries that two or more of this module's tools share word for word.
const HEADING_NOT_FOUND_ERROR_ENTRY =
  '- "heading not found" — the message lists the available headings'
const EMPTY_HEADING_ERROR_ENTRY =
  '- "heading cannot be empty" — heading is whitespace only; pass the heading\'s text'
const CONTENT_CONTROL_CHARACTER_ERROR_ENTRY =
  '- "content contains a control character" — remove the character the message names'
const AMBIGUOUS_SPAN_ANCHOR_ERROR_ENTRY =
  '- "ambiguous start anchor …" / "ambiguous end anchor …" — the anchor matches multiple lines; use a longer fragment or set first_match: true'

// picomatch throws its own SyntaxError on a pattern over 65,536 characters, so
// the glob schema stops a long pattern before the matcher runs. Real patterns
// are a few dozen characters.
const MAX_GLOB_LENGTH = 1024

/** The Errors entry of a tool whose write lock refused the call, when the caller
 *  re-reads the note before retrying because the other write may have changed it. */
const CONCURRENT_WRITE_REREAD_ERROR_ENTRY =
  '- "concurrent write in progress" — a write to this note is in flight; re-read it and retry'

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
  const nestedSentence = `The ${bytes} bytes of pre-existing content above the note's first heading are now nested under the inserted heading.`

  // insert_before rejects an empty heading, so naming one would send the agent into a failing call.
  if (!firstHeading.text) {
    return `${nestedSentence} The first heading is an empty H${firstHeading.level}, which operation "insert_before" cannot target. To add a section below existing content instead, use operation "append".`
  }
  return `${nestedSentence} To add a section above the first heading without pulling existing content into it, use operation "insert_before" with heading "${firstHeading.text}" (H${firstHeading.level}).`
}

/** Protected-path list for tool descriptions. Descriptions are built once at
 *  registration and the daily notes folder is resolved per call, so the text
 *  names that folder's default and the tool whose result shows the folder in
 *  use, not its resolved value. */
const describeProtectedPaths = (params: {
  config: VaultConfig
  dailyNotePathClause: string
}): string => {
  const { config, dailyNotePathClause } = params

  if (config.protectedPathsOverride) {
    // loadConfig strips trailing slashes from override entries.
    return config.protectedPathsOverride.map((protectedPath) => protectedPath + "/").join(", ")
  }
  return `${config.memoryDir}/ and the daily notes folder (${DEFAULT_DAILY_NOTES_FOLDER}/ by default${dailyNotePathClause}; not protected when Obsidian's Daily Notes folder setting is the vault root or blank)`
}

export const registerVaultCrudTools = ({
  registerTool,
  isToolEnabled,
  safeHandler,
  safeHandlerContent,
  whenToolEnabledText,
  formatEnabledToolList,
  vaultPath,
  search,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  // The read, edit, and delete tools' not-found remedies name vault_list_notes or
  // vault_read_note only while that tool is served; otherwise they fall back to a
  // check that needs no tool. Each remedy keeps its own tools' wording, so the
  // three note-not-found remedies differ by a word or two.
  const listNotesEnabled = isToolEnabled("vault_list_notes")
  const noteNotFoundCheckRemedy = listNotesEnabled
    ? "check vault_list_notes for valid paths"
    : "check its spelling and letter case"
  const noteNotFoundVerifyRemedy = listNotesEnabled
    ? "verify path with vault_list_notes"
    : "check the path's spelling and letter case"
  const readNoteNotFoundRemedy = listNotesEnabled
    ? "verify it with vault_list_notes"
    : "check its spelling and letter case"
  const readNoteEnabled = isToolEnabled("vault_read_note")
  const textNotFoundRemedy = readNoteEnabled
    ? "verify exact text with vault_read_note"
    : "check old_text's letter case, spacing, and line breaks"
  const anchorNotFoundRemedy = readNoteEnabled
    ? "verify with vault_read_note"
    : "check the fragment's letter case and spacing"

  // Errors entries built from those remedies that two or more tools share word for word.
  const noteNotFoundCheckErrorEntry = `- "note not found" — path does not exist; ${noteNotFoundCheckRemedy}`
  const noteNotFoundVerifyErrorEntry = `- "note not found" — ${noteNotFoundVerifyRemedy}`
  const spanAnchorNotFoundErrorEntry = `- "start anchor not found" / "end anchor not found" — no body line holds the fragment; ${anchorNotFoundRemedy}`

  const protectedPathsText = describeProtectedPaths({
    config,
    dailyNotePathClause: whenToolEnabledText(
      "vault_get_daily_note",
      "; vault_get_daily_note's path shows the folder in use",
    ),
  })
  // DAILY_NOTES_FOLDER and PROTECTED_PATHS both bypass daily-notes.json, so
  // the entry is listed only when the file is read.
  const readsDailyNotesConfig = !config.protectedPathsOverride && !config.dailyNotesFolder
  const dailyNotesConfigErrorEntry = readsDailyNotesConfig
    ? `\n- "cannot read daily notes config from .obsidian/daily-notes.json" — the file that names the protected daily notes folder can't be parsed; ask the vault's owner to repair it, or the server's operator to set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry`
    : ""

  // Incoming and outgoing links are separate tools, so the sentence names
  // whichever of the pair is served.
  const describeReadNoteLinkTools = (): string => {
    const backlinksEnabled = isToolEnabled("vault_get_backlinks")
    const outgoingLinksEnabled = isToolEnabled("vault_get_outgoing_links")

    if (backlinksEnabled && outgoingLinksEnabled) {
      return "To explore what links to this note or what it links to, use vault_get_backlinks and vault_get_outgoing_links."
    }
    if (backlinksEnabled) {
      return "To explore what links to this note, use vault_get_backlinks."
    }
    if (outgoingLinksEnabled) {
      return "To explore what this note links to, use vault_get_outgoing_links."
    }
    return ""
  }

  const readNoteAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText("vault_search", "Prefer vault_search when you don't know the path."),
    whenToolEnabledText(
      "vault_list_tasks",
      "For task status or order on a board, prefer vault_list_tasks; heading mode returns a lane's Markdown.",
    ),
    whenToolEnabledText(
      "vault_get_memory",
      `Prefer vault_get_memory for ${config.memoryDir}/ files (returns content without properties).`,
    ),
    whenToolEnabledText("vault_patch_note", "To edit a section you've read, use vault_patch_note."),
    describeReadNoteLinkTools(),
  ])

  registerTool(
    TOOL_NAMES.VAULT_READ_NOTE,
    {
      title: "Read Note",
      description: `Read a markdown note by its vault-relative path. By default returns the full raw content including properties; optional modes return just the properties, just the heading outline, or just one section.

Example: vault_read_note({ path: "Projects/vault-cortex.md" })
Example: vault_read_note({ path: "TASKS.md", outline: true })
Example: vault_read_note({ path: "TASKS.md", heading: "Active" })
Example: vault_read_note({ path: "TASKS.md", heading: "Done", start_line: 1, limit: 20 })

When to use: You know the exact path and need a specific note's content. For a large note (a long Kanban board or doc), use outline: true to see its headings and any text sitting above them, then heading: "..." to read just the one section you need. For a note or section too long for one response, page it with start_line and limit to read a window at a time. To check a note's or section's line count, request start_line: 1 with limit: 1 — one line plus the total.${readNoteAlternativesLine}

Behavior: a section spans from its heading to the next heading with the same or a smaller level number (or EOF), so it includes its child headings. Empty headings ("##" with no text) act as boundaries but cannot be targeted; read the parent section or the full note${whenToolEnabledText("vault_replace_in_note", ", and edit them via vault_replace_in_note")}.

Errors:
- "note not found" — no note exists at this path; ${readNoteNotFoundRemedy}
${HEADING_NOT_FOUND_ERROR_ENTRY}
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate, or read the full note (omit heading) when headings share the same level
- "outline, heading, and properties_only are mutually exclusive — set at most one"
- "heading_level requires a heading" — pass heading with it
${EMPTY_HEADING_ERROR_ENTRY}
- "line paging is not available in outline mode" / "… properties_only mode" — start_line and limit page only a full read or a heading section
- "start line past the end" — the message states the line count; resend a start_line within it
- 'path must end in ".md"' — add the extension to a note's path${whenToolEnabledText("vault_read_file", "; read other files (images, .canvas, data files) with vault_read_file")}
${PATH_SAFETY_ERROR_ENTRY}
- "properties block is not valid YAML …" — only properties_only raises it; a full read, outline and heading still work; the error says how to repair it
${FILESYSTEM_ERROR_ENTRY}

Returns: Raw markdown string (default); JSON object of properties, {} when the note has none (properties_only); JSON outline object, shaped as the outline parameter describes (outline); raw markdown of the section, heading line included (heading). When start_line or limit is given, the result is preceded by a window-metadata text block ("path — lines 1–20 of 250 (continue with start_line: 21)"). Unpaged full reads return the file's exact bytes; heading sections and paged reads use LF line endings. In the outline, bytes at the root is the whole file's size, modified its modification time (ISO 8601), and each heading's bytes the size of the text heading mode returns for that section; an empty heading appears with text: "".`,
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
            "If true, returns { bytes, modified, leading_callout?, leading_content?, headings } as JSON instead of body content. headings: [{ level, text, bytes }]; leading_callout: { type, title, body } when the note has a top-of-file callout; leading_content: the rest of the body text above the first heading (callout lines excluded) when the note has any.",
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
            "Heading level (1-6) for disambiguation when multiple headings share the same text",
          ),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First line to return, 1-based (default 1)."),
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

      const returnError = (message: string) => toolInputErrorResult({ message, logger: reqLogger })

      // The read modes select different content; allowing more than one would
      // make the result ambiguous, so reject the combination up front. The
      // schema's min(1) rejects an empty heading and a 0 for heading_level,
      // start_line and limit, so truthy checks below find every value sent; a
      // whitespace-only heading still counts as section mode, so the heading
      // lookup rejects it rather than the read silently falling through to a
      // full one.
      const selectedModeCount = [properties_only, outline, Boolean(heading)].filter(Boolean).length

      if (selectedModeCount > 1) {
        return returnError(
          "outline, heading, and properties_only are mutually exclusive — set at most one",
        )
      }

      // heading_level only disambiguates a heading; on its own it would be
      // silently ignored, so require its companion explicitly.
      if (heading_level && !heading) {
        return returnError("heading_level requires a heading")
      }

      const isPagedRead = Boolean(start_line || limit)

      const formatPagedRead = (params: {
        text: string
        mode: "section" | "full"
      }): CallToolResult["content"] => {
        const { text: windowText, lineWindow } = pageTextByLines({
          text: params.text,
          path,
          startLine: start_line,
          limit,
        })
        reqLogger.info("tool_result", { mode: params.mode, lineWindow })
        return [
          { type: "text" as const, text: describeTextWindow(path, lineWindow) },
          { type: "text" as const, text: windowText },
        ]
      }

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
          (noteOutline) => {
            reqLogger.info("tool_result", { mode: "outline" })
            return JSON.stringify(noteOutline)
          },
        )
      }

      // A present heading selects section mode; its absence falls through to a
      // full read.
      if (heading) {
        if (isPagedRead) {
          return safeHandlerContent(
            reqLogger,
            () => {
              return vaultFs.readNoteSection(
                { vaultPath, path, heading, headingLevel: heading_level },
                reqLogger,
              )
            },
            (text) => formatPagedRead({ text, mode: "section" }),
          )
        }
        return safeHandler(
          reqLogger,
          () => {
            return vaultFs.readNoteSection(
              { vaultPath, path, heading, headingLevel: heading_level },
              reqLogger,
            )
          },
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
          (text) => formatPagedRead({ text, mode: "full" }),
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

  const listNotesAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_search_by_folder",
      "Prefer vault_search_by_folder when you need metadata (tags, type, related) along with paths.",
    ),
    whenToolEnabledText("vault_search", "Prefer vault_search for content-based discovery."),
    whenToolEnabledText("vault_read_note", "Use vault_read_note to read a note from the results."),
  ])

  registerTool(
    TOOL_NAMES.VAULT_LIST_NOTES,
    {
      title: "List Notes",
      description: `List the vault's note (.md) paths, optionally filtered by folder and/or glob pattern. Returns paths only — not content or metadata.

Example: vault_list_notes({ folder: "Projects" })
Example: vault_list_notes({ glob: "**/*session-log*.md" })
Example: vault_list_notes({ folder: "Projects", glob: "*.md" }) — the folder's top-level notes only

When to use: Browsing what exists in a folder by filename, or finding notes matching a path pattern.${listNotesAlternativesLine}

Parameters:
- folder names a whole folder; without a glob, notes in its subfolders are listed too: "Projects" covers "Projects/Archive" but not "ProjectsOld/". Use the folder's exact letter case; a different case can find nothing.
- glob matches each note's path inside folder (its vault-relative path when folder is omitted), case-sensitively. * stays within one folder level and ** spans any depth: with folder "Projects", "**/*.md" lists every note under it.

Behavior: A nonexistent folder or no glob matches returns an empty array, not an error. Paths come back sorted by vault-relative path in code-unit order (uppercase before lowercase). Hidden (dot-prefixed) notes and folders are never listed.

Errors:
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative folder outside hidden folders, or omit folder to list the whole vault.
${LISTING_FILESYSTEM_ERROR_ENTRY}.

Returns: JSON array of every matching vault-relative path (e.g. ["Notes/idea.md", "Projects/plan.md"]).`,
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
          .max(MAX_GLOB_LENGTH)
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

  // The routing line names only the partial-edit tools the server serves, and
  // drops out when it serves neither.
  const partialEditToolNames = formatEnabledToolList(["vault_patch_note", "vault_replace_in_note"])

  const writeNoteAlternativeLines = [
    partialEditToolNames ? `Prefer ${partialEditToolNames} to change part of a note.` : "",
    whenToolEnabledText(
      "vault_update_properties",
      "Prefer vault_update_properties for property-only edits (no body round-trip).",
    ),
    whenToolEnabledText(
      "vault_update_memory",
      `Prefer vault_update_memory for appending dated entries to ${config.memoryDir}/ memory files.`,
    ),
  ]
    .filter(Boolean)
    .map((line) => `\n${line}`)
    .join("")

  registerTool(
    TOOL_NAMES.VAULT_WRITE_NOTE,
    {
      title: "Write Note",
      description: `Create a markdown note, or with overwrite: true replace an existing note's body.

Example: vault_write_note({ path: "Projects/notes.md", body: "# Notes\\n\\nProject notes here.", properties: { tags: ["project"], type: "project" } })
Example: vault_write_note({ path: "Projects/notes.md", body: "Updated content.", overwrite: true })

When to use: Creating a new note, or replacing a whole note's body.${writeNoteAlternativeLines}

Behavior:
- Properties merge with any existing properties when overwriting (new keys added, matching keys overwritten, keys set to null removed, unmentioned keys preserved); overwriting without properties keeps the existing property values.
- A new note leaves out keys set to null.

Errors:
- "note already exists" — set overwrite: true to replace it
${NOTE_EXTENSION_ERROR_ENTRY}
- "cannot write note …: that path is not a file" — a folder already has this name; choose another path
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
- "body contains a control character" — remove the character the message names
${FILESYSTEM_ERROR_ENTRY}
${describePropertiesBlockErrorEntry("with overwrite: true")}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: Body is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag (escape with \\#), [[ = wikilink, %% = comment block. In properties: quote wikilink values ("[[Note]]"), use YAML lists for tags, keep property types consistent (string/number/list mismatches cause silent query failures).

Returns: "Wrote <path>".`,
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
            "Markdown body content — do not include a properties block (the --- lines); use the properties parameter instead.",
          ),
        properties: z
          .record(z.string().min(1), z.unknown())
          .optional()
          .describe("The note's properties."),
        overwrite: z
          .boolean()
          .optional()
          .default(false)
          .describe("Allow overwriting an existing note (default: false)."),
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

  // The leading-callout edit calls vault_read_note, then vault_replace_in_note,
  // so it is left out when either tool is disabled.
  const readAndReplaceInNoteEnabled =
    isToolEnabled("vault_read_note") && isToolEnabled("vault_replace_in_note")
  const leadingCalloutEditEntry = readAndReplaceInNoteEnabled
    ? `
- To edit a leading callout, read it via vault_read_note(outline: true), then vault_replace_in_note the old block for the new one; a no-heading prepend would stack a second callout above it.`
    : ""

  // One "Prefer" sentence lists every served sibling, so the routing reads as
  // one choice and costs one sentence however many tools are served.
  const patchNoteAlternatives = [
    whenToolEnabledText(
      "vault_write_note",
      "vault_write_note for a new note or a full rewrite (overwrite: true)",
    ),
    whenToolEnabledText(
      "vault_replace_in_note",
      "vault_replace_in_note for an in-place text change (a typo, a rename)",
    ),
    whenToolEnabledText(
      "vault_insert_at_anchor",
      "vault_insert_at_anchor for inserting next to a specific line",
    ),
    whenToolEnabledText("vault_replace_span", "vault_replace_span for replacing a run of lines"),
    whenToolEnabledText("vault_delete_span", "vault_delete_span for removing lines"),
    whenToolEnabledText("vault_update_properties", "vault_update_properties for properties"),
    whenToolEnabledText("vault_create_task", "vault_create_task for adding a task"),
    whenToolEnabledText("vault_update_task", "vault_update_task for a task's status or lane"),
  ].filter(Boolean)
  const patchNoteAlternativesLine =
    patchNoteAlternatives.length > 0 ? `\nPrefer ${patchNoteAlternatives.join("; ")}.` : ""

  registerTool(
    TOOL_NAMES.VAULT_PATCH_NOTE,
    {
      title: "Patch Note",
      description: `Surgical edits to a markdown note — append, prepend, replace, or insert content by heading. ${EDIT_SAVE_RULES_SENTENCE} A repeated call can write the content again, ${RETRY_REREAD_CLAUSE}.

Example: vault_patch_note({ path: "Projects/plan.md", operation: "append", heading: "Open questions", content: "- Which region hosts the backup?" })
Example: vault_patch_note({ path: "Notes/Plan.md", operation: "replace", heading: "Status", content: "On track for launch.\\n" })
Example: vault_patch_note({ path: "Notes/Plan.md", operation: "insert_before", heading: "Phase 2", content: "## Phase 1\\nDone.\\n" })
Example: vault_patch_note({ path: "Notes/Plan.md", operation: "prepend", content: "> [!info] Draft\\n> Not reviewed yet.\\n" }) — adds a leading callout

When to use: Modifying part of an existing note without overwriting the entire body.${patchNoteAlternativesLine}

Operations:
- append: add content at end of section (or end of file if no heading), below any empty lines that end it. So when a blank line follows a table, an appended row starts a new table${whenToolEnabledText("vault_insert_at_anchor", "; to extend the original table, use vault_insert_at_anchor after its last row")}
- prepend: add content after heading line (or at the top of the body, below the properties block, if no heading). To start a new section above the note's current first heading, use insert_before on that heading: a no-heading prepend whose content starts with a heading nests any content above the first heading inside the new section.
- replace: replace section body (requires heading)${whenToolEnabledText("vault_delete_span", "; to empty it, use vault_delete_span on its lines")}
- insert_before: insert content above the heading line (requires heading)

Behavior:
- Heading-targeted operations keep the matched heading. Every operation inserts content as whole lines and adds no empty lines of its own: content ending in a newline ("Done.\\n") leaves an empty line after it, and content without one ("Done.") puts the next line directly below.
- A section spans from its heading to the next heading with the same or a smaller level number (or EOF), so it includes its child headings. Empty headings ("##" with no text) act as boundaries but cannot be targeted${whenToolEnabledText("vault_replace_in_note", "; edit their content via vault_replace_in_note instead")}.${leadingCalloutEditEntry}

Errors:
${noteNotFoundCheckErrorEntry}
${NOTE_EXTENSION_ERROR_ENTRY}
${HEADING_NOT_FOUND_ERROR_ENTRY}
- "ambiguous heading" — multiple headings match; use heading_level to disambiguate; if they share a level, rename one${whenToolEnabledText("vault_replace_in_note", " or use vault_replace_in_note to target by text content")}
- "operation … requires a heading target" — pass heading, or use append or prepend to edit the file body
${EMPTY_HEADING_ERROR_ENTRY}
- "content begins with the heading … which would duplicate it" — content's first line repeats the target heading; omit it
- "section … has N child headings …" — the target section contains child headings that replace would destroy; pass include_children: true to confirm, or target the child heading directly
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
${CONTENT_CONTROL_CHARACTER_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: Content is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block.
Table rows: send only the data row ("| cell1 | cell2 |"), not the header or separator — duplicating them splits the table.

Returns: Confirmation message — "Applied <operation> to <path> → <target>", where target is the matched heading (e.g. "## Active") or "file body" for a no-heading append/prepend. A no-heading prepend that nested existing content under an inserted heading adds a sentence naming the content's size and any call that would have avoided it.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "TASKS.md", "Projects/plan.md"). Use the exact letter case.',
          ),
        operation: z
          .enum(["append", "prepend", "replace", "insert_before"])
          .describe("The edit to apply."),
        content: z
          .string()
          .min(1)
          .describe("Markdown content to insert, or the section's new body for replace."),
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
            "When true, allows replace to overwrite a section that contains child headings.",
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
        () => {
          return vaultPatcher.patchNote(
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
          )
        },
        (result) => {
          reqLogger.info("tool_result", {
            outcome: "patched",
            displaced: Boolean(result.displacedLeadingContent),
          })
          if (!result.displacedLeadingContent) return result.message
          return `${result.message}. ${describeDisplacedLeadingContent(result.displacedLeadingContent)}`
        },
      )
    },
  )

  const replaceInNoteAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_delete_span",
      "To delete a large multi-line block, prefer vault_delete_span (short anchors instead of full old_text).",
    ),
    whenToolEnabledText(
      "vault_replace_span",
      "To replace a large block by anchors instead of reproducing the full old_text, use vault_replace_span.",
    ),
    whenToolEnabledText(
      "vault_patch_note",
      'To relocate content between headings, use vault_patch_note to add at the target first, then remove from source (new_text="") — add-before-delete, so a failure duplicates the block instead of losing it.',
    ),
  ])
  const servedPropertyEditors = [
    whenToolEnabledText("vault_update_properties", "vault_update_properties"),
    whenToolEnabledText("vault_write_note", "vault_write_note's properties parameter"),
  ].filter(Boolean)
  const propertyEditSentence =
    servedPropertyEditors.length > 0
      ? ` Edit properties via ${servedPropertyEditors.join(" or ")}.`
      : ""

  registerTool(
    TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
    {
      title: "Replace in Note",
      description: `Find and replace exact text in a markdown note's body. ${EDIT_SAVE_RULES_SENTENCE}${propertyEditSentence} A repeated call replaces old_text again if the note still holds it, including a copy inside the first call's new_text, ${RETRY_REREAD_CLAUSE}.

Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "TODO: write summary", new_text: "Summary complete." })
Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "- [ ] draft outline\\n", new_text: "" })
Example: vault_replace_in_note({ path: "Projects/plan.md", old_text: "Q3", new_text: "Q4", replace_all_occurrences: true })

When to use: Targeted text changes within a single location — fixing typos, updating values, renaming terms, or removing a short line (new_text="").${replaceInNoteAlternativesLine}

Parameters:
- old_text: include enough surrounding context to ensure uniqueness when the target text appears in multiple places.
- replace_all_occurrences: set true for deliberate bulk renames or term replacements.

Behavior:
- A non-empty new_text replaces the match exactly; new_text="" deletes it, and when text remains on the line, the line is written exactly as asked.
- When new_text="" leaves the match's line empty, ${BLANK_LINES_NEVER_DOUBLE_CLAUSE}, and by at least one.
- ${NOTE_END_BLANK_LINES_SENTENCE}
- To remove a table row or list item, include its line break in old_text, or the empty line left behind splits the table or list.
- A ${WHITESPACE_ONLY_LINE_CLAUSE}.

Errors:
${noteNotFoundCheckErrorEntry}
${NOTE_EXTENSION_ERROR_ENTRY}
- "text not found" — old_text does not appear in the note body; ${textNotFoundRemedy}
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
- "new_text contains a control character" — remove the character the message names
${FILESYSTEM_ERROR_ENTRY}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: new_text is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block in replacement text.

Returns: "Replaced <N> occurrence(s) in <path>".`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension (e.g. "Projects/plan.md"). Use the exact letter case.',
          ),
        old_text: z.string().min(1).describe("Exact text to find, no regex (case-sensitive)."),
        new_text: z.string().describe('Replacement text; "" deletes the matched text.'),
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
        () => {
          return vaultPatcher.replaceInNote(
            {
              vaultPath,
              path,
              oldText: old_text,
              newText: new_text,
              replaceAllOccurrences: replace_all_occurrences,
            },
            reqLogger,
          )
        },
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

  /** The span tools' warning about a fenced code block: an end anchor on its
   *  closing fence also matches the opening fence, which the span includes.
   *  `editVerb` names the span tool's edit, and picks the vault_replace_in_note
   *  arguments that make the same edit to such a block. */
  const fencedBlockEndAnchorText = (editVerb: "remove" | "replace"): string => {
    const newTextArgument = editVerb === "remove" ? ' with new_text: ""' : ""
    const fallbackAdvice = whenToolEnabledText(
      "vault_replace_in_note",
      `; to ${editVerb} such a block, use vault_replace_in_note${newTextArgument}`,
    )
    return `A span that includes a code block's opening fence can't end at a plain closing fence (\`\`\`): the end anchor is ambiguous, and first_match: true would end the span at the opening fence${fallbackAdvice}.`
  }

  /** The anchor rule the three anchor tools share. "Body line" is defined here
   *  because the schema texts use the term without saying what it excludes;
   *  substring and case-sensitive matching stay in the schema texts. */
  const anchorMatchingText = "An anchor matches a body line (any line below the properties block)."

  const replaceBlockAdvice = isToolEnabled("vault_replace_span")
    ? "use vault_replace_span (one atomic step)"
    : `delete it here${whenToolEnabledText("vault_patch_note", ", then vault_patch_note to add the new content")}`

  const deleteSpanAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_replace_in_note",
      "Prefer vault_replace_in_note for small in-place edits.",
    ),
    `To replace a block, ${replaceBlockAdvice}.`,
  ])

  registerTool(
    TOOL_NAMES.VAULT_DELETE_SPAN,
    {
      title: "Delete Span",
      description: `Delete a contiguous block of whole lines from a note's body by referencing short anchor substrings instead of reproducing the full block text. ${EDIT_SAVE_RULES_SENTENCE} With first_match: true, a repeated call deletes the next match, ${RETRY_REREAD_CLAUSE}.

Example: vault_delete_span({ path: "Tracker.md", start_anchor: "| 2024-03-02 | Acme" }) — deletes the one table row whose line contains that fragment.
Example: vault_delete_span({ path: "Notes/Plan.md", start_anchor: "> [!warning] Stale", end_anchor: "remove after launch" }) — deletes from the start anchor line through the end anchor line.

When to use: Removing a block you have already read — a table row, callout, or run of list items — where reproducing it exactly as old_text would be error-prone.${deleteSpanAlternativesLine}

Parameters:
- ${anchorMatchingText}
- end_anchor is searched at or after the start line and must be unique among those lines. If start_anchor and end_anchor match the same line, only that one line is deleted.
- ${fencedBlockEndAnchorText("remove")}

Behavior:
- Where the removed lines stood, ${BLANK_LINES_NEVER_DOUBLE_CLAUSE}. So removing a table row leaves the table whole.
- ${NOTE_END_BLANK_LINES_SENTENCE}
- A ${WHITESPACE_ONLY_LINE_CLAUSE}.

Errors:
${noteNotFoundVerifyErrorEntry}
${NOTE_EXTENSION_ERROR_ENTRY}
${spanAnchorNotFoundErrorEntry}
${AMBIGUOUS_SPAN_ANCHOR_ERROR_ENTRY}
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
${OPENING_BLOCK_ERROR_ENTRY}

Returns: 'Deleted <N> line(s) from <path>: "<removed lines>"' — the removed lines joined by line breaks, cut at 80 characters with "…".`,
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
            "Short, unique substring of the block's first line, a body line (case-sensitive).",
          ),
        end_anchor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short substring of the block's LAST line, a body line (case-sensitive). Omit to delete just the single line containing start_anchor.",
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
        () => {
          return vaultPatcher.deleteSpan(
            {
              vaultPath,
              path,
              startAnchor: start_anchor,
              endAnchor: end_anchor,
              firstMatch: first_match,
            },
            reqLogger,
          )
        },
        (confirmation) => {
          reqLogger.info("tool_result", { outcome: "span_deleted" })
          return confirmation
        },
      )
    },
  )

  const replaceSpanAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_replace_in_note",
      "Prefer vault_replace_in_note for small in-place text changes (typos, renaming).",
    ),
    whenToolEnabledText(
      "vault_delete_span",
      "Prefer vault_delete_span when removing without replacement.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_REPLACE_SPAN,
    {
      title: "Replace Span",
      description: `Replace a contiguous block of whole lines in a note's body with new content, identified by short anchor substrings instead of the block's full text. ${EDIT_SAVE_RULES_SENTENCE} A repeated call can write the content again, or with first_match: true replace the next match, ${RETRY_REREAD_CLAUSE}.

Example: vault_replace_span({ path: "Tracker.md", start_anchor: "| 2024-03-02 | Acme", content: "| 2024-03-02 | Acme Corp | Updated |" }) — replaces the one table row whose line contains that fragment.
Example: vault_replace_span({ path: "Notes/Plan.md", start_anchor: "> [!warning] Stale", end_anchor: "remove after launch", content: "> [!info] Current\\n> Updated for v2." }) — replaces the callout block with a new one.

When to use: Replacing a block you have already read — a table row, callout, or run of list items — where reproducing it exactly as old_text would be error-prone.${replaceSpanAlternativesLine}

Parameters:
- ${anchorMatchingText}
- end_anchor is searched at or after the start line and must be unique among those lines. If start_anchor and end_anchor match the same line, only that one line is replaced.
- ${fencedBlockEndAnchorText("replace")}

Behavior:
- Each line break at content's start or end becomes an empty line on that side, so content ending in one ("| X |\\n") leaves an empty line after it, which splits a table.
- Where the note already has empty lines next to content's start or end, the wider run (the note's or content's) is kept, so blank lines never double. At the note's end, content's trailing line breaks count one fewer ("| X |\\n" leaves no empty line).
- Empty lines inside content are kept as written, and a ${WHITESPACE_ONLY_LINE_CLAUSE}.

Errors:
${noteNotFoundVerifyErrorEntry}
${NOTE_EXTENSION_ERROR_ENTRY}
${spanAnchorNotFoundErrorEntry}
${AMBIGUOUS_SPAN_ANCHOR_ERROR_ENTRY}
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
${CONTENT_CONTROL_CHARACTER_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: content is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block.

Returns: Confirmation message "Replaced <N> line(s) with <M> line(s) in <path>" — N counts the lines the span covered, M the lines in content as sent (its line breaks plus one).`,
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
            "Short, unique substring of the block's first line, a body line (case-sensitive).",
          ),
        end_anchor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short substring of the block's LAST line, a body line (case-sensitive). Omit to replace just the single line containing start_anchor.",
          ),
        content: z.string().min(1).describe("Replacement content (one or more lines)."),
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
        () => {
          return vaultPatcher.replaceSpan(
            {
              vaultPath,
              path,
              startAnchor: start_anchor,
              endAnchor: end_anchor,
              content,
              firstMatch: first_match,
            },
            reqLogger,
          )
        },
        (confirmation) => {
          reqLogger.info("tool_result", { outcome: "span_replaced" })
          return confirmation
        },
      )
    },
  )

  const insertAtAnchorAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_patch_note",
      "Prefer vault_patch_note for heading-targeted inserts (append/prepend to a section).",
    ),
    whenToolEnabledText(
      "vault_replace_span",
      "Prefer vault_replace_span when replacing a block rather than inserting next to it.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
    {
      title: "Insert at Anchor",
      description: `Insert content as whole lines into a note's body, before or after a specific line identified by a short anchor substring. ${EDIT_SAVE_RULES_SENTENCE} A repeated call inserts the content again, or fails as ambiguous when the content holds the anchor and first_match is false, ${RETRY_REREAD_CLAUSE}.

Example: vault_insert_at_anchor({ path: "Tracker.md", anchor: "| 2024-03-02 | Acme", position: "after", content: "| 2024-03-03 | Beta Corp | New entry |" }) — inserts a new table row after the matched row.
Example: vault_insert_at_anchor({ path: "Notes/Plan.md", anchor: "## Phase 2", position: "before", content: "> [!note] Phase 1 must close before this starts.\\n" }) — inserts a callout and a blank line above the Phase 2 heading.

When to use: Adding content at a precise location identified by a nearby line's text, without needing to know the heading structure. Good for inserting rows into tables, adding items into lists at a specific position, or placing content relative to a known landmark line.${insertAtAnchorAlternativesLine}

Parameters:
- ${anchorMatchingText}
- content is inserted verbatim — blank lines inside it are kept, and a trailing newline adds a blank line after the inserted block.

Behavior: A failed save leaves the note unchanged.

Errors:
${noteNotFoundVerifyErrorEntry}
${NOTE_EXTENSION_ERROR_ENTRY}
- "anchor not found" — no body line holds the fragment; ${anchorNotFoundRemedy}
- "ambiguous anchor …" — the anchor matches multiple lines; use a longer fragment or set first_match: true
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
${CONTENT_CONTROL_CHARACTER_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: content is Obsidian Flavored Markdown (no escaping applied). Watch for: #word = tag, [[ = wikilink, %% = comment block.

Returns: Confirmation message "Inserted <N> line(s) <before|after> anchor in <path>" — N counts the lines in content as sent (its line breaks plus one).`,
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
          .describe("Short, unique substring of the body line to insert next to (case-sensitive)."),
        position: z
          .enum(["before", "after"])
          .describe('"before" inserts above the anchor line, "after" below it.'),
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
        () => {
          return vaultPatcher.insertAtAnchor(
            {
              vaultPath,
              path,
              anchor,
              position,
              content,
              firstMatch: first_match,
            },
            reqLogger,
          )
        },
        (confirmation) => {
          reqLogger.info("tool_result", { outcome: "inserted_at_anchor" })
          return confirmation
        },
      )
    },
  )

  // Under Obsidian Sync a delete never reads the "Deleted files" setting or
  // touches .trash/, so the text about that setting, the trash outcomes, and
  // the errors they produce is left out. Each entry text starts with a line
  // break because it joins a list mid-way, and is "" when left out.
  const deleteNoteText = config.obsidianSyncEnabled
    ? {
        opener: `Delete a markdown note for good. The vault's owner can recover it from Obsidian Sync's version history (1 month on Standard, 12 months on Plus).`,
        trashOutcomeEntries: "",
        trashMoveErrorEntries: "",
        trashConfigErrorEntry: "",
        returns: `Confirmation message — "Deleted <path>".`,
      }
    : {
        opener: `Delete a markdown note, moving it to the vault's .trash/ folder or removing it for good as the vault's Obsidian "Deleted files" setting directs.`,
        trashOutcomeEntries: `
- The "Deleted files" setting decides the outcome, which the caller can't choose or see in advance:
  - "Move to system trash" moves the note to \`.trash/\`. Notes this server moved there are deleted after its retention period (TRASH_RETENTION_DAYS: 30 days by default, never when set to none).
  - "Move to Obsidian trash" moves the note to \`.trash/\` and keeps it forever.
  - "Permanently delete" removes the note for good.`,
        trashMoveErrorEntries: `
- "cannot move to trash … — 100 collisions in .trash/" — .trash/ holds this name and 100 numbered copies; ask the vault's owner to clear old copies, then retry
- "cannot move to trash …" without "100 collisions" — the note stays put; ask the vault's owner to fix .trash/ (e.g. a plain file blocks a needed folder), then retry`,
        trashConfigErrorEntry: `
- "cannot read trash config from .obsidian/app.json" — ask the vault's owner to repair it, then retry`,
        returns: `Confirmation message naming the outcome — "Deleted <path>" for permanent removal, "Moved <path> to trash (<.trash/ path>)" when the note landed in .trash/.`,
      }

  // A memory entry has a tool of its own; a daily note has none, so its remedy
  // is always Obsidian.
  const protectedPathRemedy = isToolEnabled("vault_delete_memory")
    ? "use vault_delete_memory for a memory entry, or ask the vault's owner to delete the note in Obsidian"
    : "ask the vault's owner to delete the note in Obsidian"

  registerTool(
    TOOL_NAMES.VAULT_DELETE_NOTE,
    {
      title: "Delete Note",
      description: `${deleteNoteText.opener}

Example: vault_delete_note({ path: "Scratch/temp.md" })
Example: vault_delete_note({ path: "Archive/2024/old.md", prune_empty_folders: true }) — also remove "Archive/2024" (and "Archive") if deleting the note empties them.

When to use: Removing a note you no longer need.${whenToolEnabledText("vault_delete_memory", `\nPrefer vault_delete_memory for removing individual dated entries from ${config.memoryDir}/ memory files.`)}${whenToolEnabledText("vault_move_note", "\nTo relocate a note, use vault_move_note instead.")}${whenToolEnabledText("vault_write_note", "\nTo replace a note's content, use vault_write_note with overwrite: true instead.")}

Behavior:${deleteNoteText.trashOutcomeEntries}
- Links to the note from other notes become broken${whenToolEnabledText("vault_get_backlinks", "; list them first with vault_get_backlinks")}. Protected paths are refused: ${protectedPathsText}.

Parameters:
- prune_empty_folders keeps a folder that holds any file, even a hidden .DS_Store. Pruning is best-effort: a folder that can't be removed never fails the call.

Errors:
- "cannot delete protected path" — the path sits under a protected folder; ${protectedPathRemedy}
${NOTE_EXTENSION_ERROR_ENTRY}
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_RETRY_ERROR_ENTRY}
- "note not found: …" — ${noteNotFoundVerifyRemedy}${deleteNoteText.trashMoveErrorEntries}
- "cannot delete …" (other than a protected path) — the note stays put; ask the vault's owner to fix the cause (e.g. permissions), then retry
${FILESYSTEM_ERROR_ENTRY}; the note stays put${deleteNoteText.trashConfigErrorEntry}${dailyNotesConfigErrorEntry}

Returns: ${deleteNoteText.returns} Notes how many empty folders were pruned when any were.`,
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
              // "local" is Obsidian's keep-forever trash.
              recordTrashEntry: trashOption === "system" ? search.recordTrashEntry : undefined,
              // Passed for every option, not only "system":
              // - Emptying .trash/ by hand leaves trash records behind, so a
              //   stale record can sit at the path this delete lands on.
              // - A move the server does not record ("local", or a "system"
              //   move whose record failed) drops that stale record, so the
              //   retention sweep never deletes the note just trashed.
              // - A "none" delete lands nothing in .trash/ and never calls it.
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

  // Each edit tool changes one part of a note, so the sentence names only the
  // parts whose tool is served.
  const noteEditRoutes = [
    { tool: TOOL_NAMES.VAULT_PATCH_NOTE, part: "body" },
    { tool: TOOL_NAMES.VAULT_UPDATE_PROPERTIES, part: "properties" },
  ].filter((route) => isToolEnabled(route.tool))
  const noteEditParts = noteEditRoutes.map((route) => route.part).join(" or ")
  const noteEditToolNames = formatEnabledToolList(noteEditRoutes.map((route) => route.tool))
  const noteEditSentence = noteEditToolNames
    ? `To only change a note's ${noteEditParts}, use ${noteEditToolNames}.`
    : ""
  // The two-tool alternative is worth warning against only while both tools
  // are served
  const writeAndDeleteServed =
    isToolEnabled(TOOL_NAMES.VAULT_WRITE_NOTE) && isToolEnabled(TOOL_NAMES.VAULT_DELETE_NOTE)
  const moveAlternativeSentence = writeAndDeleteServed
    ? "Prefer this over vault_write_note + vault_delete_note, which would orphan every backlink."
    : ""
  const moveRoutingLine = formatServedSentencesLine([moveAlternativeSentence, noteEditSentence])

  registerTool(
    TOOL_NAMES.VAULT_MOVE_NOTE,
    {
      title: "Move Note",
      description: `Move or rename a note and rewrite every link across the vault that points to it, like Obsidian's built-in rename. Incoming links in other notes — [[wikilinks]], [[wikilink|aliases]], [[wikilink#headings]], ![[embeds]], [markdown](links.md), and links in properties (e.g. related:) — and Canvas cards that embed the note are updated to the new path; the moved note's own relative links are fixed so they still resolve from the new folder, including relative links to attachments (e.g. ![[../assets/photo.png]]).

Example: vault_move_note({ old_path: "Inbox/Draft.md", new_path: "Inbox/Spec.md" }) — pure rename.
Example: vault_move_note({ old_path: "Inbox/spec.md", new_path: "Inbox/Spec.md" }) — case-only rename; works even where the filesystem treats both spellings as one file.
Example: vault_move_note({ old_path: "Inbox/Spec.md", new_path: "Projects/Spec.md" }) — move to another folder.
Example: vault_move_note({ old_path: "Inbox/Spec.md", new_path: "Projects/Spec.md", prune_empty_folders: true }) — also remove "Inbox" if the move empties it.

When to use: Renaming a note or relocating it to a different folder while keeping the link graph intact.${moveRoutingLine}

Parameters:
- prune_empty_folders keeps a folder that holds any file, even a hidden .DS_Store. An in-place rename or a move into a subfolder of the source prunes nothing. Pruning is best-effort: a folder that can't be removed never fails the call.

Behavior:
- A link is only rewritten when leaving it unchanged would break it, or would keep the old letter case after a rename, so a short [[Note]] that stays unambiguous after a folder move is left alone.
- Protected paths can be neither moved nor moved into: ${protectedPathsText}.

Errors:
- "destination exists: …" — this tool never overwrites; pick a free new_path or delete the existing note first.
- "note not found: …" — old_path does not exist; ${noteNotFoundVerifyRemedy}.
- "source and destination are the same path" — nothing to move; pass a different new_path.
- "cannot move protected path …" / "cannot move into protected path …" — old_path or new_path sits under a protected folder; pick a new_path outside it, or leave a protected note where it is.${dailyNotesConfigErrorEntry ? `${dailyNotesConfigErrorEntry}.` : ""}
${NOTE_EXTENSION_ERROR_ENTRY}.
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use vault-relative paths with no hidden (dot-prefixed) file or folder in them.
- "concurrent write in progress" — a write is in flight; retry the move.
- "backlink set did not stabilize" — the notes linking to the note kept changing while the move prepared; nothing was written; retry the move.
- "move aborted: could not read …" — names the note, or a note linking to it, that could not be read; nothing was written. Fix that note, then retry.
- "move aborted: could not rewrite …" — says why a note could not be saved with its links rewritten, and how to fix it; nothing was written.
- "move aborted: could not write to …" / "move aborted: could not rename to …" (a case-only rename) — new_path could not be created, and new parent folders it needed may remain; retry once, then ask the vault's owner to fix the folder or disk.
- "move incomplete: …" — the move failed partway; no data is lost, and the message names what failed, the state it left, and the step that finishes the move.
${FILESYSTEM_ERROR_ENTRY}; nothing was written.
- "[SqliteError]: …" — the search index failed and nothing was written; the message says what to do.

Obsidian syntax: Link rewrites preserve each link's existing form — embed marker (!), heading anchor (#…), and alias (|…) are kept; a markdown link keeps its original extension and link text.

Returns: JSON with moved_to (the new path), links_updated (count of link occurrences rewritten, including the moved note's own relative links), updated_notes (sorted paths of the other notes and Canvas files that were edited; the moved note is implied by moved_to), and pruned_empty_folders (count of empty parent folders removed).`,
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
            'Destination vault-relative path (e.g. "Projects/Spec.md"). Must end in .md; parent folders are created as needed. Use the exact letter case of existing folders; a different case can create a second folder.',
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
          // here. moveNote canonicalizes again, which leaves these paths as
          // they are.
          const normalizedOldPath = resolveVaultRelativePath({
            vaultPath,
            notePath: oldPath,
          })
          const normalizedNewPath = resolveVaultRelativePath({
            vaultPath,
            notePath: newPath,
          })
          // The index stores links under the listed spelling, so an old_path
          // in another letter case finds no backlinks here. moveNote's
          // filesystem scan finds them after it switches to that spelling.
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

  const updatePropertiesNoteNotFoundRemedy = isToolEnabled("vault_write_note")
    ? "create the note first with vault_write_note"
    : noteNotFoundCheckRemedy
  const updatePropertiesAlternativesLine = formatServedSentencesLine([
    whenToolEnabledText(
      "vault_write_note",
      "Prefer vault_write_note when creating a new note, or replacing the body (with overwrite: true).",
    ),
    whenToolEnabledText(
      "vault_read_note",
      "Read current properties first with vault_read_note({ properties_only: true }), or the full note when repairing a properties block the server refused.",
    ),
  ])

  registerTool(
    TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
    {
      title: "Update Properties",
      description: `Update a note's properties, merging into the existing ones by default or replacing the whole properties block with replace: true. The body is kept.

Example: vault_update_properties({ path: "Projects/todo.md", properties: { status: "active", draft: null } })
Example: vault_update_properties({ path: "Projects/todo.md", properties: { title: "Todo", status: "active" }, replace: true })

When to use: Changing tags, status, type, or any property without reading/rewriting the full note body.${updatePropertiesAlternativesLine}

Behavior:
- By default properties merge shallowly — new keys added, matching keys overwritten, null deletes a key, unmentioned keys preserved. Arrays are replaced entirely, not appended to.
- With replace: true, null writes a property with no value, and {} removes the whole block.

Errors:
- "note not found" — path does not exist; ${updatePropertiesNoteNotFoundRemedy}
${NOTE_EXTENSION_ERROR_ENTRY}
${PATH_SAFETY_ERROR_ENTRY}
${CONCURRENT_WRITE_REREAD_ERROR_ENTRY}
${FILESYSTEM_ERROR_ENTRY}
- "properties block …" — without replace: true, the merge refuses a block it cannot keep: invalid YAML, a list, a single value, or a YAML type tag such as !!timestamp; the error says how to repair it
${OPENING_BLOCK_ERROR_ENTRY}

Obsidian syntax: Use arrays for multi-value fields (tags: [a, b]), quote wikilinks ("[[Note]]"), keep types consistent (mismatches cause silent query failures).

Returns: "Updated properties on <path>", or "Replaced properties on <path>" with replace: true.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the note, including the ".md" extension. Use the exact letter case.',
          ),
        properties: z
          .record(z.string().min(1), z.unknown())
          .describe("Properties to merge, or with replace the complete new set."),
        replace: z
          .boolean()
          .optional()
          .default(false)
          .describe("Replace instead of merging (default: false)."),
      },
    },
    async ({ path, properties, replace }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
      })
      reqLogger.info("tool_call", { path, replace })
      const propertiesWrite = replace
        ? { write: vaultFs.replaceProperties, outcome: "properties_replaced", verb: "Replaced" }
        : { write: vaultFs.updateProperties, outcome: "properties_updated", verb: "Updated" }
      return safeHandler(
        reqLogger,
        () => propertiesWrite.write({ vaultPath, path, properties }, reqLogger),
        () => {
          reqLogger.info("tool_result", { outcome: propertiesWrite.outcome })
          return `${propertiesWrite.verb} properties on ${path}`
        },
      )
    },
  )
}
