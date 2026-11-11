/** The Obsidian/Markdown link domain: recognizing links in text, parsing them
 *  into parts, extracting their targets from a note, and resolving a target to a
 *  vault path. Both the indexer (search/search-index.ts) and the link rewriter
 *  (vault-operations/note-mover.ts) depend on this module as a peer, so the two
 *  can never disagree about what a link is or where it points.
 *
 *  Recognition stays private so callers share the grammar and receive
 *  position-safe matches through the methods on `links`. */

import { posix } from "node:path"
import { classifyLines } from "./lines.js"

// ── Grammar (private) ───────────────────────────────────────────

/** JavaScript whitespace also includes non-ASCII spaces and line terminators. */
const WHITESPACE = /\s/

/** A URI scheme begins with an ASCII letter. */
const SCHEME_START = /[a-zA-Z]/

/** RFC 3986 permits these characters after a URI scheme's first letter. */
const SCHEME_CHARACTER = /[a-zA-Z0-9+.-]/

/** A dot without the s flag stops at each of these line terminators. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/** Matches inline code spans so links inside backticks (e.g. `[[Note]]`) can be
 *  ignored. Global — use only with matchAll/replaceAll. */
const INLINE_CODE_RE = /`+[^`\n]*`+/g

/** Splits a matched wikilink into [, embed `!`, target, `#heading`, `|alias`].
 *  Anchored and non-global — safe for .exec(). */
