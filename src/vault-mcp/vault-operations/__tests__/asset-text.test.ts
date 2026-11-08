import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildPdfTextResult, describePdfOpenFailure } from "../asset-text.js"
import type { AssetTextResult } from "../asset-text.js"
import { extractPdfText } from "../../obsidian-markdown/pdf.js"
import { logger } from "../../../logger.js"

vi.mock("../vault-filesystem.js", () => ({
  vaultFs: {
    readAsset: vi.fn(),
    listAssets: vi.fn(),
    statAssets: vi.fn(),
  },
}))

const {
  mockDestroy,
  mockCanvasImport,
  mockCreatePdfDocumentProxy,
  mockGetMeta,
  mockExtractTextItems,
  mockExtractLinks,
  mockRenderPageAsImage,
} = vi.hoisted(() => {
  const mockDestroy = vi.fn()
  return {
    mockDestroy,
    mockCanvasImport: vi.fn(),
    mockCreatePdfDocumentProxy: vi.fn(() => ({
      loadingTask: { destroy: mockDestroy },
      numPages: 1,
    })),
    mockGetMeta: vi.fn(),
    mockExtractTextItems: vi.fn(),
    mockExtractLinks: vi.fn(),
    mockRenderPageAsImage: vi.fn(),
  }
})

vi.mock("unpdf", () => ({
  getMeta: mockGetMeta,
  extractTextItems: mockExtractTextItems,
  extractLinks: mockExtractLinks,
  renderPageAsImage: mockRenderPageAsImage,
}))

vi.mock("../../obsidian-markdown/pdf-engine.js", () => ({
  createPdfDocumentProxy: mockCreatePdfDocumentProxy,
  canvasImport: mockCanvasImport,
}))

vi.mock("../../../utils/fit-image-to-byte-budget.js", () => ({
  fitImageToByteBudget: vi.fn(),
}))

import { vaultFs } from "../vault-filesystem.js"

const mockedReadAsset = vi.mocked(vaultFs.readAsset)

// Every test sets the mock values it relies on, so none passes on values an
// earlier test left behind
beforeEach(() => {
  vi.resetAllMocks()
})

const defaultParams = {
  path: "doc.pdf",
}

const readFixturePdfText = async (
  params: { path: string; raw?: boolean; startLine?: number; limit?: number },
  readLogger: typeof logger,
): Promise<AssetTextResult> => {
  const asset = await vaultFs.readAsset(
    { vaultPath: "/vault", path: params.path, maxBytes: 52_428_800 },
    readLogger,
  )
  const pdfData = new Uint8Array(asset.buffer)
  const extracted = await extractPdfText(pdfData).catch((error: unknown) => {
    const message = describePdfOpenFailure({ error, path: params.path, bytes: asset.bytes })

    if (!message) throw error
    throw new Error(message, { cause: error })
  })
  return buildPdfTextResult({ ...extracted, ...params, bytes: asset.bytes })
}

/** Builds a single-page StructuredTextItem array from lines of text. Items
 *  are positioned vertically (descending y, like a real PDF) with the given
 *  fontSize and fontFamily. */
const buildPageItems = (lines: string[], options?: { fontSize?: number; fontFamily?: string }) => {
  return lines.map((str, index) => ({
    str,
    x: 42,
    y: 780 - index * 15,
    width: str.length * 7,
    height: options?.fontSize ?? 10.5,
    fontSize: options?.fontSize ?? 10.5,
    fontFamily: options?.fontFamily ?? "sans-serif",
    dir: "ltr" as const,
    hasEOL: true,
  }))
}

