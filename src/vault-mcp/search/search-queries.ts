// ── Query methods extracted from search-index.ts ──────────────

import type Database from "better-sqlite3"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { sanitizeFtsQuery } from "./fts-query.js"
import { computeRrfScores } from "./rrf.js"
import { blendScores } from "./reranker.js"
import type { Reranker } from "./reranker.js"
import {
  rowToMetadata,
  rowToTaskEntry,
  noteRowToSearchResult,
  noteMatchesSearchFilters,
  buildSnippetFromChunkText,
  escapeLikeWildcards,
  stripTrailingSlashes,
} from "./search-helpers.js"
import type {
  VectorHit,
  SearchResult,
  HybridSearchResult,
  NoteMetadata,
  NoteRow,
  TagCount,
  PropertyKeyInfo,
  PropertyValueCount,
  VaultStats,
  SearchFilters,
  BacklinkEntry,
  OutgoingLinkEntry,
  TaskRow,
  TaskStatusFilter,
  TaskDateFilter,
  TaskPriorityFilter,
  TaskSortKey,
  ListTasksResult,
} from "./search-index.js"
import type { Embedder } from "./embedder.js"

// ── Context ────────────────────────────────────────────────────

export type SearchQueryContext = {
  readonly db: Database.Database
  readonly getDailyNotesFolder: () => string | null
  readonly vector: {
    readonly embedder: Embedder | undefined
    readonly knnSearchStmt: Database.Statement | null
    readonly selectNoteMetadataStmt: Database.Statement<[string], NoteRow>
  }
  readonly reranker: Reranker | undefined
  readonly selectFirstChunkStmt: Database.Statement | null
}

// ── Vector search (internal) ───────────────────────────────────

const vectorSearch = async (
  context: SearchQueryContext,
  params: { query: string; limit: number },
  logger: Logger,
): Promise<VectorHit[]> => {
  const { embedder, knnSearchStmt } = context.vector
  if (!embedder || !knnSearchStmt) return []

  try {
    const queryEmbedding = await embedder.embedText(params.query)
    const rows = knnSearchStmt.all(
      Buffer.from(
        queryEmbedding.buffer,
        queryEmbedding.byteOffset,
        queryEmbedding.byteLength,
      ),
      params.limit,
    ) as Array<{ note_path: string; chunk_text: string; distance: number }>

    // Deduplicate to best chunk per note — rows are ordered by distance
    // ascending, so the first occurrence of each path is the closest match.
    const bestChunkPerNote = new Map<string, VectorHit>()
    for (const row of rows) {
      if (!bestChunkPerNote.has(row.note_path)) {
        bestChunkPerNote.set(row.note_path, {
          path: row.note_path,
          distance: row.distance,
          chunkText: row.chunk_text,
        })
      }
    }

    logger.info("vector search", {
      query: params.query,
      knnHits: rows.length,
      uniqueNotes: bestChunkPerNote.size,
    })
    return [...bestChunkPerNote.values()]
  } catch (error) {
    logger.warn("vector search failed, falling back to FTS-only", {
      error: describeError(error),
    })
    return []
  }
}

// ── Full-text search ───────────────────────────────────────────

