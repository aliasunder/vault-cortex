// ── Query methods extracted from search-index.ts ──────────────

import type Database from "better-sqlite3"
import { DateTime } from "luxon"
import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import { sanitizeFtsQuery, sanitizeFtsQueryAnyTerm } from "./fts-query.js"
import { computeRrfScores } from "./rrf.js"
import { blendScores, sigmoid } from "./reranker.js"
import type { Reranker } from "./reranker.js"
import {
  rowToMetadata,
  rowToTaskEntry,
  noteRowToSearchResult,
  fileContentRowToSearchResult,
  noteMatchesSearchFilters,
  buildSnippetFromChunkText,
  escapeLikeWildcards,
  stripTrailingSlashes,
  dayToEpochMsRange,
} from "./search-helpers.js"
import type { FileContentFtsRow } from "./search-helpers.js"
import type {
  VectorHit,
  SearchResult,
  HybridSearchResult,
  MemoryRecallEntry,
  MemoryRecallResult,
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
  DateFilter,
  TaskPriorityFilter,
  TaskSortKey,
  ListTasksResult,
} from "./search-index.js"
import type { Embedder } from "./embedder.js"

// ── Context ────────────────────────────────────────────────────

type VectorHitRow = { note_path: string; chunk_text: string; distance: number }
type FileContentVectorHitRow = {
  file_path: string
  chunk_text: string
  distance: number
}

/** One memory_entries row — hydrated whole so recall never needs a second
 *  lookup per entry. */
export type MemoryEntryRow = {
  id: number
  file: string
  section: string
  entry_date: string
  entry_text: string
  entry_index: number
}

/** A memory-entry KNN hit: the full row plus its cosine distance. */
export type MemoryEntryVectorHitRow = MemoryEntryRow & { distance: number }

export type SearchQueryContext = {
  readonly db: Database.Database
  readonly vector: {
    readonly embedder: Embedder | undefined
    readonly knnSearchStmt: Database.Statement<unknown[], VectorHitRow> | null
    readonly selectNoteMetadataStmt: Database.Statement<[string], NoteRow>
  }
  readonly reranker: Reranker | undefined
  readonly selectFirstChunkStmt: Database.Statement<
    [string],
    { chunk_text: string }
  > | null
  /** Null when no memory dir is configured. knnStmt is additionally null
   *  without an embedder — recall degrades to its lexical leg. */
  readonly memory: {
    readonly embedder: Embedder | undefined
    readonly ftsSearchStmt: Database.Statement<[string], { entry_id: number }>
    readonly knnStmt: Database.Statement<
      unknown[],
      MemoryEntryVectorHitRow
    > | null
    readonly selectEntryByIdStmt: Database.Statement<[number], MemoryEntryRow>
  } | null
  /** Null when FILE_TOOLS_ENABLED is off — hybridSearch skips the file
   *  content FTS leg. */
  readonly fileContentFts: {
    readonly searchStmt: Database.Statement<
      [number, string, number],
      FileContentFtsRow
    >
  } | null
  /** Null when FILE_TOOLS_ENABLED or embedder is off — hybridSearch skips
   *  the file content vector leg. */
  readonly fileContentVector: {
    readonly knnSearchStmt: Database.Statement<
      unknown[],
      FileContentVectorHitRow
    >
    readonly selectFirstFileChunkStmt: Database.Statement<
      [string],
      { chunk_text: string }
    > | null
  } | null
  /** Metadata lookup for files found only via vector search (no FTS hit). */
  readonly selectFileContentMetadataStmt: Database.Statement<
    [string],
    FileContentMetadataRow
  > | null
}

type FileContentMetadataRow = {
  path: string
  title: string
  folder: string
  mtime: number
  bytes: number
}

/** Maps one search leg's results to the identifier shape computeRrfScores
 *  fuses on — path is the identity all four hybrid-search legs share. */
const toRankedList = (
  items: readonly { path: string }[],
): { identifier: string }[] => items.map((item) => ({ identifier: item.path }))

// ── Vector search (internal) ───────────────────────────────────

/** Embeds the query text and returns the Buffer for KNN queries. Null when
 *  no embedder is available or the embedding fails. */
const embedQuery = async (
  context: SearchQueryContext,
  query: string,
  logger: Logger,
): Promise<Buffer | null> => {
  const { embedder } = context.vector
  if (!embedder) return null
  try {
    const queryEmbedding = await embedder.embedText(query)
    return Buffer.from(
      queryEmbedding.buffer,
      queryEmbedding.byteOffset,
      queryEmbedding.byteLength,
    )
  } catch (error) {
    logger.warn("query embedding failed", { error: describeError(error) })
    return null
  }
}

