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

export type NoteChunk = Readonly<{
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
 *  MAX_CHUNK_TOKENS and can't be split at paragraph boundaries. */
const splitOversizedParagraph = (paragraph: string): string[] => {
  const words = paragraph.split(/\s+/).filter(Boolean)
  if (words.length <= MAX_CHUNK_TOKENS) return [paragraph]

  const fragments: string[] = []
  for (let start = 0; start < words.length; start += MAX_CHUNK_TOKENS) {
    fragments.push(words.slice(start, start + MAX_CHUNK_TOKENS).join(" "))
  }
  return fragments
}

/** Split oversized text into sub-chunks at paragraph boundaries,
 *  keeping each under MAX_CHUNK_TOKENS. Falls back to word-boundary
 *  splitting for single paragraphs that exceed the limit. */
const splitLargeText = (text: string): string[] => {
  if (approximateTokenCount(text) <= MAX_CHUNK_TOKENS) return [text]

  const paragraphs = text.split(/\n\n+/)
  const subChunks: string[] = []
  let currentChunk = ""

  for (const paragraph of paragraphs) {
    const combined = currentChunk
      ? `${currentChunk}\n\n${paragraph}`
      : paragraph

    if (approximateTokenCount(combined) > MAX_CHUNK_TOKENS && currentChunk) {
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
  return subChunks.flatMap((chunk) =>
    approximateTokenCount(chunk) > MAX_CHUNK_TOKENS
      ? splitOversizedParagraph(chunk)
      : [chunk],
  )
}

/** Prefix each text fragment with the note title and assign sequential indices. */
const toChunks = (fragments: string[], noteTitle: string): NoteChunk[] =>
  fragments.map((fragment, index) => ({
    index,
    text: `${noteTitle}\n\n${fragment}`.trim(),
  }))

/** Split a note into chunks for embedding. Short notes become a single chunk;
 *  longer notes split at heading boundaries, with oversized sections further
 *  split at paragraph boundaries. Each chunk is prefixed with the note title. */
export const chunkNoteContent = (
  noteTitle: string,
  bodyContent: string,
): NoteChunk[] => {
  const strippedBody = stripMarkdownSyntax(bodyContent)
  const tokenCount = approximateTokenCount(strippedBody)

  if (tokenCount < CHUNK_THRESHOLD_TOKENS) {
    return toChunks([strippedBody], noteTitle)
  }

  const bodyLines = splitIntoLines(bodyContent)
  const headings = parseHeadings(bodyLines)

  // No headings — split at paragraph boundaries if oversized
  if (headings.length === 0) {
    return toChunks(splitLargeText(strippedBody), noteTitle)
  }

  // Content before the first heading (preamble)
  const preambleLines = bodyLines.slice(0, headings[0].startLine)
  const preambleText = stripMarkdownSyntax(preambleLines.join("\n")).trim()

  const rawSections: string[] = []
  if (preambleText && approximateTokenCount(preambleText) >= MIN_CHUNK_TOKENS) {
    rawSections.push(preambleText)
  }

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

  // Split oversized sections at paragraph boundaries, then prefix all with title
  const allFragments = rawSections.flatMap((section) => splitLargeText(section))

  return allFragments.length > 0
    ? toChunks(allFragments, noteTitle)
    : toChunks([strippedBody], noteTitle)
}
