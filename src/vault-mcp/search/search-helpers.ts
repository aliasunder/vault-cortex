// ── Pure helpers for search-index ──────────────────────────────

import { posix } from "node:path"
import { DateTime } from "luxon"
import { mtimeToIso } from "../../utils/mtime-to-iso.js"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { isRecord } from "../../utils/is-record.js"
import { findAliasesKey } from "../obsidian-markdown/aliases.js"
import type { NoteRow, NoteMetadata, SearchResult, TaskRow, TaskEntry } from "./search-index.js"

// ── Type guards ────────────────────────────────────────────────

export const isString = (value: unknown): value is string => typeof value === "string"

const isScalarListElement = (element: unknown): boolean => {
  return element != null && typeof element !== "object"
}

/** Normalizes single-value and list-valued frontmatter fields.
 *  - Lists stringify scalar entries, including 0, false and empty text.
 *  - Single scalars stringify only when truthy.
 *  - Nulls, mappings and nested lists yield no entries. */
export const coerceToArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter(isScalarListElement).map(String)

  // A mapping value (related: { note: true }) is dropped, as the array branch
  // above drops mappings in a list; String() would index it as "[object Object]".
  if (typeof value === "object") return []
  return value ? [String(value)] : []
}

// ── Tag comparison ─────────────────────────────────────────────

/** Folds stored tags and query inputs by the rule Obsidian's Tags view uses
 *  to group spellings. The `fold_tag` SQL function uses the same rule. */
export const foldTag = (tag: string): string => tag.toLowerCase()

/**
 * Folds a tag input the way the index compares it: one leading `#` removed,
 * then `foldTag`. Throws when nothing is left, because an empty name is not a
 * tag and a clear error beats a silently empty result. Tool schemas reject an
 * empty string first (`.min(1)`), so the input that reaches the throw is "#".
 */
export const normalizeTagQuery = (input: string): string => {
  const tagName = input.startsWith("#") ? input.slice(1) : input

  if (tagName === "") throw new Error('tag must not be empty after its leading "#"')
  return foldTag(tagName)
}

/**
 * SQL predicate over a `json_each` `value` that matches the query tag itself
 * or any tag nested under it, folding each stored value once; bound to
 * `nestedTagLikePattern(input)`. Appending `/` to the stored value turns
 * "equal or nested" into one LIKE (`||` binds tighter than LIKE), so
 * `project/%` matches `project` and `project/x` but not `projects`.
 */
export const NESTED_TAG_PREDICATE_SQL = "fold_tag(value) || '/' LIKE ? ESCAPE '\\'"

/** The pattern NESTED_TAG_PREDICATE_SQL binds for a tag input: normalized, its
 *  LIKE wildcards escaped, then `/%`. Throws like normalizeTagQuery. */
export const nestedTagLikePattern = (input: string): string => {
  return `${escapeLikeWildcards(normalizeTagQuery(input))}/%`
}

/**
 * SQL condition that one requested tag holds for a note row aliased `n`: the
 * tag `predicate` matches a value of the tags property or of the body tags.
 * - The condition is parenthesised, so a caller can AND one per requested tag.
 * - `predicate` must contain exactly one `?`, and `conditionParams` repeats
 *   `boundValue` once per column.
 */
export const noteHasTagCondition = (params: {
  predicate: string
  boundValue: string
}): { condition: string; conditionParams: string[] } => {
  const { predicate, boundValue } = params
  return {
    condition:
      `(EXISTS (SELECT 1 FROM json_each(n.tags) WHERE ${predicate})` +
      ` OR EXISTS (SELECT 1 FROM json_each(n.body_tags) WHERE ${predicate}))`,
    conditionParams: [boundValue, boundValue],
  }
}

// ── Stored row integrity ───────────────────────────────────────

/** A stored index row cannot be read back: a JSON column that is not JSON or
 *  has the wrong shape, or an mtime Luxon rejects. The indexer wrote every
 *  such column itself, so the failure is the index's, never the call's, and
 *  the tool boundary appends the index remedy to it. Its `name` is set so
 *  `describeError` prints `[IndexIntegrityError]: …`, the prefix the
 *  index-backed tools' Errors entries name. */
export class IndexIntegrityError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = "IndexIntegrityError"
  }
}

