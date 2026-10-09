import { describe, it, expect } from "vitest"
import { crc32 } from "node:zlib"
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

/** A PNG that declares its size and holds no pixel data — enough for sharp to
 *  read the size and refuse an image over its pixel limit (about 268 million
 *  pixels) without the test allocating one. */
const pngHeaderOnly = (params: { width: number; height: number }): Buffer => {
  const buildChunk = (chunkType: string, chunkData: Buffer): Buffer => {
    const lengthField = Buffer.alloc(4)
    lengthField.writeUInt32BE(chunkData.length)
    const typeAndData = Buffer.concat([Buffer.from(chunkType, "ascii"), chunkData])
    const checksumField = Buffer.alloc(4)
    checksumField.writeUInt32BE(crc32(typeAndData))
    return Buffer.concat([lengthField, typeAndData, checksumField])
  }

  const imageHeader = Buffer.alloc(13)
  imageHeader.writeUInt32BE(params.width, 0)
  imageHeader.writeUInt32BE(params.height, 4)
  // 8 bits per channel, truecolour (RGB)
  imageHeader.writeUInt8(8, 8)
  imageHeader.writeUInt8(2, 9)

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    pngSignature,
    buildChunk("IHDR", imageHeader),
    buildChunk("IDAT", Buffer.alloc(0)),
    buildChunk("IEND", Buffer.alloc(0)),
  ])
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
    expect(fitted).toEqual({
      data: original,
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
    // 800px keeps the noise PNG far over budget (forcing recompression)
    // while staying cheap to WebP-encode — at 2000px this test timed out
    // on slow CI runners. Dimension descent and the 1568px clamp have
    // their own tests; only the format choice is under test here.
    const original = await noiseImage({
      width: 800,
      height: 800,
      alpha: true,
    })
    const budgetBytes = 49152
    const fitted = await fitImageToByteBudget({ buffer: original, budgetBytes })
    expect(fitted.mimeType).toBe("image/webp")
    expect(fitted.data.length).toBeLessThanOrEqual(budgetBytes)
    expect(fitted.recompressed).toBe(true)
  })

  it("shrinks dimensions below 1568 when the quality ladder alone cannot fit", async () => {
    // Just over 1568px, so the ladder runs at 1568px and any narrower result
    // proves the dimensions shrank
    const original = await noiseImage({ width: 1600, height: 1600 })
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

  it("throws after the quality ladder and one attempt at the 64px floor when nothing fits", async () => {
    // No image encodes into 10 bytes, so a small plain source takes the same
    // five attempts a large one would, without the large one's encoding time
    const original = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 200, b: 50 } },
    })
      .png()
      .toBuffer()

    // The last attempt's size depends on the JPEG encoder's build, so only
    // its digits are matched
    await expect(fitImageToByteBudget({ buffer: original, budgetBytes: 10 })).rejects.toThrow(
      /^image cannot be fitted into 10 bytes \(last attempt was \d+ bytes after 5 attempts\)$/,
    )
  })

  it.each([
    {
      label: "a non-image buffer",
      buffer: Buffer.from("not an image at all"),
      decoderMessage: "Input buffer contains unsupported image format",
    },
    { label: "an empty buffer", buffer: Buffer.alloc(0), decoderMessage: "Input Buffer is empty" },
    {
      label: "an image over the decoder's pixel limit",
      buffer: pngHeaderOnly({ width: 20_000, height: 20_000 }),
      decoderMessage: "Input image exceeds pixel limit",
    },
  ])(
    "throws its own decode error for $label, with the decoder's as the cause",
    async ({ buffer, decoderMessage }) => {
      // toMatchObject, not toEqual: sharp's native addon gives some errors an
      // enumerable message, which an Error built here never equals
      await expect(fitImageToByteBudget({ buffer, budgetBytes: 49152 })).rejects.toMatchObject({
        message:
          "could not decode image (the file is empty, damaged, not an image, or over about 268 million pixels)",
        cause: { message: decoderMessage },
      })
    },
  )
})
