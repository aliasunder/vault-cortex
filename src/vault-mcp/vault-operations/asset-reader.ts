import { vaultFs } from "./vault-filesystem.js"
import { linearizeCanvas } from "../obsidian-markdown/canvas.js"
import { fitImageToByteBudget } from "../../utils/fit-image-to-byte-budget.js"
import type { FittedImage } from "../../utils/fit-image-to-byte-budget.js"
import type { Logger } from "../../logger.js"

/**
 * Asset reading use-case — dispatches a non-markdown vault file to its most
 * useful representation: images fitted to a byte budget, canvases linearized
 * (or their raw JSON source), text formats decoded verbatim, and structured
 * errors for everything else. Composes vaultFs.readAsset with the parsers and
 * the image pipeline; the tool layer maps the result to MCP content blocks.
 */

/** Extensions dispatched to the image pipeline (model-visible image blocks). */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])

/** Extensions returned verbatim as text — plain-text formats an agent can
 *  read directly. .svg is XML source; .base is Obsidian Bases YAML. */
const TEXT_PASSTHROUGH_EXTENSIONS = new Set([
  ".svg",
  ".json",
  ".txt",
  ".csv",
  ".xml",
  ".log",
  ".base",
])

/** Fixed cap on text output (passthrough files and canvas renditions) so a
 *  huge text asset can't blow a client's response limit. Deliberately not an
 *  env var — the image budget is the tunable surface; text past this size
 *  needs paging, not a bigger blob. */
const MAX_TEXT_OUTPUT_BYTES = 102_400

/** The computed result of one asset read, before content-block formatting:
 *  an image (fitted to the byte budget) or a text rendition. */
export type AssetReadResult =
  | Readonly<{
      kind: "image"
      fitted: FittedImage
      originalBytes: number
      path: string
    }>
  | Readonly<{ kind: "text"; text: string }>

/** Rejects text output past the fixed cap — an explicit error beats silent
 *  truncation, and states the actual size so the caller knows what exists. */
const assertTextWithinCap = (params: { text: string; path: string }): void => {
  const textBytes = Buffer.byteLength(params.text, "utf8")
  if (textBytes <= MAX_TEXT_OUTPUT_BYTES) return
  throw new Error(
    `text output too large: "${params.path}" renders to ${textBytes} bytes ` +
      `(cap ${MAX_TEXT_OUTPUT_BYTES} bytes)`,
  )
}

/** Decodes an asset buffer as UTF-8, rejecting invalid byte sequences — text
 *  is promised verbatim, and the default decoder would silently substitute
 *  U+FFFD for every undecodable byte instead. */
const decodeUtf8Strict = (params: { buffer: Buffer; path: string }): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(params.buffer)
  } catch (error) {
    throw new Error(
      `not valid UTF-8: "${params.path}" cannot be returned as text`,
      { cause: error },
    )
  }
}

/**
 * Reads a non-markdown vault file and returns its most useful representation
 * per type; `raw` skips the canvas rendition for the exact JSON source.
 * Throws structured errors for images with `raw`, PDFs, and unsupported
 * types — each stating the file's existence and size.
 */
const readAssetContent = async (
  params: {
    vaultPath: string
    path: string
    raw?: boolean | undefined
    maxAssetBytes: number
    maxImageOutputBytes: number
  },
  logger: Logger,
): Promise<AssetReadResult> => {
  const { path, raw } = params
  const asset = await vaultFs.readAsset(
    { vaultPath: params.vaultPath, path, maxBytes: params.maxAssetBytes },
    logger,
  )
  const isImage = IMAGE_EXTENSIONS.has(asset.extension)
  if (isImage && raw) {
    throw new Error(
      `raw source is not available for images: "${path}" is ` +
        `binary — its image block is the delivered form`,
    )
  }
  if (isImage) {
    const fitted = await fitImageToByteBudget({
      buffer: asset.buffer,
      budgetBytes: params.maxImageOutputBytes,
    })
    return { kind: "image", fitted, originalBytes: asset.bytes, path }
  }
  if (asset.extension === ".canvas") {
    const canvasSource = decodeUtf8Strict({ buffer: asset.buffer, path })
    const text = raw ? canvasSource : linearizeCanvas(canvasSource)
    assertTextWithinCap({ text, path })
    return { kind: "text", text }
  }
  if (TEXT_PASSTHROUGH_EXTENSIONS.has(asset.extension)) {
    const text = decodeUtf8Strict({ buffer: asset.buffer, path })
    assertTextWithinCap({ text, path })
    return { kind: "text", text }
  }
  if (asset.extension === ".pdf") {
    throw new Error(
      `PDF reading is not yet supported: "${path}" exists ` +
        `(${asset.bytes} bytes) but text extraction is not available yet`,
    )
  }
  throw new Error(
    `unsupported asset type "${asset.extension}": "${path}" exists ` +
      `(${asset.bytes} bytes). Readable types: images ` +
      `(.png/.jpg/.jpeg/.gif/.webp), .canvas, and text formats ` +
      `(.svg/.json/.txt/.csv/.xml/.log/.base)`,
  )
}

/** The asset-reading use-case surface — namespace export so call sites read
 *  `assetReader.readAssetContent(...)`, matching the folder's operation
 *  modules (noteMover, vaultPatcher, taskUpdater). */
export const assetReader = {
  readAssetContent,
}