/** JSON.parse over a stored column, with a non-JSON column reported as index
 *  damage instead of a bare SyntaxError. */
const parseJsonColumn = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch (error) {
    throw new IndexIntegrityError(`JSON column is not JSON: ${json}`, { cause: error })
  }
}

/** mtimeToIso over a stored mtime, with a rejected value reported as index
 *  damage. vault-filesystem.ts passes a file's live stat time to mtimeToIso
 *  directly. */
const storedMtimeToIso = (mtimeMs: number): string => {
  try {
    return mtimeToIso(mtimeMs)
  } catch (error) {
    throw new IndexIntegrityError(`invalid mtime: ${mtimeMs}`, { cause: error })
  }
}

// ── JSON column parsers ────────────────────────────────────────

/** Parses a JSON column that must contain a string array (tags, body_tags,
 *  related, depends_on, kanban_done_lanes). The indexer writes these columns,
 *  so any other value throws as index corruption. */
export const parseStringArray = (json: string): string[] => {
  const parsed = parseJsonColumn(json)

  if (!Array.isArray(parsed) || !parsed.every(isString)) {
    throw new IndexIntegrityError(`expected string[] from JSON column, got: ${json}`)
  }
  return parsed
}

/** Parses a JSON column that must contain a record (properties).
 *  Throws on corruption — the indexer stores JSON.stringify(frontmatter). */
const parseRecord = (json: string): Record<string, unknown> => {
  const parsed = parseJsonColumn(json)

  if (!isRecord(parsed)) {
    throw new IndexIntegrityError(`expected object from JSON column, got: ${json}`)
  }
  return parsed
}

/** Type predicate for the LeadingCallout shape ({type, title, body} — all strings). */
const isLeadingCalloutShape = (
  value: Record<string, unknown>,
): value is { type: string; title: string; body: string } => {
  return (
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string"
  )
}

/** Parses a JSON column that must contain a LeadingCallout ({type, title, body}).
 *  Throws on corruption — the indexer stores JSON.stringify(parseLeadingCallout(...)). */
const parseLeadingCalloutJson = (json: string): LeadingCallout => {
  const parsed = parseJsonColumn(json)

  if (!isRecord(parsed) || !isLeadingCalloutShape(parsed)) {
    throw new IndexIntegrityError(`expected LeadingCallout from JSON column, got: ${json}`)
  }
  return { type: parsed.type, title: parsed.title, body: parsed.body }
}

// ── Folder paths and LIKE patterns ────────────────────────────

/** Strips trailing slashes so folder paths produce clean LIKE patterns
 *  (e.g. `"Projects/"` → `"Projects"`, avoiding `Projects//%`). */
export const stripTrailingSlashes = (folder: string): string => folder.replace(/\/+$/, "")

/** Escapes LIKE-wildcard characters (`\`, `%`, `_`) in a value so it is
 *  matched literally in a `LIKE ... ESCAPE '\'` clause. */
export const escapeLikeWildcards = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`)

/** The `LIKE ... ESCAPE '\'` pattern that selects every path inside a folder
 *  — segment-boundary (`Docs/%`, so "Docs" never matches "Docs2/") with the
 *  folder's own wildcard characters escaped. One definition keeps every
 *  search leg's folder predicate identical. */
export const folderLikePattern = (folder: string): string =>
  `${escapeLikeWildcards(stripTrailingSlashes(folder))}/%`

// ── FTS metadata builder ───────────────────────────────────────

/** The part of an aliases value the title column does not hold: its entries
 *  that are not text, which parseFrontmatterAliases skips. */
const nonTextAliasEntries = (value: unknown): unknown => {
  if (isString(value)) return null
  return Array.isArray(value) ? value.filter((element) => !isString(element)) : value
}

/** Flattens frontmatter into a searchable text block for the FTS metadata column.
 *  Keys are included (so "lifecycle" is findable). The title and the text
 *  aliases are excluded, because both fill the title column. */