const vectorSearch = (
  context: SearchQueryContext,
  params: { query: string; queryEmbeddingBuffer: Buffer; limit: number },
  logger: Logger,
): VectorHit[] => {
  const { knnSearchStmt } = context.vector
  if (!knnSearchStmt) return []

  try {
    const noteKnnRows = knnSearchStmt.all(
      params.queryEmbeddingBuffer,
      params.limit,
    )

    // Deduplicate to best chunk per note — rows are ordered by distance
    // ascending, so the first occurrence of each path is the closest match.
    const bestChunkPerNote = new Map<string, VectorHit>()
    for (const knnRow of noteKnnRows) {
      if (!bestChunkPerNote.has(knnRow.note_path)) {
        bestChunkPerNote.set(knnRow.note_path, {
          path: knnRow.note_path,
          distance: knnRow.distance,
          chunkText: knnRow.chunk_text,
        })
      }
    }

    logger.info("vector search", {
      query: params.query,
      knnHits: noteKnnRows.length,
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

/** KNN over file content vectors — returns the best-matching chunk per file
 *  for a pre-computed query embedding. Empty when file content vectors are
 *  disabled or the KNN query fails. */
const fileContentVectorSearch = (
  context: SearchQueryContext,
  params: { query: string; queryEmbeddingBuffer: Buffer; limit: number },
  logger: Logger,
): VectorHit[] => {
  const knnSearchStmt = context.fileContentVector?.knnSearchStmt
  if (!knnSearchStmt) return []

  try {
    const fileKnnRows = knnSearchStmt.all(
      params.queryEmbeddingBuffer,
      params.limit,
    )

    const bestChunkPerFile = new Map<string, VectorHit>()
    for (const knnRow of fileKnnRows) {
      if (!bestChunkPerFile.has(knnRow.file_path)) {
        bestChunkPerFile.set(knnRow.file_path, {
          path: knnRow.file_path,
          distance: knnRow.distance,
          chunkText: knnRow.chunk_text,
        })
      }
    }

    logger.info("file content vector search", {
      query: params.query,
      knnHits: fileKnnRows.length,
      uniqueFiles: bestChunkPerFile.size,
    })
    return [...bestChunkPerFile.values()]
  } catch (error) {
    logger.warn("file content vector search failed", {
      error: describeError(error),
    })
    return []
  }
}

// ── Full-text search ───────────────────────────────────────────

/** Rejects a malformed date filter bound with remediation text — shared by
 *  the note created/modified filters and the task date filters.
 *  `fromFormat` with `yyyy-MM-dd` pins both the format (no time component,
 *  no shorthand) and calendar correctness (2026-02-31 fails) in one call. */
const assertFilterDate = (value: string, filterName: string): void => {
  if (!DateTime.fromFormat(value, "yyyy-MM-dd").isValid) {
    throw new Error(
      `invalid ${filterName} date: "${value}". Use YYYY-MM-DD (e.g. 2026-07-03).`,
    )
  }
}

export const fullTextSearch = (
  context: SearchQueryContext,
  params: { query: string; filters?: SearchFilters | undefined },
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

  // created stores full ISO 8601 re-expressed in the server-local zone at
  // index time; its first 10 chars are the calendar day, compared
  // lexicographically against the YYYY-MM-DD bounds. Notes with NULL created
  // never match — SQL comparison with NULL is never true.
  if (params.filters?.created) {
    const { on, before, after } = params.filters.created
    if (on !== undefined) {
      assertFilterDate(on, "created.on")
      conditions.push("substr(n.created, 1, 10) = ?")
      queryParams.push(on)
    }
    if (before !== undefined) {
      assertFilterDate(before, "created.before")
      conditions.push("substr(n.created, 1, 10) < ?")
      queryParams.push(before)
    }
    if (after !== undefined) {
      assertFilterDate(after, "created.after")
      conditions.push("substr(n.created, 1, 10) > ?")
      queryParams.push(after)
    }
  }

  // mtime is epoch ms; each YYYY-MM-DD value converts to the epoch-ms window
  // that day covers in the server-local zone. Exclusive at day granularity:
  // before D matches strictly earlier days (mtime < startOf(D)), after D
  // strictly later days (mtime >= startOf(D+1)), on D matches within the day.
  if (params.filters?.modified) {
    const { on, before, after } = params.filters.modified
    if (on !== undefined) {
      assertFilterDate(on, "modified.on")
      const dayRange = dayToEpochMsRange(on)
      conditions.push("n.mtime >= ? AND n.mtime < ?")
      queryParams.push(dayRange.startMs, dayRange.endMs)
    }
    if (before !== undefined) {
      assertFilterDate(before, "modified.before")
      conditions.push("n.mtime < ?")
      queryParams.push(dayToEpochMsRange(before).startMs)
    }
    if (after !== undefined) {
      assertFilterDate(after, "modified.after")
      conditions.push("n.mtime >= ?")
      queryParams.push(dayToEpochMsRange(after).endMs)
    }
  }

  const limit = Math.max(0, Math.floor(params.filters?.limit ?? 20))
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
    const rows = context.db
      .prepare<
        unknown[],
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
      >(sql)
      .all(...queryParams)

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

// ── File content FTS (internal) ────────────────────────────────

/** Runs the file_content_fts query (canvas content, etc.) and applies the
 *  folder filter in TypeScript — returns [] when the feature is disabled. */
const runFileContentFts = (
  context: SearchQueryContext,
  query: string,
  snippetTokens: number,
  limit: number,
  folder?: string,
): FileContentFtsRow[] => {
  if (!context.fileContentFts) return []
  const sanitizedQuery = sanitizeFtsQuery(query)
  if (!sanitizedQuery) return []
  const results = context.fileContentFts.searchStmt.all(
    snippetTokens,
    sanitizedQuery,
    limit,
  )
  if (!folder) return results
  const normalizedFolder = stripTrailingSlashes(folder) + "/"
  return results.filter((row) => row.path.startsWith(normalizedFolder))
}

// ── Hybrid search ──────────────────────────────────────────────

/** Hybrid search — combines FTS5 keyword search with sqlite-vec vector
 *  similarity via RRF fusion. Falls back to FTS-only silently when no
 *  embeddings are available. */
export const hybridSearch = async (
  context: SearchQueryContext,
  params: { query: string; filters?: SearchFilters | undefined },
  logger: Logger,
): Promise<HybridSearchResult> => {
  const userLimit = Math.max(0, Math.floor(params.filters?.limit ?? 20))
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

  // Skip file content search when note-specific filters are active —
  // canvas files have no tags, type, related, properties, or created date,
  // and runFileContentFts only applies folder filtering (not modified date),
  // so any of these six filters would be bypassed by file content results.
  const hasNoteSpecificFilters = Boolean(
    params.filters?.tags ||
    params.filters?.type ||
    params.filters?.related ||
    params.filters?.properties ||
    params.filters?.created ||
    params.filters?.modified,
  )
  const fileContentResults = hasNoteSpecificFilters
    ? []
    : runFileContentFts(
        context,
        params.query,
        snippetTokens,
        candidateLimit,
        params.filters?.folder,
      )

  // Embed the query once — shared by note and file content vector searches
  const queryEmbeddingBuffer = await embedQuery(context, params.query, logger)

  // Attempt vector search — returns [] when embedding or KNN is unavailable
  const vectorHits = queryEmbeddingBuffer
    ? vectorSearch(
        context,
        { query: params.query, queryEmbeddingBuffer, limit: candidateLimit },
        logger,
      )
    : []

  // File content vector search — same skip condition as file content FTS
  const fileContentVectorHits =
    hasNoteSpecificFilters || !queryEmbeddingBuffer
      ? []
      : fileContentVectorSearch(
          context,
          { query: params.query, queryEmbeddingBuffer, limit: candidateLimit },
          logger,
        )

  const hasAnyVectorHits =
    vectorHits.length > 0 || fileContentVectorHits.length > 0

  // FTS-only fallback when no vectors are available from either source
  if (!hasAnyVectorHits) {
    if (fileContentResults.length === 0) {
      const fallbackResults = ftsResults.slice(0, userLimit)
      logger.info("hybrid search", {
        query: params.query,
        searchMode: "fts",
        resultCount: fallbackResults.length,
      })
      return { results: fallbackResults, search_mode: "fts", reranked: false }
    }
    // Merge note FTS + file content FTS via 2-list RRF
    const fallbackRrf = computeRrfScores({
      rankedLists: [toRankedList(ftsResults), toRankedList(fileContentResults)],
    })
    const ftsResultsByPath = new Map(
      ftsResults.map((result) => [result.path, result]),
    )
    const fileContentByPath = new Map(
      fileContentResults.map((result) => [result.path, result]),
    )
    const fallbackMerged: SearchResult[] = []
    for (const { identifier: path, score } of fallbackRrf) {
      const noteFts = ftsResultsByPath.get(path)
      if (noteFts) {
        fallbackMerged.push({ ...noteFts, score })
        continue
      }
      const fileResult = fileContentByPath.get(path)
      if (fileResult) {
        fallbackMerged.push(fileContentRowToSearchResult(fileResult, score))
      }
    }
    const fallbackSliced = fallbackMerged.slice(0, userLimit)
    logger.info("hybrid search", {
      query: params.query,
      searchMode: "fts",
      resultCount: fallbackSliced.length,
      fileContentResults: fileContentResults.length,
    })
    return { results: fallbackSliced, search_mode: "fts", reranked: false }
  }

  // Compute RRF scores from all four ranked lists — an empty list
  // contributes no scores, so each leg is passed unconditionally
  const rankedLists = [
    toRankedList(ftsResults),
    toRankedList(vectorHits),
    toRankedList(fileContentResults),
    toRankedList(fileContentVectorHits),
  ]
  const rrfScores = computeRrfScores({ rankedLists })

  // Index all result sources by path for O(1) lookup
  const ftsResultsByPath = new Map(
    ftsResults.map((result) => [result.path, result]),
  )
  const vectorHitsByPath = new Map(vectorHits.map((hit) => [hit.path, hit]))
  const fileContentByPath = new Map(
    fileContentResults.map((result) => [result.path, result]),
  )
  const fileContentVectorHitsByPath = new Map(
    fileContentVectorHits.map((hit) => [hit.path, hit]),
  )

  // Build the merged result set, ordered by RRF score
  const mergedResults: SearchResult[] = []
  for (const { identifier: path, score } of rrfScores) {
    const ftsResult = ftsResultsByPath.get(path)
    if (ftsResult) {
      mergedResults.push({ ...ftsResult, score })
      continue
    }

    // Check file content FTS results
    const fileResult = fileContentByPath.get(path)
    if (fileResult) {
      mergedResults.push(fileContentRowToSearchResult(fileResult, score))
      continue
    }

    // Note vector-only result — look up metadata from the notes table
    const noteRow = context.vector.selectNoteMetadataStmt.get(path)
    if (noteRow) {
      if (
        params.filters &&
        !noteMatchesSearchFilters(noteRow, params.filters)
      ) {
        continue
      }

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
      continue
    }

    // File content vector-only result — look up metadata from file_content
    const fileVectorHit = fileContentVectorHitsByPath.get(path)
    if (fileVectorHit && context.selectFileContentMetadataStmt) {
      const fileMetadata = context.selectFileContentMetadataStmt.get(path)
      if (!fileMetadata) continue

      // Apply folder filter — file content FTS applies it via SQL, but
      // vector-only results bypass FTS and need the check here. Uses a
      // segment boundary (folder + "/") so "Docs" doesn't match "Documents".
      if (params.filters?.folder) {
        const folderPrefix = stripTrailingSlashes(params.filters.folder) + "/"
        const folderMatch =
          fileMetadata.folder === stripTrailingSlashes(params.filters.folder) ||
          (fileMetadata.folder + "/").startsWith(folderPrefix)
        if (!folderMatch) continue
      }

      mergedResults.push(
        fileContentRowToSearchResult(
          {
            ...fileMetadata,
            snippet: buildSnippetFromChunkText(
              fileVectorHit.chunkText,
              snippetTokens,
            ),
          },
          score,
        ),
      )
    }
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
          fileContentVectorHitsByPath,
          selectFirstChunkStmt: context.selectFirstChunkStmt,
          selectFirstFileChunkStmt:
            context.fileContentVector?.selectFirstFileChunkStmt ?? null,
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
    fileContentVectorHits: fileContentVectorHits.length,
    fileContentResults: fileContentResults.length,
    mergedResults: mergedResults.length,
    returnedResults: Math.min(finalResults.length, userLimit),
  })
  return {
    results: finalResults.slice(0, userLimit),
    search_mode: "hybrid",
    reranked,
  }
}

// ── Memory recall ──────────────────────────────────────────────

/** Vector-leg candidate count. ≈30% of today's ~350-entry corpus — an arc
 *  member outside its own topic's top 100 with zero lexical overlap is, for
 *  practical purposes, unrelated text, and the cross-encoder can't rescue
 *  what it never scores. sqlite-vec brute-forces this in ~1ms at this size. */
const MEMORY_VECTOR_CANDIDATE_LIMIT = 100

/** Latency safety valve on the cross-encoder pass (~10ms/pair, so ~1–2s at
 *  the cap). Lexical hits are never the ones cut — only the lowest-fused
 *  vector-only candidates fall off. */
const MEMORY_RERANK_CANDIDATE_LIMIT = 120

/** Hard lower bound on the adaptive relevance floor — sigmoid(-6.9).
 *  Blocks genuinely irrelevant content even when a vague query produces
 *  universally low cross-encoder scores. Without it, a query whose best
 *  probability is 0.0003 would set the floor at 0.00003, letting noise
 *  through. */
const MEMORY_RECALL_SANITY_FLOOR = 0.001

/** Maximum value the adaptive floor can take — caps the floor so
 *  high-confidence queries (best probability near 1.0) don't push it above
 *  the absolute cut that already works for strong-signal queries. */
const MEMORY_RECALL_MAX_FLOOR = 0.05

/** Relative margin: keep an entry scoring at least this fraction of the
 *  best non-ftsHit probability. 0.1 (10%) tracks the empirical cluster
 *  gap: on "how I like agents to communicate with me", genuine entries
 *  score 0.03–0.30 while irrelevant content scores < 0.001 — a 10:1
 *  ratio cleanly separates the two. */
const MEMORY_RECALL_RELATIVE_RATIO = 0.1

/** Fallback cut when no reranker is available: keep vector hits within this
 *  cosine distance of the best hit. On-topic bge distances cluster within
 *  ~0.10–0.25 of the best match; known weaker on drifted-vocabulary origins
 *  (a bi-encoder can't distinguish paraphrase from different-topic), which
 *  is the documented cost of running without the reranker. */
const MEMORY_RECALL_DISTANCE_MARGIN = 0.15

/** Default max_results — ≈15% of today's corpus (~2.5k tokens), comfortably
 *  holding any realistic evolution arc. */
const DEFAULT_MEMORY_RECALL_LIMIT = 50

/** One recall candidate: the hydrated row, how it was found, and its scores.
 *  ftsHit entries survive every cut — a lexical match on a short entry is
 *  near-proof of relevance (the cross-encoder can't know a distinctive term
 *  like a project name is what the query is about). */
type MemoryRecallCandidate = {
  row: MemoryEntryRow
  ftsHit: boolean
  fusedScore: number
  distance: number | undefined
}

/** KNN over memory-entry vectors — mirrors vectorSearch's contract: any
 *  failure (model load, embed error) returns [] so recall degrades to its
 *  lexical leg instead of failing the call. */
const memoryVectorSearch = async (
  memory: NonNullable<SearchQueryContext["memory"]>,
  query: string,
  logger: Logger,
): Promise<MemoryEntryVectorHitRow[]> => {
  if (!memory.embedder || !memory.knnStmt) return []
  try {
    const queryEmbedding = await memory.embedder.embedText(query)
    return memory.knnStmt.all(
      Buffer.from(
        queryEmbedding.buffer,
        queryEmbedding.byteOffset,
        queryEmbedding.byteLength,
      ),
      MEMORY_VECTOR_CANDIDATE_LIMIT,
    )
  } catch (error) {
    logger.warn("memory vector search failed, falling back to lexical-only", {
      error: describeError(error),
    })
    return []
  }
}

/** Relaxed lexical leg for the zero-result exits: any-term (OR) FTS over the
 *  entry index, bm25-ordered best-first. Rescue rows carry ftsHit: false — an
 *  any-term hit on a ubiquitous token ("on") is not an anchor and never earns
 *  the always-survive guarantee; these candidates bypass the relevance cuts
 *  only because they are the last resort before an empty result. */
const anyTermLexicalCandidates = (
  memory: NonNullable<SearchQueryContext["memory"]>,
  query: string,
  matchesFileFilter: (row: MemoryEntryRow) => boolean,
): MemoryRecallCandidate[] =>
  memory.ftsSearchStmt
    .all(sanitizeFtsQueryAnyTerm(query))
    .map((row) => memory.selectEntryByIdStmt.get(row.entry_id))
    .filter((row): row is MemoryEntryRow => row !== undefined)
    .filter(matchesFileFilter)
    .map((row, ftsRank) => ({
      row,
      ftsHit: false,
      fusedScore: -ftsRank,
      distance: undefined,
    }))

/** Attempts cross-encoder reranking of memory recall candidates. Returns the
 *  kept candidates and a relevance scorer, or null on failure — the caller
 *  falls back to the distance-margin cut. Logs adaptive floor diagnostics
 *  (bestProbability, effectiveFloor) so the caller doesn't need them. */
const tryRerankMemoryCandidates = async (
  reranker: Reranker,
  query: string,
  candidates: readonly MemoryRecallCandidate[],
  logger: Logger,
): Promise<{
  kept: MemoryRecallCandidate[]
  relevance: (candidate: MemoryRecallCandidate) => number
} | null> => {
  try {
    const rerankScores = await reranker.rerankPairs(
      query,
      candidates.map(
        (candidate) =>
          `${candidate.row.file} > ${candidate.row.section}\n${candidate.row.entry_text}`,
      ),
    )
    // Convert raw reranker scores to probabilities (0–1) via sigmoid —
    // raw scores are unbounded (-10 to +10 typical); sigmoid maps them to
    // a 0–1 scale where the adaptive floor comparisons work.
    const probabilityByEntryId = new Map<number, number>(
      candidates.flatMap((candidate, candidateIndex) => {
        const score = rerankScores[candidateIndex]
        return score === undefined
          ? []
          : [[candidate.row.id, sigmoid(score)] as const]
      }),
    )

    const probabilityOf = (candidate: MemoryRecallCandidate): number =>
      probabilityByEntryId.get(candidate.row.id) ?? 0

    // Adaptive floor: FTS hits always survive (lexical match = strong
    // evidence), so the floor only governs vector-only candidates. Find
    // the best score among those, then scale it down — entries within
    // 10% of the best are relevant enough to keep. Clamp the result
    // between 0.001 (block noise) and 0.05 (don't exceed what already
    // works for strong queries).
    const vectorOnlyCandidates = candidates.filter(
      (candidate) => !candidate.ftsHit,
    )
    const bestProbability =
      vectorOnlyCandidates.length > 0
        ? Math.max(...vectorOnlyCandidates.map(probabilityOf))
        : MEMORY_RECALL_MAX_FLOOR
    const scaledFloor = bestProbability * MEMORY_RECALL_RELATIVE_RATIO
    const effectiveFloor = Math.min(
      MEMORY_RECALL_MAX_FLOOR,
      Math.max(MEMORY_RECALL_SANITY_FLOOR, scaledFloor),
    )

    const kept = candidates.filter(
      (candidate) =>
        candidate.ftsHit || probabilityOf(candidate) >= effectiveFloor,
    )

    logger.info("memory recall rerank", { bestProbability, effectiveFloor })

    return {
      kept,
      // Missing probability (a scores/candidates length mismatch that cannot
      // normally happen) sorts as least relevant, not as an error.
      relevance: (candidate) => probabilityByEntryId.get(candidate.row.id) ?? 0,
    }
  } catch (error) {
    logger.warn("memory recall rerank failed, using distance margin", {
      error: describeError(error),
    })
    return null
  }
}

/** Ascending chronological order for the final evidence set: lexicographic
 *  ISO date (chronological for YYYY-MM-DD), then file and document position
 *  for same-date determinism — same-date entries have no knowable order. */
const compareMemoryEntriesChronologically = (
  a: MemoryEntryRow,
  b: MemoryEntryRow,
): number =>
  a.entry_date.localeCompare(b.entry_date) ||
  a.file.localeCompare(b.file) ||
  a.entry_index - b.entry_index

const memoryEntryRowToWireEntry = (row: MemoryEntryRow): MemoryRecallEntry => ({
  file: row.file,
  section: row.section,
  date: row.entry_date,
  text: row.entry_text,
})

/** Orders kept candidates most-relevant-first, truncates to maxResults, and
 *  sorts the survivors chronologically. Selection is relevance-based but
 *  output is chronological — truncation must drop the LEAST-RELEVANT
 *  entries, never a date end: cutting oldest silently destroys arc origins,
 *  cutting newest destroys current state, and both do it invisibly. */
const buildMemoryRecallResult = (
  keptCandidates: readonly MemoryRecallCandidate[],
  relevance: (candidate: MemoryRecallCandidate) => number,
  maxResults: number,
  searchMode: "hybrid" | "fts",
  reranked: boolean,
): MemoryRecallResult => {
  const byRelevanceDescending = [...keptCandidates].sort(
    (a, b) => relevance(b) - relevance(a),
  )
  const survivors = byRelevanceDescending.slice(0, maxResults)
  const entries = survivors
    .map((candidate) => candidate.row)
    .sort(compareMemoryEntriesChronologically)
    .map(memoryEntryRowToWireEntry)
  return {
    entries,
    total: keptCandidates.length,
    truncated: keptCandidates.length > entries.length,
    search_mode: searchMode,
    reranked,
  }
}

/**
 * Entry-granular hybrid recall over the memory layer — the evidence set
 * behind vault_memory_recall.
 *
 * Pipeline: lexical (FTS5) + vector (KNN) → RRF fusion → rerank or
 * distance-margin cut → chronological output. Lexical hits always survive
 * the cut. Truncation drops the least relevant entries, never a date end.
 * A result that would otherwise be empty degrades to any-term (OR) keyword
 * matching before giving up — an empty rescue stays empty.
 */
export const memoryRecall = async (
  context: SearchQueryContext,
  params: {
    query: string
    file?: string | undefined
    maxResults?: number | undefined
  },
  logger: Logger,
): Promise<MemoryRecallResult> => {
  const memory = context.memory
  if (memory === null) {
    throw new Error(
      "memory recall is not available: the memory layer is disabled (MEMORY_ENABLED=false)",
    )
  }
  const maxResults = Math.max(
    1,
    Math.floor(params.maxResults ?? DEFAULT_MEMORY_RECALL_LIMIT),
  )
  const matchesFileFilter = (row: MemoryEntryRow): boolean =>
    params.file === undefined || row.file === params.file

  // Lexical leg: ALL matches, no limit — implicit AND keeps multi-word
  // queries tight, and a lexical hit on a short entry is strong evidence.
  const ftsRows = memory.ftsSearchStmt
    .all(sanitizeFtsQuery(params.query))
    .map((row) => memory.selectEntryByIdStmt.get(row.entry_id))
    .filter((row): row is MemoryEntryRow => row !== undefined)
    .filter(matchesFileFilter)

  // Vector leg: generous KNN, file-filtered after the join (over-fetch is
  // safe at this corpus size; vec0 post-MATCH WHERE semantics are not).
  const vectorRows = (
    await memoryVectorSearch(memory, params.query, logger)
  ).filter(matchesFileFilter)

  // No vectors available — keep every lexical match, FTS-rank ordered. When
  // the all-terms leg is empty, degrade to any-term matching before returning
  // empty. (A single-token query re-runs identically and still finds nothing
  // — one redundant FTS query on an already-empty path.)
  if (vectorRows.length === 0) {
    const allTermsCandidates = ftsRows.map((row, ftsRank) => ({
      row,
      ftsHit: true,
      fusedScore: -ftsRank,
      distance: undefined,
    }))
    const lexicalCandidates =
      allTermsCandidates.length > 0
        ? allTermsCandidates
        : anyTermLexicalCandidates(memory, params.query, matchesFileFilter)
    const anyTermRescueUsed =
      allTermsCandidates.length === 0 && lexicalCandidates.length > 0
    const result = buildMemoryRecallResult(
      lexicalCandidates,
      (candidate) => candidate.fusedScore,
      maxResults,
      "fts",
      false,
    )
    logger.info("memory recall", {
      query: params.query,
      searchMode: "fts",
      reranked: false,
      ftsHits: ftsRows.length,
      vectorHits: 0,
      matched: result.total,
      returned: result.entries.length,
      ...(anyTermRescueUsed ? { anyTermRescue: true } : {}),
    })
    return result
  }

  // RRF fusion: dedupes by entry id, orders most-agreed-first.
  const fusedScores = computeRrfScores({
    rankedLists: [
      ftsRows.map((row) => ({ identifier: String(row.id) })),
      vectorRows.map((row) => ({ identifier: String(row.id) })),
    ],
  })
  const rowsById = new Map<string, MemoryEntryRow>([
    ...ftsRows.map((row): [string, MemoryEntryRow] => [String(row.id), row]),
    ...vectorRows.map((row): [string, MemoryEntryRow] => [String(row.id), row]),
  ])
  const distancesById = new Map(
    vectorRows.map((row) => [String(row.id), row.distance]),
  )
  const ftsIds = new Set(ftsRows.map((row) => String(row.id)))

  // Lexical hits always pass; only the lowest-fused vector-only candidates
  // fall off once the rerank window cap is reached.
  const candidates: MemoryRecallCandidate[] = []
  for (const { identifier: entryId, score } of fusedScores) {
    const row = rowsById.get(entryId)
    if (!row) continue
    const ftsHit = ftsIds.has(entryId)
    if (!ftsHit && candidates.length >= MEMORY_RERANK_CANDIDATE_LIMIT) continue
    candidates.push({
      row,
      ftsHit,
      fusedScore: score,
      distance: distancesById.get(entryId),
    })
  }

  const logHybridResult = (
    result: MemoryRecallResult,
    anyTermRescue = false,
  ) => {
    logger.info("memory recall", {
      query: params.query,
      searchMode: result.search_mode,
      reranked: result.reranked,
      ftsHits: ftsRows.length,
      vectorHits: vectorRows.length,
      matched: result.total,
      returned: result.entries.length,
      ...(anyTermRescue ? { anyTermRescue: true } : {}),
    })
  }

  // Primary cut: cross-encoder relevance floor (keeps drifted-vocabulary
  // arc origins that cosine distance would lose).
  const rerankOutcome = context.reranker
    ? await tryRerankMemoryCandidates(
        context.reranker,
        params.query,
        candidates,
        logger,
      )
    : null

  if (rerankOutcome) {
    // Zero-anchor hole: an empty keep-set implies the all-terms lexical leg
    // was empty (a lexical hit always survives the cut) and the cross-encoder
    // rejected every vector candidate — typical of meta-phrased queries
    // ("opinions on testing"). Degrade to any-term keyword matching rather
    // than returning nothing; an empty rescue keeps today's exact empty shape.
    const rescueCandidates =
      rerankOutcome.kept.length === 0
        ? anyTermLexicalCandidates(memory, params.query, matchesFileFilter)
        : []
    if (rescueCandidates.length > 0) {
      const result = buildMemoryRecallResult(
        rescueCandidates,
        (candidate) => candidate.fusedScore,
        maxResults,
        "fts",
        false,
      )
      logHybridResult(result, true)
      return result
    }
    const result = buildMemoryRecallResult(
      rerankOutcome.kept,
      rerankOutcome.relevance,
      maxResults,
      "hybrid",
      true,
    )
    logHybridResult(result)
    return result
  }

  // Fallback: distance margin off the best vector hit.
  const keepableDistance =
    Math.min(...distancesById.values()) + MEMORY_RECALL_DISTANCE_MARGIN
  const marginCutCandidates = candidates.filter(
    (candidate) =>
      candidate.ftsHit ||
      (candidate.distance !== undefined &&
        candidate.distance <= keepableDistance),
  )
  const result = buildMemoryRecallResult(
    marginCutCandidates,
    (candidate) => candidate.fusedScore,
    maxResults,
    "hybrid",
    false,
  )
  logHybridResult(result)
  return result
}

// ── Reranking helper ──────────────────────────────────────────

/** Attempts cross-encoder reranking with position-aware blending.
 *  Returns null on failure — the caller falls back to RRF-only ordering. */
const tryRerank = async (params: {
  reranker: Reranker
  query: string
  mergedResults: readonly SearchResult[]
  vectorHitsByPath: ReadonlyMap<string, VectorHit>
  fileContentVectorHitsByPath: ReadonlyMap<string, VectorHit>
  selectFirstChunkStmt: Database.Statement<
    [string],
    { chunk_text: string }
  > | null
  selectFirstFileChunkStmt: Database.Statement<
    [string],
    { chunk_text: string }
  > | null
  logger: Logger
}): Promise<{ results: SearchResult[] } | null> => {
  try {
    // Collect document text for each candidate — cascade through sources
    const documentTexts = params.mergedResults.map((result) => {
      // Prefer note vector chunk text (best semantic match for this note)
      const vectorHit = params.vectorHitsByPath.get(result.path)
      if (vectorHit) return vectorHit.chunkText

      // File content vector chunk text
      const fileVectorHit = params.fileContentVectorHitsByPath.get(result.path)
      if (fileVectorHit) return fileVectorHit.chunkText

      // FTS-only note: use chunk index 0 (title + intro) from note_chunks
      if (params.selectFirstChunkStmt) {
        const chunkRow = params.selectFirstChunkStmt.get(result.path)
        if (chunkRow) return chunkRow.chunk_text
      }

      // FTS-only file: use chunk index 0 from file_content_chunks
      if (params.selectFirstFileChunkStmt) {
        const fileChunkRow = params.selectFirstFileChunkStmt.get(result.path)
        if (fileChunkRow) return fileChunkRow.chunk_text
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

    const scoredResults = params.mergedResults.map((result, index) => {
      const score = blendedScores[index]
      if (score === undefined) {
        throw new Error(`blended score missing at index ${index}`)
      }
      return { ...result, score }
    })

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
  params: {
    tag: string
    exactMatch?: boolean | undefined
    limit?: number | undefined
  },
  logger: Logger,
): NoteMetadata[] => {
  const limit = Math.max(0, Math.floor(params.limit ?? 20))

  const condition = params.exactMatch
    ? "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)"
    : "EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ? OR value LIKE ? || '/%' ESCAPE '\\')"

  const queryParams: unknown[] = params.exactMatch
    ? [params.tag, limit]
    : [params.tag, escapeLikeWildcards(params.tag), limit]

  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes n
    WHERE ${condition}
    ORDER BY mtime DESC
    LIMIT ?
  `

  const rows = context.db.prepare<unknown[], NoteRow>(sql).all(...queryParams)
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
  params: {
    folder: string
    recursive?: boolean | undefined
    limit?: number | undefined
  },
  logger: Logger,
): NoteMetadata[] => {
  const recursive = params.recursive ?? true
  const limit = Math.max(0, Math.floor(params.limit ?? 20))

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

  const rows = context.db.prepare<unknown[], NoteRow>(sql).all(...queryParams)
  const results = rows.map(rowToMetadata)
  logger.info("search by folder", {
    folder: params.folder,
    resultCount: results.length,
  })
  return results
}

// ── Task listing ───────────────────────────────────────────────

/** Date cascade priority — when the primary sort date is NULL, fall through
 *  to the next most-actionable date so dateless tasks still sort meaningfully
 *  instead of landing in arbitrary file-path order. Each date key cascades
 *  through the remaining columns in urgency order (due → scheduled → start →
 *  created), then note mtime as a final recency tiebreaker before file
 *  position. `done` and `cancelled` are terminal-state dates that don't
 *  cascade — they stand alone with an mtime tiebreaker. */
const DATE_CASCADE: Record<string, readonly string[]> = {
  due: ["scheduled", "start", "created"],
  scheduled: ["due", "start", "created"],
  start: ["due", "scheduled", "created"],
  created: ["due", "scheduled", "start"],
}

const toSqlDirection = (
  direction: "asc" | "desc" | undefined,
): "ASC" | "DESC" | undefined =>
  direction === undefined ? undefined : direction === "desc" ? "DESC" : "ASC"

/** Builds a cascaded ORDER BY for a date sort key: primary date column, then
 *  each fallback date column (all with NULL-last), then note mtime descending
 *  as a recency tiebreaker for fully dateless tasks.
 *
 *  When explicitDirection is provided the caller asked for a uniform direction
 *  — every column sorts that way. When undefined each column uses its own
 *  natural default so the cascade doesn't force ASC-defaulting fields onto
 *  DESC-defaulting fallbacks (or vice-versa). */
const buildDateOrderBy = (
  column: string,
  explicitDirection: "ASC" | "DESC" | undefined,
): string => {
  const directionFor = (col: string): "ASC" | "DESC" =>
    explicitDirection ?? (DESCENDING_BY_DEFAULT.has(col) ? "DESC" : "ASC")

  const cascade = DATE_CASCADE[column]
  const primary = `t.${column} IS NULL, t.${column} ${directionFor(column)}`
  if (cascade === undefined) {
    return `${primary}, n.mtime DESC`
  }
  const fallbacks = cascade
    .map((col) => `t.${col} IS NULL, t.${col} ${directionFor(col)}`)
    .join(", ")
  return `${primary}, ${fallbacks}, n.mtime DESC`
}

/** Sort keys that default to descending — "most recent first" is the natural
 *  view for "what did I start/create/finish lately?". The remaining keys
 *  ("due", "scheduled") default ascending — soonest deadline first (overdue
 *  triage). "priority" also defaults ascending (highest priority first). */
const DESCENDING_BY_DEFAULT: ReadonlySet<string> = new Set([
  "start",
  "created",
  "done",
  "note_mtime",
])

/** ORDER BY fragment per sort key. Values are trusted SQL assembled from the
 *  whitelisted TaskSortKey union — never raw user input. Date keys cascade
 *  through related date columns so dateless tasks sort by the next available
 *  date rather than falling to arbitrary file-path order; when direction is
 *  omitted each cascade column uses its own default so the primary field's
 *  direction doesn't bleed into unrelated fallbacks. Priority maps levels
 *  to the plugin's numeric order (highest=0 … lowest=5, none=3 between medium
 *  and low, the ELSE arm since none is stored as NULL). Position sorts by file
 *  path then line number — the natural order for Kanban boards. */
const TASK_ORDER_BY: Record<
  TaskSortKey,
  (explicitDirection: "ASC" | "DESC" | undefined) => string
> = {
  due: (direction) => buildDateOrderBy("due", direction),
  scheduled: (direction) => buildDateOrderBy("scheduled", direction),
  start: (direction) => buildDateOrderBy("start", direction),
  created: (direction) => buildDateOrderBy("created", direction),
  done: (direction) => buildDateOrderBy("done", direction),
  priority: (direction) =>
    `CASE t.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 3 END ${direction ?? "ASC"}`,
  note_mtime: (direction) => `n.mtime ${direction ?? "DESC"}`,
  position: (direction) => {
    const sortDirection = direction ?? "ASC"
    return `n.path ${sortDirection}, t.line ${sortDirection}`
  },
}

/** Lists indexed tasks with structured filters and sorting. All filters
 *  AND-combine; the default view is actionable work (not_done = todo +
 *  in_progress), sorted overdue-first (due ascending, dateless last).
 *  Returns the total match count alongside the limited page so callers can
 *  tell "50 of 338" from "all 50". */
export const listTasks = (
  context: SearchQueryContext,
  params: {
    status?: TaskStatusFilter | TaskStatusFilter[] | undefined
    due?: DateFilter | undefined
    scheduled?: DateFilter | undefined
    start?: DateFilter | undefined
    done?: DateFilter | undefined
    created?: DateFilter | undefined
    cancelled?: DateFilter | undefined
    priority?: TaskPriorityFilter[] | undefined
    folder?: string | undefined
    tag?: string | undefined
    heading?: string | string[] | undefined
    path?: string | undefined
    limit?: number | undefined
    sortBy?: TaskSortKey | undefined
    sortDirection?: "asc" | "desc" | undefined
  },
  logger: Logger,
): ListTasksResult => {
  const conditions: string[] = []
  const queryParams: unknown[] = []

  // Normalize status to concrete DB values (todo/in_progress/done/cancelled),
  // expanding virtual values: not_done → todo + in_progress, all → skip the filter.
  const statusInput = params.status ?? "not_done"
  const statusValues = Array.isArray(statusInput) ? statusInput : [statusInput]
  const CONCRETE_STATUSES = [
    "todo",
    "in_progress",
    "done",
    "cancelled",
  ] as const
  // Expand virtual values to concrete DB statuses, then deduplicate so
  // ["not_done", "todo"] doesn't double-bind "todo" in the IN clause.
  const statusValuesWithExpansions = statusValues.flatMap((value) => {
    if (value === "all") return [...CONCRETE_STATUSES]
    if (value === "not_done") return ["todo", "in_progress"] as const
    return [value]
  })
  const expandedStatusValues = [...new Set(statusValuesWithExpansions)]
  const coversAllStatuses = CONCRETE_STATUSES.every((status) =>
    expandedStatusValues.includes(status),
  )
  const needsStatusFilter =
    expandedStatusValues.length > 0 && !coversAllStatuses
  if (needsStatusFilter) {
    conditions.push(
      `t.status IN (${expandedStatusValues.map(() => "?").join(", ")})`,
    )
    queryParams.push(...expandedStatusValues)
  }

  // A date filter only ever matches tasks that HAVE that date — SQL comparison
  // with NULL is never true, so undated tasks drop out automatically.
  const dateFilters: ReadonlyArray<{
    column: "due" | "scheduled" | "start" | "done" | "created" | "cancelled"
    filter: DateFilter | undefined
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
      assertFilterDate(filter.on, `${column}.on`)
      conditions.push(`t.${column} = ?`)
      queryParams.push(filter.on)
    }
    if (filter.before !== undefined) {
      assertFilterDate(filter.before, `${column}.before`)
      conditions.push(`t.${column} < ?`)
      queryParams.push(filter.before)
    }
    if (filter.after !== undefined) {
      assertFilterDate(filter.after, `${column}.after`)
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
      "EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ? OR value LIKE ? || '/%' ESCAPE '\\')",
    )
    queryParams.push(params.tag, escapeLikeWildcards(params.tag))
  }

  if (params.heading !== undefined) {
    const headings = Array.isArray(params.heading)
      ? params.heading
      : [params.heading]
    if (headings.length > 0) {
      conditions.push(`t.heading IN (${headings.map(() => "?").join(", ")})`)
      queryParams.push(...headings)
    }
  }

  if (params.path !== undefined) {
    assertPathHasExtension(params.path, ".md")
    conditions.push("t.note_path = ?")
    queryParams.push(params.path)
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const sortBy = params.sortBy ?? "due"
  const explicitDirection = toSqlDirection(params.sortDirection)
  const orderBy = TASK_ORDER_BY[sortBy](explicitDirection)

  // Math.floor: SQLite rejects a non-integer LIMIT binding with a cryptic
  // "datatype mismatch" error, so a fractional limit is floored instead.
  const limit = Math.max(0, Math.floor(params.limit ?? 50))

  const countRow = context.db
    .prepare<unknown[], { total: number }>(
      `SELECT COUNT(*) as total FROM tasks t JOIN notes n ON n.path = t.note_path ${whereClause}`,
    )
    .get(...queryParams)
  const total = countRow === undefined ? 0 : countRow.total

  // Kanban detection: notes with kanban-plugin in frontmatter are Kanban boards,
  // so their tasks need lane moves (not checkbox toggles) to complete.
  const sql = `
    SELECT t.note_path, t.line, t.status_char, t.status, t.description,
           t.created, t.scheduled, t.start, t.due, t.done, t.cancelled,
           t.priority, t.recurrence, t.on_completion, t.task_id, t.depends_on,
           t.tags, t.block_id, t.heading, t.folder,
           CASE WHEN json_extract(n.properties, '$.kanban-plugin') IS NOT NULL
                THEN 1 ELSE 0 END AS is_kanban_task,
           n.kanban_done_lanes
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
    status: statusInput,
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
  const results = context.db.prepare<unknown[], TagCount>(sql).all()
  logger.info("listed all tags", { count: results.length })
  return results
}

/** Returns recently modified or created notes, sorted by chosen timestamp. */
export const recentNotes = (
  context: SearchQueryContext,
  params: {
    sort_by?: "created" | "modified" | undefined
    limit?: number | undefined
  },
  logger: Logger,
): NoteMetadata[] => {
  const sortBy = params.sort_by ?? "modified"
  const limit = Math.max(0, Math.floor(params.limit ?? 20))

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

  const rows = context.db.prepare<unknown[], NoteRow>(sql).all(limit)
  const results = rows.map(rowToMetadata)
  logger.info("recent notes", { sortBy, resultCount: results.length })
  return results
}

// ── Property queries ───────────────────────────────────────────

/** Returns all frontmatter property keys with note counts and top 3 sample values. */
export const listPropertyKeys = (
  context: SearchQueryContext,
  params: { folder?: string | undefined },
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
  const keyRows = context.db
    .prepare<Record<string, unknown>, { key: string; count: number }>(keySql)
    .all(keySqlParams)

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
  const sampleStmt = context.db.prepare<
    Record<string, unknown>,
    { value: string }
  >(sampleSql)

  const results: PropertyKeyInfo[] = keyRows.map((keyRow) => {
    const sqlParams: Record<string, string> = escapedFolder
      ? { key: keyRow.key, folder: escapedFolder }
      : { key: keyRow.key }
    const sampleRows = sampleStmt.all(sqlParams)
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
  params: {
    key: string
    folder?: string | undefined
    limit?: number | undefined
  },
  logger: Logger,
): PropertyValueCount[] => {
  const limit = Math.max(0, Math.floor(params.limit ?? 50))
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

  const rows = context.db
    .prepare<
      Record<string, unknown>,
      { value: string | number; count: number }
    >(sql)
    .all(sqlParams)
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
  params: {
    key: string
    value: string
    folder?: string | undefined
    limit?: number | undefined
  },
  logger: Logger,
): NoteMetadata[] => {
  const limit = Math.max(0, Math.floor(params.limit ?? 20))
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

  const rows = context.db
    .prepare<Record<string, unknown>, NoteRow>(sql)
    .all(sqlParams)
  const results = rows.map(rowToMetadata)
  logger.info("search by property", {
    key: params.key,
    value: params.value,
    resultCount: results.length,
  })
  return results
}

// ── Link queries ───────────────────────────────────────────────

/** Returns notes and files that link TO the given path (incoming links /
 *  backlinks). Canvas file-node references are included — a canvas that
 *  embeds a note via a `file`-type node appears as a backlink source. */
export const getBacklinks = (
  context: SearchQueryContext,
  params: { path: string },
  logger: Logger,
): BacklinkEntry[] => {
  assertPathHasExtension(params.path, [".md", ".canvas"])
  const sql = `
    SELECT l.source as path,
           COALESCE(n.title, f.basename) as title,
           COALESCE(n.bytes, f.bytes, 0) as bytes
    FROM links l
    LEFT JOIN notes n ON n.path = l.source
    LEFT JOIN non_md_files f ON f.path = l.source
    WHERE l.target = ?
      AND (n.path IS NOT NULL OR f.path IS NOT NULL)
    ORDER BY COALESCE(n.title, f.basename)
  `
  const rows = context.db
    .prepare<unknown[], { path: string; title: string; bytes: number }>(sql)
    .all(params.path)
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

/** Returns notes and files that the given path links TO (outgoing links).
 *  Each entry carries a `kind` discriminator: "note" for .md targets,
 *  "file" for resolved non-markdown files (.canvas, .base, images, etc.),
 *  defaulting to "note" for unresolved (broken) links. Accepts both
 *  .md and .canvas paths — canvas file-node references appear as outgoing.
 *  When the caller passes the vault's daily notes folder (resolved fresh
 *  via readDailyNotesConfig), broken links under it are flagged
 *  daily_note_forward_ref — expected "create on click" navigation. */
export const getOutgoingLinks = (
  context: SearchQueryContext,
  params: { path: string; dailyNotesFolder?: string | null },
  logger: Logger,
): OutgoingLinkEntry[] => {
  assertPathHasExtension(params.path, [".md", ".canvas"])
  // Left-join against both notes and non_md_files to classify each link target:
  // notes → kind "note", non_md_files → kind "file", neither → broken (defaults to "note").
  const sql = `
    SELECT l.target as path,
           n.title,
           CASE WHEN n.path IS NOT NULL THEN 1
                WHEN f.path IS NOT NULL THEN 1
                ELSE 0 END as exists_flag,
           CASE WHEN n.path IS NOT NULL THEN 'note'
                WHEN f.path IS NOT NULL THEN 'file'
                ELSE 'note' END as kind,
           COALESCE(n.bytes, f.bytes) as bytes
    FROM links l
    LEFT JOIN notes n ON n.path = l.target
    LEFT JOIN non_md_files f ON f.path = l.target
    WHERE l.source = ?
    ORDER BY l.target
  `
  const rows = context.db
    .prepare<
      unknown[],
      {
        path: string
        title: string | null
        exists_flag: number
        kind: "note" | "file"
        bytes: number | null
      }
    >(sql)
    .all(params.path)
  const dailyNotesFolderPrefix = params.dailyNotesFolder
    ? `${params.dailyNotesFolder}/`
    : null
  const results: OutgoingLinkEntry[] = rows.map((row) => ({
    path: row.path,
    title: row.title,
    exists: row.exists_flag === 1,
    kind: row.kind,
    bytes: row.bytes ?? null,
    daily_note_forward_ref:
      row.exists_flag === 0 &&
      dailyNotesFolderPrefix !== null &&
      row.path.startsWith(dailyNotesFolderPrefix),
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
  params: { excludeFolders?: string[] | undefined; limit?: number | undefined },
  logger: Logger,
): NoteMetadata[] => {
  const excludeFolders = params.excludeFolders ?? []
  const limit = Math.max(0, Math.floor(params.limit ?? 50))

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
    .prepare<unknown[], NoteRow>(sql)
    .all(...escapedExcludeFolders, limit)
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
 *  neither the notes table nor the non_md_files table. When the caller
 *  passes the vault's daily notes folder (resolved fresh via
 *  readDailyNotesConfig), broken links under it are excluded — they are
 *  forward-references (intentional "create on click" navigation), not
 *  genuinely broken. Returns the count plus exclusion metadata so
 *  callers can communicate what was filtered. */
export const brokenLinkCount = (
  context: SearchQueryContext,
  params: { dailyNotesFolder?: string | null },
  logger: Logger,
): BrokenLinkResult => {
  const excludedFolder = params.dailyNotesFolder ?? null

  if (excludedFolder === null) {
    const row = context.db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(DISTINCT target) as count
         FROM links
         WHERE target NOT IN (SELECT path FROM notes)
           AND target NOT IN (SELECT path FROM non_md_files)`,
      )
      .get()
    if (!row) throw new Error("aggregate COUNT query returned no row")
    const count = row.count
    logger.info("broken link count", { count })
    return { count, excludedFolder: null, excludedCount: 0 }
  }

  const excludedFolderPrefix = `${excludedFolder}/`
  const brokenTargets = context.db
    .prepare<unknown[], { target: string }>(
      `SELECT DISTINCT target
       FROM links
       WHERE target NOT IN (SELECT path FROM notes)
         AND target NOT IN (SELECT path FROM non_md_files)`,
    )
    .all()

  const count = brokenTargets.filter(
    (row) => !row.target.startsWith(excludedFolderPrefix),
  ).length
  const excludedCount = brokenTargets.length - count

  logger.info("broken link count", {
    count,
    dailyNotesFolder: excludedFolder,
    excludedForwardRefs: excludedCount,
  })
  return { count, excludedFolder, excludedCount }
}

/** Returns notes whose filesystem mtime falls within a calendar date
 *  (server-local day boundaries, governed by the TZ env var). */
export const modifiedOnDate = (
  context: SearchQueryContext,
  params: { date: string; limit?: number | undefined },
  logger: Logger,
): NoteMetadata[] => {
  const limit = Math.max(0, Math.floor(params.limit ?? 50))
  const dayBounds = dayToEpochMsRange(params.date)

  const sql = `
    SELECT path, title, tags, related, folder, type, created, mtime, properties, leading_callout, bytes
    FROM notes
    WHERE mtime >= ? AND mtime < ?
    ORDER BY mtime DESC
    LIMIT ?
  `
  const rows = context.db
    .prepare<unknown[], NoteRow>(sql)
    .all(dayBounds.startMs, dayBounds.endMs, limit)
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
  const row = context.db.prepare<unknown[], VaultStats>(sql).get()
  if (!row) {
    logger.info("vault stats empty")
    return { totalNotes: 0, untaggedNotes: 0, noPropertiesNotes: 0 }
  }
  logger.info("vault stats", row)
  return row
}