export const fullTextSearch = (
  context: SearchQueryContext,
  params: { query: string; filters?: SearchFilters },
  logger: Logger,
): SearchResult[] => {
  // Build WHERE clause dynamically: each filter appends a condition + its bind params
  const conditions: string[] = []
  const queryParams: unknown[] = []

  conditions.push("notes_fts MATCH ?")
  queryParams.push(sanitizeFtsQuery(params.query))

  if (params.filters?.folder) {
    conditions.push("n.path LIKE ? ESCAPE '\\'")
    queryParams.push(
      `${escapeLikeWildcards(stripTrailingSlashes(params.filters.folder))}/%`,
    )
  }

  if (params.filters?.tags) {
    for (const tag of params.filters.tags) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)",
      )
      queryParams.push(tag)
    }
  }

  if (params.filters?.related) {
    for (const relatedNote of params.filters.related) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(n.related) WHERE value = ?)",
      )
      queryParams.push(relatedNote)
    }
  }

  if (params.filters?.type) {
    conditions.push("n.type = ?")
    queryParams.push(params.filters.type)
  }

  if (params.filters?.properties) {
    for (const [key, value] of Object.entries(params.filters.properties)) {
      conditions.push(`json_extract(n.properties, '$.' || ?) = ?`)
      queryParams.push(key, value)
    }
  }

  const limit = Math.max(0, params.filters?.limit ?? 20)
  const snippetTokens = params.filters?.snippet_tokens ?? 30
  // Opt-in: the leading callout is omitted by default to keep this hot-path
  // result lean; callers triaging which note to open can request it.
  const includeLeadingCallout = params.filters?.include_leading_callout ?? false
  queryParams.push(limit)

  // FTS5 rank is negative (lower = better), negated for human-friendly scoring
  const sql = `
    SELECT n.path, n.title,
           snippet(notes_fts, 2, '', '', '...', ${Number(snippetTokens)}) as snippet,
           rank * -1 as score, n.tags, n.folder, n.type, n.created, n.mtime,
           n.bytes${includeLeadingCallout ? ", n.leading_callout" : ""}
    FROM notes_fts
    JOIN notes n ON n.path = notes_fts.path
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank
    LIMIT ?
  `

  try {
    const rows = context.db.prepare(sql).all(...queryParams) as Array<
      Pick<
        NoteRow,
        | "path"
        | "title"
        | "tags"
        | "folder"
        | "type"
        | "created"
        | "mtime"
        | "bytes"
      > & {
        snippet: string
        score: number
        leading_callout?: string | null
      }
    >

    const results: SearchResult[] = rows.map((row) =>
      noteRowToSearchResult({
        row,
        snippet: row.snippet,
        score: Number(row.score.toPrecision(4)),
        includeLeadingCallout,
      }),
    )
    logger.info("full text search", {
      query: params.query,
      resultCount: results.length,
    })
    return results
  } catch (error) {
    logger.warn("full text search failed", {
      query: params.query,
      error: describeError(error),
    })
    return []
  }
}

// ── Hybrid search ──────────────────────────────────────────────

/** Hybrid search — combines FTS5 keyword search with sqlite-vec vector
 *  similarity via RRF fusion. Falls back to FTS-only silently when no
 *  embeddings are available. */
export const hybridSearch = async (
  context: SearchQueryContext,
  params: { query: string; filters?: SearchFilters },
  logger: Logger,
): Promise<HybridSearchResult> => {
  const userLimit = Math.max(0, params.filters?.limit ?? 20)
  const snippetTokens = params.filters?.snippet_tokens ?? 30
  const includeLeadingCallout = params.filters?.include_leading_callout ?? false
  const candidateLimit = Math.min(Math.max(1, userLimit * 3), 100)

  // Run FTS with inflated limit to give RRF enough candidates
  const ftsResults = fullTextSearch(
    context,
    {
      query: params.query,
      filters: { ...params.filters, limit: candidateLimit },
    },
    logger,
  )

  // Attempt vector search — returns [] on any failure
  const vectorHits = await vectorSearch(
    context,
    { query: params.query, limit: candidateLimit },
    logger,
  )

  // FTS-only fallback when no vectors are available
  if (vectorHits.length === 0) {
    const fallbackResults = ftsResults.slice(0, userLimit)
    logger.info("hybrid search", {
      query: params.query,
      searchMode: "fts",
      resultCount: fallbackResults.length,
    })
    return { results: fallbackResults, search_mode: "fts", reranked: false }
  }

  // Compute RRF scores from both ranked lists
  const rrfScores = computeRrfScores({
    ftsRanked: ftsResults,
    vectorRanked: vectorHits,
  })

  // Index FTS results and vector hits by path for O(1) lookup
  const ftsResultsByPath = new Map(
    ftsResults.map((result) => [result.path, result]),
  )
  const vectorHitsByPath = new Map(vectorHits.map((hit) => [hit.path, hit]))

  // Build the merged result set, ordered by RRF score
  const mergedResults: SearchResult[] = []
  for (const { path, score } of rrfScores) {
    const ftsResult = ftsResultsByPath.get(path)
    if (ftsResult) {
      // Path found via FTS — use its metadata and snippet, replace score
      mergedResults.push({ ...ftsResult, score })
      continue
    }

    // Vector-only result — look up metadata from the notes table
    const noteRow = context.vector.selectNoteMetadataStmt.get(path)
    if (!noteRow) continue

    // Apply filters that FTS would have applied via SQL
    if (params.filters && !noteMatchesSearchFilters(noteRow, params.filters))
      continue

    const vectorHit = vectorHitsByPath.get(path)
    const snippet = vectorHit
      ? buildSnippetFromChunkText(vectorHit.chunkText, snippetTokens)
      : ""

    mergedResults.push(
      noteRowToSearchResult({
        row: noteRow,
        snippet,
        score,
        includeLeadingCallout,
      }),
    )
  }

  // Apply cross-encoder reranking with position-aware score blending.
  // Cap the rerank window at userLimit — results beyond that are sliced
  // off anyway, and the cross-encoder scores sequentially (~10ms/pair).
  const rerankCandidates = mergedResults.slice(0, userLimit)
  const rerankedResult =
    context.reranker && rerankCandidates.length > 1
      ? await tryRerank({
          reranker: context.reranker,
          query: params.query,
          mergedResults: rerankCandidates,
          vectorHitsByPath,
          selectFirstChunkStmt: context.selectFirstChunkStmt,
          logger,
        })
      : null

  const finalResults = rerankedResult?.results ?? rerankCandidates
  const reranked = Boolean(rerankedResult)

  logger.info("hybrid search", {
    query: params.query,
    searchMode: "hybrid",
    reranked,
    ftsResults: ftsResults.length,
    vectorHits: vectorHits.length,
    mergedResults: mergedResults.length,
    returnedResults: Math.min(finalResults.length, userLimit),
  })
  return {
    results: finalResults.slice(0, userLimit),
    search_mode: "hybrid",
    reranked,
  }
}

