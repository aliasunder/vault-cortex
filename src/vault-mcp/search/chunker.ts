/** Heading-aware chunking for embedding. Splits a note into chunks sized for
 *  the embedding model's context window (512 tokens for bge-small-en-v1.5).
 *
 *  Algorithm (every prefix counts against the chunk budget — see
 *  chunkContent):
 *  1. Strip markdown syntax (via plaintext.ts)
 *  2. Short notes (< CHUNK_THRESHOLD_TOKENS) → single chunk, unless a
 *     metadata prefix lowers the budget below the body's token count
 *  3. Longer notes → two views per note: top-level headings own their
 *     full subtree, deeper headings own only their disjoint bodies, each
 *     fragment prefixed with title + `Section:` ancestor path (the why
 *     lives on collectSectionSpans)
 *  4. A heading whose span has no content emits nothing
 *  5. Each split note with named headings also emits one table-of-contents
 *     chunk, last (the why lives on buildTableOfContentsText)
 *  6. Spans over their budget → sub-split at paragraph boundaries,
 *     with a sub-MIN trailing fragment merged backward into its
 *     predecessor
 *  7. A split that yields no fragments at all falls back to one
 *     whole-body chunk so the note never leaves the vector index */

import { parseHeadings, type HeadingInfo } from "../obsidian-markdown/headings.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { stripMarkdownSyntax } from "../obsidian-markdown/plaintext.js"

type NoteChunk = Readonly<{
  index: number
  text: string
}>

const CHUNK_THRESHOLD_TOKENS = 500
const MAX_CHUNK_TOKENS = 450
const MIN_CHUNK_TOKENS = 50

/** Approximate token count via whitespace splitting — good enough for
 *  deciding chunk boundaries without loading a real tokenizer. */
const approximateTokenCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** Split a single oversized paragraph at word boundaries when it exceeds
 *  maxChunkTokens and can't be split at paragraph boundaries. */
const splitOversizedParagraph = (paragraph: string, maxChunkTokens: number): string[] => {
  const words = paragraph.split(/\s+/).filter(Boolean)

  if (words.length <= maxChunkTokens) return [paragraph]

  const fragments: string[] = []
  for (let start = 0; start < words.length; start += maxChunkTokens) {
    fragments.push(words.slice(start, start + maxChunkTokens).join(" "))
  }
  return fragments
}

/** Split oversized text into sub-chunks at paragraph boundaries,
 *  keeping each under maxChunkTokens. Falls back to word-boundary
 *  splitting for single paragraphs that exceed the limit. */
const splitLargeText = (text: string, maxChunkTokens: number): string[] => {
  if (approximateTokenCount(text) <= maxChunkTokens) return [text]

  const paragraphs = text.split(/\n\n+/)
  const subChunks: string[] = []
  // Accumulates paragraphs until the combined token count exceeds the limit
  let currentChunk = ""

  for (const paragraph of paragraphs) {
    const combined = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph

    if (approximateTokenCount(combined) > maxChunkTokens && currentChunk) {
      subChunks.push(currentChunk)
      currentChunk = paragraph
    } else {
      currentChunk = combined
    }
  }

  if (currentChunk) {
    subChunks.push(currentChunk)
  }

  // Word-boundary split for any chunks still over the limit
  return subChunks.flatMap((chunk) => {
    return approximateTokenCount(chunk) > maxChunkTokens
      ? splitOversizedParagraph(chunk, maxChunkTokens)
      : [chunk]
  })
}

/** splitLargeText, then merge a sub-MIN trailing fragment backward into its
 *  predecessor. A slight budget overflow beats emitting a tail fragment too
 *  small to embed meaningfully. Deliberately trailing-only: an intermediate
 *  fragment can also fall under MIN (a tiny paragraph pushed alone when the
 *  next paragraph exceeds the budget), but it keeps its full chunk prefix,
 *  so it stays retrievable rather than context-free. */
const splitWithTrailingMerge = (text: string, maxChunkTokens: number): string[] => {
  const fragments = splitLargeText(text, maxChunkTokens)

  if (fragments.length < 2) return fragments

  const trailingFragment = fragments.at(-1)
  const precedingFragment = fragments.at(-2)

  if (!trailingFragment || !precedingFragment) return fragments
  if (approximateTokenCount(trailingFragment) >= MIN_CHUNK_TOKENS) return fragments

  return [...fragments.slice(0, -2), `${precedingFragment}\n\n${trailingFragment}`]
}

