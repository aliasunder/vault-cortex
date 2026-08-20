// ── Hybrid search pipeline ─────────────────────────────────────

import type Database from "better-sqlite3"
import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { sanitizeFtsQuery } from "./fts-query.js"
import { computeRrfScores } from "./rrf.js"
import { blendScores } from "./reranker.js"
import type { Reranker } from "./reranker.js"
import {
  noteRowToSearchResult,
  fileContentRowToSearchResult,
  noteMatchesSearchFilters,
  buildSnippetFromChunkText,
  stripTrailingSlashes,
} from "./search-helpers.js"
import type { FileContentFtsRow } from "./search-helpers.js"
import type {
  VectorHit,
  SearchResult,
  HybridSearchResult,
  SearchFilters,
} from "./search-index.js"
import { fullTextSearch } from "./search-queries.js"
import type { SearchQueryContext } from "./search-queries.js"

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
    // Path found via note FTS — use its metadata and snippet, replace score
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
      // Apply filters that FTS would have applied via SQL
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