// ── Reranking helper ──────────────────────────────────────────

/** Attempts cross-encoder reranking with position-aware blending.
 *  Returns null on failure — the caller falls back to RRF-only ordering. */
const tryRerank = async (params: {
  reranker: Reranker
  query: string
  mergedResults: readonly SearchResult[]
  vectorHitsByPath: ReadonlyMap<string, VectorHit>
  selectFirstChunkStmt: Database.Statement | null
  logger: Logger
}): Promise<{ results: SearchResult[] } | null> => {
  try {
    // Collect document text for each candidate
    const documentTexts = params.mergedResults.map((result) => {
      // Prefer vector chunk text (best semantic match for this note)
      const vectorHit = params.vectorHitsByPath.get(result.path)
      if (vectorHit) return vectorHit.chunkText

      // FTS-only note: use chunk index 0 (title + intro) from note_chunks
      if (params.selectFirstChunkStmt) {
        const chunkRow = params.selectFirstChunkStmt.get(result.path) as
          | { chunk_text: string }
          | undefined
        if (chunkRow) return chunkRow.chunk_text
      }

      // Fallback: use the snippet (truncated, but better than nothing —
      // covers the edge case where chunks aren't yet indexed during
      // background embedding startup)
      return result.snippet
    })

    const rerankScores = await params.reranker.rerankPairs(
      params.query,
      documentTexts,
    )

    if (rerankScores.length !== params.mergedResults.length) {
      params.logger.warn("reranker returned mismatched score count", {
        expected: params.mergedResults.length,
        received: rerankScores.length,
      })
      return null
    }

    const rrfScores = params.mergedResults.map((result) => result.score)
    const rrfRanks = params.mergedResults.map((_result, index) => index + 1)

    const blendedScores = blendScores({ rrfScores, rerankScores, rrfRanks })

    const scoredResults = params.mergedResults.map((result, index) => ({
      ...result,
      score: blendedScores[index],
    }))

    return {
      results: scoredResults.sort(
        (resultA, resultB) => resultB.score - resultA.score,
      ),
    }
  } catch (error) {
    params.logger.warn("reranker failed, using RRF-only ordering", {
      error: describeError(error),
    })
    return null
  }
}

// ── Discovery queries ──────────────────────────────────────────

/** Finds notes with a specific tag. Supports hierarchical prefix matching. */
export const searchByTag = (
  context: SearchQueryContext,
  params: { tag: string; exactMatch?: boolean; limit?: number },
  logger: Logger,
): NoteMetadata[] => {
  const limit = Math.max(0, params.limit ?? 20)

  const condition = params.exactMatch
    ? "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)"
    : "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ? OR value LIKE ? || '/%')"

  const queryParams: unknown[] = params.exactMatch
    ? [params.tag, limit]
    : [params.tag, params.tag, limit]

  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes n
    WHERE ${condition}
    ORDER BY mtime DESC
    LIMIT ?
  `

  const rows = context.db.prepare(sql).all(...queryParams) as NoteRow[]
  const results = rows.map(rowToMetadata)
  logger.info("search by tag", {
    tag: params.tag,
    resultCount: results.length,
  })
  return results
}

/** Lists notes in a folder, optionally including subfolders. */
export const searchByFolder = (
  context: SearchQueryContext,
  params: { folder: string; recursive?: boolean; limit?: number },
  logger: Logger,
): NoteMetadata[] => {
  const recursive = params.recursive ?? true
  const limit = Math.max(0, params.limit ?? 20)

  const escapedFolder = escapeLikeWildcards(stripTrailingSlashes(params.folder))
  const condition = recursive
    ? "path LIKE ? || '/%' ESCAPE '\\'"
    : "path LIKE ? || '/%' ESCAPE '\\' AND path NOT LIKE ? || '/%/%' ESCAPE '\\'"

  const queryParams: unknown[] = recursive
    ? [escapedFolder, limit]
    : [escapedFolder, escapedFolder, limit]

  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes
    WHERE ${condition}
    ORDER BY mtime DESC
    LIMIT ?
  `

  const rows = context.db.prepare(sql).all(...queryParams) as NoteRow[]
  const results = rows.map(rowToMetadata)
  logger.info("search by folder", {
    folder: params.folder,
    resultCount: results.length,
  })
  return results
}

