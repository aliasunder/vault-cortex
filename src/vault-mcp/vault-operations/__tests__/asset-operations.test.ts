import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest"
import { assetOperations } from "../asset-operations.js"
import { logger } from "../../../logger.js"

vi.mock("../vault-filesystem.js", () => ({
  vaultFs: {
    readAsset: vi.fn(),
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

vi.mock("../../../utils/pdf-engine.js", () => ({
  createPdfDocumentProxy: mockCreatePdfDocumentProxy,
  canvasImport: mockCanvasImport,
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
  maxFileBytes: 52_428_800,
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "untitled.pdf" },
      logger,
    )

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
      'unsupported file type ".mp3": "audio/song.mp3" exists ' +
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
    mockCreatePdfDocumentProxy.mockRejectedValue(
      new Error("Invalid PDF structure"),
    )
    // Restore the default mock regardless of assertion outcome — without
    // this, a failing assertion leaves subsequent tests with a rejecting mock.
    onTestFinished(() => {
      mockCreatePdfDocumentProxy.mockResolvedValue({
        loadingTask: { destroy: mockDestroy },
        numPages: 1,
      })
    })

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "corrupt.pdf" },
        logger,
      ),
    ).rejects.toThrow("Invalid PDF structure")
  })

  it("destroys the document proxy after successful extraction", async () => {
    mockDestroy.mockClear()
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

    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it("destroys the document proxy even when extraction throws", async () => {
    mockDestroy.mockClear()
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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "code.pdf" },
      logger,
    )

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
    mockExtractLinks.mockResolvedValue({ links: [], totalPages: 1 })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "flat.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      path: "flat.pdf",
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
 *  returns the given title, the proxy reports numPages, and
 *  extractTextItems is pre-configured (only called in non-raw mode). */
const setupPdfMocks = (params: { numPages: number; title?: string }) => {
  mockedReadAsset.mockResolvedValue({
    buffer: Buffer.from("fake-pdf-bytes"),
    bytes: 50_000,
    extension: ".pdf",
  })
  mockCreatePdfDocumentProxy.mockResolvedValue({
    loadingTask: { destroy: mockDestroy },
    numPages: params.numPages,
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
    mockDestroy.mockClear()
    mockCreatePdfDocumentProxy.mockReset()
    mockCreatePdfDocumentProxy.mockResolvedValue({
      loadingTask: { destroy: mockDestroy },
      numPages: 1,
    })
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
    const fittedResult = buildFittedImage()
    mockedFitImage.mockResolvedValue(fittedResult)

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "long.pdf", raw: true, maxPdfRenderPages: 3 },
      logger,
    )

    expect(result).toMatchObject({
      kind: "pages",
      pagesRendered: 3,
      totalPages: 10,
      pages: [
        { pageNumber: 1, fitted: fittedResult },
        { pageNumber: 2, fitted: fittedResult },
        { pageNumber: 3, fitted: fittedResult },
      ],
    })
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
    const fittedResult = buildFittedImage()
    mockedFitImage.mockResolvedValue(fittedResult)

    const result = await assetOperations.readAssetContent(
      {
        ...defaultParams,
        path: "partial.pdf",
        raw: true,
        maxPdfRenderPages: 3,
      },
      logger,
    )

    expect(result).toEqual({
      kind: "pages",
      pages: [
        { pageNumber: 1, fitted: fittedResult, originalBytes: 5_000 },
        { pageNumber: 3, fitted: fittedResult, originalBytes: 5_000 },
      ],
      title: "Partial",
      totalPages: 3,
      pagesRendered: 2,
      path: "partial.pdf",
    })
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

  it("renders through the configured document proxy, not raw bytes", async () => {
    setupPdfMocks({ numPages: 1, title: "Proxy Flow" })
    const configuredProxy = {
      loadingTask: { destroy: mockDestroy },
      numPages: 1,
    }
    mockCreatePdfDocumentProxy.mockResolvedValue(configuredProxy)
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    await assetOperations.readAssetContent(
      { ...defaultParams, path: "flow.pdf", raw: true },
      logger,
    )

    // The proxy carries the font/canvas configuration — rendering from raw
    // bytes instead would silently rebuild an unconfigured document.
    expect(mockRenderPageAsImage).toHaveBeenCalledWith(configuredProxy, 1, {
      canvasImport: mockCanvasImport,
      scale: 2,
    })
  })

  it("destroys the proxy after successful page rendering", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    await assetOperations.readAssetContent(
      { ...defaultParams, path: "cleanup.pdf", raw: true },
      logger,
    )

    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it("destroys the proxy even when all pages fail", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockRejectedValue(new Error("render failed"))

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "fail.pdf", raw: true, maxPdfRenderPages: 1 },
        logger,
      ),
    ).rejects.toThrow("PDF page rendering failed")

    expect(mockDestroy).toHaveBeenCalledOnce()
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

  it("omits title from pages result when PDF has no title metadata", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new ArrayBuffer(1_000))
    const fittedResult = buildFittedImage()
    mockedFitImage.mockResolvedValue(fittedResult)

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "notitle.pdf", raw: true },
      logger,
    )

    expect(result).toEqual({
      kind: "pages",
      pages: [{ pageNumber: 1, fitted: fittedResult, originalBytes: 1_000 }],
      title: undefined,
      totalPages: 1,
      pagesRendered: 1,
      path: "notitle.pdf",
    })
  })
})

