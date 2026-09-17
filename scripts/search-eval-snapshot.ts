// ── Eval vault snapshot ────────────────────────────────────────

import { cpSync, mkdirSync, rmSync } from "node:fs"
import { resolve, sep } from "node:path"

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
