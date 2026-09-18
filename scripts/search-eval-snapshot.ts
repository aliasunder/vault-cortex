// ── Eval vault snapshot ────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { caseFoldPath } from "../src/utils/case-fold-path.js"
import { hasHiddenPathSegment } from "../src/utils/has-hidden-path-segment.js"

/** Marks a directory as harness-created so the pre-copy delete can never
 *  destroy an operator's own same-named folder under --work-dir. Holds the
 *  provenance a reuse must match — a snapshot built from another vault or
 *  other exclusions is a different corpus than the judgment file describes. */
const SNAPSHOT_MARKER = ".search-eval-snapshot"

const snapshotProvenanceSchema = z.object({
  vaultPath: z.string().min(1),
  excludePaths: z.array(z.string()),
  excludePrefixes: z.array(z.string()),
})

type SnapshotProvenance = z.infer<typeof snapshotProvenanceSchema>

/** True when the directory exists and carries the harness marker — the only
 *  directories the harness may delete, or adopt via --reuse-snapshot. */
export const isHarnessSnapshot = (snapshotDir: string): boolean => {
  return existsSync(snapshotDir) && existsSync(join(snapshotDir, SNAPSHOT_MARKER))
}

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  return JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted())
}

const parseJsonOrNull = (content: string): unknown => {
  try {
    return JSON.parse(content)
  } catch {
    // Not JSON — a pre-provenance or hand-written marker reads as mismatch.
    return null
  }
}

/** True when the snapshot's marker records the same vault and exclusion
 *  lists — false for a marker from before provenance was recorded, or one
 *  written by hand. Order within the exclusion lists does not matter. */
export const snapshotMatchesProvenance = (snapshotDir: string, expected: SnapshotProvenance): boolean => {
  const markerPath = join(snapshotDir, SNAPSHOT_MARKER)

  if (!existsSync(markerPath)) return false

  const parsedMarker = snapshotProvenanceSchema.safeParse(parseJsonOrNull(readFileSync(markerPath, "utf8")))

  if (!parsedMarker.success) return false

  const recorded = parsedMarker.data
  return (
    recorded.vaultPath === resolve(expected.vaultPath) &&
    sameStringSet(recorded.excludePaths, expected.excludePaths) &&
    sameStringSet(recorded.excludePrefixes, expected.excludePrefixes)
  )
}

/** Copies the vault to the snapshot directory, skipping hidden entries and
 *  every judgment-file exclusion. All index builds read the snapshot, so
 *  live vault writes between runs cannot confound an A/B comparison. */
export const createVaultSnapshot = (params: {
  vaultPath: string
  snapshotDir: string
  excludePaths: readonly string[]
  excludePrefixes: readonly string[]
}): void => {
  const vaultRoot = resolve(params.vaultPath)
  // Exclusion comparisons are case-folded so a hand-authored exclusion
  // still matches on a case-insensitive vault mount (macOS/Windows).
  const excludedExactPaths = new Set(params.excludePaths.map((path) => caseFoldPath(resolve(vaultRoot, path))))
  // resolve() strips trailing slashes, so append sep — without it,
  // prefix "sessions" also matches sibling "sessions-archive.md".
  const excludedPrefixes = params.excludePrefixes.map((prefix) => {
    const resolved = caseFoldPath(resolve(vaultRoot, prefix))
    return resolved.endsWith(sep) ? resolved : resolved + sep
  })

  const isForeignDirectory = existsSync(params.snapshotDir) && !isHarnessSnapshot(params.snapshotDir)

  if (isForeignDirectory) {
    throw new Error(
      `${params.snapshotDir} exists but is not a harness snapshot — remove it or choose another --work-dir`,
    )
  }
  rmSync(params.snapshotDir, { recursive: true, force: true })
  mkdirSync(params.snapshotDir, { recursive: true })
  // The marker is written in two phases. The empty ownership claim before
  // the copy lets a crashed run be deleted and rebuilt — the
  // foreign-directory guard would otherwise refuse it — and the provenance
  // follows only after the copy completes, so a partial snapshot never
  // passes the reuse check.
  writeFileSync(join(params.snapshotDir, SNAPSHOT_MARKER), "")
  cpSync(vaultRoot, params.snapshotDir, {
    recursive: true,
    filter: (source) => {
      const absoluteSource = resolve(source)
      const relativeFromRoot = relative(vaultRoot, absoluteSource)

      if (hasHiddenPathSegment(relativeFromRoot)) return false

      const foldedSource = caseFoldPath(absoluteSource)

      if (excludedExactPaths.has(foldedSource)) return false
      return !excludedPrefixes.some((prefix) => {
        return foldedSource.startsWith(prefix)
      })
    },
  })
  const provenance: SnapshotProvenance = {
    vaultPath: vaultRoot,
    excludePaths: [...params.excludePaths],
    excludePrefixes: [...params.excludePrefixes],
  }
  writeFileSync(join(params.snapshotDir, SNAPSHOT_MARKER), JSON.stringify(provenance))
}
