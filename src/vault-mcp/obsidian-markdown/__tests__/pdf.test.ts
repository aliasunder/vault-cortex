import { afterEach, describe, it, expect, onTestFinished, vi } from "vitest"
import { extractLinks, extractTextItems, getMeta } from "unpdf"
import type { StructuredTextItem } from "unpdf"
import { createPdfDocumentProxy } from "../pdf-engine.js"
import { extractPdfIndexText, extractPdfText, MAX_INDEXED_PDF_BYTES } from "../pdf.js"
import { MAX_INDEXED_CONTENT_BYTES } from "../../search/search-index.js"
import {
  buildPdf,
  buildMinimalPdf,
  buildEmptyStreamPdf,
  buildLinkedPdf,
  buildPasswordProtectedPdf,
  toPdfData,
} from "./pdf-fixture.js"

const HEADER = "Title: (untitled) | Pages: 1"

vi.mock("../pdf-engine.js", { spy: true })
vi.mock("unpdf", { spy: true })
afterEach(() => vi.restoreAllMocks())

/** Builds a single-page StructuredTextItem array from lines of text. Items
 *  are positioned vertically (descending y, like a real PDF) with the given
 *  fontSize and fontFamily. */
const buildPageItems = (
  lines: readonly string[],
  options?: { fontSize?: number; fontFamily?: string },
): StructuredTextItem[] => {
  return lines.map((str, index) => ({
    str,
    x: 42,
    y: 780 - index * 15,
    width: str.length * 7,
    height: options?.fontSize ?? 10.5,
    fontSize: options?.fontSize ?? 10.5,
    fontFamily: options?.fontFamily ?? "sans-serif",
    dir: "ltr",
    hasEOL: true,
  }))
}

/** Stands in for a parsed document: the proxy and unpdf's three readers each
 *  answer once with these values, so the rendition comes from these items
 *  alone. Returns the proxy's destroy mock. */
const stubPdfDocument = (params: {
  title?: string
  itemsByPage: StructuredTextItem[][]
  linksByPage: string[][]
}) => {
  const destroy = vi.fn()
  const totalPages = params.itemsByPage.length
  vi.mocked(createPdfDocumentProxy, { partial: true, deep: true }).mockResolvedValueOnce({
    loadingTask: { destroy },
    numPages: totalPages,
  })
  vi.mocked(getMeta, { partial: true, deep: true }).mockResolvedValueOnce({
    info: params.title ? { Title: params.title } : {},
  })
  vi.mocked(extractTextItems).mockResolvedValueOnce({ totalPages, items: params.itemsByPage })
  vi.mocked(extractLinks).mockResolvedValueOnce({ totalPages, links: params.linksByPage })
  return destroy
}

const createIndexProbe = async (params: {
  pdfData: Uint8Array
  pageTexts?: readonly string[]
  /** Replaces every text item's reading direction, to feed a value pdfjs never emits. */
  itemDirection?: string
  textFailure?: { page: number; error: Error }
}) => {
  const proxy = await createPdfDocumentProxy(params.pdfData)
  const destroy = vi.spyOn(proxy.loadingTask, "destroy")
  onTestFinished(async () => {
    await proxy.loadingTask.destroy()
  })
  const getPage = proxy.getPage.bind(proxy)
  const events: string[] = []
  const requestedPages: number[] = []
  vi.spyOn(proxy, "getPage").mockImplementation(async (pageNumber) => {
    requestedPages.push(pageNumber)
    events.push(`page ${pageNumber}`)
    const page = await getPage(pageNumber)
    const getTextContent = page.getTextContent.bind(page)
    const getAnnotations = page.getAnnotations.bind(page)
    const cleanup = page.cleanup.bind(page)
    vi.spyOn(page, "getTextContent").mockImplementation(async () => {
      events.push(`text ${pageNumber}`)
      if (params.textFailure?.page === pageNumber) throw params.textFailure.error
      const content = await getTextContent()
      const replacementText = params.pageTexts?.[pageNumber - 1]
      const replacementDirection = params.itemDirection

      if (replacementText === undefined && replacementDirection === undefined) return content

      return {
        ...content,
        items: content.items.map((item) => {
          if (!("str" in item)) return item
          return {
            ...item,
            str: replacementText ?? item.str,
            dir: replacementDirection ?? item.dir,
          }
        }),
      }
    })
    vi.spyOn(page, "getAnnotations").mockImplementation(async () => {
      events.push(`links ${pageNumber}`)
      return getAnnotations()
    })
    vi.spyOn(page, "cleanup").mockImplementation(() => {
      events.push(`cleanup ${pageNumber}`)
      return cleanup()
    })
    return page
  })
  vi.mocked(createPdfDocumentProxy).mockResolvedValueOnce(proxy)
  return { requestedPages, events, destroy }
}

