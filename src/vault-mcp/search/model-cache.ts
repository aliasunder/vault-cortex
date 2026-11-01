/** Sets transformers.js's process-wide model cache folder. A per-call cache_dir is not enough,
 *  because pipeline() and AutoTokenizer skip it for config.json and tokenizer_config.json. */
export const setModelCacheDir = async (modelCacheDir: string): Promise<void> => {
  const { env } = await import("@huggingface/transformers")
  env.cacheDir = modelCacheDir
}
