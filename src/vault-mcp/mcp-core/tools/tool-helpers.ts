/** Shared types and helpers for tool group modules. */

import { z } from "zod"
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { PdfExtractor } from "../../vault-operations/pdf-extractor.js"
import type { SearchIndex } from "../../search/search-index.js"
import type { VaultConfig } from "../../config.js"
import type { Logger } from "../../../logger.js"
import type { LineWindow } from "../../obsidian-markdown/lines.js"
import type { ToolName } from "../tool-registry.js"
import type { ToolAvailability } from "../tool-availability.js"
import { DEFAULT_DAILY_NOTES_FOLDER } from "../../vault-operations/daily-notes.js"
import { TRASH_NAME_SUFFIX_LIMIT } from "../../vault-operations/vault-filesystem.js"
import type { PathKind } from "../../vault-operations/vault-filesystem.js"
import { describeErrorForLog, describeErrorRelativeTo } from "../../../utils/describe-error.js"
import { appendRemedy, remedyForCodedError } from "../coded-error-remedy.js"
import { isTagsKey } from "../../obsidian-markdown/tags.js"
import { MAX_LISTED_HEADINGS } from "../../obsidian-markdown/headings.js"
import { getExtensionsOfKind, type FileKind } from "../../obsidian-markdown/file-kinds.js"
import {
  OverwriteBlockedError,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
} from "../../obsidian-markdown/frontmatter.js"

// Zod's base object config would add an index signature to handler args, so a
// misspelled parameter name would still compile
export type ToolInputObject<Shape extends z.ZodRawShape> = z.ZodObject<Shape, z.core.$strict>

/** Registers one tool through the enabled-set gate: skips silently when the
 *  config disables the tool, and injects the registry's annotations so group
 *  modules never restate them — the config type carries no annotations key,
 *  making an inline block a compile error. Throws on a name missing from the
 *  registry (a typo'd registration would otherwise be invisible forever).
 *  inputSchema is required because the SDK validates nothing without one. */
export type RegisterGatedTool = <InputShape extends z.ZodRawShape>(
  name: ToolName,
  config: { title: string; description: string; inputSchema: InputShape },
  handler: ToolCallback<ToolInputObject<InputShape>>,
) => void

/** An input object that rejects keys its shape lacks, naming the accepted
 *  ones in the error; a shape with no keys accepts any key. */
export const createStrictInputObject = <Shape extends z.ZodRawShape>(
  shape: Shape,
): ToolInputObject<Shape> => {
  const acceptedKeys = Object.keys(shape)

  // Some clients send a placeholder argument to tools that take no parameters
  if (acceptedKeys.length === 0) return z.object(shape)

  const acceptedKeysText = `accepted: ${acceptedKeys.join(", ")}`

  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined

      const keyNoun = issue.keys.length === 1 ? "key" : "keys"
      const quotedKeys = issue.keys.map((key) => `"${key}"`).join(", ")
      return `unrecognized ${keyNoun} ${quotedKeys} (${acceptedKeysText})`
    },
  })
}

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

export type ToolRegistrationContext = ToolAvailability &
  SafeHandlers & {
    registerTool: RegisterGatedTool
    vaultPath: string
    search: SearchIndex
    pdfExtractor: PdfExtractor
    logger: Logger
    config: VaultConfig
  }

// Five frontmatter keys are promoted to top-level fields on NoteMetadata and
// so are stripped from additional_properties, which would otherwise repeat
// them. Four have one fixed spelling. The fifth, `tags`, is spelled per note:
// the index reads the first key spelled `tags` in any letter case (`tags`,
// `Tags`, `TAGS`), as Obsidian does, so that key is the one stripped, and a
// later tags-spelled key, which the index ignores, stays in
// additional_properties.
const FIXED_PROMOTED_KEYS = new Set(["title", "type", "created", "related"])

/** The promoted keys of one note: the fixed four plus the tags key its
 *  frontmatter spells, when it has one. */
