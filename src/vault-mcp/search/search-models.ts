import type { Logger } from "../../logger.js"
import type { VaultConfig } from "../config.js"
import { describeError } from "../../utils/describe-error.js"
import { createEmbedder, type Embedder } from "./embedder.js"
import { createReranker, type Reranker } from "./reranker.js"

type SearchModels = { embedder: Embedder | undefined; reranker: Reranker | undefined }

/** Builds the search models the config turns on, with transformers.js's cache folder set to
 *  `modelCacheDir` first. */
export const createSearchModels = async (
  params: Pick<VaultConfig, "embeddingEnabled" | "rerankMode"> & { modelCacheDir: string },
  logger: Logger,
): Promise<SearchModels> => {
  const { embeddingEnabled, rerankMode, modelCacheDir } = params

  // Return before importing transformers.js, because that import loads the ONNX runtime.
  if (!embeddingEnabled) return { embedder: undefined, reranker: undefined }

  // transformers.js ignores a per-call cache_dir in two reads, so set its process-wide folder:
  // - pipeline() reading config.json
  // - pipeline() and AutoTokenizer checking for tokenizer_config.json
  try {
    const { env } = await import("@huggingface/transformers")
    env.cacheDir = modelCacheDir
  } catch (error) {
    // Node caches the failed import, so models built now could never load. Return none, so
    // search stays keyword-only and the server keeps running.
    logger.error("search model runtime failed to load, falling back to keyword-only search", {
      error: describeError(error),
    })
    return { embedder: undefined, reranker: undefined }
  }

  return {
    embedder: createEmbedder(logger),
    reranker: rerankMode === "blended" ? createReranker(logger) : undefined,
  }
}
