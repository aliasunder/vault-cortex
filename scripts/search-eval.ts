/** Search ranking eval harness — measures hybrid search against a local
 *  judgment file of queries with expected results.
 *
 *  The judgment file stays OUTSIDE the repo (it names real vault content):
 *
 *    npx tsx scripts/search-eval.ts --judgment ~/.config/vault-cortex/search-eval.json
 *
 *  Method, in order:
 *  1. Copy the vault once to a snapshot directory, skipping the judgment
 *     file's `exclude_paths`/`exclude_prefixes` — notes that quote the eval
 *     queries verbatim (research notes, session logs) would otherwise match
 *     their own documentation. Reruns reuse the snapshot via
 *     --reuse-snapshot so every configuration sees an identical corpus.
 *  2. Build the search index with real ONNX models and AWAIT the background
 *     embedding pass — scoring a partially embedded index measures indexing
 *     order, not ranking. Any embedding error fails the run.
 *  3. Assert a probe query returns search_mode "hybrid" with reranked true.
 *  4. Run every judgment query at each --limits value, reporting the rank
 *     of the first expected result, file pollution in the top 5, and
 *     latency. The requested limit shapes the candidate and rerank windows,
 *     so the production default (20) is the primary reading and small
 *     limits cover the exclusion boundary they create.
 *
 *  Ranking overrides (--file-leg-weight, --kind-prefix, --enrich-metadata)
 *  map to createSearchIndex's `ranking` option. The first two are
 *  query-time settings: one built index serves a whole sweep via
 *  --reuse-snapshot --reuse-index. --enrich-metadata is index-time — it
 *  prefixes note chunks with frontmatter type/tags before embedding, so it
 *  builds its own index file (search-eval-enriched.db) and its first run
 *  re-embeds every note.
 *
 *  Usage:
 *    npx tsx scripts/search-eval.ts --judgment <path> [--label baseline]
 *      [--file-leg-weight 0.5] [--kind-prefix] [--enrich-metadata]
 *      [--limits 20,5,3] [--work-dir <dir>] [--reuse-snapshot]
 *      [--reuse-index] [--json-out <path>]
 */

import { parseArgs } from "node:util"
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { Logger } from "../src/logger.js"
import { createEmbedder } from "../src/vault-mcp/search/embedder.js"
import { createReranker } from "../src/vault-mcp/search/reranker.js"
import { createSearchIndex } from "../src/vault-mcp/search/search-index.js"
import type { SearchResult } from "../src/vault-mcp/search/search-index.js"

// ── Judgment file schema ───────────────────────────────────────

const judgmentQuerySchema = z.object({
  id: z.string().min(1),
  class: z.enum(["recall", "precision", "sentinel", "filtered"]),
  query: z.string().min(1),
  expected_any: z.array(z.string().min(1)).optional(),
  expected_prefix: z.string().min(1).optional(),
  filters: z.object({ folder: z.string().min(1) }).optional(),
})

const judgmentFileSchema = z.object({
  vault_path: z.string().min(1),
  exclude_paths: z.array(z.string().min(1)),
  exclude_prefixes: z.array(z.string().min(1)),
  queries: z.array(judgmentQuerySchema).min(1),
})

type JudgmentQuery = z.infer<typeof judgmentQuerySchema>

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

// ── Snapshot ───────────────────────────────────────────────────

/** Copies the vault to the snapshot directory, skipping hidden entries and
 *  every judgment-file exclusion. All index builds read the snapshot, so
 *  live vault writes between runs cannot confound an A/B comparison. */
const createVaultSnapshot = (params: {
  vaultPath: string
  snapshotDir: string
  excludePaths: readonly string[]
  excludePrefixes: readonly string[]
}): void => {
  const vaultRoot = resolve(params.vaultPath)
  const excludedExactPaths = new Set(
    params.excludePaths.map((path) => resolve(vaultRoot, path)),
  )
  // resolve() strips trailing slashes, so append sep — without it,
  // prefix "sessions" also matches sibling "sessions-archive.md".
  const excludedPrefixes = params.excludePrefixes.map((prefix) => {
    const resolved = resolve(vaultRoot, prefix)
    return resolved.endsWith(sep) ? resolved : resolved + sep
  })

  rmSync(params.snapshotDir, { recursive: true, force: true })
  mkdirSync(params.snapshotDir, { recursive: true })
  cpSync(vaultRoot, params.snapshotDir, {
    recursive: true,
    filter: (source) => {
      const absoluteSource = resolve(source)
      const relativeFromRoot = absoluteSource.slice(vaultRoot.length)
      const isHidden = relativeFromRoot
        .split(sep)
        .some((segment) => segment.startsWith("."))
      if (isHidden) return false
      if (excludedExactPaths.has(absoluteSource)) return false
      return !excludedPrefixes.some((prefix) => {
        return absoluteSource.startsWith(prefix)
      })
    },
  })
}

// ── Scoring ────────────────────────────────────────────────────

type QueryScore = {
  id: string
  class: JudgmentQuery["class"]
  query: string
  limit: number
  expectedRank: number | null
  filesInTop5: number
  latencyMs: number
  topPaths: string[]
}

/** True when the path is one of the judgment entry's expected answers —
 *  by exact `expected_any` match or by `expected_prefix`. */
const matchesExpectedPath = (
  judgmentQuery: JudgmentQuery,
  path: string,
): boolean => {
  if (judgmentQuery.expected_any?.includes(path)) return true
  return Boolean(
    judgmentQuery.expected_prefix &&
    path.startsWith(judgmentQuery.expected_prefix),
  )
}