const resolvePromotedKeys = (properties: Record<string, unknown>): ReadonlySet<string> => {
  const noteTagsKey = Object.keys(properties).find(isTagsKey)
  return noteTagsKey ? new Set([...FIXED_PROMOTED_KEYS, noteTagsKey]) : FIXED_PROMOTED_KEYS
}

/** Reshapes NoteMetadata for client responses: keeps the top-level fields,
 *  leaving out a null leading_callout, and replaces `properties` (full
 *  frontmatter, mostly duplicated) with `additional_properties` (only
 *  unpromoted keys like topic, agent, date), left out when there are none. */
export const formatNoteMetadata = (meta: {
  properties: Record<string, unknown>
  [key: string]: unknown
}): Record<string, unknown> => {
  const { properties, leading_callout: leadingCallout, ...fields } = meta

  const promotedKeys = resolvePromotedKeys(properties)
  const additionalProperties = Object.fromEntries(
    Object.entries(properties).filter(([key]) => !promotedKeys.has(key)),
  )

  return {
    ...fields,
    ...(leadingCallout ? { leading_callout: leadingCallout } : {}),
    ...(Object.keys(additionalProperties).length > 0
      ? { additional_properties: additionalProperties }
      : {}),
  }
}

/** Shared Zod schema for one date filter ({ before, on, after }) — used by
 *  vault_list_tasks' task date filters and vault_search's created/modified. */
export const dateFilterSchema = createStrictInputObject({
  before: z
    .string()
    .min(1)
    .optional()
    .describe("Exclusive upper bound (YYYY-MM-DD) — strictly earlier dates"),
  on: z.string().min(1).optional().describe("Exact date match (YYYY-MM-DD)"),
  after: z
    .string()
    .min(1)
    .optional()
    .describe("Exclusive lower bound (YYYY-MM-DD) — strictly later dates"),
}).optional()

/** One-line, model-facing summary of a paged text read: the window served,
 *  the paged text's total line count, and the next start_line when more
 *  remains — shared by vault_read_note and vault_read_file. */
export const describeTextWindow = (path: string, lineWindow: LineWindow): string => {
  const { startLine, endLine, totalLines } = lineWindow

  if (totalLines === 0) return `${path} — 0 lines (end of file)`

  const isLastWindow = endLine >= totalLines
  const continuation = isLastWindow ? "(end of file)" : `(continue with start_line: ${endLine + 1})`

  return `${path} — lines ${startLine}–${endLine} of ${totalLines} ${continuation}`
}

type ToolHandlerResult = {
  content: CallToolResult["content"]
  isError?: true
}

/** The try/catch wrappers every tool handler runs inside, built per server
 *  from two inputs:
 *  - the enabled tool set, because the remedies they add name tools a server
 *    may not serve;
 *  - the vault path, which a Node error's text must not show. */
type SafeHandlers = {
  /** Wraps a handler with try/catch. A throw is logged as `tool_error` and
   *  returned as an isError result that holds only text, so the error's
   *  cause and stack never reach the client. The text is:
   *  - `[ErrorName]: message`, with a Node error's paths made vault-relative;
   *  - then how to fix it, for a raw filesystem or index error or a
   *    properties-block refusal.
   *
   *  The format callback produces the full content-block array — text, image,
   *  or mixed (the SDK union) — for tools whose results aren't a single text
   *  block. */
  safeHandlerContent: <T>(
    logger: Logger,
    fn: () => Promise<T>,
    format: (result: T) => CallToolResult["content"],
  ) => Promise<ToolHandlerResult>
  /** The common single-text-block case. Delegates to safeHandlerContent so
   *  the error contract (error text, tool_error log, isError) has exactly
   *  one home. */
  safeHandler: <T>(
    logger: Logger,
    fn: () => Promise<T>,
    format: (result: T) => string,
  ) => Promise<ToolHandlerResult>
}

/** The tools each kind's repair steps name: a raw read and a whole-block
 *  replace, plus a body edit to put prose back for the kinds that often hold
 *  it. An "explicit-tag" block is valid key-value YAML whose value carries a
 *  tag such as `!!timestamp`, so it holds no prose. Keep each list in step with
 *  the text describePropertiesBlockRepair returns for that kind. */
