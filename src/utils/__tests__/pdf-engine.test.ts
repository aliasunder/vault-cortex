import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect, vi, onTestFinished } from "vitest"
import sharp from "sharp"
import { getDocumentProxy, renderPageAsImage, extractText } from "unpdf"
import { createPdfDocumentProxy } from "../pdf-engine.js"
import { buildMinimalPdf } from "../../vault-mcp/mcp-core/__tests__/pdf-fixture.js"

// Spy mode keeps the real unpdf implementation — the rendering tests below
// are true integration tests — while letting the configuration test assert
// the exact options handed to pdfjs.
vi.mock("unpdf", { spy: true })

/** The fixture as the Uint8Array shape production hands to the engine. */
const fixtureBytes = (): Uint8Array => {
  const pdfBuffer = buildMinimalPdf()
  return new Uint8Array(
    pdfBuffer.buffer,
    pdfBuffer.byteOffset,
    pdfBuffer.byteLength,
  )
}

/** Counts near-black opaque pixels in a rendered page — glyph coverage.
 *  Rendered text produces thousands of dark pixels; a page whose glyphs
 *  were dropped produces zero, so a floor assertion separates the two
 *  states cleanly despite platform-dependent antialiasing. */
const countDarkPixels = async (
  pngArrayBuffer: ArrayBuffer,
): Promise<number> => {
  const { data, info } = await sharp(Buffer.from(pngArrayBuffer))
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixelValues = new Uint8Array(data)
  // Mutable counter over raw pixel data — a typed-array walk has no
  // readable immutable equivalent.
  let darkPixels = 0
  for (let offset = 0; offset < pixelValues.length; offset += info.channels) {
    const red = pixelValues[offset] ?? 255
    const green = pixelValues[offset + 1] ?? 255
    const blue = pixelValues[offset + 2] ?? 255
    if (red < 128 && green < 128 && blue < 128) darkPixels += 1
  }
  return darkPixels
}

describe("createPdfDocumentProxy", () => {
  it("renders glyphs from bundled font data, independent of system fonts", async () => {
    // The fixture uses non-embedded base-14 Helvetica — the case that renders
    // ONLY when pdfjs loads its bundled standard fonts (useSystemFonts is
    // false), so this fails if the font-data plumbing breaks: the module
    // swap, the standard-font path shape, or the option set.
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const pngArrayBuffer = await renderPageAsImage(proxy, 1, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2.0,
    })

    expect(await countDarkPixels(pngArrayBuffer)).toBeGreaterThan(500)
  })

  it("extracts text through the swapped pdfjs module", async () => {
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const { totalPages, text } = await extractText(proxy)

    expect(totalPages).toBe(1)
    expect(text).toEqual(["Hello PDF"])
  })

  it("configures the proxy for font-independent rendering", async () => {
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    expect(getDocumentProxy).toHaveBeenCalledWith(expect.any(Uint8Array), {
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: expect.stringMatching(/standard_fonts\/$/),
      cMapUrl: expect.stringMatching(/cmaps\/$/),
      cMapPacked: true,
      CanvasFactory: expect.any(Function),
    })
  })

  it("resolves font and cMap paths that exist on disk", async () => {
    // Grounds the resolved directories in reality: pdfjs fetches individual
    // files by concatenation, so the paths must point at pdfjs-dist's real
    // asset layout — this fails if a pdfjs-dist upgrade moves them.
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    const proxyOptions = vi.mocked(getDocumentProxy).mock.calls.at(-1)?.[1]
    if (!proxyOptions?.standardFontDataUrl || !proxyOptions.cMapUrl) {
      throw new Error("expected font options on the getDocumentProxy call")
    }
    expect(
      existsSync(
        join(proxyOptions.standardFontDataUrl, "LiberationSans-Regular.ttf"),
      ),
    ).toBe(true)
    expect(existsSync(join(proxyOptions.cMapUrl, "78-H.bcmap"))).toBe(true)
  })
})
