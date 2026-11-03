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
 * glyph is silently dropped while vector graphics still draw. The edge build
 * also cannot read font/cMap data from disk at all (no `node:fs`).
 *
 * The fix:
 * 1. Inject @napi-rs/canvas's DOMMatrix, Path2D and ImageData into
 *    globalThis before pdfjs loads, overwriting any existing value. pdfjs
 *    fills in DOMMatrix and Path2D only when they are missing, and unpdf
 *    does the same for DOMMatrix with a stub that lacks the `invertSelf` and
 *    `multiplySelf` pdfjs's canvas code calls, so whichever value is set
 *    first is the one pdfjs draws with.
 * 2. Swap in `pdfjs-dist/legacy/build/pdf.mjs` (the Node-targeted build with
 *    runtime polyfills; the modern build requires newer JS APIs than Node 24
 *    ships, e.g. `Math.sumPrecise`).
 * 3. Create proxies with `disableFontFace: true` + `useSystemFonts: false`
 *    so glyphs are always drawn from font data — embedded fonts from the PDF,
 *    base-14 fonts from pdfjs-dist's bundled standard fonts — never from the
 *    host font stack. Font/cMap locations are plain directory paths: pdfjs's
 *    Node fetch reads them with `fs`, which treats a `file://` string as a
 *    literal path and fails.
 */

/** The proxy options a started engine supplies, under pdfjs's option names;
 *  the canvas globals and pdfjs module it also sets are process-wide state. */
type PdfEngine = Readonly<{
  standardFontDataUrl: string
  cMapUrl: string
}>

/** The one canvas-module importer every PDF surface shares: the global
 *  injection below, page rendering (unpdf's `canvasImport` option takes a
 *  function), and tests.
 *  - pdfjs-dist's Node build draws every canvas with its own
 *    `require("@napi-rs/canvas")`, and its contexts reject a Path2D from
 *    another copy of the package.
 *  - npm installs one copy for both, because the @napi-rs/canvas version
 *    package.json pins satisfies pdfjs-dist's range; a pdf-engine test fails
 *    on a second copy. */
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
  const canvasModule = await canvasImport()

  // Step 1 — overwrite rather than set only when missing, so a stub left by
  // an earlier unpdf or pdfjs load in this process is replaced too.
  Object.assign(globalThis, {
    DOMMatrix: canvasModule.DOMMatrix,
    Path2D: canvasModule.Path2D,
    ImageData: canvasModule.ImageData,
  })

  // Step 2 — every later unpdf call uses this module. unpdf loads it on first
  // use, so load it here: a load failure then rejects inside this init, and
  // getPdfEngine's catch keeps the module's install path out of the client's
  // error.
  definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"))
  await getResolvedPDFJS()
  return resolvePdfjsAssetPaths()
}

// Single-flight init: the module swap and global injection must run exactly
// once per process, before any pdfjs use — concurrent callers share the same
// in-flight promise. Mutation justified: memoization is inherently stateful.
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
