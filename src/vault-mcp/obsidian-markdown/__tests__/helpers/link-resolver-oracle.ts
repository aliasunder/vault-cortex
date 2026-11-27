/** A frozen copy of the scanning resolvers links.ts shipped before its
 *  per-list lookups: every tier scans the whole path list. The oracle tests
 *  compare the current resolvers with it, so their answers stay unchanged.
 *  Only the helpers both versions share come from links.ts. The comments are
 *  copied too, so they describe the index as it was then, with an SQL twin of
 *  the asset resolver. */

import { posix } from "node:path"
import { links } from "../../links.js"

const { isWithinLinkTargetLimit, stripExtension } = links

/** A link target's path segments without the "." and empty ones, which path
 *  normalization skips. */
const meaningfulSegments = (target: string): string[] => {
  return target.split("/").filter((segment) => segment !== "" && segment !== ".")
}

const countLeadingParentSegments = (segments: readonly string[]): number => {
  const firstNameIndex = segments.findIndex((segment) => segment !== "..")
  return firstNameIndex === -1 ? segments.length : firstNameIndex
}

/** Joins a link target to the linking note's folder ("path from current
 *  file"), or returns null when the target's leading ".." run climbs above the
 *  vault root, where no vault file is. Skipping that join keeps a long leading
 *  run of "../" from costing more than linear time. A caller bounds every other
 *  shape by checking isWithinLinkTargetLimit first. */
const joinToSourceFolder = (sourcePath: string, target: string): string | null => {
  const sourceFolder = posix.dirname(sourcePath)
  const leadingParentCount = countLeadingParentSegments(meaningfulSegments(target))
  const sourceFolderDepth = meaningfulSegments(sourceFolder).length

  if (leadingParentCount > sourceFolderDepth) return null
  return posix.join(sourceFolder, target)
}

/** Code-point count of a path — SQLite's length() metric, not the UTF-16
 *  code-unit count that String.length reports (they differ on paths with
 *  emoji or other non-BMP characters). */
const codePointLength = (path: string): number => [...path].length

/** Lowercases ASCII letters only, the fold SQLite applies in LIKE and in
 *  COLLATE NOCASE. */
const foldAsciiCase = (path: string): string => {
  return path.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Picks the winner among same-tier resolution matches: the shortest path,
 *  with a byte-order tiebreak for determinism — the same total order as the
 *  SQL resolver's ORDER BY length(path), path LIMIT 1 (code-point length,
 *  BINARY collation), so the array-based and SQL-backed resolvers can never
 *  pick different files for one target. The Buffer.compare tie-break is
 *  deliberately inline: this leaf layer cannot import utils, so it must
 *  stay in lockstep with utils/compare-utf8-bytes.ts. */
const shortestOf = (paths: string[]): string | null => {
  if (paths.length === 0) return null
  return paths.reduce((shortest, candidatePath) => {
    const candidateLength = codePointLength(candidatePath)
    const shortestLength = codePointLength(shortest)

    if (candidateLength < shortestLength) return candidatePath
    const tieBreaksEarlier =
      candidateLength === shortestLength &&
      Buffer.compare(Buffer.from(candidatePath), Buffer.from(shortest)) < 0
    return tieBreaksEarlier ? candidatePath : shortest
  })
}

/** How one resolution pass compares paths: in their own letter case, or with
 *  letter case folded. The folded pass runs only after the exact pass finds
 *  nothing, so a link that resolves with its own letter case keeps its target. */
type LetterCase = "exact" | "folded"

/** A stored path beside the form of it that one resolution pass compares. */
type ComparablePath = { storedPath: string; comparablePath: string }

/** Folds each list once, on its first lookup, however many links resolve
 *  against it. The cache is keyed by the list itself, so a caller must not
 *  change a list after passing it in. */
const createComparablePathsCache = (
  toComparablePath: (path: string) => string,
): ((paths: readonly string[]) => readonly ComparablePath[]) => {
  const comparablePathsByList = new WeakMap<readonly string[], readonly ComparablePath[]>()

  return (paths) => {
    const cachedComparablePaths = comparablePathsByList.get(paths)

    if (cachedComparablePaths) return cachedComparablePaths

    const comparablePaths = paths.map((storedPath) => {
      return { storedPath, comparablePath: toComparablePath(storedPath) }
    })
    comparablePathsByList.set(paths, comparablePaths)
    return comparablePaths
  }
}

/** The folded note form lowercases every letter, because note resolution runs
 *  only in memory, so nothing narrows it to ASCII. */
const lowercaseNotePath = (path: string): string => path.toLowerCase()

const getLowercaseNotePaths = createComparablePathsCache(lowercaseNotePath)

/** The folded asset form lowercases ASCII letters only, because every asset
 *  comparison has an SQL twin in the index (search/search-index.ts), and a
 *  wider fold would let the two resolvers pick different files for one link. */
