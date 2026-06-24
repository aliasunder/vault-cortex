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

/** Matches markdown internal links to .md files: [text](path.md) or
 *  [text](path.md#heading). Excludes external URLs and non-.md assets (images,
 *  PDFs). Captures the path without extension (group 1). Global — matchAll only. */
const MD_LINK_RE =
  /\[[^\]]*\]\((?!https?:\/\/|mailto:|#)([^)#\s]+?)\.md(?:#[^)\s]*)?\)/g

/** Matches inline code spans so links inside backticks (e.g. `[[Note]]`) can be
 *  ignored. Global — use only with matchAll/replaceAll. */
const INLINE_CODE_RE = /`+[^`\n]*`+/g

/** Splits a matched wikilink into [, embed `!`, target, `#heading`, `|alias`].
 *  Anchored and non-global — safe for .exec(). */
const WIKILINK_PARTS = /^(!?)\[\[([^\]#|]+)(#[^\]|]*)?(\|[^\]]+)?\]\]$/

/** Splits a matched markdown link into [, `[text](`, path-without-ext, `#heading`,
 *  `)`]. Anchored and non-global — safe for .exec(). */
const MD_LINK_PARTS = /^(\[[^\]]*\]\()([^)#\s]+?)\.md(#[^)\s]*)?(\))$/

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

/** The structural parts of a markdown link [text](path.md#heading). path is the
 *  DECODED target without the .md extension; prefix/closeParen/heading are
 *  verbatim literals for lossless reconstruction. */
type MarkdownLinkParts = {
  prefix: string
  path: string
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
 *  well-formed wikilink. Escaped table pipes (`\|`) are normalized: the trailing
 *  `\` is stripped from target and shifted into the alias, so reconstruction via
 *  concatenation preserves the escape. */
const splitWikilink = (linkText: string): WikilinkParts | null => {
  const parts = WIKILINK_PARTS.exec(linkText)
  if (!parts) return null
  const [, embed, rawTarget, heading = "", rawAlias = ""] = parts
  const hasEscapedPipe = rawTarget!.endsWith("\\") && rawAlias !== ""
  const target = hasEscapedPipe ? rawTarget!.slice(0, -1) : rawTarget!
  const alias = hasEscapedPipe ? `\\${rawAlias}` : rawAlias
  return { embed: embed!, target, heading, alias }
}

/** Splits a matched markdown link into its parts (path decoded, .md stripped), or
 *  null when the text is not a well-formed .md link. */
const splitMarkdownLink = (linkText: string): MarkdownLinkParts | null => {
  const parts = MD_LINK_PARTS.exec(linkText)
  if (!parts) return null
  const [, prefix, encodedPath, heading = "", closeParen] = parts
  return {
    prefix: prefix!,
    path: safeDecodeURIComponent(encodedPath!),
    heading,
    closeParen: closeParen!,
  }
}

// ── Extraction ──────────────────────────────────────────────────

/** Extracts link targets from a note body, skipping fenced code blocks and inline
 *  code spans. Returns deduplicated raw targets (pre-resolution). */
const extractFromBody = (content: string): string[] => {
  const targets = new Set<string>()

  for (const { text, inCode } of classifyLines(content)) {
    if (inCode) continue

    // Replace inline code spans with spaces so links inside backticks are ignored.
    const withoutInlineCode = text.replace(INLINE_CODE_RE, (match) =>
      " ".repeat(match.length),
    )

    for (const match of withoutInlineCode.matchAll(WIKILINK_RE)) {
      const target = stripEscapedPipe(match[1]!.trim())
      if (target.length > 0) targets.add(target)
    }
    for (const match of withoutInlineCode.matchAll(MD_LINK_RE)) {
      const target = safeDecodeURIComponent(match[1]!.trim())
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
        const target = stripEscapedPipe(match[1]!.trim())
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
  if (basenameMatches.length === 1) return basenameMatches[0]!
  // Multiple matches: prefer the shortest path (Obsidian's resolution heuristic)
  if (basenameMatches.length > 1) {
    return basenameMatches.reduce((shortest, candidatePath) =>
      candidatePath.length < shortest.length ? candidatePath : shortest,
    )
  }

  return null
}

/** The link domain — grammar recognition, traversal, parsing, extraction, and
 *  resolution. Single namespace export so call sites read `links.resolve(...)`. */
export const links = {
  matchLinksInLine,
  inlineCodeSpans,
  splitWikilink,
  splitMarkdownLink,
  extractFromBody,
  extractFromFrontmatter,
  resolve,
}
