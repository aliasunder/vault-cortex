import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { definePDFJSModule, getDocumentProxy, getResolvedPDFJS } from "unpdf"
import type { PDFDocumentProxy } from "unpdf/pdfjs"

/**
 * PDF engine bootstrap — swaps unpdf's bundled pdfjs build for the real
 * `pdfjs-dist` Node build and creates document proxies whose glyph rendering
 * is self-contained (no system fonts required).
 *
 * unpdf ships a serverless/edge pdfjs build and resolves its Node defaults
 * (standard fonts, cMaps) from an installed `pdfjs-dist` package inside a
 * silent catch — without the package those defaults vanish, leaving
 * `useSystemFonts: true` + CSS font paths as the effective config. Text then
 * renders only when the host has system fonts; in a fontless container every
 * glyph is silently dropped while vector graphics still draw.
 *
 * The fix:
 * 1. Swap in `pdfjs-dist/legacy/build/pdf.mjs` (the Node-targeted build with
 *    runtime polyfills; the modern build requires newer JS APIs than Node 24
 *    ships, e.g. `Math.sumPrecise`).
 * 2. Create proxies with `disableFontFace: true` + `useSystemFonts: false`
 *    so glyphs are always drawn from font data — embedded fonts from the PDF,
 *    base-14 fonts from pdfjs-dist's bundled standard fonts — never from the
 *    host font stack. Font/cMap locations are plain directory paths: pdfjs's
 *    Node fetch reads them with `fs`, which treats a `file://` string as a
 *    literal path and fails.
 */

/** The proxy options a started engine supplies, under pdfjs's option names;
 *  the pdfjs module it also sets is process-wide state. */
type PdfEngine = Readonly<{
  standardFontDataUrl: string
  cMapUrl: string
}>

/** The canvas-module importer page rendering and tests share; unpdf's
 *  `canvasImport` option takes a function, not the module. */
export const canvasImport = (): Promise<typeof import("@napi-rs/canvas")> =>
  import("@napi-rs/canvas")

/** Resolves pdfjs-dist's bundled font and cMap directories as plain paths
 *  (trailing slash required — pdfjs concatenates the file name directly, and
 *  `join` keeps a trailing slash). */
const resolvePdfjsAssetPaths = (): PdfEngine => {
  const require = createRequire(import.meta.url)
  const pdfjsPackageRoot = dirname(require.resolve("pdfjs-dist/package.json"))
  return {
    standardFontDataUrl: join(pdfjsPackageRoot, "standard_fonts/"),
    cMapUrl: join(pdfjsPackageRoot, "cmaps/"),
  }
}

const initializePdfEngine = async (): Promise<PdfEngine> => {
  // Step 1 — every later unpdf call uses this module. unpdf loads it on first
  // use, so load it here: a load failure then rejects inside this init, and
  // getPdfEngine's catch keeps the module's install path out of the client's
  // error.
  definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"))
  await getResolvedPDFJS()
  return resolvePdfjsAssetPaths()
}

// A successful init runs once per process and concurrent callers share its
// in-flight promise, because the module swap must happen before any pdfjs
// use and definePDFJSModule drops unpdf's loaded module on every call. The
// `let` is justified because memoization is inherently stateful.
let pdfEnginePromise: Promise<PdfEngine> | undefined

const getPdfEngine = (): Promise<PdfEngine> => {
  if (!pdfEnginePromise) {
    // A failed init drops the memo, so one failed start does not poison
    // every later PDF read:
    // - The next call retries. That recovers a failure outside module
    //   evaluation, such as resolving pdfjs-dist's asset folders. A module
    //   whose first evaluation threw stays failed until the process
    //   restarts, because Node caches that failure.
    // - Every caller sharing this promise sees one rejection: a generic
    //   message with the original error as its cause, because a module-load
    //   error quotes the server's install paths, which must not reach a
    //   client.
    pdfEnginePromise = initializePdfEngine().catch((error: unknown) => {
      pdfEnginePromise = undefined
      throw new Error("PDF reader could not start", { cause: error })
    })
  }
  return pdfEnginePromise
}

/**
 * Creates a fully-configured pdfjs document proxy from raw PDF bytes — the
 * one entry point every PDF read (text extraction and page rendering) goes
 * through, so the font-independence guarantees above hold everywhere. The
 * caller owns the proxy lifecycle (`proxy.loadingTask.destroy()` — the
 * disposal call; `cleanup()` alone keeps the document alive).
 */
export const createPdfDocumentProxy = async (pdfData: Uint8Array): Promise<PDFDocumentProxy> => {
  const engine = await getPdfEngine()
  return getDocumentProxy(pdfData, {
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: engine.standardFontDataUrl,
    cMapUrl: engine.cMapUrl,
    cMapPacked: true, // pdfjs-dist ships its cMaps as packed .bcmap files
  })
}
