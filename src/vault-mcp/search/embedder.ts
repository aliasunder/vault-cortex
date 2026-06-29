/** Lazy-loading embedding pipeline for local ONNX models.
 *
 * Factory-closure pattern: `createEmbedder(logger)` returns the embed API.
 * The model is downloaded on first use and cached by the transformers library.
 * Bi-encoder only — the cross-encoder reranker lives in a separate PR. */

import { createHash } from "node:crypto"
import type { Logger } from "../../logger.js"

const MODEL_NAME = "Xenova/bge-small-en-v1.5"

export const EMBEDDING_DIMENSIONS = 384

/** SHA-256 content hash — used to skip re-embedding unchanged chunks. */
export const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

export type Embedder = ReturnType<typeof createEmbedder>

export const createEmbedder = (logger: Logger) => {
  type TransformersPipeline = Awaited<
    ReturnType<
      typeof import("@huggingface/transformers").pipeline<"feature-extraction">
    >
  >

  let pipelineInstance: TransformersPipeline | null = null
  // Guards against concurrent callers both triggering a model download —
  // the second caller awaits the first's promise instead of loading again.
  let pipelineLoading: Promise<TransformersPipeline> | null = null

  const getPipeline = async (): Promise<TransformersPipeline> => {
    if (pipelineInstance) return pipelineInstance
    if (pipelineLoading) return pipelineLoading

    pipelineLoading = (async () => {
      try {
        const startMs = performance.now()
        const { pipeline } = await import("@huggingface/transformers")
        const instance = await pipeline("feature-extraction", MODEL_NAME, {
          dtype: "q8",
        })
        const elapsedMs = Math.round(performance.now() - startMs)
        logger.info("embedding model loaded", { model: MODEL_NAME, elapsedMs })
        pipelineInstance = instance
        return instance
      } catch (error) {
        logger.warn("embedding model failed to load", {
          model: MODEL_NAME,
          error: error instanceof Error ? error.message : String(error),
        })
        // Allow retry on next call (e.g. transient network failure during download)
        pipelineLoading = null
        throw error
      }
    })()

    return pipelineLoading
  }

  /** The transformers pipeline returns a Tensor whose `.data` is typed as
   *  `DataArray` (a union of typed arrays). Feature-extraction with mean
   *  pooling always produces Float32Array — guard at runtime rather than
   *  using an `as` cast. */
  const toFloat32Array = (data: unknown): Float32Array => {
    if (data instanceof Float32Array) return data
    throw new Error(
      `expected Float32Array from embedding pipeline, got ${typeof data}`,
    )
  }

  /** Embed a single text. Returns a 384-dim Float32Array (mean-pooled, L2-normalized). */
  const embedText = async (text: string): Promise<Float32Array> => {
    const pipe = await getPipeline()
    const output = await pipe(text, { pooling: "mean", normalize: true })
    return new Float32Array(toFloat32Array(output.data))
  }

  /** Embed multiple texts in a single pipeline call. Returns one Float32Array per input. */
  const embedBatch = async (
    texts: readonly string[],
  ): Promise<Float32Array[]> => {
    if (texts.length === 0) return []
    const pipe = await getPipeline()
    const output = await pipe([...texts], { pooling: "mean", normalize: true })
    const data = toFloat32Array(output.data)

    // The pipeline returns all embeddings concatenated in a single flat array
    // (e.g. 3 inputs × 384 dims = 1152 floats). Slice out each input's embedding.
    return texts.map(
      (_text, index) =>
        new Float32Array(
          data.slice(
            index * EMBEDDING_DIMENSIONS,
            (index + 1) * EMBEDDING_DIMENSIONS,
          ),
        ),
    )
  }

  return { embedText, embedBatch }
}
