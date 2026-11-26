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
 *     fragment prefixed with title + `Section:` ancestor path, capped
 *     at the remaining budget (leading ancestors dropped, deepest kept;
 *     omitted when title + metadata exhaust it — see capHeadingPath)
 *  4. A heading whose span has no content emits nothing
 *  5. Each split note with named headings also emits one table-of-contents
 *     chunk, last (the why lives on buildTableOfContentsText)
 *  6. Spans over their budget → sub-split at paragraph boundaries,
 *     with a sub-MIN trailing fragment merged backward into its
 *     predecessor
 *  7. A split that yields no fragments at all falls back to one
 *     whole-body chunk so the note never leaves the vector index
 *  8. Each prefix part (title, metadata line, heading name) is cut to
 *     MAX_CHUNK_PREFIX_PART_CODE_POINTS, and a note's chunks stop at the
 *     limits MAX_CHUNK_TEXT_TO_BODY_RATIO, MAX_NOTE_CHUNK_TEXT_CHARACTERS and
 *     MAX_NOTE_CHUNKS set, so the chunks stay proportional to the note's length
 *  9. Each chunk's text is cut to MAX_CHUNK_CODE_POINTS */

import { parseHeadings, type HeadingInfo } from "../obsidian-markdown/headings.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { stripMarkdownSyntax } from "../obsidian-markdown/plaintext.js"
import { truncateToCodePointLimit } from "../../utils/truncate-to-code-point-limit.js"

type NoteChunk = Readonly<{
  index: number
  text: string
}>

// These budgets count whitespace-separated words (approximateTokenCount), not
// the embedding model's own tokens.
const CHUNK_THRESHOLD_TOKENS = 500
const MAX_CHUNK_TOKENS = 450
const MIN_CHUNK_TOKENS = 50

/** Each prefix part (the note title, the metadata line, each heading name) is
 *  cut to this many code points before it joins a chunk prefix. The embedding
 *  model reads 512 tokens, and 2,000 characters of English take about 370 of
 *  them, so a longer part would leave little or no body text in view. */
const MAX_CHUNK_PREFIX_PART_CODE_POINTS = 2_000

// A note's chunks stop at MAX_NOTE_CHUNKS, or once their text would pass
// MAX_CHUNK_TEXT_TO_BODY_RATIO times the stripped body's length or
// MAX_NOTE_CHUNK_TEXT_CHARACTERS, whichever is smaller. The first chunk and the
// table-of-contents chunk are always kept.

/** A note's chunk texts total several times the length of its stripped body:
 *  each chunk repeats its prefix, and a section below the top level is also
 *  embedded in its top-level aggregate. Prose measures under 3 times, a Kanban
 *  board about 4.7, and a note of one-line sections 7 to 14 as its title
 *  lengthens, reaching 50 only with a title of about 700 characters. 50
 *  leaves room above those while keeping a note's chunk text, and the work to
 *  embed it, proportional to the note's length. */
const MAX_CHUNK_TEXT_TO_BODY_RATIO = 50

/** Bounds a very large note's chunk text in memory; a real note at the densest
 *  measured ratio needs a stripped body over 3.5 MB to reach it. */
const MAX_NOTE_CHUNK_TEXT_CHARACTERS = 50_000_000

/** Each chunk is one model call and one stored vector, and a chunk of a tiny
 *  section can be a few bytes, so the chunk text limits above do not bound the
 *  count. A long real note (a multi-year journal in one note, a book-length
 *  note) makes about 5,000 chunks, so this leaves about three times that. */
const MAX_NOTE_CHUNKS = 16_384

/** Tokenizing runs on the main thread, when a chunk is embedded and again when
 *  the reranker scores it, and its cost grows with the text's length. Both
 *  models read only the first 512 tokens, which a real chunk reaches long
 *  before this many code points, so the cut changes no vector. */
const MAX_CHUNK_CODE_POINTS = 32_768

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

/** One or more empty lines between two paragraphs. A body reaches the chunker
 *  with its line endings as written, so CRLF line endings match too. */
const PARAGRAPH_BREAK = /(?:\r?\n){2,}/