export const buildFtsMetadataText = (frontmatter: Record<string, unknown>): string => {
  const aliasesKey = findAliasesKey(frontmatter)
  const lines: string[] = []
  for (const [key, frontmatterValue] of Object.entries(frontmatter)) {
    if (key === "title") continue

    const value = key === aliasesKey ? nonTextAliasEntries(frontmatterValue) : frontmatterValue

    if (value == null) continue
    if (Array.isArray(value)) {
      const primitiveElements = value.filter(isScalarListElement).map(String)

      if (primitiveElements.length > 0) {
        lines.push(`${key}: ${primitiveElements.join(" ")}`)
      }
    } else if (typeof value !== "object") {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  return lines.join("\n")
}

// ── Note names ─────────────────────────────────────────────────

/**
 * The longest name, in UTF-16 code units, that is normalized and checked for
 * duplicates. Each check's cost grows faster than the name's length, so it is
 * bounded per name:
 * - NFC sorts each run of combining marks, in time that grows with the square
 *   of the run's length;
 * - V8 hashes a string longer than 16,383 characters by its length alone, so a
 *   Set of many long names of one length compares each new name with all of them.
 *
 * A file name is at most 255 bytes on common file systems, so every note's file
 * name fits, and so do the titles and aliases of real vaults.
 */
const MAX_COMPARED_NAME_LENGTH = 256

/**
 * Folds a note name for comparison without letter case.
 * - Obsidian's Quick Switcher, which opens a note by its title or an alias,
 *   compares names this way: https://obsidian.md/help/plugins/quick-switcher
 * - NFC normalization first makes an accented letter stored as a base letter
 *   plus a combining mark (as some file systems save names) equal its
 *   single-character form, which is what a typed query holds. A name longer
 *   than MAX_COMPARED_NAME_LENGTH is compared without it.
 */
export const foldName = (name: string): string => {
  const normalizedName = name.length > MAX_COMPARED_NAME_LENGTH ? name : name.normalize("NFC")
  return normalizedName.toLowerCase()
}

/**
 * SQL expression over `notes_fts` that is 1 when the bound text equals a whole
 * line of the names column, and 0 otherwise. It binds `toNameLookupText(query)`.
 * - buildFtsNameText writes each name folded, on a line of its own, so a search
 *   folds nothing per row.
 * - A newline on both sides of both strings limits `instr` to whole lines.
 */
export const EXACT_NAME_MATCH_SQL =
  "instr(char(10) || notes_fts.names || char(10), char(10) || ? || char(10)) > 0"

/** Matches a run of line breaks. */
const LINE_BREAK_RUN_RE = /[\r\n]+/

/**
 * A name on one line: its lines, trimmed and without the blank ones, joined by
 * one space.
 * - A YAML block scalar can give a title or an alias several lines and a final
 *   line break.
 * - EXACT_NAME_MATCH_SQL compares the query with whole lines of the names
 *   column, so each name, and the query, must fill one line and nothing else.
 * - Splitting at line breaks keeps the work linear in the name's length; a
 *   regex that also takes the whitespace around each break backtracks through
 *   every long run of spaces.
 */
const toSingleLineName = (name: string): string => {
  const lines = name.split(LINE_BREAK_RUN_RE).map((line) => line.trim())
  return lines.filter(Boolean).join(" ")
}

/** Matches a query that is one double-quoted phrase and captures the text
 *  inside the quotes. */
const QUOTED_PHRASE_RE = /^"(?<phrase>[^"]*)"$/

/**
 * The folded, single-line text EXACT_NAME_MATCH_SQL compares with each note name:
 * - the text inside the quotes when the whole query is one double-quoted phrase;
 * - otherwise the query;
 * - empty when the query has no text.
 */
export const toNameLookupText = (query: string): string => {
  const trimmedQuery = query.trim()
  const quotedPhrase = QUOTED_PHRASE_RE.exec(trimmedQuery)?.groups?.phrase

  return foldName(toSingleLineName(quotedPhrase ?? trimmedQuery))
}

/** A note name on one line, and its folded form. */
type NoteName = { singleLineName: string; foldedName: string }

/** The title, then each alias, in document order. */
const toNoteNames = (params: { title: string; aliases: ReadonlyArray<string> }): NoteName[] => {
  return [params.title, ...params.aliases].map((name) => {
    const singleLineName = toSingleLineName(name)
    return { singleLineName, foldedName: foldName(singleLineName) }
  })
}

/**
 * The names that repeat no earlier name in the compared form, in document
 * order. A name longer than MAX_COMPARED_NAME_LENGTH is kept without the check.
 */
