import { getMeta, extractTextItems, extractLinks } from "unpdf"
import type { StructuredTextItem } from "unpdf"
import type { PDFPageProxy } from "unpdf/pdfjs"
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Pure UTF-8 truncation is shared with indexing.
import { getUtf8BytePrefix } from "../../utils/get-utf8-byte-prefix.js"
import { createPdfDocumentProxy } from "./pdf-engine.js"

// Bound useful indexing work while the extraction process contains individual-page expansion.
export const MAX_INDEXED_PDF_PAGES = 500
// Match the searchable-content budget, including metadata, separators and links.
const MAX_INDEXED_PDF_BYTES = 102_400

type PageTextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>

const structuredPageItems = (content: PageTextContent): StructuredTextItem[] => {
  const toStructuredItem = (
    textItem: Extract<PageTextContent["items"][number], { str: string }>,
  ): StructuredTextItem => {
    const [, , verticalBasisX, verticalBasisY, xCoordinate, yCoordinate] = textItem.transform
    const direction = textItem.dir

    if (direction !== "ltr" && direction !== "rtl" && direction !== "ttb") {
      throw new Error("PDF text has an invalid direction")
    }

    return {
      str: textItem.str,
      x: xCoordinate,
      y: yCoordinate,
      width: textItem.width,
      height: textItem.height,
      // The transformed vertical unit vector's length gives the font size even for rotated text.
      fontSize: Math.hypot(verticalBasisX, verticalBasisY),
      fontFamily: content.styles[textItem.fontName]?.fontFamily ?? "",
      dir: direction,
      hasEOL: textItem.hasEOL,
    }
  }
  return content.items.filter((textItem) => "str" in textItem).map(toStructuredItem)
}

/** Rounds a font size to one decimal place — used as the bucketing key for
 *  heading-level detection. Both the map builder (`buildHeadingLevels`) and
 *  the per-line lookup (`dominantRoundedFontSize`) must agree on rounding. */
const roundFontSize = (size: number): number => Math.round(size * 10) / 10

/** Items within this many points of the previous item's y-coordinate belong
 *  to the same visual line; `rejoinOrphanedMarkers` searches the same
 *  radius. Grouping and rejoin share the constant so they cannot disagree
 *  about what "same line" means. 2pt absorbs sub-pixel jitter from font
 *  metrics and inline elements while staying well below the smallest real
 *  line gap (~12pt for body text at typical PDF sizes). */
const LINE_GROUP_Y_THRESHOLD = 2

/** Fraction of the font size a horizontal gap between adjacent items must
 *  exceed to count as a word boundary (joined with a space). 0.2em sits above
 *  kerning jitter and typical heading letter-spacing (0.05–0.15em) and below
 *  standard word-space advances (0.25–0.33em, with ~0.2em as the floor under
 *  justified compression). */
const WORD_GAP_THRESHOLD_EM = 0.2

/** Matches a line that is nothing but a list marker — a numbered marker
 *  ("1.", "42."), a lettered marker ("a.", "A."), or a bullet glyph. Anchored
 *  so decimals ("3.14") and prose never match. A bare "-" is deliberately not
 *  a marker (indistinguishable from a stray dash or horizontal rule). */
const MARKER_LINE_PATTERN = /^(?:\d{1,4}\.|[A-Za-z]\.|[•◦▪‣●○·])$/

const hasVisibleText = (item: StructuredTextItem): boolean => item.str.trim().length > 0

/** pdfjs reports a generic CSS family for each font ("monospace" for a
 *  fixed-pitch font), never the font's own name. */
const isMonospaceItem = (item: StructuredTextItem): boolean => item.fontFamily === "monospace"

/** Groups text items into lines by y-coordinate proximity — items within
 *  `LINE_GROUP_Y_THRESHOLD` points of the previous item's y are on the same
 *  line. Whitespace-only items are dropped, which also discards the synthetic
 *  zero-height " " items pdfjs inserts to span large horizontal gaps. */