/** Split oversized text into sub-chunks at paragraph boundaries,
 *  keeping each under maxChunkTokens. Falls back to word-boundary
 *  splitting for single paragraphs that exceed the limit. */
const splitLargeText = (text: string, maxChunkTokens: number): string[] => {
  if (approximateTokenCount(text) <= maxChunkTokens) return [text]

  const paragraphs = text.split(PARAGRAPH_BREAK)
  const subChunks: string[] = []
  // The paragraphs of the chunk being built, joined with "\n\n" when it is
  // pushed; a new list starts after each push.
  let chunkParagraphs: string[] = []
  // The word count of chunkParagraphs, kept as a running total: joining with
  // "\n\n" never merges two words, so it always equals a recount of the joined
  // text, and each paragraph is counted once.
  let chunkTokens = 0

  for (const paragraph of paragraphs) {
    // An empty paragraph comes only from a paragraph break at the start or end
    // of the text. It holds no words, and in a chunk it would only add a
    // separator.
    if (paragraph === "") continue

    const paragraphTokens = approximateTokenCount(paragraph)
    const overflowsChunk =
      chunkParagraphs.length > 0 && chunkTokens + paragraphTokens > maxChunkTokens

    if (overflowsChunk) {
      subChunks.push(chunkParagraphs.join("\n\n"))
      chunkParagraphs = []
      chunkTokens = 0
    }

    chunkParagraphs.push(paragraph)
    chunkTokens += paragraphTokens
  }

  if (chunkParagraphs.length > 0) {
    subChunks.push(chunkParagraphs.join("\n\n"))
  }

  // Word-boundary split for any chunks still over the limit. Only a chunk
  // holding a single paragraph can be: a paragraph joins a chunk only while
  // the total stays within the limit.
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
  const trailingFragment = fragments.at(-1)
  const precedingFragment = fragments.at(-2)

  // Fewer than two fragments leaves nothing to merge into.
  if (!trailingFragment || !precedingFragment) return fragments
  if (approximateTokenCount(trailingFragment) >= MIN_CHUNK_TOKENS) return fragments

  return [...fragments.slice(0, -2), `${precedingFragment}\n\n${trailingFragment}`]
}

/** The trim drops the whitespace that an empty title, or a fragment that starts
 *  or ends with whitespace, leaves at either end. */
const prefixFragment = (chunkPrefix: string, fragment: string): string => {
  return `${chunkPrefix}\n\n${fragment}`.trim()
}

/** The chunk texts in order, up to the one that would take their total length
 *  past maxCharacters or their count past MAX_NOTE_CHUNKS; the first text is
 *  always kept. Texts are read one at a time, so from a lazy iterator no text
 *  after that one is built. */
const takeWithinNoteLimits = (chunkTexts: Iterable<string>, maxCharacters: number): string[] => {
  const keptTexts: string[] = []
  // The total length of keptTexts, threaded through the loop.
  let keptCharacters = 0

  for (const chunkText of chunkTexts) {
    const isFirstText = keptTexts.length === 0
    const passesCharacterLimit = keptCharacters + chunkText.length > maxCharacters
    const chunkCountReached = keptTexts.length >= MAX_NOTE_CHUNKS

    if (!isFirstText && (passesCharacterLimit || chunkCountReached)) break
    keptTexts.push(chunkText)
    keptCharacters += chunkText.length
  }
  return keptTexts
}

const indexChunks = (chunkTexts: readonly string[]): NoteChunk[] => {
  return chunkTexts.map((chunkText, index) => ({
    index,
    text: truncateToCodePointLimit(chunkText, MAX_CHUNK_CODE_POINTS),
  }))
}

/** Chunk budget after subtracting the prefix's own token cost, floored at
 *  MIN_CHUNK_TOKENS so a pathological prefix (huge tag list, over-budget
 *  title, or a single heading segment longer than the budget) cannot
 *  shrink the budget to nothing. */
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

/** One heading name in a Section line, with its word count taken once, so
 *  every descendant's Section line is sized without counting the name again. */
type HeadingSegment = Readonly<{
  text: string
  tokens: number
}>

