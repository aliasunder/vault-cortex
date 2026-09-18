// ── Hybrid search pipeline ─────────────────────────────────────

import type Database from "better-sqlite3"
import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { compareByUtf8Bytes } from "../../utils/compare-utf8-bytes.js"
import { sanitizeFtsQuery } from "./fts-query.js"
import { computeRrfScores } from "./rrf.js"
import { blendScores } from "./reranker.js"
import type { Reranker } from "./reranker.js"
import {
  noteRowToSearchResult,
  fileContentRowToSearchResult,
  noteMatchesSearchFilters,
  buildSnippetFromChunkText,
  folderLikePattern,
} from "./search-helpers.js"
import type { FileContentFtsRow } from "./search-helpers.js"
import type { VectorHit, SearchResult, HybridSearchResult, SearchFilters } from "./search-index.js"
import { fullTextSearch } from "./search-queries.js"
import type { SearchQueryContext } from "./search-queries.js"

/** Maps one search leg's results to the identifier shape computeRrfScores
 *  fuses on — path is the identity all four hybrid-search legs share. */
const toRankedList = (items: readonly { path: string }[]): { identifier: string }[] =>
  items.map((item) => ({ identifier: item.path }))

/** Weight on the file-content legs (FTS + KNN) in RRF fusion, relative to
 *  the note legs' implicit 1. Below 1, a thin file match cannot reach the
 *  blend-protected top ranks on leg rank alone — it needs corroboration —
 *  while a strong file answer still surfaces through its leg presence.
 *
 *  Chosen via the search-eval harness (scripts/search-eval.ts), which
 *  scores candidate values against a judgment set of queries:
 *  - 0.5 is the largest sweep value (1.0/0.7/0.6/0.5/0.3) that removed
 *    every unrelated file from the top 5 where files are off-topic;
 *    results only degraded at 0.3.
 *  - Every query expecting a specific file kept it in the top 3 or at
 *    its pre-change rank.
 *  - At exactly 0.5, a file at rank 1 in both file legs ties a note at
 *    rank 1 in a single note leg; the path tie-break orders that pair.
 *  The harness overrides this per run via the ranking option. */
const DEFAULT_FILE_LEG_WEIGHT = 0.5

/** Whether reranker document text for file results is prefixed with the
 *  file's kind ("PDF file:") so the cross-encoder can penalize a document
 *  kind that is off-topic for the query. Overridable like the leg weight. */
const DEFAULT_RERANK_KIND_PREFIX = false

/** Kind label for the reranker prefix, from the file's extension. */
const fileKindLabel = (extension: string | undefined): string => {
  if (extension === ".pdf") return "PDF file"
  if (extension === ".canvas") return "Canvas file"
  return "File"
}

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
    return Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength)
  } catch (error) {
    logger.warn("query embedding failed", { error: describeError(error) })
    return null
  }
}

/** KNN over note vectors — the best-matching chunk per note. With a folder
 *  pattern the k-window is taken over in-folder chunks only, so a folder
 *  filter can never be starved by closer matches elsewhere in the vault. */