describe("readAssetContent — line paging", () => {
  /** Stubs readAsset with a UTF-8 text file of the given extension. */
  const stubReadAsset = (content: string, extension: string): void => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from(content, "utf8"),
      bytes: Buffer.byteLength(content, "utf8"),
      extension,
    })
  }

  it("pages a text file to the requested window with 1-based metadata", async () => {
    stubReadAsset("line1\nline2\nline3\nline4\nline5\n", ".csv")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "data.csv", startLine: 2, limit: 2 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "line2\nline3",
      path: "data.csv",
      lineWindow: { startLine: 2, endLine: 3, totalLines: 5 },
    })
  })

  it("returns the remaining lines when limit is omitted", async () => {
    stubReadAsset("line1\nline2\nline3\nline4\nline5\n", ".log")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "server.log", startLine: 4 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "line4\nline5",
      path: "server.log",
      lineWindow: { startLine: 4, endLine: 5, totalLines: 5 },
    })
  })

  it("returns the first lines when the start line is omitted", async () => {
    stubReadAsset("line1\nline2\nline3\nline4\nline5\n", ".txt")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "notes.txt", limit: 2 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "line1\nline2",
      path: "notes.txt",
      lineWindow: { startLine: 1, endLine: 2, totalLines: 5 },
    })
  })

  it("returns LF-joined lines for a CRLF file", async () => {
    stubReadAsset("alpha\r\nbeta\r\ngamma\r\n", ".csv")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "windows.csv", startLine: 1, limit: 3 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "alpha\nbeta\ngamma",
      path: "windows.csv",
      lineWindow: { startLine: 1, endLine: 3, totalLines: 3 },
    })
  })

  it("does not count a trailing newline's empty final line", async () => {
    stubReadAsset("alpha\nbeta\n", ".txt")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "trailing.txt", startLine: 1 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "alpha\nbeta",
      path: "trailing.txt",
      lineWindow: { startLine: 1, endLine: 2, totalLines: 2 },
    })
  })

  it("counts lines correctly for a file without a trailing newline", async () => {
    stubReadAsset("line1\nline2\nline3", ".csv")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "no-trailing.csv", startLine: 2, limit: 2 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "line2\nline3",
      path: "no-trailing.csv",
      lineWindow: { startLine: 2, endLine: 3, totalLines: 3 },
    })
  })

  it("returns a zero-line window for an empty file", async () => {
    stubReadAsset("", ".csv")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "empty.csv", startLine: 1 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "",
      path: "empty.csv",
      lineWindow: { startLine: 1, endLine: 0, totalLines: 0 },
    })
  })

  it("returns the empty window for a start line past an empty file", async () => {
    stubReadAsset("", ".log")

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "empty.log", startLine: 50 },
      logger,
    )

    // The window covers [startLine, endLine] and is empty when
    // endLine < startLine — an empty rendition has nothing to overshoot.
    expect(result).toEqual({
      kind: "text",
      text: "",
      path: "empty.log",
      lineWindow: { startLine: 50, endLine: 49, totalLines: 0 },
    })
  })

  it("rejects a start line below 1 instead of slicing from the end", async () => {
    stubReadAsset("alpha\nbeta\ngamma\n", ".csv")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "data.csv", startLine: 0 },
        logger,
      ),
    ).rejects.toThrow(
      'invalid line range: "data.csv" needs a start line and limit of at least 1',
    )
  })

  it("rejects a limit below 1", async () => {
    stubReadAsset("alpha\nbeta\ngamma\n", ".csv")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "data.csv", limit: 0 },
        logger,
      ),
    ).rejects.toThrow(
      'invalid line range: "data.csv" needs a start line and limit of at least 1',
    )
  })

  it("rejects a start line past the end stating the total line count", async () => {
    stubReadAsset("alpha\nbeta\ngamma\n", ".csv")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "data.csv", startLine: 4 },
        logger,
      ),
    ).rejects.toThrow('start line past the end: "data.csv" renders to 3 lines')
  })

  it("rejects a paged window that still exceeds the output cap", async () => {
    const oversizedLine = "x".repeat(102_401)
    stubReadAsset(`${oversizedLine}\nshort line\n`, ".log")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "big.log", startLine: 1, limit: 1 },
        logger,
      ),
    ).rejects.toThrow(
      'text output too large: "big.log" lines 1–1 render to 102401 bytes ' +
        "(cap 102400 bytes)",
    )
  })

  it("pages the reconstructed PDF text", async () => {
    stubReadAsset("fake-pdf-bytes", ".pdf")
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
      { ...defaultParams, path: "papers/research.pdf", startLine: 3, limit: 2 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "# Introduction\nThis is the body text of the paper.",
      path: "papers/research.pdf",
      lineWindow: { startLine: 3, endLine: 4, totalLines: 7 },
    })
  })

  it("pages the raw canvas source", async () => {
    stubReadAsset('{\n  "nodes": [],\n  "edges": []\n}', ".canvas")

    const result = await assetOperations.readAssetContent(
      {
        ...defaultParams,
        path: "Boards/Roadmap.canvas",
        raw: true,
        startLine: 2,
        limit: 2,
      },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: '  "nodes": [],\n  "edges": []',
      path: "Boards/Roadmap.canvas",
      lineWindow: { startLine: 2, endLine: 3, totalLines: 4 },
    })
  })

  it("rejects paging combined with raw PDF page rendering", async () => {
    stubReadAsset("fake-pdf-bytes", ".pdf")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "doc.pdf", raw: true, startLine: 1 },
        logger,
      ),
    ).rejects.toThrow(
      'line range is not available for rendered PDF pages: "doc.pdf" ' +
        "delivers page images, not text",
    )
  })

  it("rejects paging for an image", async () => {
    stubReadAsset("fake-png-bytes", ".png")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "pic.png", limit: 10 },
        logger,
      ),
    ).rejects.toThrow(
      'line range is not available for images: "pic.png" is binary — ' +
        "its image block is the delivered form",
    )
  })
})
