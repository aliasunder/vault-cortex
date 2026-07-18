/** The Obsidian/Markdown link domain: recognizing links in text, parsing them
 *  into parts, extracting their targets from a note, and resolving a target to a
 *  vault path. Both the indexer (search/search-index.ts) and the link rewriter
 *  (vault-operations/note-mover.ts) depend on this module as a peer, so the two
 *  can never disagree about what a link is or where it points.
 *
 *  The raw `/g` grammar regexes are module-private: a shared global regex carries
 *  `lastIndex` between calls, which corrupts iteration the moment a caller reaches
 *  for `.exec()`-in-a-loop or `.test()`. Callers instead use the position-safe
 *  methods on `links` (matchLinksInLine, inlineCodeSpans), which drive the
 *  regexes only via matchAll/replaceAll internally. */

import { posix } from "node:path"
import { classifyLines } from "./lines.js"

// ── Grammar (private) ───────────────────────────────────────────

/** Matches wikilinks: [[target]], [[target|text]], [[target#heading]],
 *  [[target#heading|text]], and embeds ![[target]]. Captures the target
 *  path/name (group 1) before any # or |. Global — use only with matchAll. */
const WIKILINK_RE = /!?\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g

/** Matches markdown internal links and embeds to any vault target —
 *  [text](Note.md), ![alt](image.png), [doc](file.pdf), [text](Extensionless%20Note),
 *  each optionally with a #heading. Obsidian resolves all of these, so
 *  recognition must too. External targets are excluded by a URI-scheme
 *  lookahead ([a-zA-Z][a-zA-Z0-9+.-]*: is RFC 3986 scheme grammar; both letter
 *  cases because schemes are case-insensitive, and a colon is illegal in
 *  Obsidian filenames so a scheme-like prefix is never a vault path), plus
 *  same-page #anchors. Captures the full target including any extension
 *  (group 1). Global — use only with matchAll. */