const rankOfFirstExpected = (
  results: readonly SearchResult[],
  judgmentQuery: JudgmentQuery,
): number | null => {
  const index = results.findIndex((result) => {
    return matchesExpectedPath(judgmentQuery, result.path)
  })
  return index === -1 ? null : index + 1
}

/** File results in the top 5 that are not themselves expected — for the
 *  precision class no file is a correct answer, so every one is pollution. */
const countUnexpectedFilesInTop5 = (
  results: readonly SearchResult[],
  judgmentQuery: JudgmentQuery,
): number => {
  return results.slice(0, 5).filter((result) => {
    return (
      result.kind === "file" && !matchesExpectedPath(judgmentQuery, result.path)
    )
  }).length
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

  if (!cliArgs.judgment) {
    throw new Error(
      "--judgment <path> is required (a local judgment JSON — see the file header)",
    )
  }

  const judgmentRaw: unknown = JSON.parse(
    await readFile(cliArgs.judgment, "utf8"),
  )
  const judgment = judgmentFileSchema.parse(judgmentRaw)

  const limits = cliArgs.limits.split(",").map((limitText) => {
    const limit = Number(limitText.trim())
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `--limits entries must be positive integers: ${limitText}`,
      )
    }
    return limit
  })

  const fileLegWeight = cliArgs["file-leg-weight"]
    ? Number(cliArgs["file-leg-weight"])
    : undefined
  // Strict undefined check — 0 is a valid weight (removes the file legs).
  // Negated >= catches NaN (which fails every comparison).
  if (fileLegWeight !== undefined && !(fileLegWeight >= 0)) {
    throw new Error("--file-leg-weight must be a number >= 0")
  }

  // A reused index over a freshly copied snapshot would score a corpus the
  // index never saw — the two reuse flags only make sense together.
  if (cliArgs["reuse-index"] && !cliArgs["reuse-snapshot"]) {
    throw new Error("--reuse-index requires --reuse-snapshot")
  }

  const workDir =
    cliArgs["work-dir"] ?? join(tmpdir(), "vault-cortex-search-eval")
  const snapshotDir = join(workDir, "vault-snapshot")
  // Enrichment changes every note chunk's text, so it gets its own index
  // file — the plain index stays reusable for weight sweeps.
  const indexDbPath = join(
    workDir,
    cliArgs["enrich-metadata"] ? "search-eval-enriched.db" : "search-eval.db",
  )
  mkdirSync(workDir, { recursive: true })

  if (cliArgs["reuse-snapshot"] && existsSync(snapshotDir)) {
    console.log(`reusing snapshot: ${snapshotDir}`)
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

  if (cliArgs["reuse-index"] && existsSync(indexDbPath)) {
    console.log(`reusing index: ${indexDbPath}`)
  } else {
    console.log("rebuilding index (FTS + embedding — this takes minutes)…")
    const rebuildStartMs = performance.now()
    const { count, embedding } = await search.rebuildFromVault(
      { vaultPath: snapshotDir },
      logger,
    )
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
    const rebuildSeconds = Math.round(
      (performance.now() - rebuildStartMs) / 1000,
    )
    console.log(`indexed ${count} notes in ${rebuildSeconds}s`)
  }

  // Probe: the run is only meaningful fully hybrid + reranked. A fixed
  // probe string keeps the check independent of the judgment file's query
  // order — with a healthy index, KNN returns neighbors for any text.
  const PROBE_QUERY = "vault search eval probe"
  const probe = await search.hybridSearch({ query: PROBE_QUERY }, logger)
  if (probe.search_mode !== "hybrid" || !probe.reranked) {
    throw new Error(
      `probe query ran search_mode=${probe.search_mode} reranked=${String(probe.reranked)} — expected hybrid + reranked (is the index fully embedded?)`,
    )
  }

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
      scores.push({
        id: judgmentQuery.id,
        class: judgmentQuery.class,
        query: judgmentQuery.query,
        limit,
        expectedRank: rankOfFirstExpected(searchResult.results, judgmentQuery),
        filesInTop5: countUnexpectedFilesInTop5(
          searchResult.results,
          judgmentQuery,
        ),
        latencyMs,
        topPaths: searchResult.results
          .slice(0, 5)
          .map(
            (result) => `${result.kind === "file" ? "F " : "  "}${result.path}`,
          ),
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
    const rankText =
      score.expectedRank === null ? "MISS" : `#${score.expectedRank}`
    const gate =
      score.expectedRank !== null && score.expectedRank <= 3 ? "pass" : "FAIL"
    const pollutionText =
      score.class === "precision" ? ` files@5=${score.filesInTop5}` : ""
    console.log(
      `  [${score.class}] ${score.id}: expected ${rankText} (top-3 ${gate})${pollutionText} ${score.latencyMs}ms`,
    )
  }

  // KNN-window diversity across the scoring runs (Codex finding 4): when a
  // repeated metadata prefix lets one note's chunks flood the window, hits
  // rise while unique notes fall — a shrinking ratio is the warning sign.
  const totalKnnHits = vectorSearchStats.reduce(
    (sum, stats) => sum + stats.knnHits,
    0,
  )
  const totalUniqueNotes = vectorSearchStats.reduce(
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
      `at limit ${limit}: ${missesAtLimit.length} queries lose their expected result${missesAtLimit.length > 0 ? ` (${missesAtLimit.map((entry) => entry.id).join(", ")})` : ""}`,
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
          enrichMetadata: cliArgs["enrich-metadata"],
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
