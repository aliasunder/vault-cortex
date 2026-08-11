import { getMeta, extractTextItems, extractLinks } from "unpdf"
import type { StructuredTextItem } from "unpdf"
import { createPdfDocumentProxy } from "./pdf-engine.js"

/** Rounds a font size to one decimal place — used as the bucketing key for
 *  heading-level detection. Both the map builder (`buildHeadingLevels`) and
 *  the per-line lookup (`reconstructPdfMarkdown`) must agree on rounding. */
const roundFontSize = (size: number): number => Math.round(size * 10) / 10

/** Groups text items into lines by y-coordinate proximity — items within
 *  `threshold` pixels of the previous item's y are on the same line.
 *  Default 2px absorbs sub-pixel jitter from font metrics and inline
 *  elements while staying well below the smallest real line gap (~12px
 *  for body text at typical PDF sizes). */
const groupIntoLines = (
  pageItems: readonly StructuredTextItem[],
  threshold = 2,
): StructuredTextItem[][] => {
  const nonEmpty = pageItems.filter((item) => item.str.trim().length > 0)
  if (nonEmpty.length === 0) return []

  // PDF text items arrive in content-stream order with y-coordinates
  // descending down the page. Items on the same visual line share a y
  // (within `threshold` px); a jump in y starts a new line.
  const lines: StructuredTextItem[][] = []
  let lastY = -Infinity
  for (const item of nonEmpty) {
    const currentLine = lines[lines.length - 1]
    if (currentLine && Math.abs(item.y - lastY) < threshold) {
      currentLine.push(item)
    } else {
      lines.push([item])
    }
    lastY = item.y
  }
  return lines
}

/** Builds a heading-level map from the distinct font sizes in the document.
 *  Up to three sizes larger than the smallest get H1–H3; the smallest is
 *  always body text. Returns an empty map when only one font size exists. */
const buildHeadingLevels = (
  allItems: readonly StructuredTextItem[],
): ReadonlyMap<number, number> => {
  const sortedSizes = [
    ...new Set(allItems.map((item) => roundFontSize(item.fontSize))),
  ].sort((a, b) => b - a)
  if (sortedSizes.length <= 1) return new Map()

  // Drop the smallest (body text) and cap at 3 heading levels.
  const headingSizes = sortedSizes.slice(0, -1).slice(0, 3)
  return new Map(headingSizes.map((size, index) => [size, index + 1]))
}

/** Reconstructs a markdown-formatted text rendition from structured PDF items,
 *  metadata, and links — heading hierarchy from relative font sizes, fenced
 *  code blocks from monospace fontFamily detection, page separators, and a
 *  deduplicated links footer. */
const reconstructPdfMarkdown = (params: {
  title: string | undefined
  totalPages: number
  items: readonly (readonly StructuredTextItem[])[]
  pdfLinks: readonly string[]
}): string => {
  const { title, totalPages, items, pdfLinks } = params
  const allNonEmpty = items.flat().filter((item) => item.str.trim().length > 0)
  const headingLevels = buildHeadingLevels(allNonEmpty)
  const uniqueLinks = [...new Set(pdfLinks)]

  const headerParts = [
    `Title: ${title ?? "(untitled)"}`,
    `Pages: ${totalPages}`,
  ]
  if (uniqueLinks.length > 0) {
    headerParts.push(`Links: ${uniqueLinks.length}`)
  }

  const outputLines: string[] = [headerParts.join(" | "), ""]

  for (let pageIndex = 0; pageIndex < items.length; pageIndex++) {
    const pageItems = items[pageIndex]
    if (!pageItems) continue

    const lines = groupIntoLines(pageItems)
    if (lines.length === 0) continue

    if (pageIndex > 0) {
      outputLines.push("", `--- Page ${pageIndex + 1} ---`, "")
    }

    // Fence state machine — tracks whether we're inside a code block
    // so monospace→sans-serif transitions emit closing fences.
    let inCodeBlock = false
    for (const line of lines) {
      const lineText = line
        .map((item) => item.str)
        .join(" ")
        .trim()
      if (!lineText) continue

      const isMonospace = line.some((item) => item.fontFamily === "monospace")
      const lineFontSizes = line.map((item) => item.fontSize)
      const maxFontSize = roundFontSize(Math.max(...lineFontSizes))
      const headingLevel = headingLevels.get(maxFontSize) ?? 0

      if (isMonospace && !inCodeBlock) {
        outputLines.push("```")
        inCodeBlock = true
      } else if (!isMonospace && inCodeBlock) {
        outputLines.push("```")
        inCodeBlock = false
      }

      if (inCodeBlock) {
        outputLines.push(lineText)
      } else if (headingLevel > 0) {
        outputLines.push(`${"#".repeat(headingLevel)} ${lineText}`)
      } else {
        outputLines.push(lineText)
      }
    }
    if (inCodeBlock) {
      outputLines.push("```")
    }
  }

  if (uniqueLinks.length > 0) {
    outputLines.push("", "Links:", ...uniqueLinks.map((link) => `- ${link}`))
  }

  return outputLines.join("\n")
}

/**
 * Extracts structured text from a PDF buffer — creates a pdfjs proxy,
 * extracts text items and metadata, reconstructs a markdown rendition
 * with headings, code blocks, and links, then disposes the proxy.
 * Returns an empty string when the PDF has no extractable text
 * (scanned/image-only documents).
 */
export const extractPdfText = async (pdfData: Uint8Array): Promise<string> => {
  const proxy = await createPdfDocumentProxy(pdfData)
  try {
    const meta = await getMeta(proxy)
    const pdfTitle = meta.info?.Title ?? undefined
    const { totalPages, items } = await extractTextItems(proxy)
    const linkResult = await extractLinks(proxy)

    const hasContent = items.flat().some((item) => item.str.trim().length > 0)
    if (!hasContent) return ""

    return reconstructPdfMarkdown({
      title: pdfTitle,
      totalPages,
      items,
      pdfLinks: linkResult.links ?? [],
    })
  } finally {
    await proxy.loadingTask.destroy()
  }
}
