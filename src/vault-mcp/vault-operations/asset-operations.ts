import { posix } from "node:path"
import { getMeta, renderPageAsImage } from "unpdf"
import type { PDFDocumentProxy } from "unpdf/pdfjs"
import { vaultFs } from "./vault-filesystem.js"
import { buildTextResult, requestsLineWindow, describePdfOpenFailure } from "./asset-text.js"
import type { AssetTextResult } from "./asset-text.js"
import type { PdfExtractor } from "./pdf-extractor.js"
import { linearizeCanvas } from "../obsidian-markdown/canvas.js"
import { getExtensionsOfKind, getFileKind } from "../obsidian-markdown/file-kinds.js"
import { canvasImport, createPdfDocumentProxy } from "../obsidian-markdown/pdf-engine.js"
import { toPdfData } from "../obsidian-markdown/pdf.js"
import { decodeTextBuffer, NUL_SEARCH_WINDOW_BYTES } from "../../utils/decode-text-buffer.js"
import { describeErrorForLog } from "../../utils/describe-error.js"
import { fitImageToByteBudget } from "../../utils/fit-image-to-byte-budget.js"
import type { FittedImage } from "../../utils/fit-image-to-byte-budget.js"
import type { Logger } from "../../logger.js"

/**
 * Asset operations use-case — the grouped read/browse surface over the
 * vault's non-markdown files, composing vaultFs primitives with the parsers
 * and the image pipeline. Two operations share the domain:
 *
 * - `readAssetContent` dispatches one file to its most useful representation:
 *   images fitted to a byte budget, canvases linearized (or their raw JSON
 *   source), PDFs as extracted text (or rendered page images), and every other
 *   file decoded verbatim as UTF-8 text — whole, or as a 1-based line window
 *   when paging params are supplied.
 * - `buildAssetListing` browses many: extension-filtered, counted per
 *   extension over the full filtered set, and capped to a statted slice.
 *   There is no pagination — `limit` caps the returned entries, and
 *   counts/total over the full set tell the caller to narrow with
 *   folder/extensions when the cap is hit.
 *
 * The tool layer maps results to MCP content blocks / wire JSON.
 */

// ── Reading ─────────────────────────────────────────────────────

type RenderedPdfPage = Readonly<{
  fitted: FittedImage
  pageNumber: number
  /** The page's PNG rendering before fitting, in bytes; an image result's
   *  originalBytes is instead the file's size on disk. */
  originalBytes: number
}>

/** The computed result of one asset read, before content-block formatting:
 *  an image (fitted to the byte budget), a text rendition (whole, or a line
 *  window when paging params were supplied), or multiple sequential page
 *  images (e.g. rendered PDF pages). */
export type AssetReadResult =
  | Readonly<{
      kind: "image"
      fitted: FittedImage
      originalBytes: number
      path: string
    }>
  | AssetTextResult
  /** Multiple sequential page images — e.g. rendered PDF pages. */
  | Readonly<{
      kind: "pages"
      pages: ReadonlyArray<RenderedPdfPage>
      title: string | undefined
      totalPages: number
      pagesRendered: number
      path: string
    }>

const notValidUtf8Message = (path: string): string => {
  return `not valid UTF-8: "${path}" cannot be returned as text`
}

/** Decodes an asset buffer as UTF-8, rejecting invalid byte sequences — text
 *  is promised verbatim, and the default decoder would silently substitute
 *  U+FFFD for every undecodable byte instead. Unlike decodeTextBuffer, it
 *  accepts NUL bytes. */
const decodeUtf8Strict = (params: { buffer: Buffer; path: string }): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(params.buffer)
  } catch (error) {
    throw new Error(notValidUtf8Message(params.path), { cause: error })
  }
}

type ReadAsset = Readonly<{ buffer: Buffer; bytes: number; extension: string }>

/** Builds the text result for a file outside the dedicated types (HTML pages,
 *  scripts, files with no extension), refusing binary data and bytes that are
 *  not UTF-8. */
