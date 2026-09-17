/** Heading-aware chunking for embedding. Splits a note into chunks sized for
 *  the embedding model's context window (512 tokens for bge-small-en-v1.5).
 *
 *  Algorithm:
 *  1. Strip markdown syntax (via plaintext.ts)
 *  2. Short notes (< CHUNK_THRESHOLD_TOKENS) → single chunk
 *  3. Longer notes → split at heading boundaries (via parseHeadings)
 *  4. Tiny sections (< MIN_CHUNK_TOKENS) → merged with adjacent
 *  5. Oversized sections (> MAX_CHUNK_TOKENS) → sub-split at paragraph boundaries
 *  6. Every chunk is prefixed with the note title for embedding context */

import { parseHeadings } from "../obsidian-markdown/headings.js"
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
const approximateTokenCount = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length

/** Split a single oversized paragraph at word boundaries when it exceeds
 *  maxChunkTokens and can't be split at paragraph boundaries. */
const splitOversizedParagraph = (
  paragraph: string,
  maxChunkTokens: number,
): string[] => {
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
    const combined = currentChunk
      ? `${currentChunk}\n\n${paragraph}`
      : paragraph

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

/** Prefix each text fragment with the chunk prefix (title, optionally
 *  followed by a metadata line) and assign sequential indices. */
const toChunks = (fragments: string[], chunkPrefix: string): NoteChunk[] => {
  return fragments.map((fragment, index) => ({
    index,
    text: `${chunkPrefix}\n\n${fragment}`.trim(),
  }))
}

/** One human-readable line naming the note's frontmatter type and tags, for
 *  prepending to chunk text so the embedder and reranker can see metadata.
 *  Null when the note has neither. */
export const buildChunkMetadataPrefix = (params: {
  type: string | null
  tags: readonly string[]
}): string | null => {
  const typePart = params.type ? `Type: ${params.type}.` : null
  const tagsPart =
    params.tags.length > 0 ? `Tags: ${params.tags.join(", ")}.` : null
  const parts = [typePart, tagsPart].filter(Boolean)
  return parts.length > 0 ? parts.join(" ") : null
}

/** Split a note into chunks for embedding. Short notes become a single chunk;
 *  longer notes split at heading boundaries, with oversized sections further
 *  split at paragraph boundaries. Each chunk is prefixed with the note title
 *  and, when `metadataPrefix` is given, a metadata line below it.
 *
 *  With a metadata prefix, the whole prefix counts against the chunk token
 *  budget — the embedding and reranker windows truncate at 512 model tokens,
 *  so an unbudgeted prefix would push body tail content out of view. Without
 *  one, sizing stays byte-identical to the historical behavior so existing
 *  content hashes don't churn. */
export const chunkNoteContent = (
  noteTitle: string,
  bodyContent: string,
  options?: { metadataPrefix?: string | null | undefined },
): NoteChunk[] => {
  const metadataPrefix = options?.metadataPrefix
  const chunkPrefix = metadataPrefix
    ? `${noteTitle}\n${metadataPrefix}`
    : noteTitle
  // Floor at MIN_CHUNK_TOKENS so a pathological tag list cannot shrink the
  // budget to nothing.
  const maxChunkTokens = metadataPrefix
    ? Math.max(
        MAX_CHUNK_TOKENS - approximateTokenCount(chunkPrefix),
        MIN_CHUNK_TOKENS,
      )
    : MAX_CHUNK_TOKENS

  const strippedBody = stripMarkdownSyntax(bodyContent)
  const tokenCount = approximateTokenCount(strippedBody)

  if (tokenCount < CHUNK_THRESHOLD_TOKENS) {
    // Only a metadata prefix tightens the single-chunk ceiling — without
    // one, short-note behavior (and its content hashes) stays historical.
    const exceedsBudgetWithPrefix =
      Boolean(metadataPrefix) && tokenCount > maxChunkTokens
    if (!exceedsBudgetWithPrefix) {
      return toChunks([strippedBody], chunkPrefix)
    }
    return toChunks(splitLargeText(strippedBody, maxChunkTokens), chunkPrefix)
  }

  const bodyLines = splitIntoLines(bodyContent)
  const headings = parseHeadings(bodyLines)

  // No headings — split at paragraph boundaries if oversized
  if (headings.length === 0) {
    return toChunks(splitLargeText(strippedBody, maxChunkTokens), chunkPrefix)
  }

  // Content before the first heading (preamble)
  const firstHeading = headings[0]
  // noUncheckedIndexedAccess: length > 0 guarantees this, but TS
  // doesn't narrow array index access from a prior length check.
  if (!firstHeading) {
    return toChunks(splitLargeText(strippedBody, maxChunkTokens), chunkPrefix)
  }
  const preambleLines = bodyLines.slice(0, firstHeading.startLine)
  const preambleText = stripMarkdownSyntax(preambleLines.join("\n")).trim()

  const rawSections: string[] = []
  if (preambleText && approximateTokenCount(preambleText) >= MIN_CHUNK_TOKENS) {
    rawSections.push(preambleText)
  }

  // Merges undersized sections with the next until the combined text is
  // large enough to stand as its own chunk
  let pendingText =
    preambleText && approximateTokenCount(preambleText) < MIN_CHUNK_TOKENS
      ? preambleText
      : ""

  for (const heading of headings) {
    const sectionLines = bodyLines.slice(heading.startLine, heading.bodyEndLine)
    const sectionText = stripMarkdownSyntax(sectionLines.join("\n")).trim()

    if (approximateTokenCount(sectionText) < MIN_CHUNK_TOKENS && pendingText) {
      pendingText = `${pendingText}\n\n${sectionText}`
    } else {
      if (
        pendingText &&
        approximateTokenCount(pendingText) >= MIN_CHUNK_TOKENS
      ) {
        rawSections.push(pendingText)
        pendingText = ""
      }
      pendingText = pendingText
        ? `${pendingText}\n\n${sectionText}`
        : sectionText
    }
  }

  if (pendingText) {
    rawSections.push(pendingText)
  }

  // Split oversized sections at paragraph boundaries, then prefix all chunks
  const allFragments = rawSections.flatMap((section) => {
    return splitLargeText(section, maxChunkTokens)
  })

  return allFragments.length > 0
    ? toChunks(allFragments, chunkPrefix)
    : toChunks([strippedBody], chunkPrefix)
}