const groupIntoLines = (pageItems: readonly StructuredTextItem[]): StructuredTextItem[][] => {
  const nonEmpty = pageItems.filter(hasVisibleText)

  if (nonEmpty.length === 0) return []

  // Items stay in content-stream order, which need not run down the page
  // (see rejoinOrphanedMarkers), so a jump in y either way starts a new line.
  const lines: StructuredTextItem[][] = []
  for (const item of nonEmpty) {
    const currentLine = lines.at(-1)
    const previousY = currentLine?.at(-1)?.y
    const isSameLine =
      previousY !== undefined && Math.abs(item.y - previousY) < LINE_GROUP_Y_THRESHOLD

    if (currentLine && isSameLine) {
      currentLine.push(item)
    } else {
      lines.push([item])
    }
  }
  return lines
}

/** Returns the rounded font size carrying the greatest total character volume
 *  (sum of trimmed string lengths) across the given items, which must not be
 *  empty. Ties resolve to the larger size. For the document's body size that
 *  is the conservative direction: treating the larger size as body demotes
 *  would-be headings to plain text, where the opposite promotes body text
 *  into headings. */
const dominantRoundedFontSize = (items: readonly StructuredTextItem[]): number => {
  // Accumulate character volume per rounded size, then pick the winner.
  const volumeBySize = new Map<number, number>()
  for (const item of items) {
    const roundedSize = roundFontSize(item.fontSize)
    const currentVolume = volumeBySize.get(roundedSize) ?? 0
    volumeBySize.set(roundedSize, currentVolume + item.str.trim().length)
  }

  const [dominantSize] = [...volumeBySize.entries()].reduce((bestEntry, candidateEntry) => {
    const [bestSize, bestVolume] = bestEntry
    const [candidateSize, candidateVolume] = candidateEntry

    if (candidateVolume > bestVolume) return candidateEntry
    if (candidateVolume === bestVolume && candidateSize > bestSize) {
      return candidateEntry
    }
    return bestEntry
  })
  return dominantSize
}

/** Maps rounded font size to heading level (1 for the largest). Body text is
 *  the size carrying the most characters (`dominantRoundedFontSize`); only
 *  sizes strictly larger than body become headings — up to three levels,
 *  largest first. Sizes at or below body stay plain, so small print (contact
 *  lines, footers) can never push the body into a heading bucket.
 *  Known graceful edge: a document that is mostly heading-sized text by
 *  volume (a poster, a title page) picks that size as body and renders
 *  everything plain — readable, unlike the inverse failure. */
const buildHeadingLevels = (
  allItems: readonly StructuredTextItem[],
): ReadonlyMap<number, number> => {
  if (allItems.length === 0) return new Map()

  const bodySize = dominantRoundedFontSize(allItems)
  const distinctSizes = [...new Set(allItems.map((item) => roundFontSize(item.fontSize)))]
  const headingSizes = distinctSizes
    .filter((size) => size > bodySize)
    .toSorted((firstSize, secondSize) => secondSize - firstSize)
    .slice(0, 3)
  return new Map(headingSizes.map((size, index) => [size, index + 1]))
}

/** Orders a line's items into visual left-to-right order by x. Stream order
 *  is kept when the line contains RTL text: pdfjs emits RTL runs in logical
 *  reading order, which an x-ascending sort would reverse. Only items inside
 *  the line move: the order of lines, and so of columns, stays content-stream
 *  order. */
const orderLineItems = (line: readonly StructuredTextItem[]): readonly StructuredTextItem[] => {
  const hasRtlItem = line.some((item) => item.dir === "rtl")

  if (hasRtlItem) return line
  return line.toSorted((leftItem, rightItem) => leftItem.x - rightItem.x)
}

/** True when the horizontal gap between two adjacent items is a word
 *  boundary rather than kerning or letter-spacing. Degenerate metrics
 *  (non-positive width or font size, non-finite values) count as a word
 *  boundary, so the items join with a space. */
const isWordGap = (previousItem: StructuredTextItem, nextItem: StructuredTextItem): boolean => {
  const gap = nextItem.x - (previousItem.x + previousItem.width)

  // At a font-size change the smaller size sets the lower threshold, so the
  // junction leans toward a space rather than gluing two words together
  const referenceFontSize = Math.min(previousItem.fontSize, nextItem.fontSize)
  const hasUsableMetrics = Number.isFinite(gap) && previousItem.width > 0 && referenceFontSize > 0

  if (!hasUsableMetrics) return true
  return gap > WORD_GAP_THRESHOLD_EM * referenceFontSize
}

/** True when joining these two adjacent items needs an inserted space — the
 *  gap is a word boundary and neither string already carries whitespace at
 *  the junction (pdfjs bakes literal spaces into merged runs; adding another
 *  would double them). */
