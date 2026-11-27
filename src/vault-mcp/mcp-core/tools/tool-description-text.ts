/** Text that two or more tools render into their descriptions at
 *  registration: the sentences and Errors entries they state word for word,
 *  and the builders (`describe*`) for text that depends on the config or the
 *  enabled tool set. Nothing here runs per call; the text a handler returns is
 *  in tool-helpers.ts. tool-definitions.test.ts fails when a sibling's copy
 *  drifts. */

import type { VaultConfig } from "../../config.js"
import type { ToolAvailability } from "../tool-availability.js"
import { DEFAULT_DAILY_NOTES_FOLDER } from "../../vault-operations/daily-notes.js"
import { MAX_LISTED_HEADINGS } from "../../obsidian-markdown/headings.js"
import { getExtensionsOfKind, type FileKind } from "../../obsidian-markdown/file-kinds.js"

/** Sentences, any of them "" when gated off, as one line that starts with a
 *  line break. Empty sentences drop out before the join, so none leaves a
 *  leading space or an empty line. */
export const formatServedSentencesLine = (gatedSentences: readonly string[]): string => {
  const servedSentences = gatedSentences.filter(Boolean).join(" ")

  return servedSentences ? `\n${servedSentences}` : ""
}

/** A file kind's extensions as the tool text writes them (".html/.htm"), read
 *  from the file-kind map so the text follows it when a type is added. */
export const formatExtensionsOfKind = (kind: FileKind): string =>
  getExtensionsOfKind(kind).join("/")

/** The file kinds vault_search indexes by content. vault_search,
 *  vault_read_file and vault_list_files all name them through this one phrase,
 *  so their descriptions cannot list different kinds. The text kind is named
 *  by its extensions alone, because the file tools call any UTF-8 file a text
 *  file, and search has no row for a file of an extension outside this list. */
export const SEARCHED_FILE_KINDS_TEXT = `canvases, PDFs, HTML pages (${formatExtensionsOfKind("html")}, visible text only), scripts (${formatExtensionsOfKind("script")}), and ${formatExtensionsOfKind("text")} files`

/** The save rules every body-editing tool opens with. A properties-block
 *  CRLF that follows a raw CR is kept as it is, so the sentence covers the
 *  body only. */
export const EDIT_SAVE_RULES_SENTENCE =
  "Properties are kept as written, and body line breaks are saved as LF."

/** The clause every non-idempotent note write ends its repeat sentence with. */
export const RETRY_REREAD_CLAUSE =
  "so after a timeout or lost response, re-read the note before retrying"

/** How the patcher closes the gap a deleted line leaves. No full stop: a
 *  text edit that empties a line keeps that line, so vault_replace_in_note
 *  adds "and by at least one", while a whole-line delete does not. */
export const BLANK_LINES_NEVER_DOUBLE_CLAUSE =
  "blank lines never double: the text above and below ends up separated by the wider of the two runs of empty lines that stood there"

/** The same rule at the note's end, where no text follows the gap. */
export const NOTE_END_BLANK_LINES_SENTENCE =
  'At the note\'s end, where no text follows, the run of empty lines above is kept one line shorter ("A\\n\\nB\\n" without "B" → "A\\n").'

/** What counts as an empty line for the blank-line rules. */
export const WHITESPACE_ONLY_LINE_CLAUSE =
  "line holding only spaces or tabs counts as text, not as an empty line"

/** The index-lag sentence the search tools' Behavior sections open with. */
export const INDEX_LAG_LEAD = "Results can lag a file change by a few seconds"

/** How an index-backed folder input scopes its matches. The filesystem
 *  listing tools match case-sensitively, so they state their own rule. */
export const INDEX_FOLDER_SCOPE_CLAUSE =
  'a whole folder, subfolders included: "Projects" covers "Projects/Archive" but not "ProjectsOld/", ignoring ASCII letter case'

/** The end of a missing-heading Errors entry, after "the message lists
 *  <headings>;": how the message shortens a long note's list. */
export const HEADING_LIST_CAP_CLAUSE = `past ${MAX_LISTED_HEADINGS}, only the first ${MAX_LISTED_HEADINGS}, marked "(first ${MAX_LISTED_HEADINGS} of N)"`

/** What a limit on an index-backed listing never tells the caller. */
export const LIMIT_TRUNCATION_CLAUSE =
  "nothing in the response signals truncation; raise limit for more"

/** The Errors entry of every tool whose write can leave `---` lines at the
 *  top of a note with no properties. The error carries the ways around it. */
export const OPENING_BLOCK_ERROR_ENTRY =
  '- "the note would open with a properties block …" — a note without properties would start with --- lines around text that can\'t be properties; the error says how to avoid it'

/** The Errors entry of every tool that reads or writes a vault file, for a
 *  raw filesystem error. The message is Node's with the path made
 *  vault-relative, plus the remedy sentence the tool boundary appends
 *  (coded-error-remedy.ts), so the entry names no remedy itself. */
export const FILESYSTEM_ERROR_ENTRY =
  '- "ENAMETOOLONG: …" or another filesystem error — the message says what to do'

