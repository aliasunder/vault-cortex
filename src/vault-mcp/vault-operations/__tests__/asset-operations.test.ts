import { describe, it, expect, vi, beforeEach } from "vitest"
import { assetOperations } from "../asset-operations.js"
import { logger } from "../../../logger.js"

vi.mock("../vault-filesystem.js", () => ({
  vaultFs: {
    readAsset: vi.fn(),
  },
}))

const {
  mockCleanup,
  mockGetDocumentProxy,
  mockGetMeta,
  mockExtractTextItems,
  mockExtractLinks,
  mockRenderPageAsImage,
} = vi.hoisted(() => {
  const mockCleanup = vi.fn()
  return {
    mockCleanup,
    mockGetDocumentProxy: vi.fn(() => ({ cleanup: mockCleanup })),
    mockGetMeta: vi.fn(),
    mockExtractTextItems: vi.fn(),
    mockExtractLinks: vi.fn(),
    mockRenderPageAsImage: vi.fn(),
  }
})

vi.mock("unpdf", () => ({
  getDocumentProxy: mockGetDocumentProxy,
  getMeta: mockGetMeta,
  extractTextItems: mockExtractTextItems,
  extractLinks: mockExtractLinks,
  renderPageAsImage: mockRenderPageAsImage,
}))

vi.mock("../../../utils/fit-image-to-byte-budget.js", () => ({
  fitImageToByteBudget: vi.fn(),
}))

import { vaultFs } from "../vault-filesystem.js"
import { fitImageToByteBudget } from "../../../utils/fit-image-to-byte-budget.js"

const mockedReadAsset = vi.mocked(vaultFs.readAsset)
const mockedFitImage = vi.mocked(fitImageToByteBudget)

const defaultParams = {
  vaultPath: "/vault",
  maxAssetBytes: 52_428_800,
  maxImageOutputBytes: 49_152,
  maxPdfRenderPages: 5,
}

/** Builds a single-page StructuredTextItem array from lines of text. Items
 *  are positioned vertically (descending y, like a real PDF) with the given
 *  fontSize and fontFamily. */
const buildPageItems = (
  lines: string[],
  options?: { fontSize?: number; fontFamily?: string },
) =>
  lines.map((str, index) => ({
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

describe("readAssetContent — PDF extraction", () => {
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
      links: ["https://example.com"],
      totalPages: 1,
    })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "papers/research.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
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
          ...buildPageItems(["End of example."], { fontSize: 10.5 }).map(
            (item) => ({ ...item, y: 720 }),
          ),
        ],
      ],
    })
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "doc.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
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
      links: [
        "https://example.com",
        "https://other.com",
        "https://example.com",
      ],
      totalPages: 1,
    })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "doc.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "untitled.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
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
      items: [
        [...buildPageItems(["Page one content"])],
        [...buildPageItems(["Page two content"])],
      ],
    })
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 2 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "multi.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
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

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "scans/receipt.pdf" },
        logger,
      ),
    ).rejects.toThrow(
      'PDF has no extractable text: "scans/receipt.pdf" exists ' +
        "(5000000 bytes, 12 pages) but contains no text content " +
        "— it may be a scanned document or image-only PDF",
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

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "empty.pdf" },
        logger,
      ),
    ).rejects.toThrow(
      'PDF has no extractable text: "empty.pdf" exists ' +
        "(1000 bytes, 1 pages) but contains no text content " +
        "— it may be a scanned document or image-only PDF",
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "huge.pdf" },
        logger,
      ),
    ).rejects.toThrow(
      'text output too large: "huge.pdf" renders to 200024 bytes ' +
        "(cap 102400 bytes)",
    )
  })

  it("includes .pdf in the unsupported-type error's readable types list", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-audio"),
      bytes: 10_000,
      extension: ".mp3",
    })

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "audio/song.mp3" },
        logger,
      ),
    ).rejects.toThrow(
      'unsupported asset type ".mp3": "audio/song.mp3" exists ' +
        "(10000 bytes). Readable types: images " +
        "(.png/.jpg/.jpeg/.gif/.webp), .canvas, .pdf, and text formats " +
        "(.svg/.json/.txt/.csv/.xml/.log/.base)",
    )
  })

  it("propagates getDocumentProxy errors for corrupt PDFs", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("not-a-real-pdf"),
      bytes: 14,
      extension: ".pdf",
    })
    mockGetDocumentProxy.mockRejectedValue(new Error("Invalid PDF structure"))

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "corrupt.pdf" },
        logger,
      ),
    ).rejects.toThrow("Invalid PDF structure")

    // Restore the default mock for other tests
    mockGetDocumentProxy.mockResolvedValue({ cleanup: mockCleanup })
  })

  it("cleans up the document proxy after successful extraction", async () => {
    mockCleanup.mockClear()
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    await assetOperations.readAssetContent(
      { ...defaultParams, path: "test.pdf" },
      logger,
    )

    expect(mockCleanup).toHaveBeenCalledOnce()
  })

  it("cleans up the document proxy even when extraction throws", async () => {
    mockCleanup.mockClear()
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      bytes: 1_000,
      extension: ".pdf",
    })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[]],
    })

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "scanned.pdf" },
        logger,
      ),
    ).rejects.toThrow("PDF has no extractable text")

    expect(mockCleanup).toHaveBeenCalledOnce()
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "code.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "flat.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: [
        "Title: Flat Doc | Pages: 1",
        "",
        "Title Line",
        "Body text here",
      ].join("\n"),
    })
  })
})