describe("extractPdfIndexText", () => {
  it("preserves the full normal rendition including headings, code and marker joining", async () => {
    const pdfData = toPdfData(
      buildPdf([
        { text: "Heading", x: 72, y: 720, fontSize: 18 },
        {
          text: "A body sentence long enough to determine the body font size.",
          x: 72,
          y: 690,
          fontSize: 12,
        },
        { text: "1.", x: 72, y: 670, fontSize: 12 },
        { text: "List item", x: 100, y: 670, fontSize: 12 },
        { text: "return true", x: 72, y: 640, fontSize: 12, font: "courier" },
      ]),
    )
    const probe = await createIndexProbe({ pdfData })

    expect(await extractPdfIndexText(pdfData)).toEqual({
      text: `${HEADER}\n\n# Heading\nA body sentence long enough to determine the body font size.\n1. List item\n\`\`\`\nreturn true\n\`\`\``,
      totalPages: 1,
    })
    expect(probe.requestedPages).toEqual([1])
    expect(probe.events).toEqual(["page 1", "text 1", "links 1", "cleanup 1"])
    expect(probe.destroy).toHaveBeenCalledExactlyOnceWith()
  })

  it("visits pages sequentially and deduplicates visited links in the full rendition", async () => {
    const pdfData = toPdfData(
      buildLinkedPdf({
        title: "Linked Doc",
        pages: [
          { text: "Page one", linkUrls: ["https://a.example/", "https://b.example/"] },
          { text: "Page two", linkUrls: ["https://b.example/", "https://c.example/"] },
        ],
      }),
    )
    const probe = await createIndexProbe({ pdfData })

    expect(await extractPdfIndexText(pdfData)).toEqual({
      text: "Title: Linked Doc | Pages: 2 | Links: 3\n\nPage one\n\n--- Page 2 ---\n\nPage two\n\nLinks:\n- https://a.example/\n- https://b.example/\n- https://c.example/",
      totalPages: 2,
    })
    expect(probe.requestedPages).toEqual([1, 2])
    expect(probe.events).toEqual([
      "page 1",
      "text 1",
      "links 1",
      "cleanup 1",
      "page 2",
      "text 2",
      "links 2",
      "cleanup 2",
    ])
    expect(probe.destroy).toHaveBeenCalledExactlyOnceWith()
  })

  it("returns empty text for a scanned document", async () => {
    expect(await extractPdfIndexText(toPdfData(buildEmptyStreamPdf()))).toEqual({
      text: "",
      totalPages: 1,
    })
  })

  it.each([
    { label: "just below", extraBytes: -1, expectedPages: [1, 2] },
    { label: "exactly at", extraBytes: 0, expectedPages: [1] },
    { label: "just above", extraBytes: 1, expectedPages: [1] },
  ])(
    "stops at the first formatted prefix $label the byte cap",
    async ({ extraBytes, expectedPages }) => {
      const header = "Title: Bound | Pages: 3 | Links: 1\n\n"
      const footer = "\n\nLinks:\n- https://one.example/"
      const fixedBytes = Buffer.byteLength(header + footer, "utf8")
      const bodyText = "é".repeat(30_000) + "x".repeat(102_400 + extraBytes - fixedBytes - 60_000)
      const pdfData = toPdfData(
        buildLinkedPdf({
          title: "Bound",
          pages: [
            { text: "first", linkUrls: ["https://one.example/"] },
            { text: "CAP-CROSSING-PAGE", linkUrls: [] },
            { text: "UNVISITED-AFTER-CAP", linkUrls: ["https://unvisited.example/"] },
          ],
        }),
      )
      const probe = await createIndexProbe({ pdfData, pageTexts: [bodyText] })
      // The rendition that first reaches the cap is returned whole; the caller cuts it.
      const chosenRendition =
        extraBytes === -1
          ? header + bodyText + "\n\n--- Page 2 ---\n\nCAP-CROSSING-PAGE" + footer
          : header + bodyText + footer

      expect(await extractPdfIndexText(pdfData)).toEqual({ text: chosenRendition, totalPages: 3 })
      expect(probe.requestedPages).toEqual(expectedPages)
      expect(probe.destroy).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it("measures the stop against the index's own content budget", () => {
    expect(MAX_INDEXED_PDF_BYTES).toBe(102_400)
    expect(MAX_INDEXED_CONTENT_BYTES).toBe(102_400)
  })

  it.each([{ totalPages: 500 }, { totalPages: 501 }])(
    "visits exactly 500 pages in a $totalPages-page document",
    async ({ totalPages }) => {
      const pages = Array.from({ length: totalPages }, (_, pageIndex) => ({
        text: pageIndex === 500 ? "UNVISITED-PAGE-501" : `Page ${pageIndex + 1}`,
        linkUrls: [],
      }))
      const pdfData = toPdfData(buildLinkedPdf({ title: "Long", pages }))
      const probe = await createIndexProbe({ pdfData })
      const expectedSections = Array.from({ length: 500 }, (_, pageIndex) => {
        if (pageIndex === 0) return "Page 1"
        return `\n--- Page ${pageIndex + 1} ---\n\nPage ${pageIndex + 1}`
      })

      expect(await extractPdfIndexText(pdfData)).toEqual({
        text: `Title: Long | Pages: ${totalPages}\n\n${expectedSections.join("\n")}`,
        totalPages,
      })
      expect(probe.requestedPages).toEqual(
        Array.from({ length: 500 }, (_, pageIndex) => pageIndex + 1),
      )
      expect(probe.destroy).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it("rejects a text direction pdfjs never emits and still cleans the page and document", async () => {
    const pdfData = toPdfData(buildMinimalPdf())
    const probe = await createIndexProbe({ pdfData, itemDirection: "btt" })

    await expect(extractPdfIndexText(pdfData)).rejects.toThrow(
      new Error("PDF text has an invalid direction"),
    )
    expect(probe.events).toEqual(["page 1", "text 1", "cleanup 1"])
    expect(probe.destroy).toHaveBeenCalledExactlyOnceWith()
  })

  it("cleans the page and document when page text extraction fails, without visiting later pages", async () => {
    const pdfData = toPdfData(
      buildLinkedPdf({
        title: "Failure",
        pages: [
          { text: "first", linkUrls: [] },
          { text: "unvisited", linkUrls: [] },
        ],
      }),
    )
    const error = new Error("controlled page text failure")
    const probe = await createIndexProbe({ pdfData, textFailure: { page: 1, error } })

    await expect(extractPdfIndexText(pdfData)).rejects.toThrow(error)
    expect(probe.requestedPages).toEqual([1])
    expect(probe.events).toEqual(["page 1", "text 1", "cleanup 1"])
    expect(probe.destroy).toHaveBeenCalledExactlyOnceWith()
  })
})

describe("extractPdfText", () => {
  it("extracts text from a valid PDF", async () => {
    const result = await extractPdfText(toPdfData(buildMinimalPdf()))
    expect(result).toEqual({ text: `${HEADER}\n\nHello PDF`, totalPages: 1 })
  })

  it("returns empty text with page count for a PDF with no extractable text", async () => {
    const result = await extractPdfText(toPdfData(buildEmptyStreamPdf()))
    expect(result).toEqual({ text: "", totalPages: 1 })
  })

  it("lists every page's links once each in a footer under the document's title", async () => {
    const pdfBuffer = buildLinkedPdf({
      title: "Linked Doc",
      pages: [
        { text: "Page one", linkUrls: ["https://a.example/", "https://b.example/"] },
        { text: "Page two", linkUrls: ["https://b.example/", "https://c.example/"] },
      ],
    })

    const result = await extractPdfText(toPdfData(pdfBuffer))

    expect(result).toEqual({
      text: [
        "Title: Linked Doc | Pages: 2 | Links: 3",
        "",
        "Page one",
        "",
        "--- Page 2 ---",
        "",
        "Page two",
        "",
        "Links:",
        "- https://a.example/",
        "- https://b.example/",
        "- https://c.example/",
      ].join("\n"),
      totalPages: 2,
    })
  })

  // The file reader turns these two refusals into its own messages by name,
  // so the names are the contract pinned here; the rest of each error is
  // pdf.js's own and left unchecked
  it("rejects a password-protected PDF with pdf.js's PasswordException", async () => {
    await expect(extractPdfText(toPdfData(buildPasswordProtectedPdf()))).rejects.toMatchObject({
      name: "PasswordException",
      message: "No password given",
    })
  })

  it("rejects bytes that are not a PDF with pdf.js's InvalidPDFException", async () => {
    const notAPdf = Buffer.from("plain text, not a PDF")

    await expect(extractPdfText(toPdfData(notAPdf))).rejects.toMatchObject({
      name: "InvalidPDFException",
      message: "Invalid PDF structure.",
    })
  })

  describe("heading levels", () => {
    it("keeps the volume-dominant size as body even when smaller sizes exist", async () => {
      const pdfBuffer = buildPdf([
        { text: "Sample Heading", x: 72, y: 720, fontSize: 18 },
        { text: "Senior Engineer", x: 72, y: 690, fontSize: 13 },
        {
          text: "This is the body of the letter with plenty of text in it.",
          x: 72,
          y: 660,
          fontSize: 11,
        },
        {
          text: "It keeps going with more words than any other size has.",
          x: 72,
          y: 640,
          fontSize: 11,
        },
        { text: "toronto@example.com", x: 72, y: 610, fontSize: 9 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` +
          "# Sample Heading\n" +
          "## Senior Engineer\n" +
          "This is the body of the letter with plenty of text in it.\n" +
          "It keeps going with more words than any other size has.\n" +
          "toronto@example.com",
      )
    })

    it("produces no headings when the document has a single font size", async () => {
      const pdfBuffer = buildPdf([
        { text: "First line", x: 72, y: 720, fontSize: 12 },
        { text: "Second line", x: 72, y: 700, fontSize: 12 },
        { text: "Third line", x: 72, y: 680, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nFirst line\nSecond line\nThird line`)
    })

    it("resolves a volume tie by treating the larger size as body", async () => {
      const pdfBuffer = buildPdf([
        { text: "AAAA", x: 72, y: 720, fontSize: 14 },
        { text: "BBBB", x: 72, y: 690, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nAAAA\nBBBB`)
    })

    it("classifies a line by its dominant size, not one oversized glyph", async () => {
      const pdfBuffer = buildPdf([
        { text: "Heading", x: 72, y: 720, fontSize: 18 },
        {
          text: "The body text of this line keeps its size dominant",
          x: 72,
          y: 680,
          fontSize: 11,
        },
        { text: "!", x: 420, y: 680, fontSize: 18 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` + "# Heading\n" + "The body text of this line keeps its size dominant !",
      )
    })

    it("makes headings of only the three largest sizes above body", async () => {
      const pdfBuffer = buildPdf([
        { text: "Level one", x: 72, y: 720, fontSize: 24 },
        { text: "Level two", x: 72, y: 690, fontSize: 20 },
        { text: "Level three", x: 72, y: 660, fontSize: 16 },
        { text: "Fourth size", x: 72, y: 630, fontSize: 14 },
        {
          text: "Body copy long enough to outweigh every larger size combined.",
          x: 72,
          y: 600,
          fontSize: 11,
        },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` +
          "# Level one\n" +
          "## Level two\n" +
          "### Level three\n" +
          "Fourth size\n" +
          "Body copy long enough to outweigh every larger size combined.",
      )
    })

    it("renders sizes smaller than body as plain text, never headings", async () => {
      const pdfBuffer = buildPdf([
        {
          text: "Body copy long enough to dominate the character count.",
          x: 72,
          y: 720,
          fontSize: 11,
        },
        { text: "small footer", x: 72, y: 690, fontSize: 9 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` +
          "Body copy long enough to dominate the character count.\n" +
          "small footer",
      )
    })
  })

  describe("within-line ordering and joining", () => {
    it("renders same-line items in x order even when the stream order differs", async () => {
      const pdfBuffer = buildPdf([
        { text: "world", x: 300, y: 700, fontSize: 12 },
        { text: "Hello", x: 100, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nHello world`)
    })

    it("collapses letter-spaced caps but keeps real word gaps and lowercase prose", async () => {
      // "SUMMARY" and "SECTION" as per-glyph ops with 0.3em tracking (pdfjs
      // merges each into one item with literal spaces baked in), separated by
      // a 1em word gap (pdfjs breaks items there). Helvetica AFM widths at
      // 12pt drive the x positions.
      const pdfBuffer = buildPdf([
        { text: "S", x: 100, y: 700, fontSize: 12 },
        { text: "U", x: 111.6, y: 700, fontSize: 12 },
        { text: "M", x: 123.87, y: 700, fontSize: 12 },
        { text: "M", x: 137.46, y: 700, fontSize: 12 },
        { text: "A", x: 151.06, y: 700, fontSize: 12 },
        { text: "R", x: 162.66, y: 700, fontSize: 12 },
        { text: "Y", x: 174.93, y: 700, fontSize: 12 },
        { text: "S", x: 195, y: 700, fontSize: 12 },
        { text: "E", x: 206.6, y: 700, fontSize: 12 },
        { text: "C", x: 218.21, y: 700, fontSize: 12 },
        { text: "T", x: 230.47, y: 700, fontSize: 12 },
        { text: "I", x: 241.4, y: 700, fontSize: 12 },
        { text: "O", x: 248.34, y: 700, fontSize: 12 },
        { text: "N", x: 261.28, y: 700, fontSize: 12 },
        { text: "on a to", x: 100, y: 660, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nSUMMARY SECTION\non a to`)
    })

    it("does not collapse spaced digit runs", async () => {
      const pdfBuffer = buildPdf([{ text: "12 34 56", x: 100, y: 700, fontSize: 12 }])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n12 34 56`)
    })

    it("keeps on one line items that each sit within 2pt of the item before them", async () => {
      // Each item is 1.4pt below the one before it, and the last is 2.8pt
      // below the first, so only comparing each item with its predecessor
      // keeps all three together.
      const pdfBuffer = buildPdf([
        { text: "rising", x: 100, y: 700, fontSize: 12 },
        { text: "baseline", x: 160, y: 698.6, fontSize: 12 },
        { text: "drift", x: 230, y: 697.2, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nrising baseline drift`)
    })

    it("joins items separated by a word-sized gap with exactly one space", async () => {
      const pdfBuffer = buildPdf([
        { text: "foo", x: 100, y: 700, fontSize: 12 },
        { text: "bar", x: 200, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nfoo bar`)
    })
  })

  describe("monospace rendering", () => {
    it("fences consecutive fully-monospace lines as one code block", async () => {
      const pdfBuffer = buildPdf([
        { text: "const x = 1", x: 72, y: 700, fontSize: 12, font: "courier" },
        { text: "return x", x: 72, y: 680, fontSize: 12, font: "courier" },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n\`\`\`\nconst x = 1\nreturn x\n\`\`\``)
    })

    it("wraps a monospace run inside a mixed line in inline backticks, not a fence", async () => {
      const pdfBuffer = buildPdf([
        { text: "Run", x: 100, y: 700, fontSize: 12 },
        {
          text: "kubectl apply",
          x: 125.6,
          y: 700,
          fontSize: 12,
          font: "courier",
        },
        { text: "now", x: 222.8, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nRun \`kubectl apply\` now`)
    })

    it("joins tight cross-font junctions without inserting spaces", async () => {
      // "(" ends at 103.996 (Helvetica 12pt); the Courier run starts 0.5pt
      // later — far below the 0.2em word-gap threshold — and ")" hugs the run
      // end the same way. The font changes force separate items, so this is
      // the only shape that exercises the no-space branch of the gap rule
      // (same-font tight glyphs get merged by pdfjs itself).
      const pdfBuffer = buildPdf([
        { text: "(", x: 100, y: 700, fontSize: 12 },
        { text: "robt", x: 104.5, y: 700, fontSize: 12, font: "courier" },
        { text: ")", x: 133.8, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n(\`robt\`)`)
    })

    it("reconstructs leading indentation inside fence blocks from glyph positions", async () => {
      // pdfjs folds the second op's leading spaces into its x position
      // (str arrives as "return True" at x = 72 + 4 × 7.2); the fence-block
      // renderer rebuilds the four spaces from the x offset and Courier's
      // per-character advance.
      const pdfBuffer = buildPdf([
        { text: "def check():", x: 72, y: 700, fontSize: 12, font: "courier" },
        {
          text: "    return True",
          x: 72,
          y: 680,
          fontSize: 12,
          font: "courier",
        },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n\`\`\`\ndef check():\n    return True\n\`\`\``)
    })

    it("measures fence indentation from the block's leftmost line, not its first", async () => {
      // The first line sits two characters right of the second (Courier 12pt
      // advance = 7.2pt), so the block margin comes from the later line.
      const pdfBuffer = buildPdf([
        {
          text: "indented first",
          x: 86.4,
          y: 700,
          fontSize: 12,
          font: "courier",
        },
        { text: "at margin", x: 72, y: 680, fontSize: 12, font: "courier" },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n\`\`\`\n  indented first\nat margin\n\`\`\``)
    })

    it("lengthens the fence when block content contains backtick runs", async () => {
      const pdfBuffer = buildPdf([
        { text: "```js", x: 72, y: 700, fontSize: 12, font: "courier" },
        { text: "const x = 1", x: 72, y: 680, fontSize: 12, font: "courier" },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n\`\`\`\`\n\`\`\`js\nconst x = 1\n\`\`\`\``)
    })

    it("closes an open fence before a mixed line and reopens after it", async () => {
      const pdfBuffer = buildPdf([
        { text: "line one", x: 72, y: 700, fontSize: 12, font: "courier" },
        { text: "see", x: 72, y: 660, fontSize: 12 },
        { text: "cmd", x: 100, y: 660, fontSize: 12, font: "courier" },
        { text: "line two", x: 72, y: 620, fontSize: 12, font: "courier" },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n\`\`\`\nline one\n\`\`\`\nsee \`cmd\`\n\`\`\`\nline two\n\`\`\``,
      )
    })
  })

  describe("orphaned list markers", () => {
    it("rejoins numeric markers emitted before their items in the stream", async () => {
      const pdfBuffer = buildPdf([
        { text: "1.", x: 100, y: 700, fontSize: 12 },
        { text: "2.", x: 100, y: 660, fontSize: 12 },
        { text: "First thing", x: 115, y: 700, fontSize: 12 },
        { text: "Second thing", x: 115, y: 660, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n1. First thing\n2. Second thing`)
    })

    it("rejoins lettered markers, lowercase and uppercase, to their items", async () => {
      // The markers and their items are separated in the stream by another
      // line, so only the rejoin pass — not plain sequential grouping — can
      // merge them (same shape as the numeric-marker test).
      const pdfBuffer = buildPdf([
        { text: "a.", x: 100, y: 700, fontSize: 12 },
        { text: "A.", x: 100, y: 660, fontSize: 12 },
        { text: "closing line", x: 72, y: 620, fontSize: 12 },
        { text: "Alpha item", x: 115, y: 700, fontSize: 12 },
        { text: "Upper item", x: 115, y: 660, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nclosing line\na. Alpha item\nA. Upper item`)
    })

    it("rejoins bullet-glyph markers to their items", async () => {
      const pdfBuffer = buildPdf([
        { text: "•", x: 100, y: 700, fontSize: 12 },
        { text: "closing line", x: 72, y: 660, fontSize: 12 },
        { text: "Bullet item", x: 112, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nclosing line\n• Bullet item`)
    })

    it("rejoins a marker equidistant from two lines to the earlier line in the stream", async () => {
      // "Alpha item" sits 1pt below the marker and "Beta item" 1pt above it.
      // "Spacer" keeps the marker from grouping with Alpha, and Alpha and Beta
      // are 2pt apart, not under the 2pt threshold, so the marker, Alpha and
      // Beta are three separate lines before the rejoin.
      const pdfBuffer = buildPdf([
        { text: "1.", x: 100, y: 700, fontSize: 12 },
        { text: "Spacer", x: 72, y: 600, fontSize: 12 },
        { text: "Alpha item", x: 115, y: 699, fontSize: 12 },
        { text: "Beta item", x: 115, y: 701, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nSpacer\n1. Alpha item\nBeta item`)
    })

    it("leaves non-marker short lines and partnerless markers untouched", async () => {
      const pdfBuffer = buildPdf([
        { text: "3.14", x: 100, y: 700, fontSize: 12 },
        { text: "middle", x: 72, y: 660, fontSize: 12 },
        { text: "pi value", x: 150, y: 700, fontSize: 12 },
        { text: "7.", x: 100, y: 500, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n3.14\nmiddle\npi value\n7.`)
    })
  })
})

describe("extractPdfText rendition from structured items", () => {
  it("returns structured markdown with title, headings, and text", async () => {
    stubPdfDocument({
      title: "Research Paper",
      itemsByPage: [
        [
          ...buildPageItems(["Introduction"], { fontSize: 18 }),
          ...buildPageItems(["This is the body text of the paper."], {
            fontSize: 10.5,
          }).map((item) => ({ ...item, y: 750 })),
        ],
      ],
      linksByPage: [["https://example.com"]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: [
        "Title: Research Paper | Pages: 1 | Links: 1",
        "",
        "# Introduction",
        "This is the body text of the paper.",
        "",
        "Links:",
        "- https://example.com",
      ].join("\n"),
      totalPages: 1,
    })
  })

  it("detects monospace font as fenced code blocks", async () => {
    stubPdfDocument({
      title: "Code Doc",
      itemsByPage: [
        [
          ...buildPageItems(["Example:"], { fontSize: 10.5 }),
          ...buildPageItems(["const x = 42"], {
            fontSize: 10.5,
            fontFamily: "monospace",
          }).map((item) => ({ ...item, y: 750 })),
          ...buildPageItems(["return x"], {
            fontSize: 10.5,
            fontFamily: "monospace",
          }).map((item) => ({ ...item, y: 735 })),
          ...buildPageItems(["End of example."], { fontSize: 10.5 }).map((item) => ({
            ...item,
            y: 720,
          })),
        ],
      ],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: [
        "Title: Code Doc | Pages: 1",
        "",
        "Example:",
        "```",
        "const x = 42",
        "return x",
        "```",
        "End of example.",
      ].join("\n"),
      totalPages: 1,
    })
  })

  it("keeps an RTL line's items in stream order instead of sorting them by x", async () => {
    // pdfjs emits RTL runs in reading order, so the first word in the stream
    // sits further right. The baked space joins the words in either order,
    // which leaves the word order as the only thing under test.
    const rtlItemMetrics = {
      y: 780,
      height: 10.5,
      fontSize: 10.5,
      fontFamily: "sans-serif",
      dir: "rtl" as const,
      hasEOL: false,
    }
    stubPdfDocument({
      title: "RTL Doc",
      itemsByPage: [
        [
          { ...rtlItemMetrics, str: "שלום ", x: 300, width: 35 },
          { ...rtlItemMetrics, str: "עולם", x: 200, width: 28 },
        ],
      ],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: ["Title: RTL Doc | Pages: 1", "", "שלום עולם"].join("\n"),
      totalPages: 1,
    })
  })

  it("keeps a space baked into either edge of a tight cross-font junction", async () => {
    // Each item starts where the one before it ends, so neither junction has
    // a word-sized gap. Only the space at the end of "Run " and the start of
    // " now" can put a space back once each font run's text is trimmed.
    const itemMetrics = {
      y: 780,
      height: 10.5,
      fontSize: 10.5,
      dir: "ltr" as const,
      hasEOL: false,
    }
    stubPdfDocument({
      title: "Junction Doc",
      itemsByPage: [
        [
          { ...itemMetrics, str: "Run ", x: 42, width: 28, fontFamily: "sans-serif" },
          { ...itemMetrics, str: "kubectl", x: 70, width: 49, fontFamily: "monospace" },
          { ...itemMetrics, str: " now", x: 119, width: 28, fontFamily: "sans-serif" },
        ],
      ],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: ["Title: Junction Doc | Pages: 1", "", "Run `kubectl` now"].join("\n"),
      totalPages: 1,
    })
  })

  it("deduplicates links in the footer", async () => {
    stubPdfDocument({
      title: "Links Doc",
      itemsByPage: [buildPageItems(["Some text"])],
      linksByPage: [["https://example.com", "https://other.com", "https://example.com"]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: [
        "Title: Links Doc | Pages: 1 | Links: 2",
        "",
        "Some text",
        "",
        "Links:",
        "- https://example.com",
        "- https://other.com",
      ].join("\n"),
      totalPages: 1,
    })
  })

  it("shows (untitled) when the PDF has no title metadata", async () => {
    stubPdfDocument({ itemsByPage: [buildPageItems(["Hello"])], linksByPage: [[]] })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: ["Title: (untitled) | Pages: 1", "", "Hello"].join("\n"),
      totalPages: 1,
    })
  })

  it("adds page separators for multi-page documents", async () => {
    stubPdfDocument({
      title: "Multi-page",
      itemsByPage: [buildPageItems(["Page one content"]), buildPageItems(["Page two content"])],
      linksByPage: [[], []],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: [
        "Title: Multi-page | Pages: 2",
        "",
        "Page one content",
        "",
        "--- Page 2 ---",
        "",
        "Page two content",
      ].join("\n"),
      totalPages: 2,
    })
  })

  it("returns empty text when every item is whitespace", async () => {
    stubPdfDocument({
      title: "Blank",
      itemsByPage: [buildPageItems(["   ", "\t", "  \n  "])],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({ text: "", totalPages: 1 })
  })

  it("closes a code fence at end of page when no sans-serif transition follows", async () => {
    stubPdfDocument({
      title: "Trailing Code",
      itemsByPage: [
        [
          ...buildPageItems(["Preamble"], { fontSize: 10.5 }),
          ...buildPageItems(["func main() {"], {
            fontSize: 10.5,
            fontFamily: "monospace",
          }).map((item) => ({ ...item, y: 750 })),
          ...buildPageItems(["  fmt.Println()"], {
            fontSize: 10.5,
            fontFamily: "monospace",
          }).map((item) => ({ ...item, y: 735 })),
        ],
      ],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: [
        "Title: Trailing Code | Pages: 1",
        "",
        "Preamble",
        "```",
        "func main() {",
        "fmt.Println()",
        "```",
      ].join("\n"),
      totalPages: 1,
    })
  })

  it("skips heading detection when all items share one font size", async () => {
    stubPdfDocument({
      title: "Flat Doc",
      itemsByPage: [buildPageItems(["Title Line", "Body text here"], { fontSize: 11 })],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: ["Title: Flat Doc | Pages: 1", "", "Title Line", "Body text here"].join("\n"),
      totalPages: 1,
    })
  })

  // Spreading this many values into one call throws a RangeError in Node, so
  // these pin that a code block and a links list are built without one.
  const OVERSIZED_COUNT = 130_000

  it("renders a code block longer than a call's argument limit", async () => {
    // Each line carries a backtick, so the fence-length check sees one run per line
    const codeLines = Array.from({ length: OVERSIZED_COUNT }, () => "`x")
    stubPdfDocument({
      title: "Long Code",
      itemsByPage: [buildPageItems(codeLines, { fontFamily: "monospace" })],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: ["Title: Long Code | Pages: 1", "", "```", ...codeLines, "```"].join("\n"),
      totalPages: 1,
    })
  })

  it("lists more links than a call's argument limit", async () => {
    const linkUrls = Array.from({ length: OVERSIZED_COUNT }, (_, index) => {
      return `https://example.com/${index}`
    })
    stubPdfDocument({
      title: "Many Links",
      itemsByPage: [buildPageItems(["Some text"])],
      linksByPage: [linkUrls],
    })
    const linkLines = linkUrls.map((linkUrl) => `- ${linkUrl}`)

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: [
        `Title: Many Links | Pages: 1 | Links: ${OVERSIZED_COUNT}`,
        "",
        "Some text",
        "",
        "Links:",
        ...linkLines,
      ].join("\n"),
      totalPages: 1,
    })
  })

  it("destroys the document proxy after successful extraction", async () => {
    const destroy = stubPdfDocument({
      title: "Cleanup Test",
      itemsByPage: [buildPageItems(["Content"])],
      linksByPage: [[]],
    })

    expect(await extractPdfText(new Uint8Array([1]))).toEqual({
      text: ["Title: Cleanup Test | Pages: 1", "", "Content"].join("\n"),
      totalPages: 1,
    })
    expect(destroy).toHaveBeenCalledExactlyOnceWith()
  })

  it("destroys the document proxy even when extraction throws", async () => {
    const destroy = vi.fn()
    vi.mocked(createPdfDocumentProxy, { partial: true, deep: true }).mockResolvedValueOnce({
      loadingTask: { destroy },
      numPages: 1,
    })
    vi.mocked(getMeta, { partial: true, deep: true }).mockResolvedValueOnce({ info: {} })
    const extractionFailure = new Error("text layer could not be read")
    vi.mocked(extractTextItems).mockRejectedValueOnce(extractionFailure)

    // The failure arriving unchanged shows it was thrown inside extraction
    await expect(extractPdfText(new Uint8Array([1]))).rejects.toBe(extractionFailure)
    expect(destroy).toHaveBeenCalledExactlyOnceWith()
  })

  it("passes a PDF load failure through unchanged", async () => {
    // The engine's own failure to load arrives under this message
    const loadFailure = new Error("PDF reader could not start", {
      cause: new Error("worker terminated"),
    })
    vi.mocked(createPdfDocumentProxy).mockRejectedValueOnce(loadFailure)

    await expect(extractPdfText(new Uint8Array([1]))).rejects.toBe(loadFailure)
  })
})
