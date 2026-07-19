import { describe, it, expect } from "vitest"
import sharp from "sharp"
import { fitImageToByteBudget } from "../fit-image-to-byte-budget.js"

/** Gaussian-noise fixture — noise resists compression, so size assertions
 *  exercise the real descent logic instead of trivially fitting. */
const noiseImage = (params: {
  width: number
  height: number
  alpha?: boolean
}): Promise<Buffer> => {
  const channels = params.alpha ? 4 : 3
  return sharp({
    create: {
      width: params.width,
      height: params.height,
      channels,
      background: { r: 128, g: 128, b: 128, alpha: 1 },
      noise: { type: "gaussian", mean: 128, sigma: 30 },
    },
  })
    .png()
    .toBuffer()
}

describe("fitImageToByteBudget", () => {
  it("passes a small supported image through untouched", async () => {
    const original = await sharp({
      create: {
        width: 100,
        height: 80,
        channels: 3,
        background: { r: 255, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer()
    const fitted = await fitImageToByteBudget({
      buffer: original,
      budgetBytes: 49152,
    })
    expect(fitted.data.equals(original)).toBe(true)
    expect(fitted).toMatchObject({
      mimeType: "image/png",
      width: 100,
      height: 80,
      originalWidth: 100,
      originalHeight: 80,
      recompressed: false,
    })
  })

  it("downscales an oversized opaque image to JPEG within the budget", async () => {
    const original = await noiseImage({ width: 2400, height: 1600 })
    const budgetBytes = 49152
    const fitted = await fitImageToByteBudget({ buffer: original, budgetBytes })
    expect(fitted.data.length).toBeLessThanOrEqual(budgetBytes)
    expect(fitted.mimeType).toBe("image/jpeg")
    expect(fitted.recompressed).toBe(true)
    expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(1568)
    expect(fitted.originalWidth).toBe(2400)
    expect(fitted.originalHeight).toBe(1600)
  })

  it("recompresses an alpha image to WebP, not JPEG", async () => {
    const original = await noiseImage({
      width: 2000,
      height: 2000,
      alpha: true,
    })
    const budgetBytes = 49152
    const fitted = await fitImageToByteBudget({ buffer: original, budgetBytes })
    expect(fitted.mimeType).toBe("image/webp")
    expect(fitted.data.length).toBeLessThanOrEqual(budgetBytes)
    expect(fitted.recompressed).toBe(true)
  })

  it("shrinks dimensions below 1568 when the quality ladder alone cannot fit", async () => {
    const original = await noiseImage({ width: 3000, height: 3000 })
    // Small enough that no 1568px JPEG of gaussian noise can fit.
    const budgetBytes = 8192
    const fitted = await fitImageToByteBudget({ buffer: original, budgetBytes })
    expect(fitted.data.length).toBeLessThanOrEqual(budgetBytes)
    expect(Math.max(fitted.width, fitted.height)).toBeLessThan(1568)
  })

  it("applies EXIF orientation before resizing", async () => {
    // Landscape pixels + EXIF orientation 6 (rotate 90° CW) = portrait image.
    const rotatedSource = await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 3,
        background: { r: 10, g: 200, b: 50 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const fitted = await fitImageToByteBudget({
      buffer: rotatedSource,
      budgetBytes: 49152,
    })
    expect(fitted.height).toBeGreaterThan(fitted.width)
  })

  it("throws when no attempt can fit the budget", async () => {
    const original = await noiseImage({ width: 3000, height: 3000 })
    await expect(
      fitImageToByteBudget({ buffer: original, budgetBytes: 10 }),
    ).rejects.toThrow(/^image cannot be fitted into 10 bytes/)
  })

  it("throws a decode error for a non-image buffer", async () => {
    await expect(
      fitImageToByteBudget({
        buffer: Buffer.from("not an image at all"),
        budgetBytes: 49152,
      }),
    ).rejects.toThrow("Input buffer contains unsupported image format")
  })
})