const WIKILINK_PARTS = /^(!?)\[\[([^\]#|]+)(#[^\]|]*)?(\|[^\]]+)?\]\]$/

/** Splits a matched markdown link into [, `[text](`, path-without-ext,
 *  extension-with-dot, `#heading`, `)`]. Any extension is captured
 *  ([text](Note.md), ![alt](image.png), [doc](file.pdf)); an extensionless
 *  target ([text](Extensionless%20Note)) parses with extension "". The
 *  extension group excludes "/" so a dot in a folder name is never misread
 *  as the extension. Anchored and non-global — safe for .exec(). */
const MD_LINK_PARTS = /^(\[[^\]]*\]\()([^)#\s]+?)(\.[^/.#\s]+)?(#[^)\s]*)?(\))$/

/** Safely decodes a URI component, falling back to the raw string if the
 *  percent-encoding is malformed (e.g. "100%complete"). */
const safeDecodeURIComponent = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Treats a trailing backslash as Obsidian's table-pipe escape (`[[path\|alias]]`), even
 *  outside a table, because Obsidian does not allow a backslash in a file name. */
const stripEscapedPipe = (target: string): string => target.replace(/\\$/, "")

// ── Types ───────────────────────────────────────────────────────

/** A link found in a single line, with the character offsets needed to splice a
 *  replacement around it. */
type LinkMatch = {
  text: string
  start: number
  end: number
  kind: "wikilink" | "markdown"
}

/** The half-open character range [start, end) of an inline code span in a line. */
type CodeSpan = { start: number; end: number }

type TargetSpan = CodeSpan & { targetStart: number; targetEnd: number }

/** The structural parts of a wikilink ![[target#heading|alias]]. heading/alias
 *  keep their leading `#` / `|` (or `\|` for table-escaped pipes) so
 *  reconstruction is plain concatenation; target is not trimmed (the caller
 *  trims). */
type WikilinkParts = {
  embed: string
  target: string
  heading: string
  alias: string
}

/** The structural parts of a markdown link [text](path.ext#heading). path and
 *  extension are both DECODED — path is the target without its extension;
 *  extension keeps its leading dot ("" for an extensionless target);
 *  prefix/closeParen/heading are verbatim literals for lossless
 *  reconstruction. */
type MarkdownLinkParts = {
  prefix: string
  path: string
  extension: string
  heading: string
  closeParen: string
}

// ── Line scanning ───────────────────────────────────────────────

/** Delimiter cursors only advance, so failed openers share suffix scans. */
const scanWikilinks = (text: string, visit: (span: TargetSpan) => void): void => {
  // A later opener can start inside text an earlier attempt already scanned.
  // That text holds no delimiter, so each search resumes from its cursor.
  let targetEnd = 0
  let headingEnd = 0
  let closeBracket = 0

  for (let start = 0; start < text.length; start++) {
    const open = text[start] === "!" ? start + 1 : start

    if (text[open] !== "[" || text[open + 1] !== "[") continue
    const targetStart = open + 2
    targetEnd = Math.max(targetEnd, targetStart)

    while (targetEnd < text.length && !"]#|".includes(text.charAt(targetEnd))) targetEnd++
    if (targetEnd === targetStart) continue
    let end = targetEnd

    if (text[end] === "#") {
      headingEnd = Math.max(headingEnd, end + 1)
      while (headingEnd < text.length && !"]|".includes(text.charAt(headingEnd))) headingEnd++
      end = headingEnd
    }
    if (text[end] === "|") {
      const aliasStart = end + 1
      closeBracket = Math.max(closeBracket, aliasStart)
      while (closeBracket < text.length && text[closeBracket] !== "]") closeBracket++
      // The grammar permits an empty heading, but requires a nonempty alias.
      if (closeBracket === aliasStart) continue
      end = closeBracket
    }
    if (text[end] !== "]" || text[end + 1] !== "]") continue
    visit({ start, end: end + 2, targetStart, targetEnd })
    // end + 1 is the second "]", and the loop's start++ moves past it.
    start = end + 1
  }
}

/** Finds markdown links `[text](target)` whose target can name a vault file.
 *  It skips a target that starts with `#`, a heading in the same note, and a
 *  target that starts with a URI scheme such as `https:`. URI schemes follow
 *  RFC 3986, including uppercase letters and punctuation. */
const scanMarkdownLinks = (text: string, visit: (span: TargetSpan) => void): void => {
  // Later openers reuse the same ] or reach a later one, so ]( target starts never move back.
  // A cached scheme end stays valid until a target starts beyond it.
  let textEnd = 0
  let targetEnd = 0
  let fragmentEnd = 0
  let schemeEnd = 0

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "[") continue
    textEnd = Math.max(textEnd, start + 1)
    while (textEnd < text.length && text[textEnd] !== "]") textEnd++
    if (text[textEnd + 1] !== "(") continue
    const targetStart = textEnd + 2

    if (text[targetStart] === "#") continue
    if (SCHEME_START.test(text.charAt(targetStart))) {
      schemeEnd = Math.max(schemeEnd, targetStart + 1)
      while (schemeEnd < text.length && SCHEME_CHARACTER.test(text.charAt(schemeEnd))) schemeEnd++
      if (text[schemeEnd] === ":") continue
    }
    targetEnd = Math.max(targetEnd, targetStart)
    while (
      targetEnd < text.length &&
      text[targetEnd] !== ")" &&
      text[targetEnd] !== "#" &&
      !WHITESPACE.test(text.charAt(targetEnd))
    )
      targetEnd++
    if (targetEnd === targetStart) continue
    // A fragment may be empty; whitespace still ends the attempted match.
    let end = targetEnd

    if (text[end] === "#") {
      fragmentEnd = Math.max(fragmentEnd, end + 1)
      while (
        fragmentEnd < text.length &&
        text[fragmentEnd] !== ")" &&
        !WHITESPACE.test(text.charAt(fragmentEnd))
      )
        fragmentEnd++
      end = fragmentEnd
    }
    if (text[end] !== ")") continue
    visit({ start, end: end + 1, targetStart, targetEnd })
    start = end
  }
}

/** Replaces each Templater plugin expression (`<% … %>`,
 *  https://silentvoid13.github.io/Templater/) with spaces of the same length,
 *  so links inside one are not extracted. Line terminators stop an expression
 *  even when the caller supplies a whole note. */
const maskTemplaterExpressions = (text: string): string => {
  const pieces: string[] = []
  // The closer cursor is shared by every failed opener before it.
  let close = 0
  let copiedThrough = 0

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "<" || text[start + 1] !== "%") continue
    close = Math.max(close, start + 2)
    while (close < text.length && !LINE_TERMINATOR.test(text.charAt(close))) {
      if (text[close] === "%" && text[close + 1] === ">") break
      close++
    }
    if (text[close] !== "%" || text[close + 1] !== ">") continue
    const end = close + 2
    pieces.push(text.slice(copiedThrough, start), " ".repeat(end - start))
    copiedThrough = end
    start = end - 1
  }
  if (pieces.length === 0) return text
  pieces.push(text.slice(copiedThrough))
  return pieces.join("")
}

