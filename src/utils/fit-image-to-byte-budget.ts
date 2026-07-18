import sharp from "sharp"
import type { OutputInfo } from "sharp"

/**
 * Fits an image into a byte budget by downscaling and recompressing —
 * deterministic and provably terminating. Model-facing image transports cap
 * response sizes well below typical photo sizes, so oversized images must be
 * shrunk server-side; this module owns that policy for any caller.
 *
 * Strategy, in order:
 * 1. Pass through untouched when the original already fits the budget, needs
 *    no downscale, and is in a model-supported format — no quality loss.
 * 2. Auto-orient (EXIF), resize the long edge to ≤1568px (models downscale
 *    beyond that anyway), and walk a fixed quality ladder — JPEG for opaque
 *    images, WebP for images with alpha (PNG has no quality knob, so it
 *    cannot hit a byte budget reliably).
 * 3. If the ladder floor still exceeds the budget, shrink dimensions by
 *    sqrt(budget/actual) per step (clamped so each step is a real reduction)
 *    at mid-ladder quality, down to a 64px floor.
 *
 * Throws when the attempt cap is reached without fitting — callers surface
 * that as a structured error rather than silently sending an oversized image.
 * Sharp's default limitInputPixels (~268 megapixels) stays active as the
 * decompression-bomb guard; `failOn: "none"` tolerates slightly-corrupt files.
 */

const MAX_LONG_EDGE_PX = 1568
const MIN_LONG_EDGE_PX = 64
const QUALITY_LADDER = [75, 60, 45, 30]
const MID_LADDER_QUALITY = 45
const MAX_ENCODE_ATTEMPTS = 8

/** Formats the Claude API accepts as image input; anything else must be
 *  re-encoded even when it fits the budget. */
const MODEL_SUPPORTED_FORMATS = new Map<string, string>([
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
])

export type FittedImage = Readonly<{
  data: Buffer
  mimeType: string
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  /** False when the original bytes passed through untouched. */
  recompressed: boolean
}>

/** One resize+encode pass; the encoder is WebP when alpha must survive
 *  (JPEG would flatten it), JPEG otherwise. */
const encodeAttempt = async (params: {
  buffer: Buffer
  longEdgePx: number
  quality: number
  keepAlpha: boolean
}): Promise<{ data: Buffer; info: OutputInfo }> => {
  const resized = sharp(params.buffer, { failOn: "none" }).autoOrient().resize({
    width: params.longEdgePx,
    height: params.longEdgePx,
    fit: "inside",
    withoutEnlargement: true,
  })
  const encoded = params.keepAlpha
    ? resized.webp({ quality: params.quality })
    : resized.jpeg({ quality: params.quality, mozjpeg: true })
  return encoded.toBuffer({ resolveWithObject: true })
}

/**
 * Downscales/recompresses `buffer` until its encoded size is ≤ `budgetBytes`.
 * Returns the fitted image with its final and original dimensions, or throws
 * when the image cannot be fitted within the attempt cap.
 */
export const fitImageToByteBudget = async (params: {
  buffer: Buffer
  budgetBytes: number
}): Promise<FittedImage> => {
  const metadata = await sharp(params.buffer, { failOn: "none" }).metadata()
  const { width, height, format } = metadata
  if (!width || !height || !format) {
    throw new Error("could not decode image (no dimensions or format)")
  }

  const longEdge = Math.max(width, height)
  const passthroughMime = MODEL_SUPPORTED_FORMATS.get(format)
  const fitsAsIs =
    params.buffer.length <= params.budgetBytes && longEdge <= MAX_LONG_EDGE_PX
  if (fitsAsIs && passthroughMime) {
    return {
      data: params.buffer,
      mimeType: passthroughMime,
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      recompressed: false,
    }
  }

  const keepAlpha = metadata.hasAlpha === true
  // Mutable descent state: each attempt either succeeds (returns) or tightens
  // quality/dimensions for the next — inherently sequential.
  let longEdgePx = Math.min(longEdge, MAX_LONG_EDGE_PX)
  let attemptCount = 0
  let qualityLadderIndex = 0
  let lastEncodedBytes = params.buffer.length

  while (attemptCount < MAX_ENCODE_ATTEMPTS) {
    const quality =
      qualityLadderIndex < QUALITY_LADDER.length
        ? QUALITY_LADDER[qualityLadderIndex]
        : MID_LADDER_QUALITY
    if (quality === undefined) break
    const { data, info } = await encodeAttempt({
      buffer: params.buffer,
      longEdgePx,
      quality,
      keepAlpha,
    })
    attemptCount += 1
    lastEncodedBytes = info.size
    if (info.size <= params.budgetBytes) {
      return {
        data,
        mimeType: keepAlpha ? "image/webp" : "image/jpeg",
        width: info.width,
        height: info.height,
        originalWidth: width,
        originalHeight: height,
        recompressed: true,
      }
    }
    if (qualityLadderIndex < QUALITY_LADDER.length - 1) {
      qualityLadderIndex += 1
      continue
    }
    // Ladder floor still over budget — shrink dimensions. sqrt because encoded
    // size scales roughly with pixel area; the 0.7 clamp guarantees each step
    // is a real reduction even when the overshoot is marginal.
    qualityLadderIndex = QUALITY_LADDER.length
    const areaScale = Math.sqrt(params.budgetBytes / lastEncodedBytes)
    const nextLongEdgePx = Math.floor(longEdgePx * Math.min(areaScale, 0.7))
    if (nextLongEdgePx < MIN_LONG_EDGE_PX) break
    longEdgePx = nextLongEdgePx
  }

  throw new Error(
    `image cannot be fitted into ${params.budgetBytes} bytes ` +
      `(smallest attempt was ${lastEncodedBytes} bytes after ${attemptCount} attempts)`,
  )
}