const needsSpaceBetween = (
  previousItem: StructuredTextItem,
  nextItem: StructuredTextItem,
): boolean => {
  const junctionHasWhitespace = /\s$/.test(previousItem.str) || /^\s/.test(nextItem.str)

  if (junctionHasWhitespace) return false
  return isWordGap(previousItem, nextItem)
}

/** Collapses letter-spaced banner text ("S U M M A RY" → "SUMMARY"). pdfjs
 *  merges tracked glyphs into one item with literal spaces baked in, so the
 *  shatter is intra-string and only a text-level collapse can undo it. The
 *  text collapses only when all of these hold:
 *  - Every whitespace-separated token is at most 2 characters, since a
 *    tracked pair of glyphs can stay joined ("RY" above).
 *  - There are at least three tokens.
 *  - It has no ASCII lowercase letter: letter-spaced banners are caps or
 *    small caps in practice, and short-word prose ("on a to") must stay
 *    intact.
 *  - It has no digit, so spaced number runs ("12 34 56") never glue into a
 *    different number. Digit-bearing banners ("S E C T I O N 0 1") stay
 *    shattered, the safe direction.
 *
 *  Applied per item, never across items, so a real word gap wide enough to
 *  split items keeps its space ("INTERVIEW PREPARATION"). */
const collapseLetterSpacedText = (text: string): string => {
  if (/[a-z]/.test(text) || /\d/.test(text)) return text

  const tokens = text.trim().split(/\s+/)
  const isShatteredRun = tokens.length >= 3 && tokens.every((token) => token.length <= 2)

  if (!isShatteredRun) return text
  return tokens.join("")
}

/** Joins a mixed line's ordered items into markdown text, wrapping each
 *  maximal monospace run in inline backticks (fully-monospace lines go to
 *  `renderFenceBlock` instead and never reach here).
 *  Non-monospace item text goes through the letter-spacing collapse;
 *  monospace text is left verbatim (code is never reflowed), and backticks
 *  inside monospace text are not escaped. */
const renderLineText = (orderedItems: readonly StructuredTextItem[]): string => {
  // Partition into maximal runs of equal monospace-ness, tracking each run's
  // boundary items so junction spacing can use the real gap metrics.
  // "Run" is used in the text-layout sense: a maximal stretch of consecutive
  // items sharing a property — the same concept as DOCX formatting runs
  // (`<w:r>` elements) and Core Text's CTRun (glyph runs):
  // https://developer.apple.com/documentation/coretext/ctrun
  type FontRun = { monospace: boolean; items: StructuredTextItem[] }
  const fontRuns: FontRun[] = []
  for (const item of orderedItems) {
    const itemIsMonospace = isMonospaceItem(item)
    const currentRun = fontRuns.at(-1)

    if (currentRun && currentRun.monospace === itemIsMonospace) {
      currentRun.items.push(item)
    } else {
      fontRuns.push({ monospace: itemIsMonospace, items: [item] })
    }
  }

  // Renders one run to text: gap-aware join, letter-spacing collapse for
  // plain text only (code is never reflowed), backtick wrap for monospace.
  const renderRun = (run: FontRun): string => {
    const joinedText = run.items
      .map((item, index) => {
        const previousItem = run.items[index - 1]
        const itemText = run.monospace ? item.str : collapseLetterSpacedText(item.str)

        if (!previousItem) return itemText
        return needsSpaceBetween(previousItem, item) ? ` ${itemText}` : itemText
      })
      .join("")
    const trimmedText = joinedText.trim()
    return run.monospace ? `\`${trimmedText}\`` : trimmedText
  }

  return fontRuns
    .map((run, index) => {
      const previousRun = fontRuns[index - 1]
      const renderedRun = renderRun(run)

      if (!previousRun) return renderedRun

      const previousBoundaryItem = previousRun.items.at(-1)
      const nextBoundaryItem = run.items[0]

      if (!previousBoundaryItem || !nextBoundaryItem) return renderedRun

      // Run texts are edge-trimmed (so backticks hug the code), which drops any
      // baked junction whitespace. So unlike needsSpaceBetween, whitespace at
      // the junction asks for a space here, as does a word-sized gap.
      const junctionNeedsSpace =
        /\s$/.test(previousBoundaryItem.str) ||
        /^\s/.test(nextBoundaryItem.str) ||
        isWordGap(previousBoundaryItem, nextBoundaryItem)
      return junctionNeedsSpace ? ` ${renderedRun}` : renderedRun
    })
    .join("")
}

