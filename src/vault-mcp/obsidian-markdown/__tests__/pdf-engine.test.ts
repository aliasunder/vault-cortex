import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, it, expect, vi, onTestFinished } from "vitest"
import sharp from "sharp"
import { getDocumentProxy, renderPageAsImage, extractText } from "unpdf"
import { createPdfDocumentProxy } from "../pdf-engine.js"
import { buildMinimalPdf } from "../../mcp-core/__tests__/pdf-fixture.js"

// Spy mode keeps the real unpdf implementation — the rendering tests below
// are true integration tests — while letting the configuration test assert
// the exact options handed to pdfjs.
vi.mock("unpdf", { spy: true })

/** Test-owned expectation for the engine's asset roots — derived here with
 *  the same resolution mechanism production uses, so the configuration test
 *  asserts exact paths without reading them back out of the mock call log,
 *  and catches production ever resolving somewhere else. */
const expectedPdfjsRoot = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
)

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

    const result = await extractText(proxy)

    expect(result).toMatchObject({ totalPages: 1, text: ["Hello PDF"] })
  })

  it("configures the proxy for font-independent rendering", async () => {
    const proxy = await createPdfDocumentProxy(fixtureBytes())
    onTestFinished(async () => {
      await proxy.loadingTask.destroy()
    })

    expect(getDocumentProxy).toHaveBeenCalledWith(expect.any(Uint8Array), {
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: join(expectedPdfjsRoot, "standard_fonts/"),
      cMapUrl: join(expectedPdfjsRoot, "cmaps/"),
      cMapPacked: true,
      CanvasFactory: expect.any(Function),
    })
  })

  it("retries initialization after a failed first attempt", async () => {
    // Fresh module registry so this test's engine instance starts with a
    // cold memo — the file's other tests have already initialized theirs.
    vi.resetModules()
    const freshUnpdf = await import("unpdf")
    const freshEngine = await import("../pdf-engine.js")
    vi.mocked(freshUnpdf.definePDFJSModule).mockRejectedValueOnce(
      new Error("transient init failure"),
    )

    await expect(
      freshEngine.createPdfDocumentProxy(fixtureBytes()),
    ).rejects.toThrow(/^transient init failure$/)

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
      existsSync(
        join(
          expectedPdfjsRoot,
          "standard_fonts/",
          "LiberationSans-Regular.ttf",
        ),
      ),
    ).toBe(true)
    expect(existsSync(join(expectedPdfjsRoot, "cmaps/", "78-H.bcmap"))).toBe(
      true,
    )
  })
})
