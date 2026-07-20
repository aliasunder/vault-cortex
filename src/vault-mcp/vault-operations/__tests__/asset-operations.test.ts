import { describe, it, expect, vi } from "vitest"
import { assetOperations } from "../asset-operations.js"
import { logger } from "../../../logger.js"

vi.mock("../vault-filesystem.js", () => ({
  vaultFs: {
    readAsset: vi.fn(),
  },
}))

vi.mock("unpdf", () => ({
  extractText: vi.fn(),
}))

vi.mock("../../../utils/fit-image-to-byte-budget.js", () => ({
  fitImageToByteBudget: vi.fn(),
}))

import { vaultFs } from "../vault-filesystem.js"
import { extractText } from "unpdf"

const mockedReadAsset = vi.mocked(vaultFs.readAsset)
const mockedExtractText = vi.mocked(extractText)

const defaultParams = {
  vaultPath: "/vault",
  maxAssetBytes: 52_428_800,
  maxImageOutputBytes: 49_152,
}

describe("readAssetContent — PDF extraction", () => {
  it("extracts text from a PDF and returns it as a text result", async () => {
    const pdfBuffer = Buffer.from("fake-pdf-bytes")
    mockedReadAsset.mockResolvedValue({
      buffer: pdfBuffer,
      bytes: 12_345,
      extension: ".pdf",
    })
    mockedExtractText.mockResolvedValue({
      totalPages: 3,
      text: "Page one content.\nPage two content.\nPage three content.",
    })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "papers/research.pdf" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "Page one content.\nPage two content.\nPage three content.",
    })
    expect(mockedExtractText).toHaveBeenCalledWith(expect.any(Uint8Array), {
      mergePages: true,
    })
  })

  it("throws a descriptive error for scanned PDFs with no extractable text", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("fake-scanned-pdf"),
      bytes: 5_000_000,
      extension: ".pdf",
    })
    mockedExtractText.mockResolvedValue({
      totalPages: 12,
      text: "",
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
    mockedExtractText.mockResolvedValue({
      totalPages: 1,
      text: "   \n\t  \n  ",
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
    mockedExtractText.mockResolvedValue({
      totalPages: 50,
      text: largeText,
    })

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "huge.pdf" },
        logger,
      ),
    ).rejects.toThrow(
      'text output too large: "huge.pdf" renders to 200000 bytes ' +
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

  it("propagates extractText errors for corrupt PDFs", async () => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("not-a-real-pdf"),
      bytes: 14,
      extension: ".pdf",
    })
    mockedExtractText.mockRejectedValue(new Error("Invalid PDF structure"))

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "corrupt.pdf" },
        logger,
      ),
    ).rejects.toThrow("Invalid PDF structure")
  })
})