const REPAIR_TOOLS_BY_KIND = {
  "explicit-tag": ["vault_read_note", "vault_update_properties"],
  "invalid-yaml": ["vault_read_note", "vault_update_properties", "vault_patch_note"],
  "not-key-value": ["vault_read_note", "vault_update_properties", "vault_patch_note"],
} as const satisfies Record<UnsupportedPropertiesBlockError["kind"], readonly ToolName[]>

/** How an agent repairs a properties block the server refuses, by the kind
 *  of block. A server missing any tool the steps name points at Obsidian
 *  instead, so the error never names a tool the client cannot call. */
const describePropertiesBlockRepair = (params: {
  kind: UnsupportedPropertiesBlockError["kind"]
  isToolEnabled: (name: ToolName) => boolean
}): string => {
  const repairToolsServed = REPAIR_TOOLS_BY_KIND[params.kind].every(params.isToolEnabled)

  if (!repairToolsServed) return "Fix the properties block in Obsidian."

  switch (params.kind) {
    case "explicit-tag":
      return "To repair it, read the note in full with vault_read_note, then call vault_update_properties with replace: true and the complete corrected properties (leave out a key to remove it; null keeps it with an empty value). The tag cannot be kept; write the value without it."
    // replace drops the whole block, and a block of invalid YAML, a list or a
    // single value is often prose written as body text, so that text has to
    // be copied before the replace and put back after it
    case "invalid-yaml":
    case "not-key-value":
      return "To repair it: 1. read the note in full with vault_read_note; 2. copy any text between the --- lines that is not a property; 3. call vault_update_properties with replace: true and the complete corrected properties (leave out a key to remove it; null keeps it with an empty value); 4. add the copied text back to the body with vault_patch_note, without the --- lines."
  }
}

/** The tools an overwrite's repair names: a raw read to see the broken
 *  block, and a whole-block replace before the overwrite runs again. */
const OVERWRITE_REPAIR_TOOLS = [
  "vault_read_note",
  "vault_update_properties",
] as const satisfies readonly ToolName[]

/** How to finish an overwrite refused for the note's existing block. The
 *  overwrite replaces the body, so no prose needs carrying over. */
const describeOverwriteRepair = (isToolEnabled: (name: ToolName) => boolean): string => {
  const repairToolsServed = OVERWRITE_REPAIR_TOOLS.every(isToolEnabled)

  if (!repairToolsServed) return "Fix the properties block in Obsidian."
  return "To overwrite it, read the note in full with vault_read_note, call vault_update_properties with replace: true and the properties to keep ({} for none), then run this write again."
}

/** Each remedy keeps the body's `---` lines from opening the note:
 *  - with a property, the server writes its own properties block above them;
 *  - a line of text above them pushes them down the same way;
 *  - removing them leaves no block to read.
 *  The sentence names no tool, so it needs no gating. */
const OPENING_BLOCK_REMEDY =
  "To write it, give the note at least one property, put a line of text above the --- lines, or remove those lines."

/** The Errors entry of every tool whose write can leave `---` lines at the
 *  top of a note with no properties. The error carries the ways around it. */
export const OPENING_BLOCK_ERROR_ENTRY =
  '- "the note would open with a properties block …" — a note without properties would start with --- lines around text that can\'t be properties; the error says how to avoid it'

// Sentences two or more tools state word for word. Each tool renders its copy
// from here, and tool-definitions.test.ts fails when a sibling's copy drifts.

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

// ── Deleting notes and files ────────────────────────────────────
// vault_delete_note and vault_delete_file share the trash-outcome text, the
// protected-path and daily-notes entries, the pruning text and the result
// text, which render from here; the per-call options they share are resolved
// in vault-operations/delete-options.ts.

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

/** The words that differ between the two tools' text. The recovery sentence
 *  differs in substance, not only in noun: Obsidian Sync keeps note history for
 *  a month or a year by plan, and attachment versions for two weeks. */
const DELETE_WORDS: Record<
  PathKind,
  { singular: string; pluralCapital: string; kindPhrase: string; syncRecovery: string }
