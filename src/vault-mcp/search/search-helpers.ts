// ── Pure helpers for search-index ──────────────────────────────

import { DateTime } from "luxon"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import type {
  NoteRow,
  NoteMetadata,
  SearchResult,
  SearchFilters,
  TaskRow,
  TaskEntry,
} from "./search-index.js"

// ── Type guards ────────────────────────────────────────────────

export const isString = (value: unknown): value is string =>
  typeof value === "string"

/** Coerces a YAML frontmatter field to a string array.
 *  gray-matter may parse multi-value YAML fields as a single string
 *  or an array depending on syntax (flow vs block). */
export const coerceToArray = (value: unknown): string[] =>
  Array.isArray(value) ? value : value ? [String(value)] : []

// ── JSON column parsers (private) ──────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parses a JSON column that must contain a string array (tags, related,
 *  depends_on). Throws on corruption — these columns are serialized by the
 *  indexer, so a non-array value indicates index corruption. */
const parseStringArray = (json: string): string[] => {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every(isString))
    throw new Error(`expected string[] from JSON column, got: ${json}`)
  return parsed
}

/** Parses a JSON column that must contain a record (properties).
 *  Throws on corruption — the indexer stores JSON.stringify(frontmatter). */
const parseRecord = (json: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(json)
  if (!isRecord(parsed))
    throw new Error(`expected object from JSON column, got: ${json}`)
  return parsed
}

/** Type predicate for the LeadingCallout shape ({type, title, body} — all strings). */
const isLeadingCalloutShape = (
  value: Record<string, unknown>,
): value is { type: string; title: string; body: string } =>
  typeof value.type === "string" &&
  typeof value.title === "string" &&
  typeof value.body === "string"

/** Parses a JSON column that must contain a LeadingCallout ({type, title, body}).
 *  Throws on corruption — the indexer stores JSON.stringify(parseLeadingCallout(...)). */
const parseLeadingCalloutJson = (json: string): LeadingCallout => {
  const parsed: unknown = JSON.parse(json)
  if (!isRecord(parsed) || !isLeadingCalloutShape(parsed))
    throw new Error(`expected LeadingCallout from JSON column, got: ${json}`)
  return { type: parsed.type, title: parsed.title, body: parsed.body }
}

// ── LIKE escaping ─────────────────────────────────────────────

/** Strips trailing slashes so folder paths produce clean LIKE patterns
 *  (e.g. `"Projects/"` → `"Projects"`, avoiding `Projects//%`). */
export const stripTrailingSlashes = (folder: string): string =>
  folder.replace(/\/+$/, "")

/** Escapes LIKE-wildcard characters (`\`, `%`, `_`) in a value so it is
 *  matched literally in a `LIKE ... ESCAPE '\'` clause. */