const getAsciiFoldedAssetPaths = createComparablePathsCache(foldAsciiCase)

const findStoredPathsWhere = (
  comparablePaths: readonly ComparablePath[],
  comparablePathMatches: (comparablePath: string) => boolean,
): string[] => {
  return comparablePaths
    .filter(({ comparablePath }) => comparablePathMatches(comparablePath))
    .map(({ storedPath }) => storedPath)
}

/** The form of a note path or link target that one pass compares. */
const notePathForComparison = (path: string, letterCase: LetterCase): string => {
  switch (letterCase) {
    case "exact":
      return path
    case "folded":
      return lowercaseNotePath(path)
  }
}

/** The form of an asset path or link target that one pass compares. */
const assetPathForComparison = (path: string, letterCase: LetterCase): string => {
  switch (letterCase) {
    case "exact":
      return path
    case "folded":
      return foldAsciiCase(path)
  }
}

/** One pass over the three note tiers, comparing paths in `letterCase`. A
 *  match returns the stored path, never the link's spelling. */
const resolveNoteInLetterCase = (params: {
  targetWithExtension: string
  allPaths: readonly string[]
  sourcePath: string | undefined
  letterCase: LetterCase
}): string | null => {
  const { targetWithExtension, allPaths, sourcePath, letterCase } = params
  const comparableTarget = notePathForComparison(targetWithExtension, letterCase)

  // In the folded pass, two notes that differ only in letter case both match
  // one link, so every tier picks with shortestOf rather than taking the
  // first hit.
  const findPathsEqualTo = (comparablePath: string): string[] => {
    // Vault paths are unique, so the exact pass has at most one match, and
    // the native includes finds it without a call per path.
    if (letterCase === "exact") return allPaths.includes(comparablePath) ? [comparablePath] : []

    return findStoredPathsWhere(
      getLowercaseNotePaths(allPaths),
      (lowercasePath) => lowercasePath === comparablePath,
    )
  }

  // Exact path match ("path from vault folder"): "folder/Note.md" or "Note.md"
  const exactMatch = shortestOf(findPathsEqualTo(comparableTarget))

  if (exactMatch) return exactMatch

  // Relative-to-source match ("path from current file"): resolve the target
  // against the linking note's directory so "../C/target" and "sub/target"
  // land on the right note. The join collapses ".."/".". A target whose
  // leading ".." run climbs above the vault root gets no join; one that
  // escapes later, as "a/../../x" does from a note at the vault root, joins
  // to a path that starts with ".." and matches nothing in allPaths.
  const targetRelativeToSource = sourcePath
    ? joinToSourceFolder(sourcePath, targetWithExtension)
    : null

  if (targetRelativeToSource) {
    const relativeMatch = shortestOf(
      findPathsEqualTo(notePathForComparison(targetRelativeToSource, letterCase)),
    )

    if (relativeMatch) return relativeMatch
  }

  // A path-suffix match is any path that ends with the whole target, folders
  // included, so [[sub/Note]] reaches A/sub/Note.md. A path equal to the
  // target already returned at the exact tier.
  const comparableSuffix = `/${comparableTarget}`
  const pathSuffixMatches =
    letterCase === "exact"
      ? allPaths.filter((candidatePath) => candidatePath.endsWith(comparableSuffix))
      : findStoredPathsWhere(getLowercaseNotePaths(allPaths), (lowercasePath) => {
          return lowercasePath.endsWith(comparableSuffix)
        })

  // With multiple matches, Obsidian's heuristic prefers the shortest path;
  // shortestOf also breaks equal-length ties lexicographically, so the
  // winner never depends on allPaths order (callers feed it from unordered
  // SQL scans that change across index rebuilds).
  return shortestOf(pathSuffixMatches)
}

const noteTargetWithExtension = (target: string): string => {
  return target.endsWith(".md") ? target : `${target}.md`
}

/** Resolves a link target the way `resolve` does, but only in the link's own
 *  letter case, so `[[real]]` misses `Folder/Real.md`. A match means the link
 *  already spells the path in that path's letter case. */
const resolveInExactCase = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  return resolveNoteInLetterCase({
    targetWithExtension: noteTargetWithExtension(target),
    allPaths,
    sourcePath,
    letterCase: "exact",
  })
}

/** Resolves a link target to a vault-relative path using all known paths,
 *  covering Obsidian's three "New link format" modes: path from vault folder
 *  (exact), shortest path / basename, and — when the linking note's `sourcePath`
 *  is supplied — path from current file, including upward "../" segments.
 *  All three tiers run with exact letter case first, then again with letter
 *  case folded, so `[[real]]` reaches `Folder/Real.md` only when no note
 *  matches it exactly. Returns null if unresolvable, including for a target
 *  over the link-target limit. The folded forms of `allPaths` are cached by
 *  the array, so the caller must not change it after the call. */