> = {
  note: {
    singular: "note",
    pluralCapital: "Notes",
    kindPhrase: "a markdown note",
    syncRecovery:
      "The vault's owner can recover it from Obsidian Sync's version history (1 month on Standard, 12 months on Plus).",
  },
  file: {
    singular: "file",
    pluralCapital: "Files",
    kindPhrase: "a non-markdown file",
    syncRecovery:
      "The vault's owner may recover it from Obsidian Sync's version history, which keeps attachment versions for two weeks.",
  },
}

/** The prune_empty_folders text the delete tools share: the Parameters entry,
 *  the schema text and the Returns sentence. vault_move_note's Parameters entry
 *  adds a clause of its own, so it is not this constant. */
export const PRUNE_EMPTY_FOLDERS_PARAMETER_ENTRY =
  "- prune_empty_folders keeps a folder that holds any file, even a hidden .DS_Store. Pruning is best-effort: a folder that can't be removed never fails the call."
export const PRUNE_EMPTY_FOLDERS_DESCRIPTION =
  "When true, also remove parent folders the delete leaves empty. Default false."
export const PRUNED_FOLDERS_RETURNS_SENTENCE =
  "Notes how many empty folders were pruned when any were."

/** The parts of a delete tool's description that carry the tool's noun or
 *  depend on the trash setting. Under Obsidian Sync a delete never reads the
 *  "Deleted files" setting or touches .trash/, so the text about that setting,
 *  the trash outcomes and the errors they produce is left out. Each entry text
 *  starts with a line break because it joins a list mid-way, and is "" when
 *  left out. */
export const describeDeleteOutcomes = (params: {
  obsidianSyncEnabled: boolean
  pathKind: PathKind
}): {
  opener: string
  trashOutcomeEntries: string
  trashMoveErrorEntries: string
  /** The "cannot delete …" entry and the filesystem entry, each saying the
   *  note or file stays put; listed in every mode. */
  deleteFailureEntries: string
  trashConfigErrorEntry: string
  returns: string
} => {
  const { singular, pluralCapital, kindPhrase, syncRecovery } = DELETE_WORDS[params.pathKind]
  const deleteFailureEntries = `
- "cannot delete …" (other than a protected path) — the ${singular} stays put; ask the vault's owner to fix the cause (e.g. permissions), then retry
${FILESYSTEM_ERROR_ENTRY}; the ${singular} stays put`

  if (params.obsidianSyncEnabled) {
    return {
      opener: `Delete ${kindPhrase} for good. ${syncRecovery}`,
      trashOutcomeEntries: "",
      trashMoveErrorEntries: "",
      deleteFailureEntries,
      trashConfigErrorEntry: "",
      returns: `Confirmation message — "Deleted <path>".`,
    }
  }
  return {
    opener: `Delete ${kindPhrase}, moving it to the vault's .trash/ folder or removing it for good as the vault's Obsidian "Deleted files" setting directs.`,
    trashOutcomeEntries: `
- The "Deleted files" setting decides the outcome, which the caller can't choose or see in advance:
  - "Move to system trash" moves the ${singular} to \`.trash/\`. ${pluralCapital} this server moved there are deleted after its retention period (TRASH_RETENTION_DAYS: 30 days by default, never when set to none).
  - "Move to Obsidian trash" moves the ${singular} to \`.trash/\` and keeps it forever.
  - "Permanently delete" removes the ${singular} for good.`,
    trashMoveErrorEntries: `
- "cannot move to trash … — ${TRASH_NAME_SUFFIX_LIMIT} collisions in .trash/" — .trash/ holds this name and ${TRASH_NAME_SUFFIX_LIMIT} numbered copies; ask the vault's owner to clear old copies, then retry
- "cannot move to trash …" without "${TRASH_NAME_SUFFIX_LIMIT} collisions" — the ${singular} stays put; ask the vault's owner to fix .trash/ (e.g. a plain file blocks a needed folder), then retry`,
    deleteFailureEntries,
    trashConfigErrorEntry: `
- "cannot read trash config from .obsidian/app.json" — ask the vault's owner to repair it, then retry`,
    returns: `Confirmation message naming the outcome — "Deleted <path>" for permanent removal, "Moved <path> to trash (<.trash/ path>)" when the ${singular} landed in .trash/.`,
  }
}

