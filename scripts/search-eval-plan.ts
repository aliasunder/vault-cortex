// ── Eval run plan: judgment schema + CLI validation + reuse decisions ──

import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { isHarnessSnapshot } from "./search-eval-snapshot.js"

const judgmentQuerySchema = z
  .object({
    id: z.string().min(1),
    class: z.enum(["recall", "precision", "sentinel", "filtered"]),
    query: z.string().min(1),
    expected_any: z.array(z.string().min(1)).optional(),
    expected_prefix: z.string().min(1).optional(),
    filters: z.object({ folder: z.string().min(1) }).optional(),
  })
  // Zod strips unknown keys, so a typoed expectation field would otherwise
  // parse cleanly into a query that reads MISS on every run.
  .refine((query) => Boolean(query.expected_any || query.expected_prefix), {
    message: "each query needs expected_any or expected_prefix",
  })

export const judgmentFileSchema = z.object({
  vault_path: z.string().min(1),
  exclude_paths: z.array(z.string().min(1)),
  exclude_prefixes: z.array(z.string().min(1)),
  queries: z.array(judgmentQuerySchema).min(1),
})

export type JudgmentQuery = z.infer<typeof judgmentQuerySchema>

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
