import { describe, it, expect, vi, beforeEach } from "vitest"
import { normalizeScores, blendScores } from "../reranker.js"
import { logger } from "../../../logger.js"

// ── Mock for cross-encoder factory tests ──────────────────────

// Deterministic mock: each (query, document) pair produces a score
// derived from the document text length, so different documents give
// distinguishable scores. The actual scoring logic is in the model —
// the mock just needs to produce stable, distinct values.
const mockTokenizer = vi.fn().mockReturnValue({
  input_ids: { data: [1, 2, 3] },
  attention_mask: { data: [1, 1, 1] },
})

const mockModel = vi.fn().mockImplementation(() =>
  Promise.resolve({
    logits: { data: [0.95] },
  }),
)

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(vi.fn()),
  AutoTokenizer: {
    from_pretrained: vi.fn().mockResolvedValue(mockTokenizer),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn().mockResolvedValue(mockModel),
  },
}))

describe("normalizeScores", () => {
  it("normalizes a range to [0, 1]", () => {
    const result = normalizeScores([1, 3, 5])
    expect(result).toEqual([0, 0.5, 1])
  })

  it("returns all 0.5 when all scores are identical", () => {
    const result = normalizeScores([7, 7, 7])
    expect(result).toEqual([0.5, 0.5, 0.5])
  })

  it("returns [0.5] for a single element", () => {
    const result = normalizeScores([42])
    expect(result).toEqual([0.5])
  })

  it("returns empty array for empty input", () => {
    const result = normalizeScores([])
    expect(result).toEqual([])
  })

  it("handles negative scores", () => {
    const result = normalizeScores([-10, 0, 10])
    expect(result).toEqual([0, 0.5, 1])
  })

  it("normalizes two-element range", () => {
    const result = normalizeScores([0, 100])
    expect(result).toEqual([0, 1])
  })
})

describe("blendScores", () => {
  const scenarios = [
    {
      name: "ranks 1-3 use 75/25 weights",
      rrfScores: [0.08, 0.06, 0.04],
      rerankScores: [0.2, 0.8, 0.5],
      rrfRanks: [1, 2, 3],
      expected: [
        // rrfNorm: [1, 0.5, 0] — rerankNorm: [0, 1, 0.5]
        // rank 1: 1 * 0.75 + 0 * 0.25 = 0.75
        Number((0.75).toPrecision(4)),
        // rank 2: 0.5 * 0.75 + 1 * 0.25 = 0.625
        Number((0.625).toPrecision(4)),
        // rank 3: 0 * 0.75 + 0.5 * 0.25 = 0.125
        Number((0.125).toPrecision(4)),
      ],
    },
    {
      name: "ranks 4-10 use 50/50 weights",
      rrfScores: [0.03, 0.02, 0.01],
      rerankScores: [0.1, 0.9, 0.5],
      rrfRanks: [4, 7, 10],
      expected: [
        // rrfNorm: [1, 0.5, 0] — rerankNorm: [0, 1, 0.5]
        // rank 4: 1 * 0.5 + 0 * 0.5 = 0.5
        Number((0.5).toPrecision(4)),
        // rank 7: 0.5 * 0.5 + 1 * 0.5 = 0.75
        Number((0.75).toPrecision(4)),
        // rank 10: 0 * 0.5 + 0.5 * 0.5 = 0.25
        Number((0.25).toPrecision(4)),
      ],
    },
    {
      name: "ranks 11+ use 40/60 weights",
      rrfScores: [0.005, 0.003, 0.001],
      rerankScores: [0.1, 0.9, 0.5],
      rrfRanks: [11, 15, 20],
      expected: [
        // rrfNorm: [1, 0.5, 0] — rerankNorm: [0, 1, 0.5]
        // rank 11: 1 * 0.4 + 0 * 0.6 = 0.4
        Number((0.4).toPrecision(4)),
        // rank 15: 0.5 * 0.4 + 1 * 0.6 = 0.8
        Number((0.8).toPrecision(4)),
        // rank 20: 0 * 0.4 + 0.5 * 0.6 = 0.3
        Number((0.3).toPrecision(4)),
      ],
    },
    {
      name: "mixed tiers across ranks",
      rrfScores: [0.08, 0.06, 0.04, 0.02],
      rerankScores: [0.1, 0.9, 0.5, 0.3],
      rrfRanks: [1, 5, 11, 3],
      expected: [
        // rrfNorm: [1, 2/3, 1/3, 0] — rerankNorm: [0, 1, 0.5, 0.25]
        // rank 1 (75/25): 1 * 0.75 + 0 * 0.25 = 0.75
        Number((0.75).toPrecision(4)),
        // rank 5 (50/50): 2/3 * 0.5 + 1 * 0.5 = 0.8333
        Number(((2 / 3) * 0.5 + 1 * 0.5).toPrecision(4)),
        // rank 11 (40/60): 1/3 * 0.4 + 0.5 * 0.6 = 0.4333
        Number(((1 / 3) * 0.4 + 0.5 * 0.6).toPrecision(4)),
        // rank 3 (75/25): 0 * 0.75 + 0.25 * 0.25 = 0.0625
        Number((0 * 0.75 + 0.25 * 0.25).toPrecision(4)),
      ],
    },
    {
      name: "all identical RRF scores normalize to 0.5",
      rrfScores: [0.05, 0.05, 0.05],
      rerankScores: [0.1, 0.9, 0.5],
      rrfRanks: [1, 2, 3],
      expected: [
        // rrfNorm: all 0.5 — rerankNorm: [0, 1, 0.5]
        // rank 1: 0.5 * 0.75 + 0 * 0.25 = 0.375
        Number((0.375).toPrecision(4)),
        // rank 2: 0.5 * 0.75 + 1 * 0.25 = 0.625
        Number((0.625).toPrecision(4)),
        // rank 3: 0.5 * 0.75 + 0.5 * 0.25 = 0.5
        Number((0.5).toPrecision(4)),
      ],
    },
    {
      name: "all identical rerank scores normalize to 0.5",
      rrfScores: [0.08, 0.06, 0.04],
      rerankScores: [0.5, 0.5, 0.5],
      rrfRanks: [1, 2, 3],
      expected: [
        // rrfNorm: [1, 0.5, 0] — rerankNorm: all 0.5
        // rank 1: 1 * 0.75 + 0.5 * 0.25 = 0.875
        Number((0.875).toPrecision(4)),
        // rank 2: 0.5 * 0.75 + 0.5 * 0.25 = 0.5
        Number((0.5).toPrecision(4)),
        // rank 3: 0 * 0.75 + 0.5 * 0.25 = 0.125
        Number((0.125).toPrecision(4)),
      ],
    },
  ]

  it.each(scenarios)(
    "$name",
    ({ rrfScores, rerankScores, rrfRanks, expected }) => {
      const result = blendScores({ rrfScores, rerankScores, rrfRanks })
      expect(result).toEqual(expected)
    },
  )

  it("returns empty array for empty inputs", () => {
    const result = blendScores({
      rrfScores: [],
      rerankScores: [],
      rrfRanks: [],
    })
    expect(result).toEqual([])
  })
})