// ── Task listing ───────────────────────────────────────────────

/** Strict YYYY-MM-DD guard for task date filters (matches the format the
 *  Tasks plugin recognizes on task lines). */
const STRICT_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Rejects a malformed task date filter with remediation text. Luxon
 *  validates calendar correctness (2026-02-31 fails), the regex pins the
 *  format (no time component, no shorthand). */
const assertTaskFilterDate = (value: string, filterName: string): void => {
  if (!STRICT_ISO_DATE_RE.test(value) || !DateTime.fromISO(value).isValid) {
    throw new Error(
      `invalid ${filterName} date: "${value}". Use YYYY-MM-DD (e.g. 2026-07-03).`,
    )
  }
}

/** ORDER BY fragment per sort key. Values are trusted SQL assembled from the
 *  whitelisted TaskSortKey union — never raw user input. Date keys push
 *  dateless tasks last regardless of direction; priority maps levels to the
 *  plugin's numeric order (highest=0 … lowest=5, none=3 between medium and
 *  low, the ELSE arm since none is stored as NULL). */
const TASK_ORDER_BY: Record<TaskSortKey, (direction: string) => string> = {
  due: (direction) => `t.due IS NULL, t.due ${direction}`,
  scheduled: (direction) => `t.scheduled IS NULL, t.scheduled ${direction}`,
  start: (direction) => `t.start IS NULL, t.start ${direction}`,
  created: (direction) => `t.created IS NULL, t.created ${direction}`,
  done: (direction) => `t.done IS NULL, t.done ${direction}`,
  priority: (direction) =>
    `CASE t.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 3 END ${direction}`,
  note_mtime: (direction) => `n.mtime ${direction}`,
}

/** Lists indexed tasks with structured filters and sorting. All filters
 *  AND-combine; the default view is actionable work (not_done = todo +
 *  in_progress), sorted overdue-first (due ascending, dateless last).
 *  Returns the total match count alongside the limited page so callers can
 *  tell "50 of 338" from "all 50". */