/** Prefix each text fragment with the chunk prefix and assign sequential
 *  indices. */
const toChunks = (fragments: string[], chunkPrefix: string): NoteChunk[] => {
  return fragments.map((fragment, index) => ({
    index,
    text: `${chunkPrefix}\n\n${fragment}`.trim(),
  }))
}

/** Chunk budget after subtracting the prefix's own token cost, floored at
 *  MIN_CHUNK_TOKENS so a pathological prefix (huge tag list, deep heading
 *  nesting) cannot shrink the budget to nothing. */
const budgetAfterPrefix = (chunkPrefix: string): number => {
  return Math.max(MAX_CHUNK_TOKENS - approximateTokenCount(chunkPrefix), MIN_CHUNK_TOKENS)
}

/** One human-readable line naming the note's frontmatter type and tags, for
 *  prepending to chunk text so the embedder and reranker can see metadata.
 *  Null when the note has neither. */
export const buildChunkMetadataPrefix = (params: {
  type: string | null
  tags: readonly string[]
}): string | null => {
  const typePart = params.type ? `Type: ${params.type}.` : null
  const tagsPart = params.tags.length > 0 ? `Tags: ${params.tags.join(", ")}.` : null
  const parts = [typePart, tagsPart].filter(Boolean)
  return parts.length > 0 ? parts.join(" ") : null
}

/** A heading's slice of the note (full subtree for top-level headings,
 *  own body for deeper ones — see collectSectionSpans) plus the
 *  ancestor-chain path that names it. */
type SectionSpan = Readonly<{
  headingPath: readonly string[]
  startLine: number
  endLine: number
}>

/** Walk headings in document order, tracking the ancestor chain, and give
 *  each heading its slice of the note in one of two views:
 *
 *  - A top-level heading (the note's shallowest level) owns its FULL
 *    subtree — parseHeadings' read-side bodyEndLine. Sub-splitting that
 *    stream at paragraph boundaries produces content-anchored chunks
 *    (a table, a run of adjacent entries) that carry queries whose
 *    vocabulary spreads across child sections; heading-anchored chunks
 *    alone lose those queries. Child text therefore embeds twice — once
 *    here, once in its own chunk — a measured, deliberate overlap.
 *  - A deeper heading owns only the lines above the next heading of any
 *    level, so the leaf view stays disjoint and path-attributed.
 *
 *  A singleton top-level heading that opens the note (the common `# Title`
 *  wrapper) spans the whole note, so its aggregate keeps the plain title
 *  prefix — an empty path here means no Section line. The heading's words
 *  stay findable in the TOC chunk and in descendants' Section lines. */
const collectSectionSpans = (headings: readonly HeadingInfo[]): SectionSpan[] => {
  const topLevel = Math.min(...headings.map((heading) => heading.level))
  const topLevelHeadingCount = headings.filter((heading) => heading.level === topLevel).length

  // A wrapper must OPEN the note — a lone top-level heading preceded by
  // deeper headings does not span the note, so it keeps its Section line.
  const hasSingletonWrapper = topLevelHeadingCount === 1 && headings[0]?.level === topLevel

  const sectionSpans: SectionSpan[] = []
  const ancestorStack: { text: string; level: number }[] = []

  headings.forEach((heading, headingIndex) => {
    // Pop siblings and descendants (same or deeper level) so the stack
    // holds only the current heading's ancestors.
    while ((ancestorStack.at(-1)?.level ?? 0) >= heading.level) {
      ancestorStack.pop()
    }

    // Wikilinks and emphasis markers in heading text would inject raw [[ / **
    // tokens into Section lines and the TOC — strip to plain text once here.
    const headingText = stripMarkdownSyntax(heading.text).trim()

    // Empty-text segments (a bare `##` line) carry no vocabulary — skip them.
    const headingPath = [...ancestorStack.map((ancestor) => ancestor.text), headingText].filter(
      (segment) => segment !== "",
    )

    // The next heading's startLine gives the disjoint boundary (own body
    // only); bodyEndLine would span the full subtree.
    const ownBodyEndLine = headings[headingIndex + 1]?.startLine ?? heading.bodyEndLine

    const isTopLevelHeading = heading.level === topLevel
    // An empty headingPath suppresses the Section line in the chunk prefix.
    const skipSectionLine = isTopLevelHeading && hasSingletonWrapper
    sectionSpans.push({
      headingPath: skipSectionLine ? [] : headingPath,
      startLine: heading.bodyStartLine,
      endLine: isTopLevelHeading ? heading.bodyEndLine : ownBodyEndLine,
    })
    ancestorStack.push({ text: headingText, level: heading.level })
  })

  return sectionSpans
}

