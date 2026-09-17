// ── Eval vault snapshot ────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { hasHiddenPathSegment } from "../src/utils/has-hidden-path-segment.js"

/** Marks a directory as harness-created so the pre-copy delete can never
 *  destroy an operator's own same-named folder under --work-dir. */
const SNAPSHOT_MARKER = ".search-eval-snapshot"

/** True when the directory exists and carries the harness marker — the only
 *  directories the harness may delete, or adopt via --reuse-snapshot. */
export const isHarnessSnapshot = (snapshotDir: string): boolean => {
  return (
    existsSync(snapshotDir) && existsSync(join(snapshotDir, SNAPSHOT_MARKER))
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
  const excludedExactPaths = new Set(
    params.excludePaths.map((path) => resolve(vaultRoot, path)),
  )
  // resolve() strips trailing slashes, so append sep — without it,
  // prefix "sessions" also matches sibling "sessions-archive.md".
  const excludedPrefixes = params.excludePrefixes.map((prefix) => {
    const resolved = resolve(vaultRoot, prefix)
    return resolved.endsWith(sep) ? resolved : resolved + sep
  })

  const isForeignDirectory =
    existsSync(params.snapshotDir) && !isHarnessSnapshot(params.snapshotDir)
  if (isForeignDirectory) {
    throw new Error(
      `${params.snapshotDir} exists but is not a harness snapshot — remove it or choose another --work-dir`,
    )
  }
  rmSync(params.snapshotDir, { recursive: true, force: true })
  mkdirSync(params.snapshotDir, { recursive: true })
  writeFileSync(join(params.snapshotDir, SNAPSHOT_MARKER), "")
  cpSync(vaultRoot, params.snapshotDir, {
    recursive: true,
    filter: (source) => {
      const absoluteSource = resolve(source)
      const relativeFromRoot = relative(vaultRoot, absoluteSource)
      if (hasHiddenPathSegment(relativeFromRoot)) return false
      if (excludedExactPaths.has(absoluteSource)) return false
      return !excludedPrefixes.some((prefix) => {
        return absoluteSource.startsWith(prefix)
      })
    },
  })
}
