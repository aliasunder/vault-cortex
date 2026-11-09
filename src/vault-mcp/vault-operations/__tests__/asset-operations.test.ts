import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest"
import { assetOperations } from "../asset-operations.js"
import type { PdfExtractor } from "../pdf-extractor.js"
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
    mockRenderPageAsImage: vi.fn(),
  }
})

vi.mock("unpdf", () => ({
  getMeta: mockGetMeta,
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
import { fitImageToByteBudget } from "../../../utils/fit-image-to-byte-budget.js"

const mockedReadAsset = vi.mocked(vaultFs.readAsset)
const mockedListAssets = vi.mocked(vaultFs.listAssets)
const mockedStatAssets = vi.mocked(vaultFs.statAssets)
const mockedFitImage = vi.mocked(fitImageToByteBudget)

// Every test sets the mock values it relies on, so none passes on values an
// earlier test left behind
beforeEach(() => {
  vi.resetAllMocks()
})

const mockReadPdfText = vi.fn<PdfExtractor["readText"]>()
const pdfExtractor: PdfExtractor = {
  readText: mockReadPdfText,
  extractForIndex: vi.fn(),
  close: vi.fn(),
}

const defaultParams = {
  vaultPath: "/vault",
  maxFileBytes: 52_428_800,
  maxImageOutputBytes: 49_152,
  maxPdfRenderPages: 5,
  pdfExtractor,
}

describe("readAssetContent — isolated PDF text", () => {
  it.each([
    { label: "default text", options: {} },
    { label: "explicit text", options: { raw: false } },
    { label: "line window", options: { startLine: 3, limit: 2 } },
    { label: "uppercase extension", options: {}, path: "papers/research.PDF" },
  ])("delegates $label without reading the PDF into the parent", async ({ options, path }) => {
    const pdfPath = path ?? "papers/research.pdf"
    const extractedResult = {
      kind: "text" as const,
      text: "# Introduction\nBody text.",
      path: pdfPath,
      lineWindow: { startLine: 3, endLine: 4, totalLines: 7 },
    }
    mockReadPdfText.mockResolvedValue(extractedResult)

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: pdfPath, ...options },
      logger,
    )

    expect(result).toEqual(extractedResult)
    expect(mockReadPdfText).toHaveBeenCalledTimes(1)
    expect(mockReadPdfText).toHaveBeenCalledWith(
      { path: pdfPath, startLine: options.startLine, limit: options.limit },
      logger,
    )
    expect(mockedReadAsset).not.toHaveBeenCalled()
    expect(mockCreatePdfDocumentProxy).not.toHaveBeenCalled()
  })

  it("passes the isolated extractor's failure through unchanged", async () => {
    const failure = new Error("PDF extraction exceeded its resource limit")
    mockReadPdfText.mockRejectedValue(failure)

    await expect(
      assetOperations.readAssetContent({ ...defaultParams, path: "broken.pdf" }, logger),
    ).rejects.toBe(failure)

    expect(mockReadPdfText).toHaveBeenCalledTimes(1)
    expect(mockReadPdfText).toHaveBeenCalledWith(
      { path: "broken.pdf", startLine: undefined, limit: undefined },
      logger,
    )
    expect(mockedReadAsset).not.toHaveBeenCalled()
    expect(mockCreatePdfDocumentProxy).not.toHaveBeenCalled()
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

/** Rendering opens the parent process's proxy with the file's bytes. */
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
}

describe("readAssetContent — PDF page rendering (raw: true)", () => {
  it.each([
    {
      label: "password-protected",
      errorName: "PasswordException",
      message:
        'PDF is password-protected: "papers/locked.pdf" exists (14 bytes) but cannot be opened without its password',
    },
    {
      label: "damaged",
      errorName: "InvalidPDFException",
      message:
        'PDF is damaged or not a PDF: "papers/locked.pdf" exists (14 bytes) but cannot be parsed',
    },
  ])("retains the $label PDF open error", async ({ errorName, message }) => {
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from("not-a-real-pdf"),
      bytes: 14,
      extension: ".pdf",
    })
    const pdfError = Object.assign(new Error("pdf.js refused the file"), { name: errorName })
    mockCreatePdfDocumentProxy.mockRejectedValue(pdfError)

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "papers/locked.pdf", raw: true },
        logger,
      ),
    ).rejects.toEqual(new Error(message, { cause: pdfError }))

    expect(mockReadPdfText).not.toHaveBeenCalled()
  })

  it("returns kind pages with rendered images", async () => {
    setupPdfMocks({ numPages: 2, title: "Visual Doc" })
    const fakePng = new Uint8Array(10_000)
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
    mockRenderPageAsImage.mockResolvedValue(new Uint8Array(5_000))
    const fittedResult = buildFittedImage()
    mockedFitImage.mockResolvedValue(fittedResult)

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "long.pdf", raw: true, maxPdfRenderPages: 3 },
      logger,
    )

    expect(result).toEqual({
      kind: "pages",
      pages: [
        { pageNumber: 1, fitted: fittedResult, originalBytes: 5_000 },
        { pageNumber: 2, fitted: fittedResult, originalBytes: 5_000 },
        { pageNumber: 3, fitted: fittedResult, originalBytes: 5_000 },
      ],
      title: "Long PDF",
      totalPages: 10,
      pagesRendered: 3,
      path: "long.pdf",
    })
    expect(mockRenderPageAsImage).toHaveBeenCalledTimes(3)
  })

  it("fits each rendered page's PNG within an even share of the image budget", async () => {
    setupPdfMocks({ numPages: 4 })
    // Each page renders to bytes naming its page number
    mockRenderPageAsImage.mockImplementation(async (_proxy: unknown, pageNumber: number) => {
      return new Uint8Array([pageNumber, 0x50, 0x4e, 0x47])
    })
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
    expect(mockedFitImage).toHaveBeenCalledTimes(4)
    for (const pageNumber of [1, 2, 3, 4]) {
      expect(mockedFitImage).toHaveBeenNthCalledWith(pageNumber, {
        buffer: Buffer.from([pageNumber, 0x50, 0x4e, 0x47]),
        budgetBytes: 10_000,
      })
    }
  })

  it("skips failed pages and returns the rest", async () => {
    setupPdfMocks({ numPages: 3, title: "Partial" })
    mockRenderPageAsImage
      .mockResolvedValueOnce(new Uint8Array(5_000))
      .mockRejectedValueOnce(new Error("render failed"))
      .mockResolvedValueOnce(new Uint8Array(5_000))
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

  it("logs a skipped page's wrapped decode failure with the decoder's error as the cause", async () => {
    setupPdfMocks({ numPages: 2 })
    mockRenderPageAsImage.mockResolvedValue(new Uint8Array(5_000))
    const fittedResult = buildFittedImage()
    mockedFitImage
      .mockRejectedValueOnce(
        new Error("could not decode image", {
          cause: new Error("Input image exceeds pixel limit"),
        }),
      )
      .mockResolvedValueOnce(fittedResult)
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "huge-page.pdf", raw: true, maxPdfRenderPages: 2 },
      logger,
    )

    // Page 2 rendering proves the failure was skipped, not fatal
    expect(result).toEqual({
      kind: "pages",
      pages: [{ pageNumber: 2, fitted: fittedResult, originalBytes: 5_000 }],
      title: undefined,
      totalPages: 2,
      pagesRendered: 1,
      path: "huge-page.pdf",
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith("pdf_page_render_failed", {
      page: 1,
      error: "[Error]: could not decode image",
      cause: "[Error]: Input image exceeds pixel limit",
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
      new Error(
        'PDF page rendering failed: "broken.pdf" exists ' +
          "(50000 bytes, 2 pages) but no pages could be rendered",
      ),
    )
  })

  it("renders through the configured document proxy, not raw bytes", async () => {
    setupPdfMocks({ numPages: 1, title: "Proxy Flow" })
    const configuredProxy = {
      loadingTask: { destroy: mockDestroy },
      numPages: 1,
    }
    mockCreatePdfDocumentProxy.mockResolvedValue(configuredProxy)
    mockRenderPageAsImage.mockResolvedValue(new Uint8Array(1_000))
    mockedFitImage.mockResolvedValue(buildFittedImage())

    await assetOperations.readAssetContent(
      { ...defaultParams, path: "flow.pdf", raw: true },
      logger,
    )

    // The proxy carries the font configuration — rendering from raw bytes
    // instead would silently rebuild an unconfigured document.
    expect(mockRenderPageAsImage).toHaveBeenCalledWith(configuredProxy, 1, {
      canvasImport: mockCanvasImport,
      scale: 2,
    })
  })

  it("destroys the proxy after successful page rendering", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new Uint8Array(1_000))
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
    ).rejects.toThrow(
      new Error(
        'PDF page rendering failed: "fail.pdf" exists ' +
          "(50000 bytes, 1 pages) but no pages could be rendered",
      ),
    )

    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it("omits title from pages result when PDF has no title metadata", async () => {
    setupPdfMocks({ numPages: 1 })
    mockRenderPageAsImage.mockResolvedValue(new Uint8Array(1_000))
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

describe("readAssetContent — UTF-8 files outside the dedicated types", () => {
  /** Stubs readAsset with the given bytes, reporting the extension lowercased
   *  as readAsset does. */
  const stubReadAsset = (params: { buffer: Buffer; extension: string }): void => {
    mockedReadAsset.mockResolvedValue({
      buffer: params.buffer,
      bytes: params.buffer.length,
      extension: params.extension,
    })
  }

  /** `length` bytes of ASCII "a" with a NUL byte at `nulIndex`. */
  const buildBufferWithNulAt = (params: { length: number; nulIndex: number }): Buffer => {
    const buffer = Buffer.alloc(params.length, "a")
    buffer[params.nulIndex] = 0
    return buffer
  }

  it.each([
    {
      label: "an HTML page's source",
      path: "runbooks/restart.html",
      extension: ".html",
      source: '<!doctype html>\n<p class="step">Restart &mdash; then wait</p>\n',
    },
    {
      label: "a Python script",
      path: "scripts/report.py",
      extension: ".py",
      source: "def get_user_name():\n    return 'café'\n",
    },
    {
      label: "a PowerShell script",
      path: "scripts/Backup.ps1",
      extension: ".ps1",
      source: "Get-ChildItem -Path $Home | Out-Null\r\n",
    },
    {
      label: "a file with no extension",
      path: "scripts/Makefile",
      extension: "",
      source: "build:\n\tnpm run build\n",
    },
  ])("returns $label byte-exact as text", async ({ path, extension, source }) => {
    stubReadAsset({ buffer: Buffer.from(source, "utf8"), extension })

    const result = await assetOperations.readAssetContent({ ...defaultParams, path }, logger)

    expect(result).toEqual({ kind: "text", text: source, path })
  })

  it("pages a script by line like the dedicated text formats", async () => {
    stubReadAsset({ buffer: Buffer.from("one\ntwo\nthree\nfour\n", "utf8"), extension: ".sh" })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "deploy.sh", startLine: 2, limit: 2 },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "two\nthree",
      path: "deploy.sh",
      lineWindow: { startLine: 2, endLine: 3, totalLines: 4 },
    })
  })

  it("refuses a file with a NUL byte in its first 8,000 bytes, naming the readable types", async () => {
    stubReadAsset({
      buffer: buildBufferWithNulAt({ length: 9_000, nulIndex: 7_999 }),
      extension: ".mp3",
    })

    await expect(
      assetOperations.readAssetContent({ ...defaultParams, path: "audio/song.mp3" }, logger),
    ).rejects.toThrow(
      new Error(
        'unsupported file type ".mp3": "audio/song.mp3" exists (9000 bytes) and holds a NUL ' +
          "byte in its first 8,000 bytes (binary data or UTF-16 text). Readable types: images " +
          "(.png/.jpg/.jpeg/.gif/.webp), .canvas, .pdf, and UTF-8 text files",
      ),
    )
  })

  it("names a binary file with no extension as type (none)", async () => {
    stubReadAsset({ buffer: buildBufferWithNulAt({ length: 40, nulIndex: 0 }), extension: "" })

    await expect(
      assetOperations.readAssetContent({ ...defaultParams, path: "bin/firmware" }, logger),
    ).rejects.toThrow(
      new Error(
        'unsupported file type (none): "bin/firmware" exists (40 bytes) and holds a NUL ' +
          "byte in its first 8,000 bytes (binary data or UTF-16 text). Readable types: images " +
          "(.png/.jpg/.jpeg/.gif/.webp), .canvas, .pdf, and UTF-8 text files",
      ),
    )
  })

  it("reads an HTML page whose first NUL byte sits just past the first 8,000 bytes", async () => {
    const buffer = buildBufferWithNulAt({ length: 8_001, nulIndex: 8_000 })
    stubReadAsset({ buffer, extension: ".html" })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "padded.html" },
      logger,
    )

    expect(result).toEqual({ kind: "text", text: buffer.toString("utf8"), path: "padded.html" })
  })

  it("refuses an HTML page that is not UTF-8", async () => {
    // 0xE9 is "é" in Latin-1 and never a complete UTF-8 sequence
    stubReadAsset({ buffer: Buffer.from([0x3c, 0x70, 0x3e, 0xe9]), extension: ".html" })

    await expect(
      assetOperations.readAssetContent({ ...defaultParams, path: "latin1.html" }, logger),
    ).rejects.toThrow(new Error('not valid UTF-8: "latin1.html" cannot be returned as text'))
  })

  it("keeps reading a log that opens with NUL bytes, since the dedicated text formats skip the NUL check", async () => {
    const buffer = Buffer.concat([Buffer.alloc(4), Buffer.from("boot ok\n", "utf8")])
    stubReadAsset({ buffer, extension: ".log" })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "server.log" },
      logger,
    )

    expect(result).toEqual({ kind: "text", text: buffer.toString("utf8"), path: "server.log" })
  })
})