export const listTasks = (
  context: SearchQueryContext,
  params: {
    status?: TaskStatusFilter
    due?: TaskDateFilter
    scheduled?: TaskDateFilter
    start?: TaskDateFilter
    done?: TaskDateFilter
    created?: TaskDateFilter
    cancelled?: TaskDateFilter
    priority?: TaskPriorityFilter[]
    folder?: string
    tag?: string
    heading?: string
    path?: string
    limit?: number
    sortBy?: TaskSortKey
    sortDirection?: "asc" | "desc"
  },
  logger: Logger,
): ListTasksResult => {
  const conditions: string[] = []
  const queryParams: unknown[] = []

  const status = params.status ?? "not_done"
  if (status === "not_done") {
    conditions.push("t.status IN ('todo', 'in_progress')")
  } else if (status !== "all") {
    conditions.push("t.status = ?")
    queryParams.push(status)
  }

  // A date filter only ever matches tasks that HAVE that date — SQL comparison
  // with NULL is never true, so undated tasks drop out automatically.
  const dateFilters: ReadonlyArray<{
    column: "due" | "scheduled" | "start" | "done" | "created" | "cancelled"
    filter: TaskDateFilter | undefined
  }> = [
    { column: "due", filter: params.due },
    { column: "scheduled", filter: params.scheduled },
    { column: "start", filter: params.start },
    { column: "done", filter: params.done },
    { column: "created", filter: params.created },
    { column: "cancelled", filter: params.cancelled },
  ]
  for (const { column, filter } of dateFilters) {
    if (filter === undefined) continue
    if (filter.on !== undefined) {
      assertTaskFilterDate(filter.on, `${column}.on`)
      conditions.push(`t.${column} = ?`)
      queryParams.push(filter.on)
    }
    if (filter.before !== undefined) {
      assertTaskFilterDate(filter.before, `${column}.before`)
      conditions.push(`t.${column} < ?`)
      queryParams.push(filter.before)
    }
    if (filter.after !== undefined) {
      assertTaskFilterDate(filter.after, `${column}.after`)
      conditions.push(`t.${column} > ?`)
      queryParams.push(filter.after)
    }
  }

  if (params.priority !== undefined && params.priority.length > 0) {
    // Priority values OR-combine (a task has exactly one level); "none"
    // selects tasks with no priority signifier, stored as NULL.
    const namedLevels = params.priority.filter((level) => level !== "none")
    const priorityClauses: string[] = []
    if (namedLevels.length > 0) {
      priorityClauses.push(
        `t.priority IN (${namedLevels.map(() => "?").join(", ")})`,
      )
      queryParams.push(...namedLevels)
    }
    if (params.priority.includes("none")) {
      priorityClauses.push("t.priority IS NULL")
    }
    conditions.push(`(${priorityClauses.join(" OR ")})`)
  }

  if (params.folder !== undefined) {
    conditions.push("t.note_path LIKE ? ESCAPE '\\'")
    queryParams.push(
      `${escapeLikeWildcards(stripTrailingSlashes(params.folder))}/%`,
    )
  }

  if (params.tag !== undefined) {
    // Same nested-tag semantics as searchByTag's prefix mode: "project"
    // matches both #project and #project/vault-cortex.
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ? OR value LIKE ? || '/%')",
    )
    queryParams.push(params.tag, params.tag)
  }

  if (params.heading !== undefined) {
    conditions.push("t.heading = ?")
    queryParams.push(params.heading)
  }

  if (params.path !== undefined) {
    assertPathHasExtension(params.path, ".md")
    conditions.push("t.note_path = ?")
    queryParams.push(params.path)
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const sortBy = params.sortBy ?? "due"
  // note_mtime defaults to newest-first — "recently touched" is the only
  // useful direction for it; every other key defaults ascending.
  const sortDirection =
    params.sortDirection ?? (sortBy === "note_mtime" ? "desc" : "asc")
  const orderBy = TASK_ORDER_BY[sortBy](
    sortDirection === "desc" ? "DESC" : "ASC",
  )

  const limit = Math.max(0, params.limit ?? 50)

  const countRow = context.db
    .prepare<
      unknown[],
      { total: number }
    >(`SELECT COUNT(*) as total FROM tasks t JOIN notes n ON n.path = t.note_path ${whereClause}`)
    .get(...queryParams)
  const total = countRow === undefined ? 0 : countRow.total

  const sql = `
    SELECT t.note_path, t.line, t.status_char, t.status, t.description,
           t.created, t.scheduled, t.start, t.due, t.done, t.cancelled,
           t.priority, t.recurrence, t.on_completion, t.task_id, t.depends_on,
           t.tags, t.block_id, t.heading, t.folder
    FROM tasks t
    JOIN notes n ON n.path = t.note_path
    ${whereClause}
    ORDER BY ${orderBy}, t.note_path ASC, t.line ASC
    LIMIT ?
  `
  const rows = context.db
    .prepare<unknown[], TaskRow>(sql)
    .all(...queryParams, limit)
  const taskEntries = rows.map(rowToTaskEntry)

  logger.info("list tasks", {
    status,
    sortBy,
    resultCount: taskEntries.length,
    total,
  })
  return { total, tasks: taskEntries }
}

/** Returns all tags in the vault with their note counts. */
export const listAllTags = (
  context: SearchQueryContext,
  _params: Record<string, never>,
  logger: Logger,
): TagCount[] => {
  const sql = `
    SELECT value as tag, COUNT(DISTINCT notes.path) as count
    FROM notes, json_each(notes.tags)
    GROUP BY value
    ORDER BY count DESC
  `
  const results = context.db.prepare(sql).all() as TagCount[]
  logger.info("listed all tags", { count: results.length })
  return results
}