/** Finds wikilinks, then markdown links (not in text order), with the offsets a rewriter
 *  needs to splice replacements. Links in inline code are kept for each caller to exclude. */
const matchLinksInLine = (line: string): LinkMatch[] => {
  const matches: LinkMatch[] = []
  scanWikilinks(line, ({ start, end }) => {
    matches.push({ text: line.slice(start, end), start, end, kind: "wikilink" })
  })
  scanMarkdownLinks(line, ({ start, end }) => {
    matches.push({ text: line.slice(start, end), start, end, kind: "markdown" })
  })
  return matches
}

/** Returns the character ranges of inline code spans in a line, so a rewriter can
 *  leave links inside backticks untouched. */
const inlineCodeSpans = (line: string): CodeSpan[] =>
  [...line.matchAll(INLINE_CODE_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))

// ── Parsing ─────────────────────────────────────────────────────

const stripExtension = (filePath: string): string => {
  const extension = posix.extname(filePath)
  return filePath.slice(0, filePath.length - extension.length)
}

/** Splits a matched wikilink, or returns null for malformed text.
 *  A trailing backslash moves from the target to the alias to preserve a table-pipe escape. */
const splitWikilink = (linkText: string): WikilinkParts | null => {
  const parts = WIKILINK_PARTS.exec(linkText)

  if (!parts) return null
  const [, embed, rawTarget, heading = "", rawAlias = ""] = parts

  // Both groups take part in every match; the check only narrows their types.
  if (embed === undefined || rawTarget === undefined) return null
  const hasEscapedPipe = rawTarget.endsWith("\\")
  const target = hasEscapedPipe ? rawTarget.slice(0, -1) : rawTarget
  const alias = hasEscapedPipe ? `\\${rawAlias}` : rawAlias
  return { embed, target, heading, alias }
}

/** Splits a matched markdown link into its parts (target decoded, extension
 *  captured separately), or null when the text is not a well-formed markdown
 *  link. Any vault target parses — notes, assets, and extensionless targets —
 *  so moveNote can rewrite all of them. The full target is decoded before the
 *  path/extension split: percent-encoding can hide the dot (photo%2Epng) or
 *  span the extension (photo.p%6Eg), so a split on the raw text would disagree
 *  with how extraction and Obsidian read the same link. */
const splitMarkdownLink = (linkText: string): MarkdownLinkParts | null => {
  const parts = MD_LINK_PARTS.exec(linkText)

  if (!parts) return null
  const prefix = parts[1]
  const encodedPath = parts[2]
  const encodedExtension = parts[3] ?? ""
  const heading = parts[4] ?? ""
  const closeParen = parts[5]
  const hasRequiredGroups =
    prefix !== undefined && encodedPath !== undefined && closeParen !== undefined

  if (!hasRequiredGroups) return null
  const decodedTarget = safeDecodeURIComponent(`${encodedPath}${encodedExtension}`)
  const path = stripExtension(decodedTarget)
  return {
    prefix,
    path,
    extension: decodedTarget.slice(path.length),
    heading,
    closeParen,
  }
}

// ── Extraction ──────────────────────────────────────────────────

/** Extracts link targets from a note body, skipping fenced code blocks and inline
 *  code spans. Returns deduplicated raw targets (pre-resolution). */