/** The Errors entry of a tool that resolves a single note or file path. */
export const PATH_SAFETY_ERROR_ENTRY =
  '- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — pass a vault-relative path with no dot-prefixed part'

/** The Errors entry of a tool whose `content` parameter refuses control characters. */
export const CONTENT_CONTROL_CHARACTER_ERROR_ENTRY =
  '- "content contains a control character" — remove the character the message names'

/** The Errors entry of a tool whose path must name a markdown note. */
export const NOTE_EXTENSION_ERROR_ENTRY = '- "path must end in …" — add the .md extension'

/** The Errors entry of a tool whose write lock refused the call, when a plain
 *  retry is the remedy. The lock refuses a second write to a note instead of
 *  queueing it. */
export const CONCURRENT_WRITE_RETRY_ERROR_ENTRY =
  '- "concurrent write in progress" — another write to this note is in flight; retry'

/** The listing tools' form of the entry: one unreadable folder fails the whole
 *  listing, and the caller can list around it. */
export const LISTING_FILESYSTEM_ERROR_ENTRY =
  '- "ENAMETOOLONG: …" or another filesystem error — the message names the folder it could not read, and what to do; until then, pass a folder outside it'

/** The Errors entry of a tool that reads stored index rows back through the
 *  parsers in search-helpers.ts: a SQLite engine failure or a row the server
 *  cannot read, both with the remedy appended at the boundary. The entry
 *  quotes the error names because SQLite's messages open with no code. */
export const INDEX_ERROR_ENTRY =
  '- "[SqliteError]: …" / "[IndexIntegrityError]: …" — the index failed, not the call; the message says what to do'

/** The entry for a tool whose index query reads no stored row back through
 *  those parsers, so only the engine itself can fail. */
export const INDEX_ENGINE_ERROR_ENTRY =
  '- "[SqliteError]: …" — the index failed, not the call; the message says what to do'

/** The Errors entry of a tool that rewrites a note's properties block. A
 *  tool that rewrites it only in one mode passes that mode as rewriteCondition
 *  (`"with overwrite: true"`), and the entry opens with it. The error itself
 *  carries the repair steps, so the entry points at them and names no tool. */
export const describePropertiesBlockErrorEntry = (rewriteCondition?: string): string => {
  const conditionClause = rewriteCondition ? `${rewriteCondition}, ` : ""
  return `- "properties block …" — ${conditionClause}the note's properties block can't be read, or a rewrite would lose it; the error says how to repair it`
}

/** The result shape the five tools that return note metadata share. The
 *  tags clause names the tools that edit each tag field, so it is passed in. */
export const describeNoteMetadataResult = (tagsFieldsText: string): string => {
  return `JSON array of note metadata: path, title (the title property; file name without .md when missing or not text), ${tagsFieldsText}, related ([] when missing), folder (top-level, "" at the root), type (null when missing or not text), created (null when missing or not an ISO date), modified (ISO 8601 file time), bytes (on-disk size), and when present leading_callout (the opening callout, { type, title, body }) and additional_properties (every property but title, type, created, related and tags).`
}

// Text that depends on the server's config: built once at registration, so it
// names defaults and the tools that show the values in use.

/** Protected-path list for tool descriptions. Descriptions are built once at
 *  registration and the daily notes folder is resolved per call, so the text
 *  names that folder's default and the tool whose result shows the folder in
 *  use, not its resolved value. */
export const describeProtectedPaths = (params: {
  config: VaultConfig
  whenToolEnabledText: ToolAvailability["whenToolEnabledText"]
}): string => {
  const { config, whenToolEnabledText } = params

  if (config.protectedPathsOverride) {
    // loadConfig strips trailing slashes from override entries.
    return config.protectedPathsOverride.map((protectedPath) => protectedPath + "/").join(", ")
  }

  const dailyNotePathClause = whenToolEnabledText(
    "vault_get_daily_note",
    "; vault_get_daily_note's path shows the folder in use",
  )
  return `${config.memoryDir}/ and the daily notes folder (${DEFAULT_DAILY_NOTES_FOLDER}/ by default${dailyNotePathClause}; not protected when Obsidian's Daily Notes folder setting is the vault root or blank)`
}

/** The Errors entry for an unreadable daily-notes.json, starting with a line
 *  break because it joins a list mid-way. It is "" when the delete and move
 *  guard skips the file: DAILY_NOTES_FOLDER and PROTECTED_PATHS both bypass it. */
export const describeDailyNotesConfigErrorEntry = (config: VaultConfig): string => {
  // DAILY_NOTES_FOLDER set to the vault root loads as "" and still skips the
  // file, so the delete and move guard reads it only when the folder is unset.
  const readsDailyNotesConfig =
    !config.protectedPathsOverride && config.dailyNotesFolder === undefined

  if (!readsDailyNotesConfig) return ""
  return `\n- "cannot read daily notes config from .obsidian/daily-notes.json" — the file that names the protected daily notes folder can't be parsed; ask the vault's owner to repair it, or the server's operator to set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry`
}