const vectorSearch = (
  context: SearchQueryContext,
  params: {
    query: string
    queryEmbeddingBuffer: Buffer
    limit: number
    folderPathPattern: string | undefined
  },
  logger: Logger,
): VectorHit[] => {
  const { knnSearchStmt, knnSearchInFolderStmt } = context.vector

  if (!knnSearchStmt || !knnSearchInFolderStmt) return []

  try {
    const noteKnnRows = params.folderPathPattern
      ? knnSearchInFolderStmt.all(
          params.queryEmbeddingBuffer,
          params.limit,
          params.folderPathPattern,
        )
      : knnSearchStmt.all(params.queryEmbeddingBuffer, params.limit)

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

/** KNN over file content vectors — the best-matching chunk per file. With a
 *  folder pattern the k-window is taken over in-folder chunks only, mirroring
 *  vectorSearch. Empty when file content vectors are disabled or the query fails. */
const fileContentVectorSearch = (
  context: SearchQueryContext,
  params: {
    query: string
    queryEmbeddingBuffer: Buffer
    limit: number
    folderPathPattern: string | undefined
  },
  logger: Logger,
): VectorHit[] => {
  if (!context.fileContentVector) return []
  const { knnSearchStmt, knnSearchInFolderStmt } = context.fileContentVector

  try {
    const fileKnnRows = params.folderPathPattern
      ? knnSearchInFolderStmt.all(
          params.queryEmbeddingBuffer,
          params.limit,
          params.folderPathPattern,
        )
      : knnSearchStmt.all(params.queryEmbeddingBuffer, params.limit)

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

/** Runs the file_content_fts query (canvas content, etc.) with the folder
 *  filter applied in SQL before the limit, mirroring fullTextSearch — returns
 *  [] when the feature is disabled. */
const runFileContentFts = (
  context: SearchQueryContext,
  params: {
    query: string
    snippetTokens: number
    limit: number
    folderPathPattern: string | undefined
  },
): FileContentFtsRow[] => {
  if (!context.fileContentFts) return []
  const sanitizedQuery = sanitizeFtsQuery(params.query)

  if (!sanitizedQuery) return []
  // With no folder filter, bind "%" so the LIKE predicate matches every path —
  // one prepared statement covers both cases instead of needing a second,
  // filter-free one.
  return context.fileContentFts.searchStmt.all(
    params.snippetTokens,
    sanitizedQuery,
    params.folderPathPattern ?? "%",
    params.limit,
  )
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
  rerankKindPrefix: boolean
  selectFirstChunkStmt: Database.Statement<[string], { chunk_text: string }> | null
  selectFirstFileChunkStmt: Database.Statement<[string], { chunk_text: string }> | null
  logger: Logger
}): Promise<{ results: SearchResult[] } | null> => {
  try {
    // Cascade through sources to find the best document text for reranking
    const collectDocumentText = (result: SearchResult): string => {
      // Prefer note vector chunk text (best semantic match for this note)
      const vectorHit = params.vectorHitsByPath.get(result.path)

      if (vectorHit) return vectorHit.chunkText

      // File content vector chunk text
      const fileVectorHit = params.fileContentVectorHitsByPath.get(result.path)

      if (fileVectorHit) return fileVectorHit.chunkText

      // An FTS-only note uses chunk index 0 (title + intro) from note_chunks
      if (params.selectFirstChunkStmt) {
        const chunkRow = params.selectFirstChunkStmt.get(result.path)

        if (chunkRow) return chunkRow.chunk_text
      }

      // An FTS-only file uses chunk index 0 from file_content_chunks
      if (params.selectFirstFileChunkStmt) {
        const fileChunkRow = params.selectFirstFileChunkStmt.get(result.path)

        if (fileChunkRow) return fileChunkRow.chunk_text
      }

      // Fall back to the snippet — truncated, but better than nothing when
      // chunks aren't yet indexed during background embedding startup
      return result.snippet
    }

    const documentTexts = params.mergedResults.map((result) => {
      const documentText = collectDocumentText(result)

      // Kind marker only — the chunk text already opens with the file's
      // title, so prefixing the filename again would just repeat it.
      if (params.rerankKindPrefix && result.kind === "file") {
        return `${fileKindLabel(result.extension)}: ${documentText}`
      }
      return documentText
    })

    const rerankScores = await params.reranker.rerankPairs(params.query, documentTexts)

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
      // The path tie-break arm is defense in depth. With the current blend
      // weights, candidates whose blended scores tie also tied in RRF and
      // arrive already path-sorted — the arm exists so a future weight
      // change cannot silently reintroduce row-order-dependent output.
      results: scoredResults.toSorted((resultA, resultB) => {
        if (resultA.score !== resultB.score) {
          return resultB.score - resultA.score
        }
        return compareByUtf8Bytes(resultA.path, resultB.path)
      }),
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
  params: {
    query: string
    filters?: SearchFilters | undefined
    limit?: number | undefined
    snippet_tokens?: number | undefined
    include_leading_callout?: boolean | undefined
  },
  logger: Logger,
): Promise<HybridSearchResult> => {
  const userLimit = Math.max(0, Math.floor(params.limit ?? 20))
  const snippetTokens = params.snippet_tokens ?? 30
  const includeLeadingCallout = params.include_leading_callout ?? false
  // Inflate the per-leg candidate pool beyond the requested limit so RRF
  // has corroboration to fuse on, capped at 100.
  const candidateLimit = Math.min(Math.max(1, userLimit * 3), 100)
  const fileLegWeight = context.ranking?.fileLegWeight ?? DEFAULT_FILE_LEG_WEIGHT
  const rerankKindPrefix = context.ranking?.rerankKindPrefix ?? DEFAULT_RERANK_KIND_PREFIX
  // One LIKE pattern shared by every leg that scopes to a folder in SQL —
  // the file-content FTS leg and both KNN legs (fullTextSearch builds its own
  // from the same helper), so no leg can drift from the others.
  const folderPathPattern = params.filters?.folder
    ? folderLikePattern(params.filters.folder)
    : undefined

  // Run FTS with inflated limit to give RRF enough candidates
  const ftsResults = fullTextSearch(
    context,
    {
      query: params.query,
      filters: params.filters,
      limit: candidateLimit,
      snippet_tokens: params.snippet_tokens,
      include_leading_callout: params.include_leading_callout,
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
  // Weight 0 must exclude the file legs, not just zero their contribution —
  // RRF would still emit their identifiers at score 0, so file results
  // would surface whenever the candidate window has room.
  const skipFileContentLegs = hasNoteSpecificFilters || fileLegWeight === 0
  const fileContentResults = skipFileContentLegs
    ? []
    : runFileContentFts(context, {
        query: params.query,
        snippetTokens,
        limit: candidateLimit,
        folderPathPattern,
      })

  // Embed the query once — shared by note and file content vector searches
  const queryEmbeddingBuffer = await embedQuery(context, params.query, logger)

  // Attempt vector search — returns [] when embedding or KNN is unavailable
  const vectorHits = queryEmbeddingBuffer
    ? vectorSearch(
        context,
        {
          query: params.query,
          queryEmbeddingBuffer,
          limit: candidateLimit,
          folderPathPattern,
        },
        logger,
      )
    : []

  // File content vector search — same skip condition as file content FTS
  const fileContentVectorHits =
    skipFileContentLegs || !queryEmbeddingBuffer
      ? []
      : fileContentVectorSearch(
          context,
          {
            query: params.query,
            queryEmbeddingBuffer,
            limit: candidateLimit,
            folderPathPattern,
          },
          logger,
        )

  const hasAnyVectorHits = vectorHits.length > 0 || fileContentVectorHits.length > 0

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
    // Merge note FTS + file content FTS via 2-list RRF. The file leg keeps
    // its weight here too — with no reranker on this path, fusion is the
    // only place a thin file match can be demoted at all.
    const fallbackRrf = computeRrfScores({
      rankedLists: [
        { items: toRankedList(ftsResults) }, // note FTS
        { items: toRankedList(fileContentResults), weight: fileLegWeight },
      ],
    })
    const ftsResultsByPath = new Map(ftsResults.map((result) => [result.path, result]))
    const fileContentByPath = new Map(fileContentResults.map((result) => [result.path, result]))
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

  // An empty list contributes no scores, so each leg is passed
  // unconditionally. The file-content legs are down-weighted so a large
  // file matching scattered common words across its chunks cannot out-rank
  // topical notes on leg rank alone.
  const rrfScores = computeRrfScores({
    rankedLists: [
      { items: toRankedList(ftsResults) }, // note FTS
      { items: toRankedList(vectorHits) }, // note KNN
      { items: toRankedList(fileContentResults), weight: fileLegWeight },
      { items: toRankedList(fileContentVectorHits), weight: fileLegWeight },
    ],
  })

  // Index all result sources by path for O(1) lookup
  const ftsResultsByPath = new Map(ftsResults.map((result) => [result.path, result]))
  const vectorHitsByPath = new Map(vectorHits.map((hit) => [hit.path, hit]))
  const fileContentByPath = new Map(fileContentResults.map((result) => [result.path, result]))
  const fileContentVectorHitsByPath = new Map(fileContentVectorHits.map((hit) => [hit.path, hit]))

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
      if (params.filters && !noteMatchesSearchFilters(noteRow, params.filters)) {
        continue
      }

      const vectorHit = vectorHitsByPath.get(path)
      const snippet = vectorHit ? buildSnippetFromChunkText(vectorHit.chunkText, snippetTokens) : ""

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

      // No folder check here: every file-content leg (FTS and KNN) already
      // scoped to the folder in SQL, so a file-only hit is in-folder by
      // construction.
      mergedResults.push(
        fileContentRowToSearchResult(
          {
            ...fileMetadata,
            snippet: buildSnippetFromChunkText(fileVectorHit.chunkText, snippetTokens),
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
          rerankKindPrefix,
          selectFirstChunkStmt: context.selectFirstChunkStmt,
          selectFirstFileChunkStmt: context.fileContentVector?.selectFirstFileChunkStmt ?? null,
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