/** Returns recently modified or created notes, sorted by chosen timestamp. */
export const recentNotes = (
  context: SearchQueryContext,
  params: { sort_by?: "created" | "modified"; limit?: number },
  logger: Logger,
): NoteMetadata[] => {
  const sortBy = params.sort_by ?? "modified"
  const limit = Math.max(0, params.limit ?? 20)

  // "created IS NULL" sorts NULLs last in a DESC ordering (SQLite evaluates 0/1)
  const orderClause =
    sortBy === "created"
      ? "ORDER BY created IS NULL, created DESC"
      : "ORDER BY mtime DESC" // SQL column is still `mtime`

  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes
    ${orderClause}
    LIMIT ?
  `

  const rows = context.db.prepare(sql).all(limit) as NoteRow[]
  const results = rows.map(rowToMetadata)
  logger.info("recent notes", { sortBy, resultCount: results.length })
  return results
}

// ── Property queries ───────────────────────────────────────────

/** Returns all frontmatter property keys with note counts and top 3 sample values. */
export const listPropertyKeys = (
  context: SearchQueryContext,
  params: { folder?: string },
  logger: Logger,
): PropertyKeyInfo[] => {
  const escapedFolder = params.folder
    ? escapeLikeWildcards(stripTrailingSlashes(params.folder))
    : null
  const folderCondition = escapedFolder
    ? "WHERE n.path LIKE @folder || '/%' ESCAPE '\\'"
    : ""

  const keySql = `
    SELECT property.key, COUNT(DISTINCT n.path) as count
    FROM notes n, json_each(n.properties) property
    ${folderCondition}
    GROUP BY property.key
    ORDER BY count DESC
  `
  const keySqlParams: Record<string, string> = escapedFolder
    ? { folder: escapedFolder }
    : {}
  const keyRows = context.db.prepare(keySql).all(keySqlParams) as Array<{
    key: string
    count: number
  }>

  const sampleFolderCondition = escapedFolder
    ? "AND path LIKE @folder || '/%' ESCAPE '\\'"
    : ""

  // For each key, fetch the 3 most common values as samples.
  // json_array() wraps scalars so json_each works uniformly for
  // both scalar ("active") and array (["a","b"]) property values.
  const sampleSql = `
    SELECT element.value, COUNT(*) as count
    FROM (
      SELECT properties FROM notes
      WHERE json_type(properties, '$.' || @key) IS NOT NULL
      ${sampleFolderCondition}
    ) filtered, json_each(
      CASE json_type(filtered.properties, '$.' || @key)
        WHEN 'array' THEN json_extract(filtered.properties, '$.' || @key)
        ELSE json_array(json_extract(filtered.properties, '$.' || @key))
      END
    ) element
    WHERE typeof(element.value) IN ('text', 'integer', 'real')
    GROUP BY element.value
    ORDER BY count DESC
    LIMIT 3
  `
  const sampleStmt = context.db.prepare(sampleSql)

  const results: PropertyKeyInfo[] = keyRows.map((keyRow) => {
    const sqlParams: Record<string, string> = escapedFolder
      ? { key: keyRow.key, folder: escapedFolder }
      : { key: keyRow.key }
    const sampleRows = sampleStmt.all(sqlParams) as Array<{
      value: string
    }>
    return {
      key: keyRow.key,
      count: keyRow.count,
      sample_values: sampleRows.map((sampleRow) => String(sampleRow.value)),
    }
  })

  logger.info("listed property keys", { count: results.length })
  return results
}

/** Returns distinct values for a given property key with note counts. */
export const listPropertyValues = (
  context: SearchQueryContext,
  params: { key: string; folder?: string; limit?: number },
  logger: Logger,
): PropertyValueCount[] => {
  const limit = Math.max(0, params.limit ?? 50)
  const escapedFolder = params.folder
    ? escapeLikeWildcards(stripTrailingSlashes(params.folder))
    : null
  const folderCondition = escapedFolder
    ? "AND path LIKE @folder || '/%' ESCAPE '\\'"
    : ""

  // json_array() wraps scalars so json_each works uniformly for
  // both scalar ("active") and array (["a","b"]) property values.
  const sql = `
    SELECT element.value, COUNT(*) as count
    FROM (
      SELECT properties FROM notes
      WHERE json_type(properties, '$.' || @key) IS NOT NULL
      ${folderCondition}
    ) filtered, json_each(
      CASE json_type(filtered.properties, '$.' || @key)
        WHEN 'array' THEN json_extract(filtered.properties, '$.' || @key)
        ELSE json_array(json_extract(filtered.properties, '$.' || @key))
      END
    ) element
    WHERE typeof(element.value) IN ('text', 'integer', 'real')
    GROUP BY element.value
    ORDER BY count DESC
    LIMIT @limit
  `

  const sqlParams: Record<string, unknown> = { key: params.key, limit }
  if (escapedFolder) sqlParams.folder = escapedFolder

  const rows = context.db.prepare(sql).all(sqlParams) as Array<{
    value: string | number
    count: number
  }>
  const results = rows.map((row) => ({
    value: String(row.value),
    count: row.count,
  }))
  logger.info("listed property values", {
    key: params.key,
    count: results.length,
  })
  return results
}

/** Finds notes where a frontmatter property matches a value (exact match). */
export const searchByProperty = (
  context: SearchQueryContext,
  params: { key: string; value: string; folder?: string; limit?: number },
  logger: Logger,
): NoteMetadata[] => {
  const limit = Math.max(0, params.limit ?? 20)
  const escapedFolder = params.folder
    ? escapeLikeWildcards(stripTrailingSlashes(params.folder))
    : null
  const folderCondition = escapedFolder
    ? "AND n.path LIKE @folder || '/%' ESCAPE '\\'"
    : ""

  // Two branches handle different property shapes:
  // - Array properties (tags: ["a","b"]): check if @value is IN the array
  // - Scalar properties (status: "active"): check direct equality
  // Both branches CAST to TEXT for type-safe comparison (integer 4 = text "4")
  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes n
    WHERE (
      (json_type(n.properties, '$.' || @key) = 'array'
       AND EXISTS (
         SELECT 1 FROM json_each(json_extract(n.properties, '$.' || @key))
         WHERE CAST(value AS TEXT) = @value
       ))
      OR
      (json_type(n.properties, '$.' || @key) IS NOT NULL
       AND json_type(n.properties, '$.' || @key) != 'array'
       AND CAST(json_extract(n.properties, '$.' || @key) AS TEXT) = @value)
    )
    ${folderCondition}
    ORDER BY mtime DESC
    LIMIT @limit
  `

  const sqlParams: Record<string, unknown> = {
    key: params.key,
    value: params.value,
    limit,
  }
  if (escapedFolder) sqlParams.folder = escapedFolder

  const rows = context.db.prepare(sql).all(sqlParams) as NoteRow[]
  const results = rows.map(rowToMetadata)
  logger.info("search by property", {
    key: params.key,
    value: params.value,
    resultCount: results.length,
  })
  return results
}