const buildUtf8SourceResult = (params: {
  asset: ReadAsset
  path: string
  startLine?: number | undefined
  limit?: number | undefined
}): AssetReadResult => {
  const { asset, path, startLine, limit } = params
  const decodedSource = decodeTextBuffer(asset.buffer)

  switch (decodedSource.status) {
    case "text":
      return buildTextResult({ text: decodedSource.text, path, startLine, limit })
    case "binary": {
      // "(none)" matches the listing's label for a file with no extension.
      const fileType = asset.extension ? `"${asset.extension}"` : "(none)"
      throw new Error(
        `unsupported file type ${fileType}: "${path}" exists ` +
          `(${asset.bytes} bytes) and holds a NUL byte in its first ` +
          `${NUL_SEARCH_WINDOW_BYTES.toLocaleString("en-US")} bytes (binary data or UTF-16 text). ` +
          `Readable types: images (${getExtensionsOfKind("image").join("/")}), .canvas, .pdf, ` +
          `and UTF-8 text files`,
      )
    }
    case "invalid-utf8":
      throw new Error(notValidUtf8Message(path))
  }
}

// ── PDF reading ───────────────────────────────────────────────

/** pdf.js's refusal to open the file is rethrown as the server's own message,
 *  with pdf.js's error as the cause. */
const openPdfDocument = async (params: { pdfData: Uint8Array; path: string; bytes: number }) => {
  try {
    return await createPdfDocumentProxy(params.pdfData)
  } catch (error) {
    const openFailureMessage = describePdfOpenFailure({
      error,
      path: params.path,
      bytes: params.bytes,
    })

    if (!openFailureMessage) throw error
    throw new Error(openFailureMessage, { cause: error })
  }
}

// ── PDF page rendering ────────────────────────────────────────

/** Render scale for PDF page images — 2.0 produces 1224×1584px for US Letter
 *  (close to fitImageToByteBudget's 1568px long-edge cap), giving sharp text
 *  after JPEG compression without wasting pixels that fitImageToByteBudget
 *  would discard anyway. */
const PDF_RENDER_SCALE = 2.0

/** Renders `pagesToRender` pages of a PDF as fitted images, sequentially.
 *  Individual page failures are logged and skipped — the caller checks whether
 *  any pages succeeded. Sequential because the unpdf worker can't handle
 *  concurrent calls on the same proxy (structuredClone error on Node 24).
 *  Takes the shared proxy from createPdfDocumentProxy, so every page renders
 *  with the engine's bundled fonts and the document is parsed once. */
const renderPdfPages = async (
  params: {
    proxy: PDFDocumentProxy
    pagesToRender: number
    perPageBudget: number
  },
  logger: Logger,
): Promise<RenderedPdfPage[]> => {
  const results: RenderedPdfPage[] = []

  for (let pageNumber = 1; pageNumber <= params.pagesToRender; pageNumber++) {
    try {
      const pngBytes = await renderPageAsImage(params.proxy, pageNumber, {
        canvasImport,
        scale: PDF_RENDER_SCALE,
      })
      const pngBuffer = Buffer.from(pngBytes)
      const fitted = await fitImageToByteBudget({
        buffer: pngBuffer,
        budgetBytes: params.perPageBudget,
      })
      results.push({ pageNumber, fitted, originalBytes: pngBuffer.length })
    } catch (error) {
      // fitImageToByteBudget wraps a page it cannot decode in a generic
      // message, so the decoder's reason is only in the cause, which
      // describeErrorForLog logs too
      logger.warn("pdf_page_render_failed", { page: pageNumber, ...describeErrorForLog(error) })
    }
  }
  return results
}

/** Renders up to `maxPdfRenderPages` pages as images sharing the image
 *  budget; throws when no page renders. */