export const escapeLikeWildcards = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`)

// ── FTS metadata builder ───────────────────────────────────────

/** Flattens frontmatter into a searchable text block for the FTS metadata column.
 *  Keys are included (so "lifecycle" is findable), title is excluded (separate FTS column). */
export const buildFtsMetadataText = (
  frontmatter: Record<string, unknown>,
): string => {
  const lines: string[] = []
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === "title") continue
    if (value == null) continue
    if (Array.isArray(value)) {
      const primitiveElements = value
        .filter((element) => element != null && typeof element !== "object")
        .map(String)
      if (primitiveElements.length > 0) {
        lines.push(`${key}: ${primitiveElements.join(" ")}`)
      }
    } else if (typeof value !== "object") {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  return lines.join("\n")
}

// ── Row mappers ────────────────────────────────────────────────

/** Converts mtime (epoch ms) to an ISO string, throwing if the value is
 *  invalid — mtime comes from stat().mtimeMs during indexing, so null
 *  indicates data corruption rather than an expected edge case. */
export const mtimeToIso = (mtime: number): string => {
  const iso = DateTime.fromMillis(Math.round(mtime)).toISO()
  if (iso === null) throw new Error(`invalid mtime: ${mtime}`)
  return iso
}

/** Transforms a raw SQLite row (JSON strings) into a typed NoteMetadata object. */
export const rowToMetadata = (row: NoteRow): NoteMetadata => ({
  path: row.path,
  title: row.title,
  tags: parseStringArray(row.tags),
  related: parseStringArray(row.related),
  folder: row.folder,
  type: row.type,
  created: row.created,
  modified: mtimeToIso(row.mtime),
  bytes: row.bytes ?? 0,
  properties: parseRecord(row.properties),
  leading_callout: row.leading_callout
    ? parseLeadingCalloutJson(row.leading_callout)
    : null,
})

/** Maps a tasks-table row to its wire shape: note_path becomes path, and the
 *  JSON-encoded depends_on/tags columns are parsed back into arrays. */
export const rowToTaskEntry = (row: TaskRow): TaskEntry => ({
  path: row.note_path,
  line: row.line,
  status: row.status,
  status_char: row.status_char,
  description: row.description,
  heading: row.heading,
  folder: row.folder,
  created: row.created,
  scheduled: row.scheduled,
  start: row.start,
  due: row.due,
  done: row.done,
  cancelled: row.cancelled,
  priority: row.priority,
  recurrence: row.recurrence,
  on_completion: row.on_completion,
  task_id: row.task_id,
  depends_on: parseStringArray(row.depends_on),
  tags: parseStringArray(row.tags),
  block_id: row.block_id,
  is_kanban_task: Boolean(row.is_kanban_task),
  lane: row.is_kanban_task ? row.heading : null,
  done_lanes: row.kanban_done_lanes
    ? parseStringArray(row.kanban_done_lanes)
    : null,
})

/** Builds a SearchResult from a NoteRow and caller-provided snippet + score.
 *  Shared by fullTextSearch (FTS rows) and hybridSearch (vector-only rows). */
export const noteRowToSearchResult = (params: {
  row: Pick<
    NoteRow,
    | "path"
    | "title"
    | "tags"
    | "folder"
    | "type"
    | "created"
    | "mtime"
    | "bytes"
  > & { leading_callout?: string | null }
  snippet: string
  score: number
  includeLeadingCallout: boolean
}): SearchResult => ({
  path: params.row.path,
  title: params.row.title,
  snippet: params.snippet,
  score: params.score,
  tags: parseStringArray(params.row.tags),
  folder: params.row.folder,
  type: params.row.type,
  ...(params.row.created !== null ? { created: params.row.created } : {}),
  modified: mtimeToIso(params.row.mtime),
  bytes: params.row.bytes ?? 0,
  ...(params.includeLeadingCallout && params.row.leading_callout
    ? {
        leading_callout: parseLeadingCalloutJson(params.row.leading_callout),
      }
    : {}),
})

// ── Filters ────────────────────────────────────────────────────

/** Converts a YYYY-MM-DD day into the window of time it covers — from
 *  midnight that day to midnight the next, as half-open epoch-ms
 *  [startMs, endMs) in the process-local zone (governed by the TZ env var).
 *  Single definition shared by the SQL modified-filter conditions and their
 *  TypeScript mirror so both search legs agree on day boundaries.
 *  plus({ days: 1 }) is calendar-aware, so DST-shortened and -lengthened
 *  days get a correct range. Throws on anything but a strict YYYY-MM-DD
 *  day — a malformed date would otherwise yield a NaN range and a
 *  timestamped one a silently time-shifted window, both mis-filtering
 *  instead of failing fast. */
export const dayToEpochMsRange = (
  date: string,
): { startMs: number; endMs: number } => {
  const dayStart = DateTime.fromFormat(date, "yyyy-MM-dd")
  if (!dayStart.isValid) {
    throw new Error(
      `invalid date: "${date}". Use YYYY-MM-DD (e.g. 2026-07-03).`,
    )
  }
  return {
    startMs: dayStart.toMillis(),
    endMs: dayStart.plus({ days: 1 }).toMillis(),
  }
}

/** Returns true when a note row satisfies every active search filter (folder
 *  prefix, all-of tags, type, all-of related links, property key/value pairs,
 *  created/modified date bounds). Mirrors fullTextSearch's SQL WHERE clause
 *  in TypeScript — used for vector-only results that bypassed the FTS query.
 *  Date filter values are pre-validated by fullTextSearch, which hybridSearch
 *  always runs before this mirror. */
export const noteMatchesSearchFilters = (
  note: NoteRow,
  filters: SearchFilters,
): boolean => {
  if (
    filters.folder &&
    !note.path.startsWith(stripTrailingSlashes(filters.folder) + "/")
  )
    return false

  if (filters.tags) {
    const noteTags = parseStringArray(note.tags)
    if (!filters.tags.every((tag) => noteTags.includes(tag))) return false
  }

  if (filters.type && note.type !== filters.type) return false

  if (filters.related) {
    const noteRelated = parseStringArray(note.related)
    if (!filters.related.every((link) => noteRelated.includes(link)))
      return false
  }

  if (filters.properties) {
    const noteProperties = parseRecord(note.properties)
    for (const [key, value] of Object.entries(filters.properties)) {
      if (noteProperties[key] !== value) return false
    }
  }

  // Mirror of the SQL substr(n.created, 1, 10) comparisons — the first 10
  // chars of the stored ISO created value are its server-local calendar day.
  // The null rejection is gated on a bound being present so an empty filter
  // object stays a no-op exactly like the SQL leg (which pushes no
  // conditions); with a bound set, notes without created never match, like
  // SQL NULL comparisons.
  if (filters.created) {
    const { on, before, after } = filters.created
    const hasCreatedBound =
      on !== undefined || before !== undefined || after !== undefined
    if (hasCreatedBound) {
      if (note.created === null) return false
      const createdDay = note.created.slice(0, 10)
      if (on !== undefined && createdDay !== on) return false
      if (before !== undefined && createdDay >= before) return false
      if (after !== undefined && createdDay <= after) return false
    }
  }

  // Mirror of the SQL mtime bounds — same dayToEpochMsRange conversion,
  // exclusive at day granularity: before/after match strictly earlier/later
  // days, on matches within the day.
  if (filters.modified) {
    if (filters.modified.on !== undefined) {
      const dayRange = dayToEpochMsRange(filters.modified.on)
      if (note.mtime < dayRange.startMs || note.mtime >= dayRange.endMs)
        return false
    }
    if (
      filters.modified.before !== undefined &&
      note.mtime >= dayToEpochMsRange(filters.modified.before).startMs
    )
      return false
    if (
      filters.modified.after !== undefined &&
      note.mtime < dayToEpochMsRange(filters.modified.after).endMs
    )
      return false
  }

  return true
}

// ── Snippet builder ────────────────────────────────────────────

/** Truncates chunk text to the first N words for snippet display —
 *  used for vector-only results that have no FTS5 snippet available. */
export const buildSnippetFromChunkText = (
  chunkText: string,
  snippetTokens: number,
): string => {
  const words = chunkText.split(/\s+/).filter((word) => word.length > 0)
  if (words.length <= snippetTokens) return words.join(" ")
  return words.slice(0, snippetTokens).join(" ") + "..."
}
