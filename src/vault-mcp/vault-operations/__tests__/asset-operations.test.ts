import { describe, it, expect, vi } from "vitest"
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
} = vi.hoisted(() => {
  const mockCleanup = vi.fn()
  return {
    mockCleanup,
    mockGetDocumentProxy: vi.fn(() => ({ cleanup: mockCleanup })),
    mockGetMeta: vi.fn(),
    mockExtractTextItems: vi.fn(),
    mockExtractLinks: vi.fn(),
  }
})

vi.mock("unpdf", () => ({
  getDocumentProxy: mockGetDocumentProxy,
  getMeta: mockGetMeta,
  extractTextItems: mockExtractTextItems,
  extractLinks: mockExtractLinks,
}))

vi.mock("../../../utils/fit-image-to-byte-budget.js", () => ({
  fitImageToByteBudget: vi.fn(),
}))

import { vaultFs } from "../vault-filesystem.js"

const mockedReadAsset = vi.mocked(vaultFs.readAsset)

const defaultParams = {
  vaultPath: "/vault",
  maxAssetBytes: 52_428_800,
  maxImageOutputBytes: 49_152,
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
