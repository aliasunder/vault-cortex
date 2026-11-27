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

/** JavaScript's line terminators: LF, CR, the line separator (U+2028) and
 *  the paragraph separator (U+2029). */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/** Matches inline code spans so links inside backticks (e.g. `[[Note]]`) can be
 *  ignored. Global — use only with matchAll/replaceAll. */
const INLINE_CODE_RE = /`+[^`\n]*`+/g

/** Splits a matched wikilink into capture groups 1–4: embed `!`, target,
 *  `#heading`, `|alias`. Anchored and non-global — safe for .exec().
 *  scanWikilinks finds the links this parses, so the two must accept the same
 *  grammar. */
const WIKILINK_PARTS = /^(!?)\[\[([^\]#|]+)(#[^\]|]*)?(\|[^\]]+)?\]\]$/

/** Splits a matched markdown link into capture groups 1–5: `[text](`,
 *  path-without-ext, extension-with-dot, `#heading`, `)`. Any extension is captured
 *  ([text](Note.md), ![alt](image.png), [doc](file.pdf)); an extensionless
 *  target ([text](Extensionless%20Note)) parses with extension "". The
 *  extension group excludes "/" so a dot in a folder name is never misread
 *  as the extension. Anchored and non-global — safe for .exec().
 *  scanMarkdownLinks finds the links this parses: the two must agree on the
 *  target and `#heading` grammar. The scanner alone skips URLs; neither
 *  accepts a heading-only target (`[a](#Heading)`). */
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

/** A link a scanner found: [start, end) covers the whole link, and
 *  [targetStart, targetEnd) its target alone, without any `#heading` or `|alias`. */
type LinkSpan = { start: number; end: number; targetStart: number; targetEnd: number }

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

/** Calls `visit` for each wikilink in `text`, left to right and never
 *  overlapping: `[[target#heading|alias]]`, with an optional `!` embed prefix.
 *  The target must be nonempty and the heading may be empty, but an alias
 *  must not be. */
const scanWikilinks = (text: string, visit: (span: LinkSpan) => void): void => {
  // Each delimiter cursor outlives a failed opener and only moves forward: a
  // later opener finds no delimiter before the one already found. This keeps
  // the scan linear on a line where many `[[` never close.
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
      if (closeBracket === aliasStart) continue
      end = closeBracket
    }
    if (text[end] !== "]" || text[end + 1] !== "]") continue
    visit({ start, end: end + 2, targetStart, targetEnd })
    // end + 1 is the second "]", and the loop's start++ moves past it.
    start = end + 1
  }
}

/** Calls `visit` for each markdown link `[text](target#heading)` in `text`,
 *  left to right and never overlapping. The heading may be empty, and
 *  whitespace ends the attempt. Skipped targets:
 *  - a heading alone (`[a](#Heading)`), which points into the same note;
 *  - one that opens with a URI scheme (`https:`, `mailto:`), an external link. */
// eslint-disable-next-line complexity -- this function is over the limit; split it before adding a branch
const scanMarkdownLinks = (text: string, visit: (span: LinkSpan) => void): void => {
  // Each cursor outlives a failed opener and only moves forward, which keeps
  // the scan linear on a line where many `[` never close:
  // - a later opener reaches the same `]` or a later one, so its target never
  //   starts further left;
  // - a scheme run holds no `]`, so after the same `]` the earlier run is the
  //   one to reuse, and after a later `]` it ended before the new target.
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
    // A URI scheme is a letter, then letters, digits, `+`, `.` or `-`, then `:` (RFC 3986).
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
    ) {
      targetEnd++
    }
    if (targetEnd === targetStart) continue
    let end = targetEnd

    if (text[end] === "#") {
      fragmentEnd = Math.max(fragmentEnd, end + 1)
      while (
        fragmentEnd < text.length &&
        text[fragmentEnd] !== ")" &&
        !WHITESPACE.test(text.charAt(fragmentEnd))
      ) {
        fragmentEnd++
      }
      end = fragmentEnd
    }
    if (text[end] !== ")") continue
    visit({ start, end: end + 1, targetStart, targetEnd })
    start = end
  }
}

