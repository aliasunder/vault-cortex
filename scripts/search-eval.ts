/** Search ranking eval harness — measures hybrid search against a local
 *  judgment file of queries with expected results.
 *
 *  The judgment file stays outside the repo because it names real vault
 *  content:
 *
 *    npx tsx scripts/search-eval.ts --judgment ~/.config/vault-cortex/search-eval.json
 *
 *  Method, in order:
 *  1. Copy the vault once to a snapshot directory, skipping the judgment
 *     file's `exclude_paths`/`exclude_prefixes` — notes that quote the eval
 *     queries verbatim (research notes, session logs) would otherwise match
 *     their own documentation. Reruns reuse the snapshot via
 *     --reuse-snapshot so every configuration sees an identical corpus.
 *  2. Build the search index with real ONNX models and await the full
 *     background embedding pass — scoring a partially embedded index
 *     measures indexing order, not ranking. Any embedding error fails
 *     the run.
 *  3. Assert a probe query returns search_mode "hybrid" with reranked true.
 *  4. Run every judgment query at each --limits value, reporting the rank
 *     of the first expected result, file pollution in the top 5 (or the
 *     limit when smaller — the report labels the measured window), and
 *     latency. The requested limit shapes the candidate and rerank
 *     windows, so the production default (20) is the primary reading and
 *     small limits cover the exclusion boundary they create.
 *
 *  Ranking overrides map to createSearchIndex's `ranking` option:
 *  - --file-leg-weight and --kind-prefix are query-time and default to
 *    the shipped runtime values (0.5 / off), so one built index serves a
 *    whole sweep via --reuse-snapshot --reuse-index.
 *  - --enrich-metadata defaults off, which keeps the default run's index
 *    byte-identical to production chunking. It is index-time — it
 *    prefixes note chunks with frontmatter type/tags before embedding,
 *    builds its own index file (search-eval-enriched.db), and re-embeds
 *    every note on its first run.
 *
 *  Judgment file fields (validated by judgmentFileSchema in
 *  scripts/search-eval-plan.ts): vault_path, exclude_paths,
 *  exclude_prefixes, and queries — each query carries id, class
 *  (recall/precision/sentinel/filtered), query, expected_any or
 *  expected_prefix, and filters.folder on the filtered class.
 *
 *  Usage:
 *    npx tsx scripts/search-eval.ts --judgment <path> [--label baseline]
 *      [--file-leg-weight 0.5] [--kind-prefix] [--enrich-metadata]
 *      [--limits 20,5,3] [--work-dir <dir>] [--reuse-snapshot]
 *      [--reuse-index] [--json-out <path>]
 */

import { parseArgs } from "node:util"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import {
  countUnexpectedFilesInWindow,
  judgmentFileSchema,
  rankOfFirstExpected,
  resolveEvalRunPlan,
} from "./search-eval-plan.js"
import type { JudgmentQuery } from "./search-eval-plan.js"
import { createVaultSnapshot, snapshotMatchesProvenance } from "./search-eval-snapshot.js"
import type { Logger } from "../src/logger.js"
import { createEmbedder } from "../src/vault-mcp/search/embedder.js"
import { createReranker } from "../src/vault-mcp/search/reranker.js"
import { createSearchIndex } from "../src/vault-mcp/search/search-index.js"

// ── Counting logger ────────────────────────────────────────────

/** Silences the index's per-query info logs, records warn/error lines so
 *  the embedding pass can be failed on any logged problem, and tallies the
 *  note-KNN "vector search" lines (knnHits vs uniqueNotes) — the dedup
 *  collapse ratio shows when one note's chunks flood the KNN window. */
const createCountingLogger = (): {
  logger: Logger
  problems: { level: string; message: string }[]
  vectorSearchStats: { knnHits: number; uniqueNotes: number }[]
} => {
  const problems: { level: string; message: string }[] = []
  const vectorSearchStats: { knnHits: number; uniqueNotes: number }[] = []
  const printProblem = (
    level: "warn" | "error",
    message: string,
    data: Record<string, unknown> | undefined,
  ): void => {
    problems.push({ level, message })
    if (data) {
      console.error(`[${level}] ${message}`, data)
      return
    }
    console.error(`[${level}] ${message}`)
  }
  const logger: Logger = {
    debug: () => {},
    info: (message, data) => {
      if (
        message === "vector search" &&
        typeof data?.knnHits === "number" &&
        typeof data.uniqueNotes === "number"
      ) {
        vectorSearchStats.push({
          knnHits: data.knnHits,
          uniqueNotes: data.uniqueNotes,
        })
      }
    },
    warn: (message, data) => {
      printProblem("warn", message, data)
    },
    error: (message, data) => {
      printProblem("error", message, data)
    },
    child: () => logger,
  }
  return { logger, problems, vectorSearchStats }
}