const dropRepeatedNames = (params: {
  noteNames: ReadonlyArray<NoteName>
  compareBy: keyof NoteName
}): NoteName[] => {
  const seenForms = new Set<string>()
  const keptNames: NoteName[] = []
  for (const noteName of params.noteNames) {
    if (noteName.singleLineName.length <= MAX_COMPARED_NAME_LENGTH) {
      const comparedForm = noteName[params.compareBy]

      if (seenForms.has(comparedForm)) continue
      seenForms.add(comparedForm)
    }
    keptNames.push(noteName)
  }
  return keptNames
}

/**
 * The FTS row's two name columns. Each holds the title, then the aliases, one
 * per line:
 * - titleText holds the names as written, for keyword matching, and drops only
 *   a name spelled exactly like an earlier one. The FTS tokenizer folds letter
 *   case by an older Unicode version than `toLowerCase`, so in some scripts
 *   (Cherokee, Osage) it reads two spellings that `toLowerCase` folds together
 *   as different words;
 * - foldedNames holds each name folded, without repeats, for EXACT_NAME_MATCH_SQL.
 */
export const buildFtsNameText = (params: {
  title: string
  aliases: ReadonlyArray<string>
}): { titleText: string; foldedNames: string } => {
  const noteNames = toNoteNames(params)
  const distinctSpellings = dropRepeatedNames({ noteNames, compareBy: "singleLineName" })
  const distinctFoldedNames = dropRepeatedNames({ noteNames, compareBy: "foldedName" })

  return {
    titleText: distinctSpellings.map((noteName) => noteName.singleLineName).join("\n"),
    foldedNames: distinctFoldedNames.map((noteName) => noteName.foldedName).join("\n"),
  }
}

/** The note's title line in every chunk of the note:
 *  `Avery Quinn (also known as Avery, Mom)`, or the bare title when the note
 *  has no other name or its title is empty. */
export const buildChunkTitleLine = (params: {
  title: string
  aliases: ReadonlyArray<string>
}): string => {
  const [titleName, ...aliasNames] = dropRepeatedNames({
    noteNames: toNoteNames(params),
    compareBy: "foldedName",
  })

  const singleLineTitle = titleName?.singleLineName

  if (!singleLineTitle || aliasNames.length === 0) return params.title
  const aliasList = aliasNames.map((aliasName) => aliasName.singleLineName).join(", ")
  return `${singleLineTitle} (also known as ${aliasList})`
}

// ── Row mappers ────────────────────────────────────────────────

/** A result's `body_tags` field: each stored spelling once, in first-seen
 *  order, or no field when the note has none. The column keeps every
 *  occurrence, because `listAllTags` in `search-queries.ts` counts them. */
const bodyTagsField = (bodyTagsJson: string): { body_tags?: string[] } => {
  const uniqueBodyTags = [...new Set(parseStringArray(bodyTagsJson))]
  return uniqueBodyTags.length > 0 ? { body_tags: uniqueBodyTags } : {}
}

/** The `notes` table columns that rowToMetadata reads. Every query that
 *  returns note metadata selects them, so a new column is added in one place. */
export const NOTE_METADATA_COLUMNS_SQL =
  "path, title, tags, body_tags, related, folder, type, created, mtime, properties, leading_callout, bytes"

/** Transforms a raw SQLite row (JSON strings) into a typed NoteMetadata object. */
export const rowToMetadata = (row: NoteRow): NoteMetadata => ({
  path: row.path,
  title: row.title,
  tags: parseStringArray(row.tags),
  ...bodyTagsField(row.body_tags),
  related: parseStringArray(row.related),
  folder: row.folder,
  type: row.type,
  created: row.created,
  modified: storedMtimeToIso(row.mtime),
  bytes: row.bytes,
  properties: parseRecord(row.properties),
  leading_callout: row.leading_callout ? parseLeadingCalloutJson(row.leading_callout) : null,
})

/** Maps a tasks-table row to its wire shape: note_path becomes path, NULL
 *  metadata columns become undefined (omitted on serialization), and the
 *  JSON-encoded depends_on/tags columns are parsed back into arrays. */
