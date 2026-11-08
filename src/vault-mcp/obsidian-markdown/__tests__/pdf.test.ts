import { afterEach, describe, it, expect, onTestFinished, vi } from "vitest"
import { createPdfDocumentProxy } from "../pdf-engine.js"
import { extractPdfIndexText, extractPdfText } from "../pdf.js"
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
afterEach(() => vi.restoreAllMocks())

const createIndexProbe = async (params: { pdfData: Uint8Array; pageTexts?: readonly string[] }) => {
  const proxy = await createPdfDocumentProxy(params.pdfData)
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
      const content = await getTextContent()
      const replacementText = params.pageTexts?.[pageNumber - 1]

      if (replacementText === undefined) return content

      return {
        ...content,
        items: content.items.map((item) => {
          if (!("str" in item)) return item
          return { ...item, str: replacementText }
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
  return { requestedPages, events }
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
      const chosenRendition =
        extraBytes === -1
          ? header + bodyText + "\n\n--- Page 2 ---\n\nCAP-CROSSING-PAGE" + footer
          : header + bodyText + footer
      const expectedText = Buffer.from(chosenRendition, "utf8")
        .subarray(0, 102_400)
        .toString("utf8")

      expect(await extractPdfIndexText(pdfData)).toEqual({ text: expectedText, totalPages: 3 })
      expect(probe.requestedPages).toEqual(expectedPages)
    },
  )

  it("truncates a multibyte code point only as a whole", async () => {
    const header = "Title: Bound | Pages: 2\n\n"
    const bodyText = "x".repeat(102_400 - Buffer.byteLength(header, "utf8") - 1) + "🎉after"
    const pdfData = toPdfData(
      buildLinkedPdf({
        title: "Bound",
        pages: [
          { text: "first", linkUrls: [] },
          { text: "UNVISITED-AFTER-CAP", linkUrls: [] },
        ],
      }),
    )
    const probe = await createIndexProbe({ pdfData, pageTexts: [bodyText] })

    expect(await extractPdfIndexText(pdfData)).toEqual({
      text: header + "x".repeat(102_400 - Buffer.byteLength(header, "utf8") - 1),
      totalPages: 2,
    })
    expect(probe.requestedPages).toEqual([1])
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
    },
  )
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