/** Replaces each Templater expression in `text` with as many spaces, so links
 *  inside one are not extracted and every offset after it stays the same.
 *  - Templater is an Obsidian plugin whose `<% … %>` (and `<%+ … %>`)
 *    expressions run when a template is applied; links in them are template
 *    code, not links in the note.
 *  - An expression must close before the next line terminator, so a CR or a
 *    Unicode line separator inside `text` ends it too. */
const maskTemplaterExpressions = (text: string): string => {
  const pieces: string[] = []
  // The closer cursor outlives a failed opener: a later opener finds no `%>`
  // or line terminator before it.
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
 *  needs to splice replacements. Links in inline code are kept for each caller to exclude.
 *  The two kinds can overlap: in `[x](a[[b]])`, the wikilink sits inside the
 *  markdown link's target. */
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

/** The key that pairs a link's text with the files it could name. A link and
 *  a file a resolver could match must share a key; a key shared more widely
 *  costs only an extra re-resolve of the search index's links rows, which
 *  store it as link_name. The key is:
 *  - the last path segment, minus one trailing ".md" (case-sensitive, as
 *    noteTargetWithExtension adds it), lowercased;
 *  - "ς" folded to "σ", because toLowerCase turns a capital "Σ" into either one depending
 *    on what follows it, so one name could otherwise lowercase two ways. */
const pathToLinkName = (path: string): string => {
  const lastSegment = posix.basename(path)
  const name = lastSegment.endsWith(".md") ? lastSegment.slice(0, -".md".length) : lastSegment
  return name.toLowerCase().replaceAll("ς", "σ")
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
  const target = stripEscapedPipe(rawTarget)
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

// ── Link-target limits ──────────────────────────────────────────

/** Linux's PATH_MAX is 4,096 bytes and counts the terminating NUL, so no file
 *  path is longer than this. It must match MAX_PATH_BYTES in
 *  utils/assert-path-within-max-length.ts, which this leaf layer cannot import. */
const MAX_PATH_BYTES = 4095

/** The longest link Obsidian writes from the current file, 10,236 bytes. Such
 *  a link climbs at most one "../" per folder of the linking note, and a note
 *  sits at most 2,047 folders deep (a folder takes at least 2 bytes with its
 *  slash, the file name at least 1). It then names a path of at most
 *  MAX_PATH_BYTES. */
const MAX_RELATIVE_LINK_BYTES = "../".length * 2047 + MAX_PATH_BYTES

/** A link target's path segments without the "." and empty ones, which path
 *  normalization skips. */
const meaningfulSegments = (target: string): string[] => {
  return target.split("/").filter((segment) => segment !== "" && segment !== ".")
}

const countLeadingParentSegments = (segments: readonly string[]): number => {
  const firstNameIndex = segments.findIndex((segment) => segment !== "..")
  return firstNameIndex === -1 ? segments.length : firstNameIndex
}

/** Whether a link target is within the length limits that every link Obsidian
 *  writes meets. Extraction skips a target over them, and resolution finds no
 *  match for it. A target fits when it is:
 *  - at most MAX_PATH_BYTES of UTF-8, in any shape;
 *  - at most MAX_RELATIVE_LINK_BYTES, with every ".." segment before every
 *    other segment, ignoring "." and empty ones, as in a link from the
 *    current file.
 *
 *  Two steps cost more than linear time on a longer crafted target:
 *  - normalizing it with posix.join in joinToSourceFolder;
 *  - deduplicating it in the extractors' Sets, because V8 hashes a string longer than 16,383
 *    characters by its length alone, so a Set of many such targets of one
 *    length compares each new target with all of them. */
const isWithinLinkTargetLimit = (target: string): boolean => {
  const targetBytes = Buffer.byteLength(target, "utf8")

  if (targetBytes <= MAX_PATH_BYTES) return true
  if (targetBytes > MAX_RELATIVE_LINK_BYTES) return false

  const segments = meaningfulSegments(target)
  const leadingParentCount = countLeadingParentSegments(segments)
  return !segments.slice(leadingParentCount).includes("..")
}

const isExtractableTarget = (target: string): boolean => {
  return target.length > 0 && isWithinLinkTargetLimit(target)
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

// ── Extraction ──────────────────────────────────────────────────

/** Extracts link targets from a note body, skipping fenced code blocks and inline
 *  code spans. Returns deduplicated raw targets (pre-resolution) within the
 *  link-target limit. */
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

      if (isExtractableTarget(target)) targets.add(target)
    })
    scanMarkdownLinks(linkExtractableLine, ({ targetStart, targetEnd }) => {
      const rawTarget = linkExtractableLine.slice(targetStart, targetEnd)
      const target = safeDecodeURIComponent(rawTarget.trim())

      if (isExtractableTarget(target)) targets.add(target)
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
 *  raw targets (pre-resolution) within the link-target limit, matching
 *  extractFromBody's contract. */
const extractFromFrontmatter = (data: Record<string, unknown>): string[] => {
  const targets = new Set<string>()

  // Walks one frontmatter value, adding every [[wikilink]] target it finds to
  // `targets`. A string holds links, an array or object recurses into its
  // values, and anything else (a number, a boolean, null) holds no link.
  const collectWikilinksFrom = (frontmatterValue: unknown): void => {
    // Leaf: a string may hold one or more wikilinks — pull out each target.
    if (typeof frontmatterValue === "string") {
      scanWikilinks(frontmatterValue, ({ targetStart, targetEnd }) => {
        const rawTarget = frontmatterValue.slice(targetStart, targetEnd)
        const target = stripEscapedPipe(rawTarget.trim())

        if (isExtractableTarget(target)) targets.add(target)
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

/** Code-point count of a path, not the UTF-16 code-unit count that
 *  String.length reports, so a non-BMP character, which takes two UTF-16
 *  units, counts as one. */
const codePointLength = (path: string): number => [...path].length

/** Lowercases ASCII letters only, the fold resolveAsset compares
 *  non-markdown paths with. */
const foldAsciiCase = (path: string): string => {
  return path.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Orders same-tier resolution matches, winner first: the path with fewer
 *  code points, then the one earlier in UTF-8 byte order, so the winner never
 *  depends on the order of the path list. The Buffer.compare tie-break is
 *  the order of compareByUtf8Bytes in utils/compare-utf8-bytes.ts, written
 *  inline because this leaf layer cannot import utils. */
const compareShortestPathFirst = (leftPath: string, rightPath: string): number => {
  const lengthDifference = codePointLength(leftPath) - codePointLength(rightPath)

  if (lengthDifference !== 0) return lengthDifference
  return Buffer.compare(Buffer.from(leftPath), Buffer.from(rightPath))
}

/** Wraps `build` so it runs on the first call only; every call returns what it built. */
const buildOnFirstCall = <Built>(build: () => Built): (() => Built) => {
  // Empty until the first call. The wrapper object tells a value that is
  // built but undefined apart from one not built yet.
  let builtValue: { value: Built } | undefined

  return () => {
    builtValue ??= { value: build() }
    return builtValue.value
  }
}

/** How one resolution pass compares paths: in their own letter case, or with
 *  letter case folded. The folded pass runs only after the exact pass finds
 *  nothing, so a link that resolves with its own letter case keeps its target. */
type LetterCase = "exact" | "folded"

/** A stored path beside its comparable path, the path in one pass's letter
 *  case. A lookup's form is what its `toForm` derives from the comparable
 *  path: the path itself, the path without its extension, or the file name
 *  without its extension. */
type ComparablePath = { storedPath: string; comparablePath: string }

/** The shortest stored path whose form equals `form`, or null. */
type FormLookup = (form: string) => string | null

/** The shortest stored path whose form ends with "/" followed by
 *  `formSuffix`, or null. A path whose form equals `formSuffix` does not
 *  count, because the resolver's equality tiers match that case. */
type SuffixLookup = (formSuffix: string) => string | null

/** Builds a map from each form of a list's paths to the shortest stored path
 *  with that form, on the first lookup. */
const createFormLookup = (params: {
  getComparablePaths: () => readonly ComparablePath[]
  toForm: (comparablePath: string) => string
}): FormLookup => {
  const { getComparablePaths, toForm } = params

  const getShortestPathByForm = buildOnFirstCall(() => {
    const shortestPathByForm = new Map<string, string>()
    for (const { storedPath, comparablePath } of getComparablePaths()) {
      const form = toForm(comparablePath)
      const shortestPathSoFar = shortestPathByForm.get(form)
      // Most forms belong to one path, so the comparison, which measures both
      // paths, runs only when a second path shares the form.
      const isShortestSoFar =
        shortestPathSoFar === undefined ||
        compareShortestPathFirst(storedPath, shortestPathSoFar) < 0

      if (isShortestSoFar) shortestPathByForm.set(form, storedPath)
    }
    return shortestPathByForm
  })

  return (form) => getShortestPathByForm().get(form) ?? null
}

/** A stored path with the folder segments of its form, the segments before
 *  its last one. */
type FolderedPath = { storedPath: string; folderSegments: readonly string[] }

/** A node's paths stay in one list until a lookup first walks to one of the
 *  node's children. The lookup then splits the list into child nodes by each
 *  path's next folder segment toward the start of the path, and the node
 *  drops the list. */
type SuffixBranches =
  | { status: "unsplit"; longerPaths: readonly FolderedPath[] }
  | { status: "split"; childrenBySegment: ReadonlyMap<string, SuffixNode> }

/** A node of one last segment's suffix tree. Its paths all end with the last
 *  segment and the `depth` folder segments walked to reach the node, and each
 *  has at least one more folder segment before them. */
type SuffixNode = {
  depth: number
  /** The node's shortest path, or null when the node holds none. */
  shortestLongerPath: string | null
  branches: SuffixBranches
}

/** A node over `paths`, which must be ordered shortest first. */
const createSuffixNode = (params: {
  paths: readonly FolderedPath[]
  depth: number
}): SuffixNode => {
  const { paths, depth } = params
  // A path with exactly `depth` folder segments has a form equal to the
  // suffix that walked here, which a suffix lookup excludes, so the node
  // keeps only the paths longer than that suffix.
  const longerPaths = paths.filter((path) => path.folderSegments.length > depth)

  return {
    depth,
    shortestLongerPath: longerPaths[0]?.storedPath ?? null,
    branches: { status: "unsplit", longerPaths },
  }
}

/** The child of `node` whose paths have `segment` as their next folder segment
 *  toward the start of the path, or undefined when no path does. The first
 *  call splits the node in place, so the tree holds each path once and has
 *  nodes only for the children of nodes a lookup walked through. */
const findSuffixChild = (node: SuffixNode, segment: string): SuffixNode | undefined => {
  if (node.branches.status === "unsplit") {
    // Map.groupBy keeps each group in list order, so each child's paths stay
    // shortest first. The key is the folder segment `depth` places before
    // the path's last folder segment, counted from the end.
    const pathsBySegment = Map.groupBy(node.branches.longerPaths, (path) => {
      const nextSegment = path.folderSegments.at(-1 - node.depth)

      // createSuffixNode kept only paths with a folder segment at this depth.
      if (nextSegment === undefined) throw new Error("suffix node holds a path too short for it")
      return nextSegment
    })
    const childrenBySegment = new Map(
      [...pathsBySegment].map(([nextSegment, nextPaths]) => {
        return [nextSegment, createSuffixNode({ paths: nextPaths, depth: node.depth + 1 })]
      }),
    )
    node.branches = { status: "split", childrenBySegment }
  }
  return node.branches.childrenBySegment.get(segment)
}

/** The text after a form's last "/", the last element of `form.split("/")`,
 *  so it always agrees with the folder segments a lookup walks.
 *  posix.basename would drop a trailing "/" and name the segment before it. */
const getLastSegment = (form: string): string => form.slice(form.lastIndexOf("/") + 1)

/** Answers suffix lookups over a list's paths, building its parts on demand:
 *  - the first lookup groups the list's paths by the last segment of their form;
 *  - the first lookup of each last segment sorts that group and builds its
 *    suffix tree's root;
 *  - every lookup then walks one node per folder segment of the suffix, so a
 *    lookup's walk does not grow with the list. */
const createSuffixLookup = (params: {
  getComparablePaths: () => readonly ComparablePath[]
  toForm: (comparablePath: string) => string
}): SuffixLookup => {
  const { getComparablePaths, toForm } = params

  const getPathsByLastSegment = buildOnFirstCall(() => {
    const formedPaths = getComparablePaths().map(({ storedPath, comparablePath }) => {
      return { storedPath, form: toForm(comparablePath) }
    })
    return Map.groupBy(formedPaths, ({ form }) => getLastSegment(form))
  })
  const rootsByLastSegment = new Map<string, SuffixNode>()

  const findRoot = (lastSegment: string): SuffixNode | undefined => {
    const cachedRoot = rootsByLastSegment.get(lastSegment)

    if (cachedRoot) return cachedRoot

    const formedPaths = getPathsByLastSegment().get(lastSegment)

    if (!formedPaths) return undefined

    const folderedPaths = formedPaths
      .toSorted((left, right) => compareShortestPathFirst(left.storedPath, right.storedPath))
      .map(({ storedPath, form }) => {
        return { storedPath, folderSegments: form.split("/").slice(0, -1) }
      })
    const root = createSuffixNode({ paths: folderedPaths, depth: 0 })
    rootsByLastSegment.set(lastSegment, root)
    return root
  }

  return (formSuffix) => {
    const root = findRoot(getLastSegment(formSuffix))

    if (!root) return null

    // Walks from the last segment's root through the suffix's folder
    // segments, nearest the last segment first; a segment no path has ends
    // the lookup.
    const suffixFolderSegments = formSuffix.split("/").slice(0, -1)
    // The node the walk has reached so far.
    let node = root
    for (const segment of suffixFolderSegments.toReversed()) {
      const child = findSuffixChild(node, segment)

      if (!child) return null
      node = child
    }
    return node.shortestLongerPath
  }
}

/** Builds one set of lookups per path list, on the list's first resolve. The
 *  cache is keyed by the list itself, so a caller must not change a list after
 *  passing it in; passing a new array builds new lookups. */
const createLookupsCache = <Lookups>(
  createLookups: (paths: readonly string[]) => Lookups,
): ((paths: readonly string[]) => Lookups) => {
  const lookupsByList = new WeakMap<readonly string[], Lookups>()

  return (paths) => {
    const cachedLookups = lookupsByList.get(paths)

    if (cachedLookups) return cachedLookups

    const lookups = createLookups(paths)
    lookupsByList.set(paths, lookups)
    return lookups
  }
}

/** Pairs each path of a list with its comparable path in one pass, on the
 *  first call. */
const createComparablePaths = (params: {
  paths: readonly string[]
  toComparablePath: (path: string) => string
}): (() => readonly ComparablePath[]) => {
  const { paths, toComparablePath } = params

  return buildOnFirstCall(() => {
    return paths.map((storedPath) => {
      return { storedPath, comparablePath: toComparablePath(storedPath) }
    })
  })
}

const keepPath = (path: string): string => path

/** The folded note form lowercases every letter, so `[[éclair]]` reaches
 *  `Éclair.md`; file links fold ASCII letters only (createAssetLookups). */
const lowercaseNotePath = (path: string): string => path.toLowerCase()

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

/** One letter case's note lookups, over its comparable paths. */
type NoteLookups = { pathWithForm: FormLookup; pathEndingWith: SuffixLookup }

const createNoteLookups = (paths: readonly string[]): Record<LetterCase, NoteLookups> => {
  const createLookupsInLetterCase = (letterCase: LetterCase): NoteLookups => {
    const getComparablePaths = createComparablePaths({
      paths,
      toComparablePath: (path) => notePathForComparison(path, letterCase),
    })

    return {
      pathWithForm: createFormLookup({ getComparablePaths, toForm: keepPath }),
      pathEndingWith: createSuffixLookup({ getComparablePaths, toForm: keepPath }),
    }
  }

  return { exact: createLookupsInLetterCase("exact"), folded: createLookupsInLetterCase("folded") }
}

const getNoteLookups = createLookupsCache(createNoteLookups)

/** One letter case's asset lookups, over its comparable paths. */
type AssetLookupsInLetterCase = {
  pathWithForm: FormLookup
  pathWithStem: FormLookup
  pathWithBareStem: FormLookup
}

/** The asset lookups. The two suffix lookups compare ASCII-folded forms and
 *  serve the exact pass only, as resolveAssetInLetterCase explains. */
type AssetLookups = {
  inLetterCase: Record<LetterCase, AssetLookupsInLetterCase>
  foldedPathEndingWith: SuffixLookup
  foldedStemEndingWith: SuffixLookup
}

const pathToBareStem = (path: string): string => stripExtension(posix.basename(path))

const createAssetLookups = (paths: readonly string[]): AssetLookups => {
  const getExactPaths = createComparablePaths({ paths, toComparablePath: keepPath })
  // The folded asset form lowercases ASCII letters only. Folding every letter
  // would change which file an existing link names.
  const getAsciiFoldedPaths = createComparablePaths({ paths, toComparablePath: foldAsciiCase })

  const createLookupsOverComparablePaths = (
    getComparablePaths: () => readonly ComparablePath[],
  ): AssetLookupsInLetterCase => {
    return {
      pathWithForm: createFormLookup({ getComparablePaths, toForm: keepPath }),
      pathWithStem: createFormLookup({ getComparablePaths, toForm: stripExtension }),
      pathWithBareStem: createFormLookup({ getComparablePaths, toForm: pathToBareStem }),
    }
  }

  return {
    inLetterCase: {
      exact: createLookupsOverComparablePaths(getExactPaths),
      folded: createLookupsOverComparablePaths(getAsciiFoldedPaths),
    },
    foldedPathEndingWith: createSuffixLookup({
      getComparablePaths: getAsciiFoldedPaths,
      toForm: keepPath,
    }),
    // ASCII folding keeps every "." and "/", so stripping the extension from
    // the folded path gives the folded stem.
    foldedStemEndingWith: createSuffixLookup({
      getComparablePaths: getAsciiFoldedPaths,
      toForm: stripExtension,
    }),
  }
}

const getAssetLookups = createLookupsCache(createAssetLookups)

/** One pass over the three note tiers, comparing paths in `letterCase`. A
 *  match returns the stored path, never the link's spelling. In the folded
 *  pass, two notes that differ only in letter case share a form, and each
 *  lookup returns the shorter. */
const resolveNoteInLetterCase = (params: {
  targetWithExtension: string
  targetRelativeToSource: string | null
  lookups: NoteLookups
  letterCase: LetterCase
}): string | null => {
  const { targetWithExtension, targetRelativeToSource, lookups, letterCase } = params
  const comparableTarget = notePathForComparison(targetWithExtension, letterCase)

  // Exact path match ("path from vault folder"): "folder/Note.md" or "Note.md"
  const exactMatch = lookups.pathWithForm(comparableTarget)

  if (exactMatch) return exactMatch

  // Relative-to-source match ("path from current file"): the target joined
  // to the linking note's folder, so "../C/target" and "sub/target" land on
  // the right note.
  if (targetRelativeToSource) {
    const relativeMatch = lookups.pathWithForm(
      notePathForComparison(targetRelativeToSource, letterCase),
    )

    if (relativeMatch) return relativeMatch
  }

  // A path-suffix match is any path that ends with the whole target, folders
  // included, so [[sub/Note]] reaches A/sub/Note.md. With multiple matches,
  // Obsidian's heuristic prefers the shortest path, and the byte-order
  // tie-break keeps the winner independent of the list's order (callers feed
  // it from unordered SQL scans that change across index rebuilds).
  return lookups.pathEndingWith(comparableTarget)
}

/** Adds ".md" unless the target already ends with it in lowercase, so
 *  `[[x.MD]]` looks for `x.MD.md`. pathToLinkName strips the same ending. */
const noteTargetWithExtension = (target: string): string => {
  return target.endsWith(".md") ? target : `${target}.md`
}

/** The target joined to the linking note's folder, or null without a source.
 *  The join collapses ".."/".". A target whose leading ".." run climbs above
 *  the vault root gets no join; one that escapes later, as "a/../../x" does
 *  from a note at the vault root, joins to a path that starts with ".." and
 *  matches no vault path. */
const joinToOptionalSourceFolder = (
  sourcePath: string | undefined,
  target: string,
): string | null => {
  return sourcePath ? joinToSourceFolder(sourcePath, target) : null
}

/** Resolves a link target the way `resolve` does, but only in the link's own
 *  letter case, so `[[real]]` misses `Folder/Real.md`. A match means the link
 *  already spells the path in that path's letter case. The move rewriter
 *  asks it whether a link still reaches a note whose file name the move
 *  changes. */
const resolveInExactCase = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const targetWithExtension = noteTargetWithExtension(target)

  return resolveNoteInLetterCase({
    targetWithExtension,
    targetRelativeToSource: joinToOptionalSourceFolder(sourcePath, targetWithExtension),
    lookups: getNoteLookups(allPaths).exact,
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
 *  over the link-target limit. The lookups built over `allPaths` are cached by
 *  the array, so the caller must not change it after the call. */
const resolve = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const targetWithExtension = noteTargetWithExtension(target)
  const targetRelativeToSource = joinToOptionalSourceFolder(sourcePath, targetWithExtension)
  const noteLookups = getNoteLookups(allPaths)

  return (
    resolveNoteInLetterCase({
      targetWithExtension,
      targetRelativeToSource,
      lookups: noteLookups.exact,
      letterCase: "exact",
    }) ??
    resolveNoteInLetterCase({
      targetWithExtension,
      targetRelativeToSource,
      lookups: noteLookups.folded,
      letterCase: "folded",
    })
  )
}

/** One pass over the asset tiers, with the exact, relative, stem exact, stem
 *  relative and bare-stem comparisons in `letterCase`. The two suffix tiers
 *  run in the exact pass only. In the folded pass, two files that differ only
 *  in letter case share a form, and each lookup returns the shorter. */
const resolveAssetInLetterCase = (params: {
  target: string
  relativeTarget: string | null
  lookups: AssetLookups
  letterCase: LetterCase
}): string | null => {
  const { target, relativeTarget, lookups, letterCase } = params
  const { pathWithForm, pathWithStem, pathWithBareStem } = lookups.inLetterCase[letterCase]
  const comparableTarget = assetPathForComparison(target, letterCase)
  const comparableRelativeTarget = relativeTarget
    ? assetPathForComparison(relativeTarget, letterCase)
    : null

  // ── Full-filename family: exact → relative → path suffix ──

  const exactMatch = pathWithForm(comparableTarget)

  if (exactMatch) return exactMatch

  if (comparableRelativeTarget) {
    const relativeMatch = pathWithForm(comparableRelativeTarget)

    if (relativeMatch) return relativeMatch
  }

  // The suffix tiers compare ASCII-folded paths in the exact pass, so the
  // shortest path wins whatever its letter case: ![[photo.png]] reaches
  // A/Photo.PNG over B/sub/photo.png. The other tiers compare in the pass's
  // letter case. Folded from the start, a suffix tier could only repeat its
  // miss in the folded pass, so that pass skips it.
  const runsSuffixTiers = letterCase === "exact"
  const foldedTarget = foldAsciiCase(target)
  const fullPathSuffixMatch = runsSuffixTiers ? lookups.foldedPathEndingWith(foldedTarget) : null

  if (fullPathSuffixMatch) return fullPathSuffixMatch

  // ── Stem family: exact → relative → suffix/basename ──

  const exactStemMatch = pathWithStem(comparableTarget)

  if (exactStemMatch) return exactStemMatch

  if (comparableRelativeTarget) {
    const relativeStemMatch = pathWithStem(comparableRelativeTarget)

    if (relativeStemMatch) return relativeStemMatch
  }

  // The pass's last tier. A target with folder segments matches the stem
  // that ends with it, ASCII-folded and in the exact pass only, like the
  // full-path suffix tier.
  if (target.includes("/")) {
    return runsSuffixTiers ? lookups.foldedStemEndingWith(foldedTarget) : null
  }
  // A bare name matches a file name's stem in the pass's letter case.
  return pathWithBareStem(comparableTarget)
}

/** Resolves a link target to a known non-markdown vault file, or null when no
 *  match exists. The index (search/search-index.ts) and the move rewriter both
 *  resolve file links with it, so they agree on where an asset link points.
 *  The tiers run in this order, and the first match wins:
 *  1. Full file name: the exact path, the path joined to the source note's
 *     folder, then the shortest path ending with the target ([[photo.png]],
 *     ![img](../assets/photo.png), [[LICENSE]]).
 *  2. Stem, the path without its extension: the exact stem, the stem joined
 *     to the source note's folder, then the shortest stem ending with a
 *     target that has folders, or the shortest path whose file name's stem
 *     equals a bare target ([[Trip Route]] → Trip Route.canvas).
 *  3. Tiers 1 and 2 again with ASCII letter case folded, without the two
 *     suffix tiers, so `![[Photo.PNG]]` reaches `photo.png` only when no file
 *     matches it exactly.
 *
 *  - Full file names run first because a multi-dot file name's stem keeps its
 *    inner dots: [[photo.png]] prefers photo.png over photo.png.canvas, whose
 *    stem is "photo.png", and still reaches photo.png.canvas when no
 *    photo.png exists, as Obsidian's stem matching does.
 *  - The two suffix tiers fold ASCII letter case already in tiers 1 and 2, so
 *    `![[photo.png]]` reaches the shorter of `A/Photo.PNG` and `B/sub/photo.png`.
 *  - A target over the link-target limit resolves to null.
 *  - The lookups built over `allAssetPaths` are cached by the array, so the
 *    caller must not change it after the call. */
const resolveAsset = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allAssetPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const relativeTarget = joinToOptionalSourceFolder(sourcePath, target)
  const lookups = getAssetLookups(allAssetPaths)

  return (
    resolveAssetInLetterCase({ target, relativeTarget, lookups, letterCase: "exact" }) ??
    resolveAssetInLetterCase({ target, relativeTarget, lookups, letterCase: "folded" })
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
  isWithinLinkTargetLimit,
  joinToSourceFolder,
  resolve,
  resolveInExactCase,
  stripExtension,
  pathToLinkName,
  resolveAsset,
}