/** Joins a fully-monospace line's items verbatim for emission inside a code
 *  fence — gap-aware spacing, no backtick wrapping, no letter-spacing
 *  collapse (code is never reflowed). Leading indentation never arrives in
 *  item strings (pdfjs normalizes it into x positions), but a merged item can
 *  carry a baked space at the line's edge, so the joined text is trimmed
 *  before `renderFenceBlock` adds the indent it rebuilds from x. */
const renderFencedLineText = (orderedItems: readonly StructuredTextItem[]): string => {
  return orderedItems
    .map((item, index) => {
      const previousItem = orderedItems[index - 1]

      if (!previousItem) return item.str
      return needsSpaceBetween(previousItem, item) ? ` ${item.str}` : item.str
    })
    .join("")
    .trim()
}

/** Renders a fence block (consecutive fully-monospace lines) with leading
 *  indentation reconstructed from glyph positions. pdfjs normalizes leading
 *  whitespace out of item strings into x offsets, so indentation must be
 *  rebuilt positionally: the block's left margin is the smallest starting x
 *  across its lines, and each line's indent is its x offset from that margin
 *  divided by the line's own per-character advance (exact for monospace —
 *  first item width / character count). Degenerate metrics (a non-positive
 *  width) skip indentation for that line rather than guessing. */
