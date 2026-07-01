// ── Cross-encoder reranker + position-aware score blending ─────

import type { Logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"

const RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"

// ── Factory ───────────────────────────────────────────────────

export type Reranker = ReturnType<typeof createReranker>

/** Lazy-loading cross-encoder reranker for query-document relevance scoring.
 *
 *  Factory-closure pattern: `createReranker(logger)` returns the rerank API.
 *  The model is downloaded on first use and cached by the transformers library.
 *  Uses `AutoModelForSequenceClassification` + `AutoTokenizer` (not the
 *  `pipeline()` API) because text-classification pipelines do not support
 *  the `text_pair` tokenizer input needed for cross-encoder scoring. */
export const createReranker = (logger: Logger) => {
  type TransformersModule = typeof import("@huggingface/transformers")
  type TokenizerInstance = Awaited<
    ReturnType<TransformersModule["AutoTokenizer"]["from_pretrained"]>
  >
  type ModelInstance = Awaited<
    ReturnType<
      TransformersModule["AutoModelForSequenceClassification"]["from_pretrained"]
    >
  >

  let tokenizer: TokenizerInstance | null = null
  let model: ModelInstance | null = null
  // Guards against concurrent callers both triggering a model download —
  // the second caller awaits the first's promise instead of loading again.
  let modelLoading: Promise<{
    tokenizer: TokenizerInstance
    model: ModelInstance
  }> | null = null

  const getModel = async (): Promise<{
    tokenizer: TokenizerInstance
    model: ModelInstance
  }> => {
    if (tokenizer && model) return { tokenizer, model }
    if (modelLoading) return modelLoading

    modelLoading = (async () => {
      try {
        const startMs = performance.now()
        const { AutoTokenizer, AutoModelForSequenceClassification } =
          await import("@huggingface/transformers")
        const [loadedTokenizer, loadedModel] = await Promise.all([
          AutoTokenizer.from_pretrained(RERANKER_MODEL),
          // INT8 quantization — halves model size (~20MB vs ~80MB) with
          // negligible quality loss for cross-encoders (full-attention
          // pair scoring is robust to reduced precision).
          AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, {
            dtype: "q8",
          }),
        ])
        const elapsedMs = Math.round(performance.now() - startMs)
        logger.info("reranker model loaded", {
          model: RERANKER_MODEL,
          elapsedMs,
        })
        tokenizer = loadedTokenizer
        model = loadedModel
        return { tokenizer: loadedTokenizer, model: loadedModel }
      } catch (error) {
        logger.warn("reranker model failed to load", {
          model: RERANKER_MODEL,
          error: describeError(error),
        })
        // Allow retry on next call (e.g. transient network failure during download)
        modelLoading = null
        throw error
      }
    })()

    return modelLoading
  }

  /** Score (query, document) pairs for relevance. Returns one raw logit
   *  score per document — higher means more relevant. Scores are
   *  unnormalized (typically in the range -10 to +10 for ms-marco models);
   *  call `normalizeScores` before blending with RRF scores. */
  const rerankPairs = async (
    query: string,
    documents: readonly string[],
  ): Promise<number[]> => {
    if (documents.length === 0) return []

    const crossEncoder = await getModel()

    // Score each (query, document) pair sequentially — the ONNX runtime
    // runs on a single thread, so parallelizing wouldn't help.
    const scores: number[] = []
    for (const document of documents) {
      const inputs = crossEncoder.tokenizer(query, {
        // text_pair encodes both texts as a single [CLS] query [SEP] document [SEP]
        // sequence so the model can attend across both simultaneously.
        text_pair: document,
        // padding: required by the tokenizer API for consistent tensor shapes.
        padding: true,
        // truncation: ms-marco has a 512-token context window. Query + document
        // can exceed this (chunks are up to 450 tokens), so truncation clips
        // the combined input to fit — the model scores what it sees.
        truncation: true,
      })
      const output = await crossEncoder.model(inputs)
      // output.logits is a Tensor [1, 1] — a single relevance score per pair.
      const logit = Number(output.logits.data[0])
      scores.push(logit)
    }

    return scores
  }

  return { rerankPairs }
}

// ── Pure scoring functions ────────────────────────────────────

/** Min-max normalization to [0, 1].
 *
 *  When all scores are identical (max === min), returns 0.5 for every
 *  element to avoid division by zero — a uniform distribution conveys
 *  "no signal" rather than an arbitrary extreme. */
export const normalizeScores = (scores: readonly number[]): number[] => {
  if (scores.length === 0) return []

  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  if (range === 0) return scores.map(() => 0.5)

  return scores.map((score) => (score - min) / range)
}

/** Position-aware score blending — combines RRF retrieval scores with
 *  cross-encoder reranker scores using rank-dependent weights.
 *
 *  Inspired by qmd: https://github.com/tobi/qmd
 *
 *  Weight tiers (by 1-indexed RRF rank):
 *  - Ranks 1–3:  75% RRF / 25% reranker — protect strong retrieval hits
 *  - Ranks 4–10: 50% RRF / 50% reranker — even blend in the middle
 *  - Ranks 11+:  40% RRF / 60% reranker — let reranker rescue demoted results
 *
 *  Both score arrays are min-max normalized internally before blending
 *  so the weight ratios are meaningful regardless of input scale. */
export const blendScores = (params: {
  rrfScores: readonly number[]
  rerankScores: readonly number[]
  rrfRanks: readonly number[]
}): number[] => {
  const normalizedRrf = normalizeScores(params.rrfScores)
  const normalizedRerank = normalizeScores(params.rerankScores)

  return normalizedRrf.map((rrfNorm, index) => {
    const rerankNorm = normalizedRerank[index]
    const rank = params.rrfRanks[index]

    const rrfWeight = rank <= 3 ? 0.75 : rank <= 10 ? 0.5 : 0.4
    const rerankWeight = 1 - rrfWeight

    return Number(
      (rrfNorm * rrfWeight + rerankNorm * rerankWeight).toPrecision(4),
    )
  })
}