export const rowToTaskEntry = (row: TaskRow): TaskEntry => ({
  path: row.note_path,
  line: row.line,
  status: row.status,
  status_char: row.status_char,
  description: row.description,
  heading: row.heading ?? undefined,
  folder: row.folder,
  created: row.created ?? undefined,
  scheduled: row.scheduled ?? undefined,
  start: row.start ?? undefined,
  due: row.due ?? undefined,
  done: row.done ?? undefined,
  cancelled: row.cancelled ?? undefined,
  priority: row.priority ?? undefined,
  recurrence: row.recurrence ?? undefined,
  on_completion: row.on_completion ?? undefined,
  task_id: row.task_id ?? undefined,
  depends_on: parseStringArray(row.depends_on),
  tags: parseStringArray(row.tags),
  block_id: row.block_id ?? undefined,
  depth: row.depth,
  parent_block_id: row.parent_block_id ?? undefined,
  subtask_progress:
    row.subtask_total > 0 ? { done: row.subtask_done, total: row.subtask_total } : undefined,
  is_kanban_task: Boolean(row.is_kanban_task),
  done_lanes: row.kanban_done_lanes ? parseStringArray(row.kanban_done_lanes) : undefined,
})

/** Builds a SearchResult from a NoteRow and caller-provided snippet + score.
 *  Shared by fullTextSearch (FTS rows) and hybridSearch (vector-only rows). */
export const noteRowToSearchResult = (params: {
  row: Pick<
    NoteRow,
    "path" | "title" | "tags" | "body_tags" | "folder" | "type" | "created" | "mtime" | "bytes"
  > & {
    leading_callout?: string | null
  }
  snippet: string
  score: number
  includeLeadingCallout: boolean
}): SearchResult => ({
  path: params.row.path,
  title: params.row.title,
  snippet: params.snippet,
  score: params.score,
  tags: parseStringArray(params.row.tags),
  ...bodyTagsField(params.row.body_tags),
  folder: params.row.folder,
  type: params.row.type,
  kind: "note",
  ...(params.row.created ? { created: params.row.created } : {}),
  modified: storedMtimeToIso(params.row.mtime),
  bytes: params.row.bytes,
  ...(params.includeLeadingCallout && params.row.leading_callout
    ? {
        leading_callout: parseLeadingCalloutJson(params.row.leading_callout),
      }
    : {}),
})

/** Raw row shape from a file_content_fts JOIN file_content query. */
export type FileContentFtsRow = {
  path: string
  title: string
  folder: string
  mtime: number
  bytes: number
  snippet: string
}

/** Builds a SearchResult from a file_content FTS row. File results carry no
 *  tags, type, created, or leading_callout — those are note-specific metadata. */
export const fileContentRowToSearchResult = (
  row: FileContentFtsRow,
  score: number,
): SearchResult => ({
  path: row.path,
  title: row.title,
  snippet: row.snippet,
  score,
  tags: [],
  folder: row.folder,
  type: null,
  kind: "file",
  // Lowercased like vault_list_files' extension, and absent for a file with none
  extension: posix.extname(row.path).toLowerCase() || undefined,
  modified: storedMtimeToIso(row.mtime),
  bytes: row.bytes,
})

// ── Date ranges ────────────────────────────────────────────────

/** Converts a YYYY-MM-DD day into the half-open epoch-ms range [startMs, endMs) from its
 *  midnight to the next, in the process-local zone (the TZ env var).
 *  - plus({ days: 1 }) is calendar-aware, so DST-shortened and -lengthened days get a
 *    correct range.
 *  - Throws on anything but a strict YYYY-MM-DD day. A malformed date would yield a NaN
 *    range, and a timestamp would silently shift the range. */
export const dayToEpochMsRange = (date: string): { startMs: number; endMs: number } => {
  const dayStart = DateTime.fromFormat(date, "yyyy-MM-dd")

  if (!dayStart.isValid) {
    throw new Error(`invalid date: "${date}". Use YYYY-MM-DD (e.g. 2026-07-03).`)
  }
  return {
    startMs: dayStart.toMillis(),
    endMs: dayStart.plus({ days: 1 }).toMillis(),
  }
}

// ── Snippet builder ────────────────────────────────────────────

/** Truncates chunk text to its first `snippetTokens` words for snippet display —
 *  used for vector-only results that have no FTS5 snippet available. */
export const buildSnippetFromChunkText = (chunkText: string, snippetTokens: number): string => {
  const words = chunkText.split(/\s+/).filter((word) => word.length > 0)

  if (words.length <= snippetTokens) return words.join(" ")
  return words.slice(0, snippetTokens).join(" ") + "..."
}
