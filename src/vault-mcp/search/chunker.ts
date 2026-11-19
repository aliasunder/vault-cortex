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
 *     MAX_CHUNK_PREFIX_PART_CHARACTERS, and a note's chunk text stops at its
 *     limit (see MAX_CHUNK_TEXT_PER_BODY_CHARACTER), so the chunks stay
 *     proportional to the note's length */

import { parseHeadings, type HeadingInfo } from "../obsidian-markdown/headings.js"
import { splitIntoLines } from "../obsidian-markdown/lines.js"
import { stripMarkdownSyntax } from "../obsidian-markdown/plaintext.js"
import { truncateToCodePointLimit } from "../../utils/truncate-to-code-point-limit.js"

type NoteChunk = Readonly<{
  index: number
  text: string
}>

const CHUNK_THRESHOLD_TOKENS = 500
const MAX_CHUNK_TOKENS = 450
const MIN_CHUNK_TOKENS = 50

/** Each prefix part (the note title, the metadata line, each heading name) is
 *  cut to this many code points before it joins a chunk prefix. The embedding
 *  model reads 512 tokens, about 2,000 characters of English, so prefix text
 *  past this point leaves no body text in view. */
const MAX_CHUNK_PREFIX_PART_CHARACTERS = 2_000

// A note's chunk text stops at the smaller of the two bounds below; the first
// chunk and the table-of-contents chunk are always kept.

/** Real notes measure up to about 4.7 times their stripped body (a Kanban
 *  board: each section is embedded in its own chunk and again in its
 *  top-level aggregate, each with a prefix), so 20 leaves room above that
 *  while keeping a note's chunk text, and the work to embed it, proportional
 *  to the note's length. */
const MAX_CHUNK_TEXT_PER_BODY_CHARACTER = 20

/** Bounds a very large note's chunk text in memory; a real note at the densest
 *  measured ratio needs a stripped body over 10 MB to reach it. */