const SECTION_LABEL_TOKENS = approximateTokenCount("Section:")

/** The word count of `Section: <segments joined with " > ">`: the label, each
 *  segment, and one ">" between each pair. A space follows the label and
 *  surrounds every separator, so joining never merges two words. */
const sectionLineTokenCount = (segments: readonly HeadingSegment[]): number => {
  const segmentTokens = segments
    .map((segment) => segment.tokens)
    .reduce((sum, tokens) => sum + tokens, 0)
  return SECTION_LABEL_TOKENS + segmentTokens + segments.length - 1
}

/** Drop leading (outermost) ancestors when the assembled Section line
 *  would exceed a token budget, keeping the deepest segments — those
 *  carry the section's own vocabulary and are most useful for retrieval. */
const capHeadingPath = (
  headingPath: readonly HeadingSegment[],
  sectionLineBudget: number,
): readonly HeadingSegment[] => {
  // A zero budget (the title and metadata use all of it) cannot hold even the
  // "Section:" label, so the Section line is suppressed.
  if (sectionLineBudget < SECTION_LABEL_TOKENS || headingPath.length === 0) return []

  if (sectionLineTokenCount(headingPath) <= sectionLineBudget) return headingPath

  const capped = [...headingPath]
  // The deepest segment survives even when it alone exceeds the budget,
  // except at zero budget (title + metadata consume it all), where the
  // early return above suppresses the Section line entirely.
  while (capped.length > 1) {
    capped.shift()
    if (sectionLineTokenCount(capped) <= sectionLineBudget) break
  }
  return capped
}

/** A heading with its name as plain text, stripped once for both the Section
 *  lines and the table of contents. */
type NamedHeading = HeadingInfo & Readonly<{ name: string }>

/** A heading's slice of the note (full subtree for top-level headings,
 *  own body for deeper ones — see collectSectionSpans) plus the
 *  ancestor-chain path that names it. */
type SectionSpan = Readonly<{
  headingPath: readonly HeadingSegment[]
  startLine: number
  endLine: number
}>

/** Walk headings in document order, tracking the ancestor chain, and give
 *  each heading its slice of the note in one of two views:
 *
 *  - A top-level heading (the note's shallowest level) owns its FULL
 *    subtree — the bodyEndLine parseHeadings returns. Sub-splitting that
 *    stream at paragraph boundaries produces content-anchored chunks
 *    (a table, a run of adjacent entries) that carry queries whose
 *    vocabulary spreads across child sections; heading-anchored chunks
 *    alone lose those queries. Child text therefore embeds twice — once
 *    here, once in its own chunk — a deliberate overlap.
 *  - A deeper heading owns only the lines above the next heading of any
 *    level, so the leaf view stays disjoint and path-attributed.
 *
 *  A singleton top-level heading that opens the note — no preamble, no
 *  earlier heading (the common `# Title` wrapper) — spans the whole note,
 *  so its aggregate keeps the plain title prefix; an empty path here means
 *  no Section line. The heading's words stay findable in the TOC chunk and
 *  in descendants' Section lines. */