// ── Link queries ───────────────────────────────────────────────

/** Returns notes that link TO the given path (incoming links / backlinks). */
export const getBacklinks = (
  context: SearchQueryContext,
  params: { path: string },
  logger: Logger,
): BacklinkEntry[] => {
  assertPathHasExtension(params.path, ".md")
  const sql = `
    SELECT n.path, n.title, n.bytes
    FROM links l
    JOIN notes n ON n.path = l.source
    WHERE l.target = ?
    ORDER BY n.title
  `
  const rows = context.db.prepare(sql).all(params.path) as Array<{
    path: string
    title: string
    bytes: number
  }>
  const results: BacklinkEntry[] = rows.map((row) => ({
    path: row.path,
    title: row.title,
    bytes: row.bytes ?? 0,
  }))
  logger.info("get backlinks", {
    path: params.path,
    count: results.length,
  })
  return results
}

/** Returns notes and assets that the given path links TO (outgoing links).
 *  Each entry carries a `kind` discriminator: "note" for .md targets,
 *  "asset" for resolved non-markdown files (.canvas, .base, images, etc.),
 *  defaulting to "note" for unresolved (broken) links. */
export const getOutgoingLinks = (
  context: SearchQueryContext,
  params: { path: string },
  logger: Logger,
): OutgoingLinkEntry[] => {
  assertPathHasExtension(params.path, ".md")
  // Left-join against both notes and non_md_files to classify each link target:
  // notes → kind "note", non_md_files → kind "asset", neither → broken (defaults to "note").
  const sql = `
    SELECT l.target as path,
           n.title,
           CASE WHEN n.path IS NOT NULL THEN 1
                WHEN f.path IS NOT NULL THEN 1
                ELSE 0 END as exists_flag,
           CASE WHEN n.path IS NOT NULL THEN 'note'
                WHEN f.path IS NOT NULL THEN 'asset'
                ELSE 'note' END as kind,
           n.bytes
    FROM links l
    LEFT JOIN notes n ON n.path = l.target
    LEFT JOIN non_md_files f ON f.path = l.target
    WHERE l.source = ?
    ORDER BY l.target
  `
  const rows = context.db.prepare(sql).all(params.path) as Array<{
    path: string
    title: string | null
    exists_flag: number
    kind: "note" | "asset"
    bytes: number | null
  }>
  const folder = context.getDailyNotesFolder()
  const folderPrefix = folder !== null ? `${folder}/` : null
  const results: OutgoingLinkEntry[] = rows.map((row) => ({
    path: row.path,
    title: row.title,
    exists: row.exists_flag === 1,
    kind: row.kind,
    bytes: row.bytes ?? null,
    daily_note_forward_ref:
      row.exists_flag === 0 &&
      folderPrefix !== null &&
      row.path.startsWith(folderPrefix),
  }))
  logger.info("get outgoing links", {
    path: params.path,
    count: results.length,
  })
  return results
}