const resolve = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const targetWithExtension = noteTargetWithExtension(target)

  return (
    resolveNoteInLetterCase({ targetWithExtension, allPaths, sourcePath, letterCase: "exact" }) ??
    resolveNoteInLetterCase({ targetWithExtension, allPaths, sourcePath, letterCase: "folded" })
  )
}

/** One pass over the asset tiers, with the exact, relative, stem exact, stem
 *  relative and bare-stem comparisons in `letterCase`. The two suffix tiers
 *  run in the exact pass only, as in the SQL twin's walks. */
const resolveAssetInLetterCase = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath: string | undefined
  letterCase: LetterCase
}): string | null => {
  const { target, allAssetPaths, sourcePath, letterCase } = params
  const relativeTarget = sourcePath ? joinToSourceFolder(sourcePath, target) : null
  const comparableTarget = assetPathForComparison(target, letterCase)
  const comparableRelativeTarget = relativeTarget
    ? assetPathForComparison(relativeTarget, letterCase)
    : null

  const asciiFoldedAssetPaths = getAsciiFoldedAssetPaths(allAssetPaths)

  // In the folded pass, two files that differ only in letter case both match
  // one link, so the exact tiers pick with shortestOf as the stem tiers do.
  const findPathsWhere = (comparablePathMatches: (comparablePath: string) => boolean): string[] => {
    switch (letterCase) {
      case "exact":
        return allAssetPaths.filter(comparablePathMatches)
      case "folded":
        return findStoredPathsWhere(asciiFoldedAssetPaths, comparablePathMatches)
    }
  }

  // ── Full-filename family: exact → relative → path suffix ──

  const exactMatch = shortestOf(
    findPathsWhere((comparableAssetPath) => comparableAssetPath === comparableTarget),
  )

  if (exactMatch) return exactMatch

  if (comparableRelativeTarget) {
    const relativeMatch = shortestOf(
      findPathsWhere((comparableAssetPath) => comparableAssetPath === comparableRelativeTarget),
    )

    if (relativeMatch) return relativeMatch
  }

  // The suffix tiers fold ASCII case because their SQL twins compare with
  // LIKE, which is ASCII-case-insensitive; the other tiers compare in the
  // pass's letter case because their twins compare with =, plain in the
  // exact pass and COLLATE NOCASE in the folded one. Folding already in the
  // exact pass, a suffix tier could only repeat its miss in the folded pass.
  const runsSuffixTiers = letterCase === "exact"
  const foldedTargetSuffix = foldAsciiCase(`/${target}`)
  const fullPathSuffixMatch = runsSuffixTiers
    ? shortestOf(
        findStoredPathsWhere(asciiFoldedAssetPaths, (foldedPath) => {
          return foldedPath.endsWith(foldedTargetSuffix)
        }),
      )
    : null

  if (fullPathSuffixMatch) return fullPathSuffixMatch

  // ── Stem family: exact → relative → suffix/basename ──

  const exactStemMatch = shortestOf(
    findPathsWhere(
      (comparableAssetPath) => stripExtension(comparableAssetPath) === comparableTarget,
    ),
  )

  if (exactStemMatch) return exactStemMatch

  if (comparableRelativeTarget) {
    const relativeStemMatch = shortestOf(
      findPathsWhere(
        (comparableAssetPath) => stripExtension(comparableAssetPath) === comparableRelativeTarget,
      ),
    )

    if (relativeStemMatch) return relativeStemMatch
  }

  // A target with folder segments keeps them in the match (suffix on the
  // stem, case folded like the other suffix tier); a bare name matches the
  // filename stem in the pass's letter case, as its SQL twin compares the
  // basename with =. Either way this is the pass's last tier: a miss ends
  // the pass with null.
  if (target.includes("/")) {
    if (!runsSuffixTiers) return null

    // ASCII folding keeps every "." and "/", so stripping the extension from
    // the folded path gives the folded stem.
    return shortestOf(
      findStoredPathsWhere(asciiFoldedAssetPaths, (foldedPath) => {
        return stripExtension(foldedPath).endsWith(foldedTargetSuffix)
      }),
    )
  }
  return shortestOf(
    findPathsWhere(
      (comparableAssetPath) =>
        stripExtension(posix.basename(comparableAssetPath)) === comparableTarget,
    ),
  )
}

/** Resolves a link target to a known non-markdown vault file, or null when no
 *  match exists, by the same tiers in the same order as links.resolveAsset. */
const resolveAsset = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allAssetPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  return (
    resolveAssetInLetterCase({ target, allAssetPaths, sourcePath, letterCase: "exact" }) ??
    resolveAssetInLetterCase({ target, allAssetPaths, sourcePath, letterCase: "folded" })
  )
}

export const linkResolverOracle = { resolve, resolveInExactCase, resolveAsset }