const collectSectionSpans = (
  headings: readonly NamedHeading[],
  preambleExists: boolean,
): SectionSpan[] => {
  const shallowestLevel = headings.reduce(
    (shallowestSoFar, heading) => Math.min(shallowestSoFar, heading.level),
    Infinity,
  )
  const topLevelHeadingCount = headings.filter(
    (heading) => heading.level === shallowestLevel,
  ).length

  // A lone top-level heading that opens the note (the `# Title` wrapper
  // pattern) spans the whole body — preamble text or an earlier deeper
  // heading means it does not, so it keeps its Section line.
  const hasSingletonWrapper =
    topLevelHeadingCount === 1 && headings[0]?.level === shallowestLevel && !preambleExists

  const sectionSpans: SectionSpan[] = []
  const ancestorStack: { segment: HeadingSegment; level: number }[] = []

  headings.forEach((heading, headingIndex) => {
    // Pop siblings and descendants (same or deeper level) so the stack
    // holds only the current heading's ancestors.
    // 0 is below any valid heading level (1-6), so the condition is
    // false on an empty stack.
    while ((ancestorStack.at(-1)?.level ?? 0) >= heading.level) {
      ancestorStack.pop()
    }

    // Cut once here, so a long ancestor name is not copied in full into every
    // descendant's Section line.
    const headingText = truncateToCodePointLimit(heading.name, MAX_CHUNK_PREFIX_PART_CODE_POINTS)
    const headingSegment = { text: headingText, tokens: approximateTokenCount(headingText) }

    // Empty-text segments (a bare `##` line) carry no vocabulary — skip them.
    const headingPath = [
      ...ancestorStack.map((ancestor) => ancestor.segment),
      headingSegment,
    ].filter((segment) => segment.text !== "")

    // The next heading's startLine gives the disjoint boundary (own body
    // only); bodyEndLine would span the full subtree.
    const ownBodyEndLine = headings[headingIndex + 1]?.startLine ?? heading.bodyEndLine

    const isTopLevelHeading = heading.level === shallowestLevel
    // An empty headingPath suppresses the Section line in the chunk prefix.
    const skipSectionLine = hasSingletonWrapper && headingIndex === 0
    sectionSpans.push({
      headingPath: skipSectionLine ? [] : headingPath,
      startLine: heading.bodyStartLine,
      endLine: isTopLevelHeading ? heading.bodyEndLine : ownBodyEndLine,
    })
    ancestorStack.push({ segment: headingSegment, level: heading.level })
  })

  return sectionSpans
}

/** One deliberately short chunk naming the note and its headings in document
 *  order (`Title\n\nHeading one\nHeading two…`). Generic intent-phrased
 *  queries ("what should I work on next") are structurally won by short
 *  chunks — a long chunk's extra tokens dilute its similarity average — so
 *  each split note gets one short chunk of its own, carrying the names of
 *  all its sections, populated or empty. Null when no heading name has text
 *  or fits the budget.
 *
 *  The first line prepends the note's folder segments to the title
 *  (`Projects > my-repo > TASKS`). Same-named notes with the same headings
 *  (Kanban boards sharing standard lanes) would otherwise emit byte-identical
 *  TOC chunks and tie at identical distance, leaving their relative rank to
 *  an arbitrary tie-break. */
