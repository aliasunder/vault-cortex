// ── Eval run plan: judgment schema + CLI validation + reuse decisions ──

import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { isHarnessSnapshot } from "./search-eval-snapshot.js"
import type { SearchResult } from "../src/vault-mcp/search/search-index.js"

// The schemas are strict because a plain schema would strip a typoed key
// (a misspelled expectation or filter field) and silently score a
// different query shape than the judgment file describes.
const judgmentQuerySchema = z
  .strictObject({
    id: z.string().min(1),
    class: z.enum(["recall", "precision", "sentinel", "filtered"]),
    query: z.string().min(1),
    expected_any: z.array(z.string().min(1)).min(1).optional(),
    expected_prefix: z.string().min(1).optional(),
    filters: z.strictObject({ folder: z.string().min(1) }).optional(),
  })
  .refine((query) => Boolean(query.expected_any || query.expected_prefix), {
    message: "each query needs expected_any or expected_prefix",
  })
  .refine((query) => query.class !== "filtered" || Boolean(query.filters), {
    message: "a filtered query needs filters.folder",
  })

export const judgmentFileSchema = z.strictObject({
  vault_path: z.string().min(1),
  exclude_paths: z.array(z.string().min(1)),
  exclude_prefixes: z.array(z.string().min(1)),
  queries: z.array(judgmentQuerySchema).min(1),
})

export type JudgmentQuery = z.infer<typeof judgmentQuerySchema>

// ── Scoring ────────────────────────────────────────────────────

/** True when the path is one of the judgment entry's expected answers —
 *  by exact `expected_any` match or by `expected_prefix`. A prefix without
 *  a trailing slash matches at a path-segment boundary, mirroring the
 *  snapshot exclusions — "docs" must not swallow "docs2/noise.txt". */
const matchesExpectedPath = (
  judgmentQuery: JudgmentQuery,
  path: string,
): boolean => {
  if (judgmentQuery.expected_any?.includes(path)) return true

  const expectedPrefix = judgmentQuery.expected_prefix
  if (!expectedPrefix) return false
  const folderPrefix = expectedPrefix.endsWith("/")
    ? expectedPrefix
    : `${expectedPrefix}/`
  return path.startsWith(folderPrefix)
}

export const rankOfFirstExpected = (
  results: readonly SearchResult[],
  judgmentQuery: JudgmentQuery,
): number | null => {
  const index = results.findIndex((result) => {
    return matchesExpectedPath(judgmentQuery, result.path)
  })
  return index === -1 ? null : index + 1
}

/** File results in the window that are not themselves expected — for the
 *  precision class no file is a correct answer, so every one is pollution. */
export const countUnexpectedFilesInWindow = (
  results: readonly SearchResult[],
  judgmentQuery: JudgmentQuery,
  windowSize: number,
): number => {
  return results.slice(0, windowSize).filter((result) => {
    return (
      result.kind === "file" && !matchesExpectedPath(judgmentQuery, result.path)
    )
  }).length
}

type EvalCliArgs = {
  judgment?: string | undefined
  "file-leg-weight"?: string | undefined
  limits: string
  "work-dir"?: string | undefined
  "enrich-metadata": boolean
  "reuse-snapshot": boolean
  "reuse-index": boolean
}

type EvalRunPlan = {
  judgmentPath: string
  limits: number[]
  fileLegWeight: number | undefined
  workDir: string
  snapshotDir: string
  indexDbPath: string
  snapshotReused: boolean
  indexReused: boolean
}

/** Validates the CLI arguments and decides snapshot/index reuse from the
 *  work directory's current state — BEFORE anything opens the index
 *  database (createSearchIndex creates the file, so a later existence
 *  check would always report true). Throws on any invalid combination. */
export const resolveEvalRunPlan = (cliArgs: EvalCliArgs): EvalRunPlan => {
  if (!cliArgs.judgment) {
    throw new Error(
      "--judgment <path> is required (a local judgment JSON — see the file header)",
    )
  }

  const limits = cliArgs.limits.split(",").map((limitText) => {
    const limit = Number(limitText.trim())
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `--limits entries must be positive integers: ${limitText}`,
      )
    }
    return limit
  })

  // An empty string (--file-leg-weight= with an unset shell variable) must
  // reject like any other non-number, not silently fall back to the default.
  const rawFileLegWeight = cliArgs["file-leg-weight"]
  const fileLegWeight =
    rawFileLegWeight === undefined ? undefined : Number(rawFileLegWeight)
  // Strict undefined check — 0 is a valid weight (removes the file legs).
  // Negated >= catches NaN (which fails every comparison).
  const fileLegWeightInvalid =
    rawFileLegWeight === "" ||
    (fileLegWeight !== undefined && !(fileLegWeight >= 0))
  if (fileLegWeightInvalid) {
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

  // Only a directory the harness created may be adopted — an operator's own
  // vault-snapshot folder must not silently become the scored corpus.
  const snapshotReused =
    cliArgs["reuse-snapshot"] && isHarnessSnapshot(snapshotDir)

  // An index can only be reused over the snapshot it was built from — when
  // the snapshot is absent (or not harness-created) it gets rebuilt this
  // run, and the index would describe a corpus that no longer exists.
  if (cliArgs["reuse-index"] && !snapshotReused) {
    throw new Error(
      "--reuse-index requires the snapshot it was built from, but the snapshot would be rebuilt this run — re-run without --reuse-index",
    )
  }
  const indexReused = cliArgs["reuse-index"] && existsSync(indexDbPath)

  return {
    judgmentPath: cliArgs.judgment,
    limits,
    fileLegWeight,
    workDir,
    snapshotDir,
    indexDbPath,
    snapshotReused,
    indexReused,
  }
}