describe("PDF text rendition", () => {
  it("returns structured markdown with title, headings, and text", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf-bytes"),
      bytes: 12_345,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Research Paper" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [
        [
          ...buildPageItems(["Introduction"], { fontSize: 18 }),
          ...buildPageItems(["This is the body text of the paper."], {
            fontSize: 10.5,
          }).map((item) => ({ ...item, y: 750 })),
        ],
      ],
    })
    mockExtractLinks.mockResolvedValue({
      links: [["https://example.com"]],
      totalPages: 1,
    })

    const result = await readFixturePdfText(
      { ...defaultParams, path: "papers/research.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      path: "papers/research.pdf",
      text: [
        "Title: Research Paper | Pages: 1 | Links: 1",
        "",
        "# Introduction",
        "This is the body text of the paper.",
        "",
        "Links:",
        "- https://example.com",
      ].join("\n"),
    })
  })

  it("detects monospace font as fenced code blocks", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 5_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Code Doc" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [
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
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText({ ...defaultParams, path: "doc.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "doc.pdf",
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
    })
  })

  it("keeps an RTL line's items in stream order instead of sorting them by x", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 2_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({ info: { Title: "RTL Doc" } })
    // pdfjs emits RTL runs in reading order, so the first word in the stream
    // sits further right. The baked space joins the words in either order,
    // which leaves the word order as the only thing under test.
    const rtlItemMetrics = {
      y: 780,
      height: 10.5,
      fontSize: 10.5,
      fontFamily: "sans-serif",
      dir: "rtl",
      hasEOL: false,
    }
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [
        [
          { ...rtlItemMetrics, str: "שלום ", x: 300, width: 35 },
          { ...rtlItemMetrics, str: "עולם", x: 200, width: 28 },
        ],
      ],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText({ ...defaultParams, path: "rtl.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "rtl.pdf",
      text: ["Title: RTL Doc | Pages: 1", "", "שלום עולם"].join("\n"),
    })
  })

  it("keeps a space baked into either edge of a tight cross-font junction", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 2_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({ info: { Title: "Junction Doc" } })
    // Each item starts where the one before it ends, so neither junction has
    // a word-sized gap. Only the space at the end of "Run " and the start of
    // " now" can put a space back once each font run's text is trimmed.
    const itemMetrics = {
      y: 780,
      height: 10.5,
      fontSize: 10.5,
      dir: "ltr",
      hasEOL: false,
    }
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [
        [
          { ...itemMetrics, str: "Run ", x: 42, width: 28, fontFamily: "sans-serif" },
          { ...itemMetrics, str: "kubectl", x: 70, width: 49, fontFamily: "monospace" },
          { ...itemMetrics, str: " now", x: 119, width: 28, fontFamily: "sans-serif" },
        ],
      ],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText({ ...defaultParams, path: "junction.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "junction.pdf",
      text: ["Title: Junction Doc | Pages: 1", "", "Run `kubectl` now"].join("\n"),
    })
  })

  it("deduplicates links in the footer", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 3_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Links Doc" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[...buildPageItems(["Some text"])]],
    })
    mockExtractLinks.mockResolvedValue({
      links: [["https://example.com", "https://other.com", "https://example.com"]],
      totalPages: 1,
    })

    const result = await readFixturePdfText({ ...defaultParams, path: "doc.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "doc.pdf",
      text: [
        "Title: Links Doc | Pages: 1 | Links: 2",
        "",
        "Some text",
        "",
        "Links:",
        "- https://example.com",
        "- https://other.com",
      ].join("\n"),
    })
  })

  it("shows (untitled) when the PDF has no title metadata", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 2_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({ info: {} })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[...buildPageItems(["Hello"])]],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText({ ...defaultParams, path: "untitled.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "untitled.pdf",
      text: ["Title: (untitled) | Pages: 1", "", "Hello"].join("\n"),
    })
  })

  it("adds page separators for multi-page documents", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 5_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Multi-page" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 2,
      items: [[...buildPageItems(["Page one content"])], [...buildPageItems(["Page two content"])]],
    })
    mockExtractLinks.mockResolvedValue({ links: [[], []], totalPages: 2 })

    const result = await readFixturePdfText({ ...defaultParams, path: "multi.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "multi.pdf",
      text: [
        "Title: Multi-page | Pages: 2",
        "",
        "Page one content",
        "",
        "--- Page 2 ---",
        "",
        "Page two content",
      ].join("\n"),
    })
  })

  it("throws a descriptive error for scanned PDFs with no extractable text", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-scanned-pdf"),
      bytes: 5_000_000,
      extension: ".pdf",
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 12,
      items: Array.from({ length: 12 }, () => []),
    })
    mockExtractLinks.mockResolvedValue({
      links: Array.from({ length: 12 }, () => []),
      totalPages: 12,
    })

    await expect(
      readFixturePdfText({ ...defaultParams, path: "scans/receipt.pdf" }, logger),
    ).rejects.toThrow(
      new Error(
        'PDF has no extractable text: "scans/receipt.pdf" exists ' +
          "(5000000 bytes, 12 pages) but contains no text content " +
          "— it may be a scanned document or image-only PDF",
      ),
    )
  })

  it("throws for PDFs with only whitespace content", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 1_000,
      extension: ".pdf",
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[...buildPageItems(["   ", "\t", "  \n  "])]],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    await expect(
      readFixturePdfText({ ...defaultParams, path: "empty.pdf" }, logger),
    ).rejects.toThrow(
      new Error(
        'PDF has no extractable text: "empty.pdf" exists ' +
          "(1000 bytes, 1 pages) but contains no text content " +
          "— it may be a scanned document or image-only PDF",
      ),
    )
  })

  it("rejects PDF text exceeding the output cap", async () => {
    const largeText = "x".repeat(200_000)
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 500_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Huge" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[...buildPageItems([largeText])]],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    await expect(
      readFixturePdfText({ ...defaultParams, path: "huge.pdf" }, logger),
    ).rejects.toThrow(
      new Error(
        'text output too large: "huge.pdf" renders to 200024 bytes ' + "(cap 102400 bytes)",
      ),
    )
  })

  it("passes a PDF load failure other than pdf.js refusing the file through unchanged", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("not-a-real-pdf"),
      bytes: 14,
      extension: ".pdf",
    })
    // The engine's own failure to load arrives under this message
    const loadFailure = new Error("PDF reader could not start", {
      cause: new Error("worker terminated"),
    })
    mockCreatePdfDocumentProxy.mockRejectedValue(loadFailure)

    await expect(
      readFixturePdfText({ ...defaultParams, path: "corrupt.pdf" }, logger),
    ).rejects.toBe(loadFailure)
  })

  it.each([
    {
      label: "a password-protected PDF read as text",
      raw: false,
      pdfjsErrorName: "PasswordException",
      message:
        'PDF is password-protected: "papers/locked.pdf" exists (14 bytes) but cannot be opened without its password',
    },
    {
      label: "a damaged PDF read as text",
      raw: false,
      pdfjsErrorName: "InvalidPDFException",
      message:
        'PDF is damaged or not a PDF: "papers/locked.pdf" exists (14 bytes) but cannot be parsed',
    },
  ])(
    "rethrows pdf.js refusing $label as the server's message, keeping pdf.js's error as the cause",
    async ({ raw, pdfjsErrorName, message }) => {
      mockedReadAsset.mockResolvedValue({
        buffer: Buffer.from("not-a-real-pdf"),
        bytes: 14,
        extension: ".pdf",
      })
      // pdf.js marks its refusals by name; the class is not imported here
      const pdfjsError = Object.assign(new Error("pdf.js refused the file"), {
        name: pdfjsErrorName,
      })
      mockCreatePdfDocumentProxy.mockRejectedValue(pdfjsError)

      await expect(
        readFixturePdfText({ ...defaultParams, path: "papers/locked.pdf", raw }, logger),
      ).rejects.toEqual(new Error(message, { cause: pdfjsError }))
    },
  )

  it("destroys the document proxy after successful extraction", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 1_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Cleanup Test" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[...buildPageItems(["Content"])]],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    await readFixturePdfText({ ...defaultParams, path: "test.pdf" }, logger)

    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it("destroys the document proxy even when extraction throws", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 1_000,
      extension: ".pdf",
    })
    const extractionFailure = new Error("text layer could not be read")
    mockExtractTextItems.mockRejectedValue(extractionFailure)

    // The failure arriving unchanged shows it was thrown inside extraction
    await expect(readFixturePdfText({ ...defaultParams, path: "broken.pdf" }, logger)).rejects.toBe(
      extractionFailure,
    )

    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it("closes a code fence at end of page when no sans-serif transition follows", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 4_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Trailing Code" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [
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
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText({ ...defaultParams, path: "code.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "code.pdf",
      text: [
        "Title: Trailing Code | Pages: 1",
        "",
        "Preamble",
        "```",
        "func main() {",
        "fmt.Println()",
        "```",
      ].join("\n"),
    })
  })

  it("skips heading detection when all items share one font size", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 3_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({
      info: { Title: "Flat Doc" },
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [
        [
          ...buildPageItems(["Title Line", "Body text here"], {
            fontSize: 11,
          }),
        ],
      ],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText({ ...defaultParams, path: "flat.pdf" }, logger)

    expect(result).toEqual({
      kind: "text",
      path: "flat.pdf",
      text: ["Title: Flat Doc | Pages: 1", "", "Title Line", "Body text here"].join("\n"),
    })
  })

  // Spreading this many values into one call throws a RangeError in Node, so
  // these pin that a code block and a links list are built without one.
  const OVERSIZED_COUNT = 130_000

  it("renders a code block longer than a call's argument limit", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 5_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({ info: { Title: "Long Code" } })
    // Each line carries a backtick, so the fence-length check sees one run per line
    const codeLines = Array.from({ length: OVERSIZED_COUNT }, () => "`x")
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [buildPageItems(codeLines, { fontFamily: "monospace" })],
    })
    mockExtractLinks.mockResolvedValue({ links: [[]], totalPages: 1 })

    const result = await readFixturePdfText(
      { ...defaultParams, path: "long-code.pdf", startLine: 1, limit: 4 },
      logger,
    )

    // header, blank line, opening fence, every code line, closing fence
    expect(result).toEqual({
      kind: "text",
      path: "long-code.pdf",
      text: ["Title: Long Code | Pages: 1", "", "```", "`x"].join("\n"),
      lineWindow: { startLine: 1, endLine: 4, totalLines: OVERSIZED_COUNT + 4 },
    })
  })

  it("lists more links than a call's argument limit", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 5_000,
      extension: ".pdf",
    })
    mockGetMeta.mockResolvedValue({ info: { Title: "Many Links" } })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [buildPageItems(["Some text"])],
    })
    const linkUrls = Array.from({ length: OVERSIZED_COUNT }, (_, index) => {
      return `https://example.com/${index}`
    })
    mockExtractLinks.mockResolvedValue({ links: [linkUrls], totalPages: 1 })

    const result = await readFixturePdfText(
      { ...defaultParams, path: "many-links.pdf", startLine: 1, limit: 1 },
      logger,
    )

    // header, blank line, the text line, blank line, "Links:", every link
    expect(result).toEqual({
      kind: "text",
      path: "many-links.pdf",
      text: `Title: Many Links | Pages: 1 | Links: ${OVERSIZED_COUNT}`,
      lineWindow: { startLine: 1, endLine: 1, totalLines: OVERSIZED_COUNT + 5 },
    })
  })
})