const renderFenceBlock = (orderedLines: readonly (readonly StructuredTextItem[])[]): string[] => {
  const lineStartXs = orderedLines.map((orderedItems) => orderedItems[0]?.x ?? Infinity)

  // Folded rather than spread into Math.min: that call overflows the stack
  // once a block holds about 125,000 lines
  const blockLeftMargin = lineStartXs.reduce(
    (smallestX, lineStartX) => Math.min(smallestX, lineStartX),
    Infinity,
  )

  const indentedLines = orderedLines.map((orderedItems) => {
    const lineText = renderFencedLineText(orderedItems)
    const firstItem = orderedItems[0]

    if (!firstItem || firstItem.width <= 0) {
      return lineText
    }

    const characterAdvance = firstItem.width / firstItem.str.length
    const indentCharacters = Math.max(
      0,
      Math.round((firstItem.x - blockLeftMargin) / characterAdvance),
    )
    return `${" ".repeat(indentCharacters)}${lineText}`
  })

  // A fence must be longer than the longest backtick run inside the block —
  // otherwise content that itself shows a fence (e.g. a markdown sample)
  // would close the block early (CommonMark closing-fence rule).
  const backtickRunLengths = indentedLines.flatMap((indentedLine) => {
    const backtickRuns = indentedLine.match(/`+/g) ?? []
    return backtickRuns.map((backtickRun) => backtickRun.length)
  })

  // Folded rather than spread into Math.max: that call overflows the stack
  // once a block holds about 125,000 backtick runs
  const longestBacktickRun = backtickRunLengths.reduce(
    (longestRun, runLength) => Math.max(longestRun, runLength),
    0,
  )
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1))
  return [fence, ...indentedLines, fence]
}

/** Reattaches orphaned list markers to their items.
 *  - Some producers (notably Confluence exports) emit every list marker first
 *    in the content stream, so each marker becomes its own line at the start
 *    of the page's text and the items lose their numbering.
 *  - A line that is nothing but a marker (`MARKER_LINE_PATTERN`) merges into
 *    the nearest non-marker line within `LINE_GROUP_Y_THRESHOLD` of its y
 *    (ties: earliest line); the later x-sort puts the marker back in front of
 *    its text. A marker with no same-y partner stays a line of its own.
 *  - This is deliberately not a general same-y merge or y-sort: multi-column
 *    layouts read coherently cell by cell in stream order, and any global
 *    reorder would interleave their columns row by row. */
const rejoinOrphanedMarkers = (
  lines: readonly (readonly StructuredTextItem[])[],
): readonly (readonly StructuredTextItem[])[] => {
  const lineTexts = lines.map((line) => {
    return line
      .map((item) => item.str)
      .join(" ")
      .trim()
  })
  const isMarkerLine = lineTexts.map((lineText) => MARKER_LINE_PATTERN.test(lineText))
  const lineY = (line: readonly StructuredTextItem[]): number => line[0]?.y ?? Infinity

  // Extra items destined for each target line, keyed by target line index.
  const rejoinedItemsByTarget = new Map<number, StructuredTextItem[]>()
  const absorbedMarkerIndices = new Set<number>()

  for (const [markerIndex, markerLine] of lines.entries()) {
    if (!isMarkerLine[markerIndex]) continue

    const markerY = lineY(markerLine)
    const targetCandidates = lines
      .map((line, lineIndex) => ({
        lineIndex,
        distance: Math.abs(lineY(line) - markerY),
      }))
      .filter((candidate) => {
        return !isMarkerLine[candidate.lineIndex] && candidate.distance < LINE_GROUP_Y_THRESHOLD
      })

    // toSorted is stable, so on a distance tie the earliest line stays first
    const nearestTarget = targetCandidates.toSorted(
      (firstCandidate, secondCandidate) => firstCandidate.distance - secondCandidate.distance,
    )[0]

    if (!nearestTarget) continue

    const targetItems = rejoinedItemsByTarget.get(nearestTarget.lineIndex) ?? []
    rejoinedItemsByTarget.set(nearestTarget.lineIndex, [...targetItems, ...markerLine])
    absorbedMarkerIndices.add(markerIndex)
  }

  return lines
    .map((line, lineIndex) => {
      // Markers lead the merged line: for LTR lines the x-sort would order
      // them anyway, but RTL lines skip the x-sort and keep this order.
      const rejoinedItems = rejoinedItemsByTarget.get(lineIndex)
      return rejoinedItems ? [...rejoinedItems, ...line] : line
    })
    .filter((_line, lineIndex) => !absorbedMarkerIndices.has(lineIndex))
}

type LineSegment = {
  fenced: boolean
  orderedLines: (readonly StructuredTextItem[])[]
}

/** Renders one page's lines as output lines: each run of fully-monospace
 *  lines becomes one fenced block, and every other line becomes plain text,
 *  as a heading when its dominant font size has a heading level. */
const renderPageLines = (
  lines: readonly (readonly StructuredTextItem[])[],
  headingLevels: ReadonlyMap<number, number>,
): string[] => {
  // Partition the page's lines into alternating fenced/plain segments —
  // consecutive fully-monospace lines form one fence block, so the block
  // can compute a shared left margin for indentation reconstruction.
  const lineSegments: LineSegment[] = []
  for (const line of lines) {
    const orderedItems = orderLineItems(line)
    const isFullyMonospaceLine = orderedItems.every(isMonospaceItem)
    const currentSegment = lineSegments.at(-1)

    if (currentSegment && currentSegment.fenced === isFullyMonospaceLine) {
      currentSegment.orderedLines.push(orderedItems)
    } else {
      lineSegments.push({
        fenced: isFullyMonospaceLine,
        orderedLines: [orderedItems],
      })
    }
  }

  const pageLines: string[] = []
  for (const segment of lineSegments) {
    if (segment.fenced) {
      // One push per line, like plain lines below: spreading a fence block of
      // about 125,000 lines into a single push call overflows the stack
      for (const fenceLine of renderFenceBlock(segment.orderedLines)) {
        pageLines.push(fenceLine)
      }
      continue
    }
    for (const orderedItems of segment.orderedLines) {
      const lineText = renderLineText(orderedItems)

      if (!lineText) continue

      const headingLevel = headingLevels.get(dominantRoundedFontSize(orderedItems))
      pageLines.push(headingLevel ? `${"#".repeat(headingLevel)} ${lineText}` : lineText)
    }
  }
  return pageLines
}

/** Reconstructs a markdown-formatted text rendition from structured PDF items,
 *  metadata, and links — heading hierarchy from font sizes relative to the
 *  dominant body size, fenced code blocks for fully-monospace lines with
 *  inline code for monospace runs inside mixed lines, page separators, and a
 *  deduplicated links footer. */
const reconstructPdfMarkdown = (params: {
  title: string | undefined
  totalPages: number
  itemsByPage: readonly (readonly StructuredTextItem[])[]
  pdfLinks: readonly string[]
}): string => {
  const { title, totalPages, itemsByPage, pdfLinks } = params
  const allNonEmpty = itemsByPage.flat().filter(hasVisibleText)
  const headingLevels = buildHeadingLevels(allNonEmpty)
  const uniqueLinks = [...new Set(pdfLinks)]

  const headerParts = [`Title: ${title ?? "(untitled)"}`, `Pages: ${totalPages}`]

  if (uniqueLinks.length > 0) {
    headerParts.push(`Links: ${uniqueLinks.length}`)
  }

  /** A separator before every page but the first, then the page's lines; a
   *  page with no text renders nothing. */
  const renderPageSection = (
    pageItems: readonly StructuredTextItem[],
    pageIndex: number,
  ): string[] => {
    const lines = rejoinOrphanedMarkers(groupIntoLines(pageItems))

    if (lines.length === 0) return []

    const pageSeparator = pageIndex > 0 ? ["", `--- Page ${pageIndex + 1} ---`, ""] : []
    return [...pageSeparator, ...renderPageLines(lines, headingLevels)]
  }

  const linksFooter =
    uniqueLinks.length > 0 ? ["", "Links:", ...uniqueLinks.map((link) => `- ${link}`)] : []

  return [
    headerParts.join(" | "),
    "",
    ...itemsByPage.flatMap(renderPageSection),
    ...linksFooter,
  ].join("\n")
}

/** Result of PDF text extraction — text is the markdown rendition,
 *  totalPages is preserved so callers can include it in error messages
 *  (e.g. scanned-PDF diagnostics that guide users toward raw mode). */
export type PdfTextResult = Readonly<{
  text: string
  totalPages: number
}>

/** Reads pages sequentially until the formatted indexing prefix reaches its byte or page budget. */
export const extractPdfIndexText = async (pdfData: Uint8Array): Promise<PdfTextResult> => {
  const proxy = await createPdfDocumentProxy(pdfData)
  try {
    const meta = await getMeta(proxy)
    const totalPages = proxy.numPages
    const pageLimit = Math.min(totalPages, MAX_INDEXED_PDF_PAGES)
    const itemsByPage: StructuredTextItem[][] = []
    const pdfLinks: string[] = []
    // Each visited page changes the heading inputs and links of the current prefix.
    let text = ""
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await proxy.getPage(pageNumber)
      try {
        itemsByPage.push(structuredPageItems(await page.getTextContent()))
        const annotations = await page.getAnnotations()
        for (const annotation of annotations) {
          const isWebLink =
            annotation.subtype === "Link" &&
            typeof annotation.url === "string" &&
            annotation.url.length > 0

          if (isWebLink) {
            pdfLinks.push(annotation.url)
          }
        }
      } finally {
        page.cleanup()
      }

      const hasContent = itemsByPage.some((pageItems) => pageItems.some(hasVisibleText))
      const rendition = reconstructPdfMarkdown({
        title: meta.info.Title,
        totalPages,
        itemsByPage,
        pdfLinks,
      })
      text = hasContent ? rendition : ""
      const renditionBytes = Buffer.byteLength(rendition, "utf8")

      if (renditionBytes >= MAX_INDEXED_PDF_BYTES) {
        return {
          text:
            renditionBytes > MAX_INDEXED_PDF_BYTES
              ? getUtf8BytePrefix(text, MAX_INDEXED_PDF_BYTES)
              : text,
          totalPages,
        }
      }
    }
    return { text, totalPages }
  } finally {
    await proxy.loadingTask.destroy()
  }
}

/**
 * Extracts structured text from a PDF buffer — creates a pdfjs proxy,
 * extracts text items and metadata, reconstructs a markdown rendition
 * with headings, code blocks, and links, then disposes the proxy.
 * Returns empty text when the PDF has no extractable content
 * (scanned/image-only documents); totalPages is always populated.
 */
export const extractPdfText = async (pdfData: Uint8Array): Promise<PdfTextResult> => {
  const proxy = await createPdfDocumentProxy(pdfData)
  try {
    const meta = await getMeta(proxy)
    const { totalPages, items: itemsByPage } = await extractTextItems(proxy)
    const { links: linksByPage } = await extractLinks(proxy)

    const hasContent = itemsByPage.flat().some(hasVisibleText)

    if (!hasContent) return { text: "", totalPages }

    return {
      text: reconstructPdfMarkdown({
        title: meta.info.Title,
        totalPages,
        itemsByPage,
        pdfLinks: linksByPage.flat(),
      }),
      totalPages,
    }
  } finally {
    await proxy.loadingTask.destroy()
  }
}