const MAX_NOTE_CHUNK_TEXT_CHARACTERS = 50_000_000

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
  // The paragraphs of the chunk being built, joined with "\n\n" when it is
  // pushed; a new list starts after each push.
  let chunkParagraphs: string[] = []
  // The word count of chunkParagraphs, kept as a running total: joining with
  // "\n\n" never merges two words, so it always equals a recount of the joined
  // text, and each paragraph is counted once.
  let chunkTokens = 0

  for (const paragraph of paragraphs) {
    const paragraphTokens = approximateTokenCount(paragraph)
    const overflowsChunk =
      chunkParagraphs.length > 0 && chunkTokens + paragraphTokens > maxChunkTokens

    if (overflowsChunk) {
      subChunks.push(chunkParagraphs.join("\n\n"))
      chunkParagraphs = []
      chunkTokens = 0
    }

    // An empty paragraph (from "\n\n" at the start or end of the text) opens
    // no chunk: as a chunk's first paragraph it would add a separator the
    // text never had there.
    if (paragraph === "" && chunkParagraphs.length === 0) continue

    chunkParagraphs.push(paragraph)
    chunkTokens += paragraphTokens
  }

  if (chunkParagraphs.length > 0) {
    subChunks.push(chunkParagraphs.join("\n\n"))
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

const prefixFragment = (chunkPrefix: string, fragment: string): string => {
  return `${chunkPrefix}\n\n${fragment}`.trim()
}

/** The chunk texts in order, up to the one that would take their total length
 *  past maxCharacters; the first text is always kept. Texts are read one at a
 *  time, so a lazy iterator never builds the texts past the limit. */
const takeWithinCharacterLimit = (
  chunkTexts: Iterable<string>,
  maxCharacters: number,
): string[] => {
  const keptTexts: string[] = []
  // The total length of keptTexts, threaded through the loop.
  let keptCharacters = 0

  for (const chunkText of chunkTexts) {
    const passesLimit = keptCharacters + chunkText.length > maxCharacters

    if (passesLimit && keptTexts.length > 0) break
    keptTexts.push(chunkText)
    keptCharacters += chunkText.length
  }
  return keptTexts
}

const indexChunks = (chunkTexts: readonly string[]): NoteChunk[] => {
  return chunkTexts.map((text, index) => ({ index, text }))
}

/** Prefix each text fragment with the chunk prefix, within the note's chunk
 *  text limit, and assign sequential indices. */
const toChunks = (
  fragments: readonly string[],
  chunkPrefix: string,
  maxChunkTextCharacters: number,
): NoteChunk[] => {
  const chunkTexts = fragments.values().map((fragment) => prefixFragment(chunkPrefix, fragment))
  return indexChunks(takeWithinCharacterLimit(chunkTexts, maxChunkTextCharacters))
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
 *  segment, and one ">" between each pair. Each segment is trimmed text that
 *  starts and ends with a word, so the separators never merge two words. */
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
  // Suppress the Section line when the budget can't even hold the
  // "Section:" literal — a 1-2 token budget would add a prefix with
  // no retrievable path vocabulary.
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
 *    subtree — parseHeadings' read-side bodyEndLine. Sub-splitting that
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
  headings: readonly HeadingInfo[],
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

    // Wikilinks and emphasis markers in heading text would inject raw [[ / **
    // tokens into Section lines and the TOC — strip to plain text once here.
    // Cut once here too, so a long ancestor name is not copied in full into
    // every descendant's Section line.
    const headingText = truncateToCodePointLimit(
      stripMarkdownSyntax(heading.text).trim(),
      MAX_CHUNK_PREFIX_PART_CHARACTERS,
    )
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
    const skipSectionLine = isTopLevelHeading && hasSingletonWrapper
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
 *  Each prefix part is cut to MAX_CHUNK_PREFIX_PART_CHARACTERS, and the
 *  chunks stop at the note's chunk text limit; the first chunk and the
 *  table-of-contents chunk always stay. */
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

  // A non-markdown source keeps its full filename on the TOC title line —
  // a file and a same-stem note in one folder (Report.pdf beside Report.md)
  // would otherwise emit byte-identical TOC chunks and tie arbitrarily.
  const sourceFileName = sourcePath?.split("/").at(-1)
  const tocTitle = sourceFileName && !sourceFileName.endsWith(".md") ? sourceFileName : noteTitle

  // The TOC title above keeps the full title: the TOC chunk is emitted once,
  // so its length cannot multiply.
  const prefixTitle = truncateToCodePointLimit(noteTitle, MAX_CHUNK_PREFIX_PART_CHARACTERS)
  const prefixMetadata = metadataPrefix
    ? truncateToCodePointLimit(metadataPrefix, MAX_CHUNK_PREFIX_PART_CHARACTERS)
    : null
  const basePrefix = prefixMetadata ? `${prefixTitle}\n${prefixMetadata}` : prefixTitle

  const strippedBody = stripMarkdownSyntax(bodyContent)
  const bodyTokenCount = approximateTokenCount(strippedBody)
  const maxChunkTextCharacters = Math.min(
    MAX_CHUNK_TEXT_PER_BODY_CHARACTER * strippedBody.length,
    MAX_NOTE_CHUNK_TEXT_CHARACTERS,
  )

  if (bodyTokenCount < CHUNK_THRESHOLD_TOKENS) {
    // Only a metadata prefix can split a short note; without one, the note
    // keeps the one-chunk form described above.
    const exceedsBudgetWithPrefix =
      Boolean(prefixMetadata) && bodyTokenCount > budgetAfterPrefix(basePrefix)

    if (!exceedsBudgetWithPrefix) {
      return toChunks([strippedBody], basePrefix, maxChunkTextCharacters)
    }
    return toChunks(
      splitWithTrailingMerge(strippedBody, budgetAfterPrefix(basePrefix)),
      basePrefix,
      maxChunkTextCharacters,
    )
  }

  const bodyLines = splitIntoLines(bodyContent)
  const headings = parseHeadings(bodyLines)

  // No headings — split at paragraph boundaries
  if (headings.length === 0) {
    return toChunks(
      splitWithTrailingMerge(strippedBody, budgetAfterPrefix(basePrefix)),
      basePrefix,
      maxChunkTextCharacters,
    )
  }

  const firstHeading = headings[0]

  // noUncheckedIndexedAccess: length > 0 guarantees this, but TS
  // doesn't narrow array index access from a prior length check.
  if (!firstHeading) {
    return toChunks(
      splitWithTrailingMerge(strippedBody, budgetAfterPrefix(basePrefix)),
      basePrefix,
      maxChunkTextCharacters,
    )
  }

  // Preamble (content above the first heading) has no owning section, so it
  // keeps the base prefix (no Section line) and emits standalone at any size.
  // The preamble and section texts are built lazily, so assembly stops at the
  // note's chunk text limit before the texts past it exist.
  const preambleLines = bodyLines.slice(0, firstHeading.startLine)
  const preambleText = stripMarkdownSyntax(preambleLines.join("\n")).trim()
  const preambleTexts = preambleText
    ? splitWithTrailingMerge(preambleText, budgetAfterPrefix(basePrefix))
        .values()
        .map((fragment) => prefixFragment(basePrefix, fragment))
    : [].values()

  // Total chunk budget minus the body-content floor (MIN), title, and
  // metadata leaves what is available for the Section-line ancestor path.
  const titleTokens = approximateTokenCount(prefixTitle)
  const metadataTokens = prefixMetadata ? approximateTokenCount(prefixMetadata) : 0
  const sectionLineBudget = Math.max(
    MAX_CHUNK_TOKENS - MIN_CHUNK_TOKENS - titleTokens - metadataTokens,
    0,
  )

  const sectionTexts = collectSectionSpans(headings, preambleText !== "")
    .values()
    .flatMap((sectionSpan) => {
      const sectionSpanText = stripMarkdownSyntax(
        bodyLines.slice(sectionSpan.startLine, sectionSpan.endLine).join("\n"),
      ).trim()

      // A heading whose span has no content emits nothing — a heading-only
      // fragment is too small to embed meaningfully, and any descendant
      // fragment already carries the heading's words in its Section line.
      // A childless empty heading emits no section chunk, but its name still
      // rides the TOC chunk, and the FTS leg indexes the full note text.
      if (!sectionSpanText) return []

      const cappedPath = capHeadingPath(sectionSpan.headingPath, sectionLineBudget)
      const sectionLine =
        cappedPath.length > 0
          ? `Section: ${cappedPath.map((segment) => segment.text).join(" > ")}`
          : null
      const sectionPrefix = [prefixTitle, sectionLine, prefixMetadata].filter(Boolean).join("\n")

      return splitWithTrailingMerge(sectionSpanText, budgetAfterPrefix(sectionPrefix))
        .values()
        .map((fragment) => prefixFragment(sectionPrefix, fragment))
    })

  const bodyChunkTexts = takeWithinCharacterLimit(
    [preambleTexts, sectionTexts].values().flatMap((chunkTexts) => chunkTexts),
    maxChunkTextCharacters,
  )

  // The TOC chunk takes no metadata prefix — on a chunk this small the prefix
  // would dominate the token average, and notes of one type (e.g. Kanban
  // boards) would all share an identical Type/Tags line, collapsing exactly
  // the note-vs-note discrimination this chunk exists to provide. It sits
  // outside the chunk text limit: it is emitted once, and it is the note's one
  // short chunk for broad queries.
  const tableOfContentsText = buildTableOfContentsText(tocTitle, headings, folderSegments)
  const tableOfContentsTexts = tableOfContentsText ? [tableOfContentsText.trim()] : []

  // The TOC is emitted LAST: the reranker scores FTS-only candidates on
  // chunk index 0 as "title + intro" text, so whenever any body fragment
  // exists the first chunk is body content, not a heading list. A note
  // whose sections are all empty emits the TOC as its only fragment —
  // there the heading list IS the note's content, so index 0 holding it
  // is the accurate representation.
  const chunkTexts = [...bodyChunkTexts, ...tableOfContentsTexts]

  // A note whose split yields nothing (every heading bare of text and body)
  // keeps the whole-body fallback so it never silently leaves the vector
  // index.
  if (chunkTexts.length === 0) {
    return toChunks([strippedBody], basePrefix, maxChunkTextCharacters)
  }

  // Each text already carries its per-section prefix (sections have
  // different prefixes), so toChunks' uniform-prefix join doesn't apply.
  return indexChunks(chunkTexts)
}