// ── Scoring ────────────────────────────────────────────────────

type QueryScore = {
  id: string
  class: JudgmentQuery["class"]
  query: string
  limit: number
  expectedRank: number | null
  // The pollution metric targets the top 5, but results are truncated to the
  // query's limit first — the window records how deep the count actually saw.
  pollutionWindow: number
  filesInWindow: number
  latencyMs: number
  topPaths: string[]
}

const formatMissedIds = (misses: readonly QueryScore[]): string => {
  if (misses.length === 0) return ""
  return ` (${misses.map((entry) => entry.id).join(", ")})`
}

// ── Main ───────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const { values: cliArgs } = parseArgs({
    options: {
      judgment: { type: "string" },
      label: { type: "string", default: "run" },
      "file-leg-weight": { type: "string" },
      "kind-prefix": { type: "boolean", default: false },
      "enrich-metadata": { type: "boolean", default: false },
      limits: { type: "string", default: "20,5,3" },
      "work-dir": { type: "string" },
      "reuse-snapshot": { type: "boolean", default: false },
      "reuse-index": { type: "boolean", default: false },
      "json-out": { type: "string" },
    },
  })

  // Validation and the snapshot/index reuse decisions live in the plan
  // resolver (search-eval-plan.ts) so they are testable — this script's
  // top-level await makes it unimportable.
  const {
    judgmentPath,
    limits,
    fileLegWeight,
    workDir,
    snapshotDir,
    indexDbPath,
    snapshotReused,
    indexReused,
  } = resolveEvalRunPlan(cliArgs)

  const judgmentRaw: unknown = JSON.parse(await readFile(judgmentPath, "utf8"))
  const judgment = judgmentFileSchema.parse(judgmentRaw)
  // The work dir is created owner-only because it holds a full copy of a
  // private vault under a predictable temp-dir name — default modes would
  // expose it to every local user on a shared host.
  mkdirSync(workDir, { recursive: true, mode: 0o700 })

  if (snapshotReused) {
    // A marker-bearing snapshot may still have been built from another
    // vault or other exclusion lists — scoring it would attribute the
    // numbers to a judgment file that describes a different corpus.
    const provenanceMatches = snapshotMatchesProvenance(snapshotDir, {
      vaultPath: judgment.vault_path,
      excludePaths: judgment.exclude_paths,
      excludePrefixes: judgment.exclude_prefixes,
    })

    if (!provenanceMatches) {
      throw new Error(
        "--reuse-snapshot found a snapshot built from a different vault or exclusion lists — re-run without --reuse-snapshot to rebuild it",
      )
    }
    console.log(`reusing snapshot: ${snapshotDir} (vault ${judgment.vault_path})`)
  } else {
    console.log(`snapshotting vault ${judgment.vault_path} → ${snapshotDir}`)
    createVaultSnapshot({
      vaultPath: judgment.vault_path,
      snapshotDir,
      excludePaths: judgment.exclude_paths,
      excludePrefixes: judgment.exclude_prefixes,
    })
  }

  const { logger, problems, vectorSearchStats } = createCountingLogger()
  const embedder = createEmbedder(logger)
  const reranker = createReranker(logger)
  const search = createSearchIndex(indexDbPath, embedder, reranker, {
    memoryDir: "About Me",
    fileToolsEnabled: true,
    ranking: {
      fileLegWeight,
      rerankKindPrefix: cliArgs["kind-prefix"],
      enrichChunkMetadata: cliArgs["enrich-metadata"],
    },
  })

  if (indexReused) {
    console.log(`reusing index: ${indexDbPath}`)
  } else {
    console.log("rebuilding index (FTS + embedding — this takes minutes)…")
    const rebuildStartMs = performance.now()
    const { count, embedding } = await search.rebuildFromVault({ vaultPath: snapshotDir }, logger)
    // Scoring against a partially embedded index measures indexing order,
    // not ranking — wait for the background pass and fail on any error.
    await embedding
    const embedProblems = problems.filter((problem) => {
      return problem.message.includes("embed")
    })

    if (embedProblems.length > 0) {
      throw new Error(
        `embedding pass logged ${embedProblems.length} problem(s) — fix before scoring`,
      )
    }
    const rebuildSeconds = Math.round((performance.now() - rebuildStartMs) / 1000)
    console.log(`indexed ${count} notes in ${rebuildSeconds}s`)
  }

  // The run is only meaningful fully hybrid + reranked, so a probe query
  // checks the pipeline before scoring. A fixed probe string keeps the
  // check independent of the judgment file's query order — with a healthy
  // index, KNN returns neighbors for any text.
  const PROBE_QUERY = "vault search eval probe"
  const probe = await search.hybridSearch({ query: PROBE_QUERY }, logger)

  if (probe.search_mode !== "hybrid" || !probe.reranked) {
    throw new Error(
      `probe query ran search_mode=${probe.search_mode} reranked=${String(probe.reranked)} — expected hybrid + reranked (is the index fully embedded?)`,
    )
  }

  // The probe's vault-wide KNN window would dilute the diversity ratio —
  // only stats recorded from here on belong to the scoring runs.
  const vectorSearchStatsBeforeScoring = vectorSearchStats.length

  const scores: QueryScore[] = []
  for (const judgmentQuery of judgment.queries) {
    for (const limit of limits) {
      const queryStartMs = performance.now()
      const searchResult = await search.hybridSearch(
        {
          query: judgmentQuery.query,
          limit,
          ...(judgmentQuery.filters ? { filters: judgmentQuery.filters } : {}),
        },
        logger,
      )
      const latencyMs = Math.round(performance.now() - queryStartMs)

      // The probe proves the pipeline once; a reranker failure mid-sweep
      // would otherwise degrade silently to RRF-only ordering while the
      // report attributes the numbers to the reranked pipeline.
      if (searchResult.search_mode !== "hybrid" || !searchResult.reranked) {
        throw new Error(
          `query ${judgmentQuery.id} ran search_mode=${searchResult.search_mode} reranked=${String(searchResult.reranked)} — expected hybrid + reranked`,
        )
      }
      const pollutionWindow = Math.min(5, limit)
      scores.push({
        id: judgmentQuery.id,
        class: judgmentQuery.class,
        query: judgmentQuery.query,
        limit,
        expectedRank: rankOfFirstExpected(searchResult.results, judgmentQuery),
        pollutionWindow,
        filesInWindow: countUnexpectedFilesInWindow(
          searchResult.results,
          judgmentQuery,
          pollutionWindow,
        ),
        latencyMs,
        topPaths: searchResult.results.slice(0, 5).map((result) => result.path),
      })
    }
  }

  // ── Report ──────────────────────────────────────────────────
  const primaryLimit = limits[0] ?? 20
  console.log(
    `\n=== ${cliArgs.label} · fileLegWeight=${fileLegWeight ?? "default"} · kindPrefix=${String(cliArgs["kind-prefix"])} ===`,
  )
  console.log(`per-query results at limit ${primaryLimit}:`)
  for (const score of scores.filter((entry) => entry.limit === primaryLimit)) {
    const rankText = score.expectedRank === null ? "MISS" : `#${score.expectedRank}`
    const gate = score.expectedRank !== null && score.expectedRank <= 3 ? "pass" : "FAIL"
    const pollutionText =
      score.class === "precision" ? ` files@${score.pollutionWindow}=${score.filesInWindow}` : ""
    console.log(
      `  [${score.class}] ${score.id}: expected ${rankText} (top-3 ${gate})${pollutionText} ${score.latencyMs}ms`,
    )
  }

  // The note-KNN diversity ratio covers the scoring runs. When a repeated
  // metadata prefix lets one note's chunks flood the window, hits rise
  // while unique notes fall, so a shrinking ratio is the warning sign.
  const scoringVectorSearchStats = vectorSearchStats.slice(vectorSearchStatsBeforeScoring)
  const totalKnnHits = scoringVectorSearchStats.reduce((sum, stats) => sum + stats.knnHits, 0)
  const totalUniqueNotes = scoringVectorSearchStats.reduce(
    (sum, stats) => sum + stats.uniqueNotes,
    0,
  )

  if (totalKnnHits > 0) {
    console.log(
      `note-KNN diversity: ${totalUniqueNotes} unique notes from ${totalKnnHits} chunk hits (${((100 * totalUniqueNotes) / totalKnnHits).toFixed(1)}%)`,
    )
  }

  const otherLimits = limits.slice(1)
  for (const limit of otherLimits) {
    const missesAtLimit = scores.filter(
      (entry) => entry.limit === limit && entry.expectedRank === null,
    )
    console.log(
      `at limit ${limit}: ${missesAtLimit.length} queries lose their expected result${formatMissedIds(missesAtLimit)}`,
    )
  }

  if (cliArgs["json-out"]) {
    writeFileSync(
      cliArgs["json-out"],
      JSON.stringify(
        {
          label: cliArgs.label,
          fileLegWeight: fileLegWeight ?? null,
          kindPrefix: cliArgs["kind-prefix"],
          // enrichMetadata is index-time — with indexReused true, the scored
          // index kept whatever enrichment it was built with, regardless of
          // this value.
          enrichMetadata: cliArgs["enrich-metadata"],
          indexDbPath,
          indexReused,
          snapshotReused,
          knnDiversity: { totalKnnHits, totalUniqueNotes },
          scores,
        },
        null,
        2,
      ),
    )
    console.log(`full results written to ${cliArgs["json-out"]}`)
  }
}

await main()