/** One deliberately short chunk naming the note and its headings in document
 *  order (`Title\n\nHeading one\nHeading two…`). Generic intent-phrased
 *  queries ("what should I work on next") are structurally won by short
 *  chunks — a long chunk's extra tokens dilute its similarity average — so
 *  each split note gets one short chunk of its own, carrying the names of
 *  all its sections, populated or empty. Null when no heading has text.
 *
 *  The first line prepends the note's folder segments to the title
 *  (`Projects > my-repo > TASKS`). Same-named notes with the same headings
 *  (Kanban boards sharing standard lanes) would otherwise emit byte-identical
 *  TOC chunks and tie at identical distance, leaving their relative rank to
 *  an arbitrary tie-break. */
const buildTableOfContentsText = (
  noteTitle: string,
  headings: readonly HeadingInfo[],
  folderSegments: readonly string[],
): string | null => {
  // Stripped like the Section lines — raw wikilink/emphasis markers would
  // pollute the short chunk's vocabulary.
  const headingNames = headings
    .map((heading) => stripMarkdownSyntax(heading.text).trim())
    .filter((headingName) => headingName !== "")

  if (headingNames.length === 0) return null

  const titleLine = [...folderSegments, noteTitle].join(" > ")

  // A single short chunk is the point — splitting an oversized name list
  // into more chunks would defeat it, so the list truncates at the budget.
  // Deliberately no MIN floor (unlike budgetAfterPrefix): padding a huge
  // title line with 50 name tokens would push the chunk past MAX and
  // defeat its short-chunk purpose — when the title line exhausts the
  // budget, the TOC is suppressed instead (the null return below).
  const headingNameBudget = MAX_CHUNK_TOKENS - approximateTokenCount(titleLine)
  const budgetedHeadingNames: string[] = []
  // Cumulative token total threads through the loop sequentially.
  let tokensUsed = 0
  for (const headingName of headingNames) {
    const headingNameTokenCount = approximateTokenCount(headingName)

    if (tokensUsed + headingNameTokenCount > headingNameBudget) break
    budgetedHeadingNames.push(headingName)
    tokensUsed += headingNameTokenCount
  }

  if (budgetedHeadingNames.length === 0) return null

  return `${titleLine}\n\n${budgetedHeadingNames.join("\n")}`
}

/** Split a note into chunks for embedding. Short notes become a single chunk;
 *  longer notes split into per-heading sections in two views (top-level
 *  aggregates + disjoint leaves — see collectSectionSpans), each fragment
 *  prefixed with the note title, a `Section:` line naming the heading's
 *  ancestor path, and — when `metadataPrefix` is given — a metadata line,
 *  plus one table-of-contents chunk naming the note's headings.
 *
 *  Every prefix counts against the chunk token budget — the embedding and
 *  reranker windows truncate at 512 model tokens, so an unbudgeted prefix
 *  would push body tail content out of view. Short notes (< threshold)
 *  without a metadata prefix stay byte-identical to the historical behavior
 *  so their content hashes don't churn on upgrade. */
