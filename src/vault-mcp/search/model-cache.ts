/** Sets transformers.js's process-wide model cache folder. A per-call cache_dir is not enough,
 *  because the library ignores it in two places:
 *  - pipeline() reads config.json without it
 *  - pipeline() and AutoTokenizer check for tokenizer_config.json without it */
export const setModelCacheDir = async (modelCacheDir: string): Promise<void> => {
  const { env } = await import("@huggingface/transformers")
  env.cacheDir = modelCacheDir
}