const extractFromBody = (content: string): string[] => {
  const targets = new Set<string>()

  for (const { text, inCode } of classifyLines(content)) {
    if (inCode) continue

    // Spaces keep text on either side of an ignored span from forming a new link.
    const withoutCode = text.replace(INLINE_CODE_RE, (match) => " ".repeat(match.length))
    const linkExtractableLine = maskTemplaterExpressions(withoutCode)

    scanWikilinks(linkExtractableLine, ({ targetStart, targetEnd }) => {
      const rawTarget = linkExtractableLine.slice(targetStart, targetEnd)
      const target = stripEscapedPipe(rawTarget.trim())

      if (target.length > 0) targets.add(target)
    })
    scanMarkdownLinks(linkExtractableLine, ({ targetStart, targetEnd }) => {
      const rawTarget = linkExtractableLine.slice(targetStart, targetEnd)
      const target = safeDecodeURIComponent(rawTarget.trim())

      if (target.length > 0) targets.add(target)
    })
  }
  return [...targets]
}

/** Extracts [[wikilink]] targets from frontmatter property values. Obsidian
 *  resolves wikilinks in any frontmatter property (e.g. `related:`), so they are
 *  real graph edges — body-only extraction silently drops them. Recursively walks
 *  strings, arrays, and nested objects, applying the wikilink grammar to every
 *  string. Frontmatter is YAML (no code fences or inline-code spans), so the body
 *  extractor's fence handling doesn't apply. Markdown [text](path.md) links are a
 *  body convention and are intentionally not scanned here. Returns deduplicated
 *  raw targets (pre-resolution), matching extractFromBody's contract. */
const extractFromFrontmatter = (data: Record<string, unknown>): string[] => {
  const targets = new Set<string>()

  // Walks one frontmatter value, adding every [[wikilink]] target it finds to
  // `targets`. A value is one of three shapes, so it recurses through the two
  // container shapes down to the string leaves.
  const collectWikilinksFrom = (frontmatterValue: unknown): void => {
    // Leaf: a string may hold one or more wikilinks — pull out each target.
    if (typeof frontmatterValue === "string") {
      scanWikilinks(frontmatterValue, ({ targetStart, targetEnd }) => {
        const rawTarget = frontmatterValue.slice(targetStart, targetEnd)
        const target = stripEscapedPipe(rawTarget.trim())

        if (target.length > 0) targets.add(target)
      })
      return
    }
    // Array (e.g. a multi-value `related:`): recurse into every element.
    if (Array.isArray(frontmatterValue)) {
      for (const item of frontmatterValue) collectWikilinksFrom(item)
      return
    }
    // Nested object: recurse into every value. The null guard is required —
    // `typeof null === "object"`, and Object.values(null) would throw.
    if (frontmatterValue !== null && typeof frontmatterValue === "object") {
      for (const nestedValue of Object.values(frontmatterValue)) {
        collectWikilinksFrom(nestedValue)
      }
    }
  }

  collectWikilinksFrom(data)
  return [...targets]
}

// ── Resolution ──────────────────────────────────────────────────

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
  comparableFormOf: (path: string) => string,
): ((paths: readonly string[]) => readonly ComparablePath[]) => {
  const comparablePathsByList = new WeakMap<readonly string[], readonly ComparablePath[]>()

  return (paths) => {
    const cachedComparablePaths = comparablePathsByList.get(paths)

    if (cachedComparablePaths) return cachedComparablePaths

    const comparablePaths = paths.map((storedPath) => {
      return { storedPath, comparablePath: comparableFormOf(storedPath) }
    })
    comparablePathsByList.set(paths, comparablePaths)
    return comparablePaths
  }
}

/** The folded note form lowercases every letter, because note resolution runs
 *  only in memory, so nothing narrows it to ASCII. */
const lowercaseNotePath = (path: string): string => path.toLowerCase()

const lowercaseNotePathsOf = createComparablePathsCache(lowercaseNotePath)

/** The folded asset form lowercases ASCII letters only, because every asset
 *  comparison has an SQL twin in the index (search/search-index.ts), and a
 *  wider fold would let the two resolvers pick different files for one link. */