export const chunkContent = (
  noteTitle: string,
  bodyContent: string,
  options?: { metadataPrefix?: string | null | undefined; sourcePath?: string | undefined },
): NoteChunk[] => {
  const metadataPrefix = options?.metadataPrefix

  // Folder segments feed only the TOC chunk's first line — the vault-relative
  // path minus the filename (POSIX separators in all deployment paths).
  const folderSegments = options?.sourcePath ? options.sourcePath.split("/").slice(0, -1) : []

  // A non-markdown source keeps its full filename on the TOC title line —
  // a file and a same-stem note in one folder (Report.pdf beside Report.md)
  // would otherwise emit byte-identical TOC chunks and tie arbitrarily.
  const sourceFileName = options?.sourcePath?.split("/").at(-1)
  const tocTitle = sourceFileName && !sourceFileName.endsWith(".md") ? sourceFileName : noteTitle

  const basePrefix = metadataPrefix ? `${noteTitle}\n${metadataPrefix}` : noteTitle

  const strippedBody = stripMarkdownSyntax(bodyContent)
  const bodyTokenCount = approximateTokenCount(strippedBody)

  if (bodyTokenCount < CHUNK_THRESHOLD_TOKENS) {
    // Only a metadata prefix tightens the single-chunk ceiling — without
    // one, short-note behavior (and its content hashes) stays historical.
    const exceedsBudgetWithPrefix =
      Boolean(metadataPrefix) && bodyTokenCount > budgetAfterPrefix(basePrefix)

    if (!exceedsBudgetWithPrefix) {
      return toChunks([strippedBody], basePrefix)
    }
    return toChunks(splitWithTrailingMerge(strippedBody, budgetAfterPrefix(basePrefix)), basePrefix)
  }

  const bodyLines = splitIntoLines(bodyContent)
  const headings = parseHeadings(bodyLines)

  // No headings — split at paragraph boundaries
  if (headings.length === 0) {
    return toChunks(splitWithTrailingMerge(strippedBody, budgetAfterPrefix(basePrefix)), basePrefix)
  }

  const firstHeading = headings[0]

  // noUncheckedIndexedAccess: length > 0 guarantees this, but TS
  // doesn't narrow array index access from a prior length check.
  if (!firstHeading) {
    return toChunks(splitWithTrailingMerge(strippedBody, budgetAfterPrefix(basePrefix)), basePrefix)
  }

  // Preamble (content above the first heading) has no owning section, so it
  // keeps the base prefix (no Section line) and emits standalone at any size.
  const preambleLines = bodyLines.slice(0, firstHeading.startLine)
  const preambleText = stripMarkdownSyntax(preambleLines.join("\n")).trim()
  const preambleFragments = preambleText
    ? splitWithTrailingMerge(preambleText, budgetAfterPrefix(basePrefix)).map(
        (fragment) => `${basePrefix}\n\n${fragment}`,
      )
    : []

  const sectionFragments = collectSectionSpans(headings).flatMap((sectionSpan) => {
    const sectionSpanText = stripMarkdownSyntax(
      bodyLines.slice(sectionSpan.startLine, sectionSpan.endLine).join("\n"),
    ).trim()

    // A heading whose span has no content emits nothing — a heading-only
    // fragment is too small to embed meaningfully, and any descendant
    // fragment already carries the heading's words in its Section line.
    // A childless empty heading drops out of the vector index entirely;
    // the FTS leg still indexes the full note text.
    if (!sectionSpanText) return []

    const sectionLine =
      sectionSpan.headingPath.length > 0 ? `Section: ${sectionSpan.headingPath.join(" > ")}` : null
    const sectionPrefix = [noteTitle, sectionLine, metadataPrefix].filter(Boolean).join("\n")

    return splitWithTrailingMerge(sectionSpanText, budgetAfterPrefix(sectionPrefix)).map(
      (fragment) => `${sectionPrefix}\n\n${fragment}`,
    )
  })

  // The TOC chunk takes no metadata prefix — on a chunk this small the prefix
  // would dominate the token average, and notes of one type (e.g. Kanban
  // boards) would all share an identical Type/Tags line, collapsing exactly
  // the note-vs-note discrimination this chunk exists to provide.
  const tableOfContentsText = buildTableOfContentsText(tocTitle, headings, folderSegments)
  const tableOfContentsFragments = tableOfContentsText ? [tableOfContentsText] : []

  // The TOC is emitted LAST: the reranker scores FTS-only candidates on
  // chunk index 0 as "title + intro" text, so the first chunk must stay
  // body content, not a heading list.
  const prefixedFragments = [...preambleFragments, ...sectionFragments, ...tableOfContentsFragments]

  // A note whose split yields nothing (every heading bare of text and body)
  // keeps the whole-body fallback so it never silently leaves the vector
  // index.
  if (prefixedFragments.length === 0) {
    return toChunks([strippedBody], basePrefix)
  }

  // Each fragment already carries its per-section prefix (sections have
  // different prefixes), so toChunks' uniform-prefix join doesn't apply.
  return prefixedFragments.map((fragmentText, index) => ({
    index,
    text: fragmentText.trim(),
  }))
}