/** The confirmation text both delete tools return. */
export const describeDeleteResult = (params: {
  path: string
  prunedFolderCount: number
  trashLocation?: string | undefined
}): string => {
  const { path, prunedFolderCount, trashLocation } = params
  const folderLabel = prunedFolderCount > 1 ? "folders" : "folder"
  const pruneSuffix =
    prunedFolderCount > 0 ? ` (removed ${prunedFolderCount} empty ${folderLabel})` : ""

  if (trashLocation) return `Moved ${path} to trash (${trashLocation})${pruneSuffix}`
  return `Deleted ${path}${pruneSuffix}`
}

/** The result shape the five tools that return note metadata share. The
 *  tags clause names the tools that edit each tag field, so it is passed in. */
export const describeNoteMetadataResult = (tagsFieldsText: string): string => {
  return `JSON array of note metadata: path, title (the title property; file name without .md when missing or not text), ${tagsFieldsText}, related ([] when missing), folder (top-level, "" at the root), type (null when missing or not text), created (null when missing or not an ISO date), modified (ISO 8601 file time), bytes (on-disk size), and when present leading_callout (the opening callout, { type, title, body }) and additional_properties (every property but title, type, created, related and tags).`
}

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

/** A handler's refusal of its own arguments, before any data-layer call. The
 *  message names the fix, so it goes out with no remedy appended. */
export const toolInputErrorResult = (params: {
  message: string
  logger: Logger
}): { content: Array<{ type: "text"; text: string }>; isError: true } => {
  params.logger.warn("tool_error", { error: params.message })
  return {
    content: [{ type: "text" as const, text: params.message }],
    isError: true as const,
  }
}

export const createSafeHandlers = (params: {
  isToolEnabled: (name: ToolName) => boolean
  vaultPath: string
}): SafeHandlers => {
  const { isToolEnabled, vaultPath } = params

  /** How to fix an error, or undefined when its own text stands:
   *  - a way around `---` lines a write would leave at the top of the note;
   *  - the repair steps for a properties block already in the vault;
   *  - the remedy for a raw filesystem or index error. The properties-block
   *    errors carry no code, so at most one of these applies. */
  const describeToolErrorRemedy = (error: unknown): string | undefined => {
    if (error instanceof UnkeepableOpeningBlockError) return OPENING_BLOCK_REMEDY
    // OverwriteBlockedError extends UnsupportedPropertiesBlockError, so it is
    // checked first: the parent's repair steps copy body text out and back,
    // which an overwrite does not need. UnkeepableOpeningBlockError extends
    // Error directly, so its place in this order is free.
    if (error instanceof OverwriteBlockedError) return describeOverwriteRepair(isToolEnabled)
    if (error instanceof UnsupportedPropertiesBlockError) {
      return describePropertiesBlockRepair({ kind: error.kind, isToolEnabled })
    }
    return remedyForCodedError(error)
  }

  /** The error's text with a Node error's paths made vault-relative, then its
   *  remedy, if any. */
  const describeToolError = (error: unknown): string => {
    const message = describeErrorRelativeTo({ error, directory: vaultPath })

    return appendRemedy({ message, remedy: describeToolErrorRemedy(error) })
  }

  const safeHandlerContent: SafeHandlers["safeHandlerContent"] = async (logger, fn, format) => {
    try {
      const result = await fn()
      return { content: format(result) }
    } catch (error) {
      // The log keeps the full message and the cause a wrapped error carries;
      // the vault-relative paths and repair steps are for the client
      logger.warn("tool_error", describeErrorForLog(error))
      return {
        content: [{ type: "text" as const, text: describeToolError(error) }],
        isError: true as const,
      }
    }
  }

  const safeHandler: SafeHandlers["safeHandler"] = (logger, fn, format) => {
    return safeHandlerContent(logger, fn, (result) => [
      { type: "text" as const, text: format(result) },
    ])
  }

  return { safeHandlerContent, safeHandler }
}