const asciiFoldedAssetPathsOf = createComparablePathsCache(foldAsciiCase)

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
      lowercaseNotePathsOf(allPaths),
      (lowercasePath) => lowercasePath === comparablePath,
    )
  }

  // Exact path match ("path from vault folder"): "folder/Note.md" or "Note.md"
  const exactMatch = shortestOf(findPathsEqualTo(comparableTarget))

  if (exactMatch) return exactMatch

  // Relative-to-source match ("path from current file"): resolve the target
  // against the linking note's directory so "../C/target" and "sub/target"
  // land on the right note. posix.join collapses ".."/"."; a target that
  // escapes the vault keeps a leading ".." and simply won't be in allPaths.
  if (sourcePath) {
    const targetRelativeToSource = posix.join(posix.dirname(sourcePath), targetWithExtension)
    const relativeMatch = shortestOf(
      findPathsEqualTo(notePathForComparison(targetRelativeToSource, letterCase)),
    )

    if (relativeMatch) return relativeMatch
  }

  // A basename match is any path that ends with the whole target, folders
  // included, so [[sub/Note]] reaches A/sub/Note.md. A path equal to the
  // target already returned at the exact tier.
  const comparableSuffix = `/${comparableTarget}`
  const basenameMatches =
    letterCase === "exact"
      ? allPaths.filter((candidatePath) => candidatePath.endsWith(comparableSuffix))
      : findStoredPathsWhere(lowercaseNotePathsOf(allPaths), (lowercasePath) => {
          return lowercasePath.endsWith(comparableSuffix)
        })

  // With multiple matches, Obsidian's heuristic prefers the shortest path;
  // shortestOf also breaks equal-length ties lexicographically, so the
  // winner never depends on allPaths order (callers feed it from unordered
  // SQL scans that change across index rebuilds).
  return shortestOf(basenameMatches)
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
 *  matches it exactly. Returns null if unresolvable. The folded forms of
 *  `allPaths` are cached by the array, so the caller must not change it
 *  after the call. */
const resolve = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params
  const targetWithExtension = noteTargetWithExtension(target)

  return (
    resolveNoteInLetterCase({ targetWithExtension, allPaths, sourcePath, letterCase: "exact" }) ??
    resolveNoteInLetterCase({ targetWithExtension, allPaths, sourcePath, letterCase: "folded" })
  )
}

/** One pass over the asset tiers, with the exact, relative, stem exact, stem
 *  relative and bare-stem comparisons in `letterCase`. The two suffix tiers
 *  fold ASCII case in both passes, so in the folded pass they repeat the
 *  exact pass's miss. */
const resolveAssetInLetterCase = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath: string | undefined
  letterCase: LetterCase
}): string | null => {
  const { target, allAssetPaths, sourcePath, letterCase } = params
  const relativeTarget = sourcePath ? posix.join(posix.dirname(sourcePath), target) : null
  const comparableTarget = assetPathForComparison(target, letterCase)
  const comparableRelativeTarget =
    relativeTarget === null ? null : assetPathForComparison(relativeTarget, letterCase)

  const asciiFoldedAssetPaths = asciiFoldedAssetPathsOf(allAssetPaths)

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

  const exactMatch = shortestOf(findPathsWhere((assetPath) => assetPath === comparableTarget))

  if (exactMatch) return exactMatch

  if (comparableRelativeTarget !== null) {
    const relativeMatch = shortestOf(
      findPathsWhere((assetPath) => assetPath === comparableRelativeTarget),
    )

    if (relativeMatch) return relativeMatch
  }

  // The suffix tiers fold ASCII case because their SQL twins compare with
  // LIKE, which is ASCII-case-insensitive; the other tiers compare in the
  // pass's letter case because their twins compare with =, plain in the
  // exact pass and COLLATE NOCASE in the folded one.
  const foldedTargetSuffix = foldAsciiCase(`/${target}`)
  const fullPathSuffixMatch = shortestOf(
    findStoredPathsWhere(asciiFoldedAssetPaths, (foldedPath) => {
      return foldedPath.endsWith(foldedTargetSuffix)
    }),
  )

  if (fullPathSuffixMatch) return fullPathSuffixMatch

  // ── Stem family: exact → relative → suffix/basename ──

  const exactStemMatch = shortestOf(
    findPathsWhere((assetPath) => stripExtension(assetPath) === comparableTarget),
  )

  if (exactStemMatch) return exactStemMatch

  if (comparableRelativeTarget !== null) {
    const relativeStemMatch = shortestOf(
      findPathsWhere((assetPath) => stripExtension(assetPath) === comparableRelativeTarget),
    )

    if (relativeStemMatch) return relativeStemMatch
  }

  // A target with folder segments keeps them in the match (suffix on the
  // stem); a bare name matches on the filename stem only. Either way this is
  // the last tier: shortestOf returns null on no match — the unresolved case.
  if (target.includes("/")) {
    // ASCII folding keeps every "." and "/", so stripping the extension from
    // the folded path gives the folded stem.
    return shortestOf(
      findStoredPathsWhere(asciiFoldedAssetPaths, (foldedPath) => {
        return stripExtension(foldedPath).endsWith(foldedTargetSuffix)
      }),
    )
  }
  return shortestOf(
    findPathsWhere((assetPath) => stripExtension(posix.basename(assetPath)) === comparableTarget),
  )
}