// The tool text says a read drops a leading byte-order mark, so both decode
// paths are pinned: text formats and every other UTF-8 file
describe("readAssetContent — byte-order mark", () => {
  const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf])

  it.each([
    { label: "a text format", path: "exports/data.json", extension: ".json", source: '{"a":1}\n' },
    { label: "an HTML page", path: "pages/home.html", extension: ".html", source: "<p>hi</p>\n" },
  ])(
    "drops a leading byte-order mark from $label and keeps the rest byte-exact",
    async ({ path, extension, source }) => {
      const buffer = Buffer.concat([BYTE_ORDER_MARK, Buffer.from(source)])
      mockedReadAsset.mockResolvedValue({ buffer, bytes: buffer.length, extension })

      const result = await assetOperations.readAssetContent({ ...defaultParams, path }, logger)

      expect(result).toEqual({ kind: "text", text: source, path })
    },
  )
})

// Each stub reports the extension lowercased, as readAsset does, while the path
// keeps the caller's uppercase extension
describe("readAssetContent — uppercase extensions", () => {
  it("returns the outline of a canvas whose extension is uppercase", async () => {
    const canvasSource = JSON.stringify({
      nodes: [{ id: "t1", type: "text", text: "Launch plan", x: 0, y: 0, width: 200, height: 100 }],
      edges: [],
    })
    mockedReadAsset.mockResolvedValue({
      buffer: Buffer.from(canvasSource, "utf8"),
      bytes: Buffer.byteLength(canvasSource, "utf8"),
      extension: ".canvas",
    })

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "Boards/Roadmap.CANVAS" },
      logger,
    )

    expect(result).toEqual({
      kind: "text",
      text: "# Canvas: 1 node, 0 edges\n\n[text]\nLaunch plan",
      path: "Boards/Roadmap.CANVAS",
    })
  })

  it("fits an image whose extension is uppercase to the image budget", async () => {
    const imageBuffer = Buffer.from("fake-png-bytes")
    const fitted = buildFittedImage()
    mockedReadAsset.mockResolvedValue({ buffer: imageBuffer, bytes: 14, extension: ".png" })
    mockedFitImage.mockResolvedValue(fitted)

    const result = await assetOperations.readAssetContent(
      { ...defaultParams, path: "Scans/Receipt.PNG" },
      logger,
    )

    expect(result).toEqual({
      kind: "image",
      fitted,
      originalBytes: 14,
      path: "Scans/Receipt.PNG",
    })
    expect(mockedFitImage).toHaveBeenCalledExactlyOnceWith({
      buffer: imageBuffer,
      budgetBytes: defaultParams.maxImageOutputBytes,
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
      new Error('invalid line range: "data.csv" needs a start line and limit of at least 1'),
    )
  })

  it("rejects a limit below 1", async () => {
    stubReadAsset("alpha\nbeta\ngamma\n", ".csv")

    await expect(
      assetOperations.readAssetContent({ ...defaultParams, path: "data.csv", limit: 0 }, logger),
    ).rejects.toThrow(
      new Error('invalid line range: "data.csv" needs a start line and limit of at least 1'),
    )
  })

  it("rejects a start line past the end stating the total line count", async () => {
    stubReadAsset("alpha\nbeta\ngamma\n", ".csv")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "data.csv", startLine: 4 },
        logger,
      ),
    ).rejects.toThrow(new Error('start line past the end: "data.csv" renders to 3 lines'))
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
      new Error(
        'text output too large: "big.log" lines 1–1 render to 102401 bytes ' + "(cap 102400 bytes)",
      ),
    )
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

  it.each([
    { label: "a start line", lineWindow: { startLine: 1 } },
    { label: "a line limit", lineWindow: { limit: 1 } },
  ])("rejects $label combined with raw PDF page rendering", async ({ lineWindow }) => {
    stubReadAsset("fake-pdf-bytes", ".pdf")

    await expect(
      assetOperations.readAssetContent(
        { ...defaultParams, path: "doc.pdf", raw: true, ...lineWindow },
        logger,
      ),
    ).rejects.toThrow(
      new Error(
        'line range is not available for rendered PDF pages: "doc.pdf" ' +
          "delivers page images, not text",
      ),
    )
  })

  it("rejects paging for an image", async () => {
    stubReadAsset("fake-png-bytes", ".png")

    await expect(
      assetOperations.readAssetContent({ ...defaultParams, path: "pic.png", limit: 10 }, logger),
    ).rejects.toThrow(
      new Error(
        'line range is not available for images: "pic.png" is binary — ' +
          "its image block is the delivered form",
      ),
    )
  })
})

describe("buildAssetListing", () => {
  it("counts quickly when every file has an extension of its own", async () => {
    // Dated backups give each file its own extension; counting that copies the
    // counts for each file took over 10 seconds at this size
    const fileCount = 10_000
    const assetPaths = Array.from({ length: fileCount }, (_, index) => `backups/vault.${index}`)
    mockedListAssets.mockResolvedValue(assetPaths)
    mockedStatAssets.mockResolvedValue([{ path: "backups/vault.0", bytes: 10 }])

    const startedAt = performance.now()
    const listing = await assetOperations.buildAssetListing(
      { vaultPath: "/vault", limit: 1 },
      logger,
    )
    const elapsedMs = performance.now() - startedAt

    const expectedCounts = Object.fromEntries(
      assetPaths.map((_, index) => [`.${index}`, 1] as const),
    )
    expect(listing).toEqual({
      assets: [{ path: "backups/vault.0", extension: ".0", bytes: 10 }],
      extensionCounts: expectedCounts,
      total: fileCount,
      truncated: true,
    })
    expect(elapsedMs).toBeLessThan(1_000)
  })
})