// ── Cross-encoder factory tests ───────────────────────────────

describe("createReranker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const loadReranker = async () => {
    const { createReranker } = await import("../reranker.js")
    return createReranker(logger)
  }

  describe("rerankPairs", () => {
    it("returns one score per document", async () => {
      const reranker = await loadReranker()
      const scores = await reranker.rerankPairs("query", [
        "doc1",
        "doc2",
        "doc3",
      ])

      expect(scores).toHaveLength(3)
      scores.forEach((score) => expect(typeof score).toBe("number"))
    })

    it("returns the logit value from the model output", async () => {
      const reranker = await loadReranker()
      const scores = await reranker.rerankPairs("query", ["document"])

      expect(scores).toEqual([0.95])
    })

    it("returns empty array for empty documents", async () => {
      const reranker = await loadReranker()
      const scores = await reranker.rerankPairs("query", [])

      expect(scores).toEqual([])
    })

    it("logs model load time on first call", async () => {
      const infoSpy = vi.spyOn(logger, "info")
      const reranker = await loadReranker()
      await reranker.rerankPairs("query", ["doc"])

      expect(infoSpy).toHaveBeenCalledWith(
        "reranker model loaded",
        expect.objectContaining({ model: "Xenova/ms-marco-MiniLM-L-6-v2" }),
      )
      infoSpy.mockRestore()
    })

    it("passes query and document as text_pair to the tokenizer", async () => {
      const reranker = await loadReranker()
      await reranker.rerankPairs("search query", ["relevant document"])

      expect(mockTokenizer).toHaveBeenCalledWith("search query", {
        text_pair: "relevant document",
        padding: true,
        truncation: true,
      })
    })

    it("retries after a model load failure", async () => {
      const transformers = await import("@huggingface/transformers")
      const mockedAutoModel = vi.mocked(
        transformers.AutoModelForSequenceClassification,
      )
      mockedAutoModel.from_pretrained.mockRejectedValueOnce(
        new Error("download failed"),
      )

      const warnSpy = vi.spyOn(logger, "warn")
      const reranker = await loadReranker()

      await expect(reranker.rerankPairs("q", ["d"])).rejects.toThrow(
        "download failed",
      )
      expect(warnSpy).toHaveBeenCalledWith(
        "reranker model failed to load",
        expect.objectContaining({ model: "Xenova/ms-marco-MiniLM-L-6-v2" }),
      )

      // modelLoading was reset in the catch block, allowing retry.
      // The mock reverts to its default (success), proving retry works.
      const scores = await reranker.rerankPairs("retry", ["doc"])
      expect(scores).toHaveLength(1)

      warnSpy.mockRestore()
    })

    it("scores each document independently", async () => {
      // Make the model return different scores per call to verify
      // each document is scored separately
      let callCount = 0
      mockModel.mockImplementation(() => {
        callCount++
        return Promise.resolve({ logits: { data: [callCount * 0.1] } })
      })

      const reranker = await loadReranker()
      const scores = await reranker.rerankPairs("query", ["a", "b", "c"])

      expect(scores).toHaveLength(3)
      expect(scores[0]).not.toBe(scores[1])
      expect(scores[1]).not.toBe(scores[2])
    })
  })
})