// ── PDF page rendering (raw: true) ────────────────────────────

/** Builds a fake FittedImage result for page rendering tests. */
const buildFittedImage = (overrides?: {
  width?: number
  height?: number
  dataLength?: number
}) => ({
  data: Buffer.alloc(overrides?.dataLength ?? 9_600),
  mimeType: "image/jpeg",
  width: overrides?.width ?? 800,
  height: overrides?.height ?? 1036,
  originalWidth: 1224,
  originalHeight: 1584,
  recompressed: true,
})

/** Standard PDF mock setup: readAsset returns a .pdf buffer, getMeta
 *  returns the given title, and extractTextItems returns the given
 *  page count (with empty items — raw mode doesn't use the items). */
const setupPdfMocks = (params: { numPages: number; title?: string }) => {
  mockedReadAsset.mockResolvedValue({
    buffer: Buffer.from("fake-pdf-bytes"),
    bytes: 50_000,
    extension: ".pdf",
  })
  mockGetMeta.mockResolvedValue({
    info: params.title ? { Title: params.title } : {},
  })
  mockExtractTextItems.mockResolvedValue({
    totalPages: params.numPages,
    items: Array.from({ length: params.numPages }, () => []),
  })
}

describe("readAssetContent — PDF page rendering (raw: true)", () => {
  beforeEach(() => {
    mockRenderPageAsImage.mockReset()
    mockedFitImage.mockReset()
    mockCleanup.mockClear()
    mockGetDocumentProxy.mockReset()
    mockGetDocumentProxy.mockResolvedValue({ cleanup: mockCleanup })
    mockGetMeta.mockReset()
    mockExtractTextItems.mockReset()
  })

  it("returns kind pages with rendered images", async () => {
    setupPdfMocks({ numPages: 2, title: "Visual Doc" })
    const fakePng = new ArrayBuffer(10_000)
    mockRenderPageAsImage.mockResolvedValue(fakePng)
    const fittedResult = buildFittedImage()
    mockedFitImage.mockResolvedValue(fittedResult)

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "doc.pdf", raw: true },
      logger,
    )

    expect(result).toEqual({
      kind: "pages",
      pages: [
        { pageNumber: 1, fitted: fittedResult, originalBytes: 10_000 },
        { pageNumber: 2, fitted: fittedResult, originalBytes: 10_000 },
      ],
      title: "Visual Doc",
      totalPages: 2,
      pagesRendered: 2,
      path: "doc.pdf",
    })
  })

  it("respects maxPdfRenderPages cap", async () => {
    setupPdfMocks({ numPages: 10, title: "Long PDF" })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(5_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "long.pdf", raw: true, maxPdfRenderPages: 3 },
      logger,
    )

    expect(result.kind).toBe("pages")
    if (result.kind !== "pages") throw new Error("unreachable")
    expect(result.pagesRendered).toBe(3)
    expect(result.totalPages).toBe(10)
    expect(mockRenderPageAsImage).toHaveBeenCalledTimes(3)
  })

  it("divides per-page budget evenly across rendered pages", async () => {
    setupPdfMocks({ numPages: 4 })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    await assetOperations.readAssetContent(
      {
        ...defaultParams,
        path: "budget.pdf",
        raw: true,
        maxPdfRenderPages: 4,
        maxImageOutputBytes: 40_000,
      },
      logger,
    )

    // 40,000 / 4 pages = 10,000 per page
    for (const call of mockedFitImage.mock.calls) {
      expect(call[0].budgetBytes).toBe(10_000)
    }
  })

  it("skips failed pages and returns the rest", async () => {
    setupPdfMocks({ numPages: 3, title: "Partial" })
    mockRenderPageAsImage
      .mockResolvedValueOnce(new ArrayBuffer(5_000))
      .mockRejectedValueOnce(new Error("render failed"))
      .mockResolvedValueOnce(new ArrayBuffer(5_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    const result = await assetOperations.readAssetContent(
      {
        ...defaultParams,
        path: "partial.pdf",
        raw: true,
        maxPdfRenderPages: 3,
      },
      logger,
    )

    expect(result.kind).toBe("pages")
    if (result.kind !== "pages") throw new Error("unreachable")
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 3])
    expect(result.pagesRendered).toBe(2)
  })

  it("throws when all pages fail to render", async () => {
    setupPdfMocks({ numPages: 2 })
    mockRenderPageAsImage.mockRejectedValue(new Error("render failed"))

    await expect(
      assetOperations.readAssetContent(
        {
          ...defaultParams,
          path: "broken.pdf",
          raw: true,
          maxPdfRenderPages: 2,
        },
        logger,
      ),
    ).rejects.toThrow(
      'PDF page rendering failed: "broken.pdf" exists ' +
        "(50000 bytes, 2 pages) but no pages could be rendered",
    )
  })

  it("cleans up the proxy after successful page rendering", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    await assetOperations.readAssetContent(
      { ...defaultParams, path: "cleanup.pdf", raw: true },
      logger,
    )

    expect(mockCleanup).toHaveBeenCalledOnce()
  })

  it("cleans up the proxy even when all pages fail", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockRejectedValue(new Error("render failed"))

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "fail.pdf", raw: true, maxPdfRenderPages: 1 },
        logger,
      ),
    ).rejects.toThrow("PDF page rendering failed")

    expect(mockCleanup).toHaveBeenCalledOnce()
  })

  it("passes canvasImport and scale to renderPageAsImage", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    await assetOperations.readAssetContent(
      { ...defaultParams, path: "opts.pdf", raw: true },
      logger,
    )

    expect(mockRenderPageAsImage).toHaveBeenCalledOnce()
    const [, pageNumber, options] = mockRenderPageAsImage.mock.calls[0] ?? []
    expect(pageNumber).toBe(1)
    expect(options).toHaveProperty("canvasImport")
    expect(options).toHaveProperty("scale", 2.0)
  })

  it("does not change text extraction when raw is false", async () => {
    setupPdfMocks({ numPages: 1, title: "Text Mode" })
    mockExtractTextItems.mockResolvedValue({
      totalPages: 1,
      items: [[...buildPageItems(["Body text"])]],
    })
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "text.pdf", raw: false },
      logger,
    )

    expect(result.kind).toBe("text")
    expect(mockRenderPageAsImage).not.toHaveBeenCalled()
  })

  it("shows (untitled) in pages result when title is absent", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "notitle.pdf", raw: true },
      logger,
    )

    expect(result.kind).toBe("pages")
    if (result.kind !== "pages") throw new Error("unreachable")
    expect(result.title).toBeUndefined()
  })
})