/** Finds notes with no incoming links (orphans). */
export const findOrphans = (
  context: SearchQueryContext,
  params: { excludeFolders?: string[]; limit?: number },
  logger: Logger,
): NoteMetadata[] => {
  const excludeFolders = params.excludeFolders ?? []
  const limit = Math.max(0, params.limit ?? 50)

  // One exclusion clause per folder, each bound to a positional parameter
  const escapedExcludeFolders = excludeFolders.map((folder) =>
    escapeLikeWildcards(stripTrailingSlashes(folder)),
  )
  const folderExclusions = Array(escapedExcludeFolders.length)
    .fill("path NOT LIKE ? || '/%' ESCAPE '\\'")
    .join(" AND ")
  const whereClause =
    escapedExcludeFolders.length > 0 ? `AND ${folderExclusions}` : ""

  // Self-links (source = target) are excluded from the backlink subquery
  // so a note that only links to itself is still considered an orphan.
  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes
    WHERE path NOT IN (SELECT DISTINCT target FROM links WHERE source != target)
      ${whereClause}
    ORDER BY mtime DESC
    LIMIT ?
  `

  const rows = context.db
    .prepare(sql)
    .all(...escapedExcludeFolders, limit) as NoteRow[]
  const results = rows.map(rowToMetadata)
  logger.info("find orphans", { count: results.length })
  return results
}

// ── Aggregate queries ──────────────────────────────────────────

type BrokenLinkResult = {
  count: number
  excludedFolder: string | null
  excludedCount: number
}

/** Counts unique broken link targets — links whose targets exist in
 *  neither the notes table nor the non_md_files table. When a daily
 *  notes folder is configured, broken links under that folder are
 *  excluded — they are forward-references (intentional "create on
 *  click" navigation), not genuinely broken. Returns the count plus
 *  exclusion metadata so callers can communicate what was filtered. */
export const brokenLinkCount = (
  context: SearchQueryContext,
  _params: Record<string, never>,
  logger: Logger,
): BrokenLinkResult => {
  const folder = context.getDailyNotesFolder()

  if (folder === null) {
    const row = context.db
      .prepare(
        `SELECT COUNT(DISTINCT target) as count
         FROM links
         WHERE target NOT IN (SELECT path FROM notes)
           AND target NOT IN (SELECT path FROM non_md_files)`,
      )
      .get() as { count: number }
    logger.info("broken link count", { count: row.count })
    return { count: row.count, excludedFolder: null, excludedCount: 0 }
  }

  const folderPrefix = `${folder}/`
  const brokenTargets = context.db
    .prepare(
      `SELECT DISTINCT target
       FROM links
       WHERE target NOT IN (SELECT path FROM notes)
         AND target NOT IN (SELECT path FROM non_md_files)`,
    )
    .all() as Array<{ target: string }>

  const count = brokenTargets.filter(
    (row) => !row.target.startsWith(folderPrefix),
  ).length
  const excludedCount = brokenTargets.length - count

  logger.info("broken link count", {
    count,
    dailyNotesFolder: folder,
    excludedForwardRefs: excludedCount,
  })
  return { count, excludedFolder: folder, excludedCount }
}

/** Returns notes whose filesystem mtime falls within a calendar date
 *  (server-local day boundaries, governed by the TZ env var). */
export const modifiedOnDate = (
  context: SearchQueryContext,
  params: { date: string; limit?: number },
  logger: Logger,
): NoteMetadata[] => {
  const limit = Math.max(0, params.limit ?? 50)
  const dayStart = DateTime.fromISO(params.date)
  const dayEnd = dayStart.plus({ days: 1 })

  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes
    WHERE mtime >= ? AND mtime < ?
    ORDER BY mtime DESC
    LIMIT ?
  `
  const rows = context.db
    .prepare(sql)
    .all(dayStart.toMillis(), dayEnd.toMillis(), limit) as NoteRow[]
  const results = rows.map(rowToMetadata)
  logger.info("modified on date", {
    date: params.date,
    resultCount: results.length,
  })
  return results
}

/** Lightweight aggregate counts — total notes, untagged notes, notes without
 *  frontmatter properties. Single SQL to avoid multiple round-trips. */
export const vaultStats = (
  context: SearchQueryContext,
  _params: Record<string, never>,
  logger: Logger,
): VaultStats => {
  // Conditional aggregation: count all rows, then conditionally count rows
  // whose tags/properties are the empty-JSON sentinel set by upsertNote.
  const sql = `
    SELECT
      COUNT(*) as totalNotes,
      COALESCE(SUM(CASE WHEN tags = '[]' THEN 1 ELSE 0 END), 0) as untaggedNotes,
      COALESCE(SUM(CASE WHEN properties = '{}' THEN 1 ELSE 0 END), 0) as noPropertiesNotes
    FROM notes
  `
  const row = context.db.prepare(sql).get() as VaultStats
  logger.info("vault stats", row)
  return row
}