const readPdfPages = async (
  params: {
    pdfData: Uint8Array
    path: string
    bytes: number
    maxPdfRenderPages: number
    maxImageOutputBytes: number
  },
  logger: Logger,
): Promise<AssetReadResult> => {
  const { pdfData, path, bytes } = params
  const proxy = await openPdfDocument({ pdfData, path, bytes })
  try {
    const meta = await getMeta(proxy)
    const totalPages = proxy.numPages
    const pagesToRender = Math.min(totalPages, params.maxPdfRenderPages)

    // Config rejects MAX_PDF_RENDER_PAGES=0 at boot, so 0 here means the PDF has no pages.
    if (pagesToRender === 0) {
      throw new Error(
        `PDF page rendering failed: "${path}" exists (${bytes} bytes) but has 0 pages`,
      )
    }

    const perPageBudget = Math.floor(params.maxImageOutputBytes / pagesToRender)
    const pages = await renderPdfPages({ proxy, pagesToRender, perPageBudget }, logger)

    if (pages.length === 0) {
      throw new Error(
        `PDF page rendering failed: "${path}" exists ` +
          `(${bytes} bytes, ${totalPages} pages) but no ` +
          `pages could be rendered`,
      )
    }

    return {
      kind: "pages",
      pages,
      title: meta.info.Title,
      totalPages,
      pagesRendered: pages.length,
      path,
    }
  } finally {
    await proxy.loadingTask.destroy()
  }
}

/** Images have no raw source or line range, because the fitted image block is
 *  the only form delivered. */
const readImageAsset = async (params: {
  asset: ReadAsset
  path: string
  raw: boolean | undefined
  isPagedRead: boolean
  maxImageOutputBytes: number
}): Promise<AssetReadResult> => {
  const { asset, path } = params

  if (params.raw) {
    throw new Error(
      `raw source is not available for images: "${path}" is ` +
        `binary — its image block is the delivered form`,
    )
  }
  if (params.isPagedRead) {
    throw new Error(
      `line range is not available for images: "${path}" is ` +
        `binary — its image block is the delivered form`,
    )
  }

  const fitted = await fitImageToByteBudget({
    buffer: asset.buffer,
    budgetBytes: params.maxImageOutputBytes,
  })
  return { kind: "image", fitted, originalBytes: asset.bytes, path }
}

/**
 * Reads a non-markdown vault file and returns its most useful representation
 * per type.
 * - `raw` returns a canvas's exact JSON source instead of its rendition, and
 *   a PDF's rendered page images instead of its text.
 * - `startLine`/`limit` page any text rendition as a 1-based line window.
 *   They apply after the rendition is produced (a text file's source, canvas
 *   outline or raw JSON, PDF-extracted text), so every path that can hit the
 *   text cap can also be paged.
 * - Throws structured errors for images with `raw`, non-text reads with
 *   paging params, PDFs that can't be opened or yield nothing, binary data
 *   outside the dedicated types, and text that is not UTF-8; the PDF and
 *   binary-data errors state the file's existence and size.
 */
const readAssetContent = async (
  params: {
    vaultPath: string
    path: string
    raw?: boolean | undefined
    startLine?: number | undefined
    limit?: number | undefined
    maxFileBytes: number
    maxImageOutputBytes: number
    maxPdfRenderPages: number
    /** Reads a PDF's text in place of readAsset, so it carries its own vault path and byte cap. */
    pdfExtractor: PdfExtractor
  },
  logger: Logger,
): Promise<AssetReadResult> => {
  const { path, raw, startLine, limit } = params
  const fileKind = getFileKind(path)
  const isPdfTextRead = fileKind === "pdf" && !raw

  if (isPdfTextRead) return params.pdfExtractor.readText({ path, startLine, limit }, logger)

  const asset = await vaultFs.readAsset(
    { vaultPath: params.vaultPath, path, maxBytes: params.maxFileBytes },
    logger,
  )

  switch (fileKind) {
    case "image":
      return readImageAsset({
        asset,
        path,
        raw,
        isPagedRead: requestsLineWindow({ startLine, limit }),
        maxImageOutputBytes: params.maxImageOutputBytes,
      })
    case "canvas": {
      const canvasSource = decodeUtf8Strict({ buffer: asset.buffer, path })
      const text = raw ? canvasSource : linearizeCanvas(canvasSource)
      return buildTextResult({ text, path, startLine, limit })
    }
    // Only a raw read reaches this case; a text read returned above.
    case "pdf": {
      if (requestsLineWindow({ startLine, limit })) {
        throw new Error(
          `line range is not available for rendered PDF pages: ` +
            `"${path}" delivers page images, not text`,
        )
      }

      const pdfData = toPdfData(asset.buffer)
      return readPdfPages(
        {
          pdfData,
          path,
          bytes: asset.bytes,
          maxPdfRenderPages: params.maxPdfRenderPages,
          maxImageOutputBytes: params.maxImageOutputBytes,
        },
        logger,
      )
    }
    case "text": {
      // No NUL byte check here, so a NUL-padded log keeps reading
      const text = decodeUtf8Strict({ buffer: asset.buffer, path })
      return buildTextResult({ text, path, startLine, limit })
    }
    case "html":
    case "script":
    case "other":
      return buildUtf8SourceResult({ asset, path, startLine, limit })
  }
}