/** Resolves a link target to a known non-markdown vault file, or null when no
 *  match exists. Pure array-based twin of the indexer's SQL-backed
 *  resolveNonMarkdownFile (search/search-index.ts) — same tiers, same family
 *  ordering — so the move rewriter and the index agree on where an asset link
 *  points. Handles both extensionless targets ([[Trip Route]] →
 *  Trip Route.canvas) and explicit-extension targets ([[photo.png]],
 *  ![img](../assets/photo.png)) in every form Obsidian resolves — exact path,
 *  relative to the source note, and basename/shortest path.
 *
 *  The full-filename tiers all run before any stem tier (extension-stripped
 *  paths): the families are NOT disjoint — a multi-dot filename's stem
 *  retains its inner dots ("photo.png.canvas" → stem "photo.png"), so a
 *  with-extension target can stem-match a different file. Family ordering
 *  makes the full-filename match win, while the stem tiers stay the fallback
 *  so [[photo.png]] with only photo.png.canvas in the vault still resolves —
 *  mirroring Obsidian's stem matching. An extensionless target can match in
 *  both families: the full-filename tiers hit an extensionless file
 *  (LICENSE, Dockerfile) by exact path or path suffix, and the stem tiers
 *  hit any file whose extension-stripped name matches.
 *
 *  The exact, relative and stem tiers run with exact letter case first, then
 *  again with ASCII letter case folded, so `![[Photo.PNG]]` reaches
 *  `photo.png` only when no file matches it exactly. The two path-suffix
 *  tiers fold ASCII case in the first pass too, so `![[photo.png]]` reaches
 *  the shorter of `A/Photo.PNG` and `B/sub/photo.png`. The folded forms of
 *  `allAssetPaths` are cached by the array, so the caller must not change it
 *  after the call. */
const resolveAsset = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allAssetPaths, sourcePath } = params

  return (
    resolveAssetInLetterCase({ target, allAssetPaths, sourcePath, letterCase: "exact" }) ??
    resolveAssetInLetterCase({ target, allAssetPaths, sourcePath, letterCase: "folded" })
  )
}

/** A note's complete link set — body links unioned with frontmatter wikilinks,
 *  deduplicated. Single source of truth for "what does this note link to",
 *  shared by incremental upsert and full rebuild — must not diverge. */
const extractAll = (content: string, data: Record<string, unknown>): string[] => [
  ...new Set([...extractFromBody(content), ...extractFromFrontmatter(data)]),
]

/** The link domain — grammar recognition, traversal, parsing, extraction, and
 *  resolution. Single namespace export so call sites read `links.resolve(...)`. */
export const links = {
  matchLinksInLine,
  inlineCodeSpans,
  splitWikilink,
  splitMarkdownLink,
  extractFromBody,
  extractFromFrontmatter,
  extractAll,
  resolve,
  resolveInExactCase,
  stripExtension,
  resolveAsset,
}
