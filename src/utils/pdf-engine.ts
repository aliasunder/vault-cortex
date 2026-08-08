import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import {
  createIsomorphicCanvasFactory,
  definePDFJSModule,
  getDocumentProxy,
} from "unpdf"
import type { PDFDocumentProxy } from "unpdf/pdfjs"

/**
 * PDF engine bootstrap — swaps unpdf's bundled pdfjs build for the real
 * `pdfjs-dist` Node build and creates document proxies whose glyph rendering
 * is self-contained (no system fonts required).
 *
 * Why this exists: unpdf ships a serverless/edge pdfjs build and resolves its
 * Node defaults (`disableFontFace`, `standardFontDataUrl`, cMaps) from an
 * installed `pdfjs-dist` package inside a silent catch — without the package
 * those defaults vanish, leaving `useSystemFonts: true` + CSS font paths as
 * the effective config. Text then renders only when the host has system
 * fonts; in a fontless container every glyph is silently dropped while
 * vector graphics still draw. The edge build also cannot read font/cMap data
 * from disk at all (no `node:fs`).
 *
 * The fix:
 * 1. Inject @napi-rs/canvas constructors into globalThis, overwriting any
 *    existing value — pdfjs's legacy build installs its own Path2D polyfill
 *    when the global is missing, @napi-rs/canvas contexts reject those
 *    polyfill objects (`ctx.clip` throws InvalidArg), and unpdf's built-in
 *    injection is set-if-undefined so it keeps the polyfill once installed.
 *    Injecting before the pdfjs import keeps the polyfill from ever
 *    activating.
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

/** The canvas factory class unpdf wires into pdfjs so intermediate canvases
 *  (transparency groups, patterns, masks) come from @napi-rs/canvas. */
type PdfCanvasFactory = Awaited<
  ReturnType<typeof createIsomorphicCanvasFactory>
>

type PdfEngine = Readonly<{
  standardFontDataUrl: string
  cMapUrl: string
  CanvasFactory: PdfCanvasFactory
}>

/** The one canvas-module importer every PDF surface shares — proxies (via
 *  CanvasFactory), page rendering, and tests must all wire the same backend,
 *  or output canvases could silently come from a different canvas package
 *  than the document's intermediate canvases. */
export const canvasImport = (): Promise<typeof import("@napi-rs/canvas")> =>
  import("@napi-rs/canvas")

/** Resolves pdfjs-dist's bundled font and cMap directories as plain paths
 *  (trailing slash required — pdfjs concatenates the file name directly). */
const resolvePdfjsAssetPaths = (): {
  standardFontDataUrl: string
  cMapUrl: string
} => {
  const require = createRequire(import.meta.url)
  const pdfjsPackageRoot = dirname(require.resolve("pdfjs-dist/package.json"))
  return {
    standardFontDataUrl: join(pdfjsPackageRoot, "standard_fonts/"),
    cMapUrl: join(pdfjsPackageRoot, "cmaps/"),
  }
}

const initializePdfEngine = async (): Promise<PdfEngine> => {
  const canvasModule = await canvasImport()
  // Step 1 — the overwrite (not set-if-undefined) is the load-bearing part;
  // running before the pdfjs import below is defense in depth. See docstring.
  Object.assign(globalThis, {
    DOMMatrix: canvasModule.DOMMatrix,
    Path2D: canvasModule.Path2D,
    ImageData: canvasModule.ImageData,
  })
  // Step 2 — every later unpdf call resolves this module.
  await definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"))
  const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport)
  return { ...resolvePdfjsAssetPaths(), CanvasFactory }
}

// Single-flight init: the module swap and global injection must run exactly
// once per process, before any pdfjs use — concurrent callers share the same
// in-flight promise. Mutation justified: memoization is inherently stateful.
let pdfEnginePromise: Promise<PdfEngine> | undefined

const ensurePdfEngine = (): Promise<PdfEngine> => {
  if (!pdfEnginePromise) {
    const initAttempt = initializePdfEngine()
    // Memoize only a fulfilled init: a transient failure (e.g. the native
    // canvas binding hitting a resource limit) must not poison every later
    // PDF read for the process lifetime. The rejection itself still reaches
    // each caller through the returned promise — this observer only drops
    // the memo so the next call retries.
    initAttempt.catch(() => {
      pdfEnginePromise = undefined
    })
    pdfEnginePromise = initAttempt
  }
  return pdfEnginePromise
}

/**
 * Creates a fully-configured pdfjs document proxy from raw PDF bytes — the
 * one entry point every PDF read (text extraction and page rendering) goes
 * through, so the font-independence guarantees above hold everywhere. The
 * caller owns the proxy lifecycle (`cleanup()` / `loadingTask.destroy()`).
 */
export const createPdfDocumentProxy = async (
  pdfData: Uint8Array,
): Promise<PDFDocumentProxy> => {
  const engine = await ensurePdfEngine()
  return getDocumentProxy(pdfData, {
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: engine.standardFontDataUrl,
    cMapUrl: engine.cMapUrl,
    cMapPacked: true,
    CanvasFactory: engine.CanvasFactory,
  })
}