const buildTableOfContentsText = (params: {
  noteTitle: string
  headings: readonly NamedHeading[]
  folderSegments: readonly string[]
}): string | null => {
  const { noteTitle, headings, folderSegments } = params

  // Unlike the Section lines, the names are not cut: each appears once, in
  // this one chunk.
  const headingNames = headings
    .map((heading) => heading.name)
    .filter((headingName) => headingName !== "")

  if (headingNames.length === 0) return null

  const titleLine = [...folderSegments, noteTitle].join(" > ")

  // A single short chunk is the point — splitting an oversized name list
  // into more chunks would defeat it, so names are dropped at the budget.
  // No MIN floor — budgetAfterPrefix floors at MIN_CHUNK_TOKENS to
  // guarantee body content, but padding a huge title line with 50 name
  // tokens here would push the chunk past MAX and defeat its short-chunk
  // purpose. When the title line exhausts the budget, the TOC is
  // suppressed instead (the null return below).
  const headingNameBudget = MAX_CHUNK_TOKENS - approximateTokenCount(titleLine)
  const budgetedHeadingNames: string[] = []
  // Cumulative token total threads through the loop sequentially.
  let tokensUsed = 0
  for (const headingName of headingNames) {
    const headingNameTokenCount = approximateTokenCount(headingName)

    // An oversized name is skipped, not the end of the list — later short
    // names still land in the TOC.
    if (tokensUsed + headingNameTokenCount > headingNameBudget) continue
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
 *  ancestor path (capped at the remaining budget — see capHeadingPath),
 *  and — when `metadataPrefix` is given — a metadata line,
 *  plus one table-of-contents chunk naming the note's headings.
 *
 *  Every prefix counts against the chunk token budget — the embedding and
 *  reranker windows truncate at 512 model tokens, so an unbudgeted prefix
 *  would push body tail content out of view. A short note (under
 *  CHUNK_THRESHOLD_TOKENS) without a metadata prefix is always one chunk,
 *  the title and then the stripped body; changing that form would change
 *  every such note's content hash and re-embed it.
 *
 *  Each prefix part is cut to MAX_CHUNK_PREFIX_PART_CODE_POINTS, the chunks
 *  stop at the note's chunk text limit or MAX_NOTE_CHUNKS (the first chunk and
 *  the table-of-contents chunk always stay), and each chunk's text is cut to
 *  MAX_CHUNK_CODE_POINTS. */
export const chunkContent = (params: {
  noteTitle: string
  bodyContent: string
  metadataPrefix?: string | null | undefined
  sourcePath?: string | undefined
}): NoteChunk[] => {
  const { noteTitle, bodyContent, metadataPrefix, sourcePath } = params

  // Folder segments feed only the TOC chunk's first line — the vault-relative
  // path minus the filename (POSIX separators in all deployment paths).
  const folderSegments = sourcePath ? sourcePath.split("/").slice(0, -1) : []

  // A non-markdown source's title is its filename without the extension, so
  // it keeps its full filename on the TOC title line — a file and a same-stem
  // note in one folder (Report.pdf beside Report.md) would otherwise emit
  // byte-identical TOC chunks and tie arbitrarily.
  const sourceFileName = sourcePath?.split("/").at(-1)
  const tocTitle = sourceFileName && !sourceFileName.endsWith(".md") ? sourceFileName : noteTitle

  // The TOC title above keeps the full title: the TOC chunk is emitted once,
  // so its length cannot multiply.
  const prefixTitle = truncateToCodePointLimit(noteTitle, MAX_CHUNK_PREFIX_PART_CODE_POINTS)
  const prefixMetadata = metadataPrefix
    ? truncateToCodePointLimit(metadataPrefix, MAX_CHUNK_PREFIX_PART_CODE_POINTS)
    : null
  const buildChunkPrefix = (sectionLine: string | null): string => {
    return [prefixTitle, sectionLine, prefixMetadata].filter(Boolean).join("\n")
  }
  const basePrefix = buildChunkPrefix(null)
  const budgetAfterBasePrefix = budgetAfterPrefix(basePrefix)

  const strippedBody = stripMarkdownSyntax(bodyContent)
  const bodyTokenCount = approximateTokenCount(strippedBody)
  const maxChunkTextCharacters = Math.min(
    MAX_CHUNK_TEXT_TO_BODY_RATIO * strippedBody.length,
    MAX_NOTE_CHUNK_TEXT_CHARACTERS,
  )

  // Total chunk budget minus the body-content floor (MIN), title, and
  // metadata leaves what is available for the Section-line ancestor path.
  const titleTokens = approximateTokenCount(prefixTitle)
  const metadataTokens = prefixMetadata ? approximateTokenCount(prefixMetadata) : 0
  const sectionLineBudget = Math.max(
    MAX_CHUNK_TOKENS - MIN_CHUNK_TOKENS - titleTokens - metadataTokens,
    0,
  )

  /** A stripped text split into fragments under its heading path's prefix,
   *  each prefixed only when it is read. An empty heading path gives the base
   *  prefix (no Section line), which the preamble and an unsectioned body use. */
  const sectionChunkTexts = (
    headingPath: readonly HeadingSegment[],
    sectionText: string,
  ): Iterable<string> => {
    // A heading whose span has no content emits nothing — a heading-only
    // fragment is too small to embed meaningfully, and any descendant
    // fragment already carries the heading's words in its Section line.
    // A childless empty heading emits no section chunk, but its name still
    // rides the TOC chunk, and full-text search indexes the whole note text.
    if (!sectionText) return []

    const cappedPath = capHeadingPath(headingPath, sectionLineBudget)
    const sectionLine =
      cappedPath.length > 0
        ? `Section: ${cappedPath.map((segment) => segment.text).join(" > ")}`
        : null
    const sectionPrefix = buildChunkPrefix(sectionLine)

    return splitWithTrailingMerge(sectionText, budgetAfterPrefix(sectionPrefix))
      .values()
      .map((fragment) => prefixFragment(sectionPrefix, fragment))
  }

  if (bodyTokenCount < CHUNK_THRESHOLD_TOKENS) {
    // Only a metadata prefix can split a short note; without one, the note
    // keeps the one-chunk form described above.
    const exceedsBudgetWithPrefix =
      Boolean(prefixMetadata) && bodyTokenCount > budgetAfterBasePrefix

    if (!exceedsBudgetWithPrefix) return indexChunks([prefixFragment(basePrefix, strippedBody)])
    return indexChunks(
      takeWithinNoteLimits(sectionChunkTexts([], strippedBody), maxChunkTextCharacters),
    )
  }

  const bodyLines = splitIntoLines(bodyContent)
  // Wikilinks and emphasis markers in heading text would inject raw [[ / **
  // tokens into Section lines and the TOC, so each name is stripped to plain
  // text once here.
  const headings = parseHeadings(bodyLines).map((heading) => ({
    ...heading,
    name: stripMarkdownSyntax(heading.text).trim(),
  }))
  const firstHeading = headings[0]

  // No headings — split at paragraph boundaries
  if (!firstHeading) {
    return indexChunks(
      takeWithinNoteLimits(sectionChunkTexts([], strippedBody), maxChunkTextCharacters),
    )
  }

  // Preamble (content above the first heading) has no owning section, so it
  // keeps the base prefix and gets its own chunks, however short it is.
  const preambleText = stripMarkdownSyntax(
    bodyLines.slice(0, firstHeading.startLine).join("\n"),
  ).trim()
  const preambleExists = Boolean(preambleText)

  // A section span is split only when it is reached.
  // - Assembly stops at the first text past the note's chunk text limit or
  //   chunk count, before any later span is split or any later fragment is
  //   prefixed.
  // - That holds only while every step from the spans to takeWithinNoteLimits
  //   stays an iterator. An array anywhere in the chain splits every span first.
  const sectionTexts = collectSectionSpans(headings, preambleExists)
    .values()
    .flatMap((sectionSpan) => {
      const sectionSpanText = stripMarkdownSyntax(
        bodyLines.slice(sectionSpan.startLine, sectionSpan.endLine).join("\n"),
      ).trim()
      return sectionChunkTexts(sectionSpan.headingPath, sectionSpanText)
    })

  // The identity flatMap puts the preamble's texts before the sections'; Node
  // 24 has no Iterator.concat.
  const bodyChunkTexts = takeWithinNoteLimits(
    [sectionChunkTexts([], preambleText), sectionTexts]
      .values()
      .flatMap((chunkTexts) => chunkTexts),
    maxChunkTextCharacters,
  )

  // The TOC chunk takes no metadata prefix — on a chunk this small the prefix
  // would dominate the token average, and notes of one type (e.g. Kanban
  // boards) would all share an identical Type/Tags line, collapsing exactly
  // the note-vs-note discrimination this chunk exists to provide. It sits
  // outside the chunk text limit and the chunk count: it is emitted once, and
  // it is the note's one short chunk for broad queries.
  const tableOfContentsText = buildTableOfContentsText({
    noteTitle: tocTitle,
    headings,
    folderSegments,
  })
  const tableOfContentsTexts = tableOfContentsText ? [tableOfContentsText.trim()] : []

  // The TOC is emitted LAST: the reranker (hybrid-search.ts) scores FTS-only
  // candidates on chunk index 0 as "title + intro" text, so whenever any body
  // fragment exists the first chunk is body content, not a heading list. A note
  // whose sections are all empty emits the TOC as its only fragment —
  // there the heading list IS the note's content, so index 0 holding it
  // is the accurate representation.
  const chunkTexts = [...bodyChunkTexts, ...tableOfContentsTexts]

  // A note whose split yields nothing (no preamble, every section empty, and
  // no heading name fits the TOC's budget) keeps the whole-body fallback so it
  // never silently leaves the vector index.
  if (chunkTexts.length === 0) return indexChunks([prefixFragment(basePrefix, strippedBody)])

  return indexChunks(chunkTexts)
}