// ── Browsing ────────────────────────────────────────────────────

/** The extension a listing shows, lowercased with its dot, or "(none)" for an
 *  extensionless file. It splits the name with posix.extname, as getFileKind
 *  does, so a listed extension is the one a read dispatches on. */
const getListingExtension = (assetPath: string): string => {
  return posix.extname(assetPath).toLowerCase() || "(none)"
}

/** Normalizes a caller-supplied extension filter entry: lowercased, leading
 *  dot ensured — so "PNG", "png", and ".png" all match ".png". */
const normalizeExtension = (extension: string): string => {
  const lowered = extension.toLowerCase()
  return lowered.startsWith(".") ? lowered : `.${lowered}`
}

type AssetListing = Readonly<{
  assets: readonly Readonly<{
    path: string
    extension: string
    bytes: number
  }>[]
  extensionCounts: Readonly<Record<string, number>>
  total: number
  truncated: boolean
}>

/**
 * Lists a folder's (or the vault's) assets: extension-filtered, counted per
 * extension over the full filtered set, and capped to `limit` entries with
 * byte sizes statted for the returned slice only — entries beyond the cap
 * are never statted.
 */
const buildAssetListing = async (
  params: {
    vaultPath: string
    folder?: string | undefined
    extensions?: readonly string[] | undefined
    limit: number
  },
  logger: Logger,
): Promise<AssetListing> => {
  const assetPaths = await vaultFs.listAssets(
    { vaultPath: params.vaultPath, folder: params.folder },
    logger,
  )
  const extensionFilter = params.extensions
    ? new Set(params.extensions.map(normalizeExtension))
    : undefined
  const filteredPaths = extensionFilter
    ? assetPaths.filter((assetPath) => extensionFilter.has(getListingExtension(assetPath)))
    : assetPaths

  // Counted in place, because a fold that copies the counts for each file
  // costs files × distinct extensions, and dated backups or rotated logs
  // give nearly every file an extension of its own
  const extensionCounts: Record<string, number> = {}
  for (const extension of filteredPaths.map(getListingExtension)) {
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1
  }

  const returnedPaths = filteredPaths.slice(0, params.limit)

  // statAssets drops assets deleted since the listing, so `assets` can fall
  // short of the cap while `total` and `truncated` still count them
  const stattedAssets = await vaultFs.statAssets(
    { vaultPath: params.vaultPath, paths: returnedPaths },
    logger,
  )
  return {
    assets: stattedAssets.map((entry) => ({
      path: entry.path,
      extension: getListingExtension(entry.path),
      bytes: entry.bytes,
    })),
    extensionCounts,
    total: filteredPaths.length,
    truncated: filteredPaths.length > params.limit,
  }
}

/** The asset operations surface — one namespace for the grouped read/browse
 *  functionality, matching the folder's operation modules (noteMover,
 *  vaultPatcher, taskMutations). */
export const assetOperations = {
  readAssetContent,
  buildAssetListing,
}
