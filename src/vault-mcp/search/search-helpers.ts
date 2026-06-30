// ── Pure helpers for search-index ──────────────────────────────

import { DateTime } from "luxon"
import type { LeadingCallout } from "../obsidian-markdown/callouts.js"
import { links } from "../obsidian-markdown/links.js"
import type {
  NoteRow,
  NoteMetadata,
  SearchResult,
  SearchFilters,
} from "./search-index.js"

// ── Type guards ────────────────────────────────────────────────

export const isString = (value: unknown): value is string =>
  typeof value === "string"

/** Coerces a YAML frontmatter field to a string array.
 *  gray-matter may parse multi-value YAML fields as a single string
 *  or an array depending on syntax (flow vs block). */
export const coerceToArray = (value: unknown): string[] =>
  Array.isArray(value) ? value : value ? [String(value)] : []

// ── Link extraction ────────────────────────────────────────────

/** A note's complete link set — body links unioned with frontmatter wikilinks,
 *  deduplicated. Single source of truth for "what does this note link to",
 *  shared by incremental upsert and full rebuild — must not diverge. */
export const extractAllLinks = (
  content: string,
  data: Record<string, unknown>,
): string[] => [
  ...new Set([
    ...links.extractFromBody(content),
    ...links.extractFromFrontmatter(data),
  ]),
]

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
  tags: JSON.parse(row.tags) as string[],
  related: JSON.parse(row.related) as string[],
  folder: row.folder,
  type: row.type,
  created: row.created,
  modified: mtimeToIso(row.mtime),
  bytes: row.bytes ?? 0,
  properties: JSON.parse(row.properties) as Record<string, unknown>,
  leading_callout: row.leading_callout
    ? (JSON.parse(row.leading_callout) as LeadingCallout)
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
  tags: JSON.parse(params.row.tags) as string[],
  folder: params.row.folder,
  type: params.row.type,
  ...(params.row.created !== null ? { created: params.row.created } : {}),
  modified: mtimeToIso(params.row.mtime),
  bytes: params.row.bytes ?? 0,
  ...(params.includeLeadingCallout && params.row.leading_callout
    ? {
        leading_callout: JSON.parse(
          params.row.leading_callout,
        ) as LeadingCallout,
      }
    : {}),
})

// ── Filters ────────────────────────────────────────────────────

/** Applies the same filter logic as fullTextSearch's SQL WHERE clause, but in
 *  TypeScript — used for vector-only results that bypassed the FTS query. */
export const notePassesFilters = (
  note: NoteRow,
  filters: SearchFilters,
): boolean => {
  if (filters.folder && !note.path.startsWith(filters.folder + "/"))
    return false

  if (filters.tags) {
    const noteTags = JSON.parse(note.tags) as string[]
    if (!filters.tags.every((tag) => noteTags.includes(tag))) return false
  }

  if (filters.type && note.type !== filters.type) return false

  if (filters.related) {
    const noteRelated = JSON.parse(note.related) as string[]
    if (!filters.related.every((link) => noteRelated.includes(link)))
      return false
  }

  if (filters.properties) {
    const noteProperties = JSON.parse(note.properties) as Record<
      string,
      unknown
    >
    for (const [key, value] of Object.entries(filters.properties)) {
      if (noteProperties[key] !== value) return false
    }
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