const MD_LINK_RE =
  /\[[^\]]*\]\((?![a-zA-Z][a-zA-Z0-9+.-]*:|#)([^)#\s]+)(?:#[^)\s]*)?\)/g

/** Matches inline code spans so links inside backticks (e.g. `[[Note]]`) can be
 *  ignored. Global — use only with matchAll/replaceAll. */
const INLINE_CODE_RE = /`+[^`\n]*`+/g

/** Matches Templater expressions so links inside template directives
 *  (e.g. `<% tp.date.now("YYYY-MM-DD", 1, tp.file.title, "YYYY-MM-DD") %>`)
 *  are not extracted as link targets. Covers all Templater run-mode variants:
 *  `<%`  `<%+`  `<%*`  `<%-`  `<%_`  `<%~`. Single-line only — consistent
 *  with INLINE_CODE_RE. Global — use only with matchAll/replaceAll. */
const TEMPLATER_RE = /<%[-+*_~]?.*?%>/g

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

/** Strips a trailing backslash from a wikilink target. In Obsidian tables the
 *  pipe alias separator must be escaped as `\|` to avoid breaking column syntax.
 *  The WIKILINK_RE regex captures the `\` as part of the target — e.g.
 *  `[[path\|alias]]` yields group 1 = `path\`. Stripping the trailing backslash
 *  recovers the real target. Safe unconditionally: backslash is never valid in
 *  a file path on macOS or Windows, so a target ending in `\` is always an
 *  escaped pipe, never a legitimate path character. */
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

/** Finds every wikilink and markdown link in a single line, with the offsets a
 *  rewriter needs to splice replacements. Does not exclude inline code — the
 *  caller decides (via inlineCodeSpans), since the indexer and rewriter handle
 *  code spans differently. */
const matchLinksInLine = (line: string): LinkMatch[] => [
  ...[...line.matchAll(WIKILINK_RE)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    kind: "wikilink" as const,
  })),
  ...[...line.matchAll(MD_LINK_RE)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    kind: "markdown" as const,
  })),
]

/** Returns the character ranges of inline code spans in a line, so a rewriter can
 *  leave links inside backticks untouched. */
const inlineCodeSpans = (line: string): CodeSpan[] =>
  [...line.matchAll(INLINE_CODE_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))

// ── Parsing ─────────────────────────────────────────────────────

/** Splits a matched wikilink into its parts, or null when the text is not a
 *  well-formed wikilink. A trailing `\` on the target (from Obsidian's `\|`
 *  table-pipe escape) is always stripped — consistent with stripEscapedPipe's
 *  rule that backslash is never valid in a file path — and shifted into the
 *  alias so reconstruction via concatenation preserves the escape. */
const splitWikilink = (linkText: string): WikilinkParts | null => {
  const parts = WIKILINK_PARTS.exec(linkText)
  if (!parts) return null
  const [, embed, rawTarget, heading = "", rawAlias = ""] = parts
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
    prefix !== undefined &&
    encodedPath !== undefined &&
    closeParen !== undefined
  if (!hasRequiredGroups) return null
  const decodedTarget = safeDecodeURIComponent(
    `${encodedPath}${encodedExtension}`,
  )
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

    const linkExtractableLine = text
      .replace(INLINE_CODE_RE, (match) => " ".repeat(match.length))
      .replace(TEMPLATER_RE, (match) => " ".repeat(match.length))

    for (const match of linkExtractableLine.matchAll(WIKILINK_RE)) {
      const rawTarget = match[1]
      if (rawTarget === undefined) continue
      const target = stripEscapedPipe(rawTarget.trim())
      if (target.length > 0) targets.add(target)
    }
    for (const match of linkExtractableLine.matchAll(MD_LINK_RE)) {
      const rawTarget = match[1]
      if (rawTarget === undefined) continue
      const target = safeDecodeURIComponent(rawTarget.trim())
      if (target.length > 0) targets.add(target)
    }
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
      for (const match of frontmatterValue.matchAll(WIKILINK_RE)) {
        const rawTarget = match[1]
        if (rawTarget === undefined) continue
        const target = stripEscapedPipe(rawTarget.trim())
        if (target.length > 0) targets.add(target)
      }
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

/** Resolves a link target to a vault-relative path using all known paths,
 *  covering Obsidian's three "New link format" modes: path from vault folder
 *  (exact), shortest path / basename, and — when the linking note's `sourcePath`
 *  is supplied — path from current file, including upward "../" segments.
 *  Returns null if unresolvable. */
const resolve = (
  target: string,
  allPaths: string[],
  sourcePath?: string,
): string | null => {
  const targetWithExtension = target.endsWith(".md") ? target : `${target}.md`

  // Exact path match ("path from vault folder"): "folder/Note.md" or "Note.md"
  if (allPaths.includes(targetWithExtension)) return targetWithExtension

  // Relative-to-source match ("path from current file"): resolve the target
  // against the linking note's directory so "../C/target" and "sub/target"
  // land on the right note. posix.join collapses ".."/"."; a target that
  // escapes the vault keeps a leading ".." and simply won't be in allPaths.
  if (sourcePath) {
    const targetRelativeToSource = posix.join(
      posix.dirname(sourcePath),
      targetWithExtension,
    )
    if (allPaths.includes(targetRelativeToSource)) return targetRelativeToSource
  }

  // Basename match: find all paths that end with the target filename
  const basenameMatches = allPaths.filter(
    (candidatePath) =>
      candidatePath === targetWithExtension ||
      candidatePath.endsWith(`/${targetWithExtension}`),
  )
  const onlyMatch =
    basenameMatches.length === 1 ? basenameMatches[0] : undefined
  if (onlyMatch) return onlyMatch
  // Multiple matches: prefer the shortest path (Obsidian's resolution heuristic)
  if (basenameMatches.length > 1) {
    return basenameMatches.reduce((shortest, candidatePath) =>
      candidatePath.length < shortest.length ? candidatePath : shortest,
    )
  }

  return null
}

/** Strips the file extension from a path, or returns the path unchanged when
 *  the filename has no extension. Uses the last dot in the filename (not the
 *  path), so a multi-dot name keeps its inner dots ("photo.png.canvas" →
 *  "photo.png") and dots in folder names are ignored. A leading-dot file
 *  (".hidden") has no extension. */
const stripExtension = (filePath: string): string => {
  const fileName = posix.basename(filePath)
  const dotIndex = fileName.lastIndexOf(".")
  if (dotIndex <= 0) return filePath
  return filePath.slice(0, filePath.length - (fileName.length - dotIndex))
}

/** Picks the winner among same-tier resolution matches: the shortest path,
 *  with a lexicographic tiebreak for determinism — mirroring the SQL
 *  resolver's ORDER BY length(path), path LIMIT 1. */
const shortestOf = (paths: string[]): string | null => {
  if (paths.length === 0) return null
  return paths.reduce((shortest, candidatePath) =>
    candidatePath.length < shortest.length ||
    (candidatePath.length === shortest.length && candidatePath < shortest)
      ? candidatePath
      : shortest,
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
 *  mirroring Obsidian's stem matching. Extensionless targets fall through the
 *  full-filename family unmatched (stored paths always carry an extension). */
const resolveAsset = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allAssetPaths, sourcePath } = params
  const relativeTarget = sourcePath
    ? posix.join(posix.dirname(sourcePath), target)
    : null

  // ── Full-filename family: exact → relative → path suffix ──

  if (allAssetPaths.includes(target)) return target

  if (relativeTarget && allAssetPaths.includes(relativeTarget)) {
    return relativeTarget
  }

  const fullPathSuffixMatch = shortestOf(
    allAssetPaths.filter((assetPath) => assetPath.endsWith(`/${target}`)),
  )
  if (fullPathSuffixMatch) return fullPathSuffixMatch

  // ── Stem family: exact → relative → suffix/basename ──

  const exactStemMatch = shortestOf(
    allAssetPaths.filter((assetPath) => stripExtension(assetPath) === target),
  )
  if (exactStemMatch) return exactStemMatch

  if (relativeTarget) {
    const relativeStemMatch = shortestOf(
      allAssetPaths.filter(
        (assetPath) => stripExtension(assetPath) === relativeTarget,
      ),
    )
    if (relativeStemMatch) return relativeStemMatch
  }

  // A target with folder segments keeps them in the match (suffix on the
  // stem); a bare name matches on the filename stem only. Either way this is
  // the last tier: shortestOf returns null on no match — the unresolved case.
  if (target.includes("/")) {
    return shortestOf(
      allAssetPaths.filter((assetPath) =>
        stripExtension(assetPath).endsWith(`/${target}`),
      ),
    )
  }
  return shortestOf(
    allAssetPaths.filter(
      (assetPath) => stripExtension(posix.basename(assetPath)) === target,
    ),
  )
}

/** A note's complete link set — body links unioned with frontmatter wikilinks,
 *  deduplicated. Single source of truth for "what does this note link to",
 *  shared by incremental upsert and full rebuild — must not diverge. */
const extractAll = (
  content: string,
  data: Record<string, unknown>,
): string[] => [
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
  stripExtension,
  resolveAsset,
}
