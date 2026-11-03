import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, it, expect, vi, onTestFinished } from "vitest"
import sharp from "sharp"
import { getDocumentProxy, renderPageAsImage, extractText } from "unpdf"
import { canvasImport, createPdfDocumentProxy } from "../pdf-engine.js"
import {
  buildClippedFillPdf,
  buildClippedTextPdf,
  buildMinimalPdf,
  toPdfData,
} from "./pdf-fixture.js"

// Spy mode keeps the real unpdf implementation — the rendering tests below
// are true integration tests — while letting the configuration test assert
// the exact options handed to pdfjs.
vi.mock("unpdf", { spy: true })

/** Test-owned expectation for the engine's asset roots — derived here with
 *  the same resolution mechanism production uses, so the configuration test
 *  asserts exact paths without reading them back out of the mock call log,
 *  and catches production ever resolving somewhere else. */
const expectedPdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))

/** The fixture as the Uint8Array shape production hands to the engine. */
const fixtureBytes = (): Uint8Array => {
  const pdfBuffer = buildMinimalPdf()
  return new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength)
}

type PixelColor = Readonly<{ red: number; green: number; blue: number }>

/** Counts the pixels of a rendered page, flattened onto white, that match
 *  `isMatch`. */
const countPixels = async (
  pngBytes: Uint8Array,
  isMatch: (pixel: PixelColor) => boolean,
): Promise<number> => {
  const { data, info } = await sharp(pngBytes)
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixelValues = new Uint8Array(data)
  // Mutable counter over raw pixel data — a typed-array walk has no
  // readable immutable equivalent.
  let matchingPixels = 0
  for (let offset = 0; offset < pixelValues.length; offset += info.channels) {
    const pixel = {
      red: pixelValues[offset] ?? 255,
      green: pixelValues[offset + 1] ?? 255,
      blue: pixelValues[offset + 2] ?? 255,
    }

    if (isMatch(pixel)) matchingPixels += 1
  }
  return matchingPixels
}

/** Matches the near-black pixels glyphs draw. Rendered text produces
 *  thousands of them and a page whose glyphs were dropped produces none, so a
 *  floor assertion separates the two despite platform-dependent antialiasing. */
const isDark = ({ red, green, blue }: PixelColor): boolean => {
  return red < 128 && green < 128 && blue < 128
}

/** Exact red, the fill colour of the clipped-fill fixture. */
const isRed = ({ red, green, blue }: PixelColor): boolean => {
  return red === 255 && green === 0 && blue === 0
}

describe("createPdfDocumentProxy", () => {
  it("renders glyphs from bundled font data, independent of system fonts", async () => {
    // The fixture uses non-embedded base-14 Helvetica, which pdfjs draws from
    // its bundled standard fonts. On a host with no system fonts (the Docker
    // image), a broken module swap or font path drops every glyph and this
    // fails. A host with system fonts falls back to them and still passes, so
    // the configuration test below pins the option set as well.
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const pngBytes = await renderPageAsImage(proxy, 1, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2.0,
    })

    expect(await countPixels(pngBytes, isDark)).toBeGreaterThan(500)
  })

  it("renders a clipped vector fill on the canvases pdfjs-dist creates", async () => {
    // pdf.js clips and fills with the global Path2D on a canvas from its own
    // canvas factory; a Path2D that canvas rejects fails the render. A red
    // fill over the whole page, clipped to a 200-point square, at scale 2
    // covers exactly 400 × 400 pixels; an ignored clip paints the whole page.
    const proxy = await createPdfDocumentProxy(toPdfData(buildClippedFillPdf()))
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const pngBytes = await renderPageAsImage(proxy, 1, { canvasImport, scale: 2.0 })

    expect(await countPixels(pngBytes, isRed)).toBe(400 * 400)
  })

  it("renders a fill clipped to text outlines", async () => {
    // pdf.js builds a text clip with the global DOMMatrix's preMultiplySelf,
    // which unpdf's DOMMatrix stub lacks; this fails if the stub is ever left
    // in place for a render. Clipped to "HI" in 120-point Helvetica, the red
    // fill covers the glyph interiors only; an ignored clip paints the whole
    // 1224 × 1584 page.
    const proxy = await createPdfDocumentProxy(toPdfData(buildClippedTextPdf()))
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const pngBytes = await renderPageAsImage(proxy, 1, { canvasImport, scale: 2.0 })
    const redPixels = await countPixels(pngBytes, isRed)

    expect(redPixels).toBeGreaterThan(5_000)
    expect(redPixels).toBeLessThan(100_000)
  })

  it("extracts text through the swapped pdfjs module", async () => {
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const result = await extractText(proxy)

    expect(result).toEqual({ totalPages: 1, text: ["Hello PDF"] })
  })

  it("configures the proxy for font-independent rendering", async () => {
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    expect(getDocumentProxy).toHaveBeenLastCalledWith(fixtureBytes(), {
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: join(expectedPdfjsRoot, "standard_fonts/"),
      cMapUrl: join(expectedPdfjsRoot, "cmaps/"),
      cMapPacked: true,
    })
  })

  it("retries initialization after a failed first attempt", async () => {
    // Fresh module registry so this test's engine instance starts with a
    // cold memo — the file's other tests have already initialized theirs.
    vi.resetModules()
    const freshUnpdf = await import("unpdf")
    const freshEngine = await import("../pdf-engine.js")
    const initFailure = new Error("transient init failure")
    vi.mocked(freshUnpdf.getResolvedPDFJS).mockRejectedValueOnce(initFailure)

    // The server's own message, with the original failure kept as the cause
    await expect(freshEngine.createPdfDocumentProxy(fixtureBytes())).rejects.toEqual(
      new Error("PDF reader could not start", { cause: initFailure }),
    )

    // A cached rejection would surface the same error here instead.
    const proxy = await freshEngine.createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })
    expect(proxy.numPages).toBe(1)
  })

  it("pdfjs-dist ships the font and cMap assets at the expected locations", () => {
    // Grounds the asset roots in reality: pdfjs fetches individual files by
    // concatenation, so the directories the configuration test pins must
    // match pdfjs-dist's real layout — this fails if an upgrade moves them.
    expect(
      existsSync(join(expectedPdfjsRoot, "standard_fonts/", "LiberationSans-Regular.ttf")),
    ).toBe(true)
    expect(existsSync(join(expectedPdfjsRoot, "cmaps/", "78-H.bcmap"))).toBe(true)
  })
})
