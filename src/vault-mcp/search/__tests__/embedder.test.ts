import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest"
import { contentHash, EMBEDDING_DIMENSIONS } from "../embedder.js"
import { logger } from "../../../logger.js"

// First input gets fill 0.1, second gets 0.2, etc.
const MOCK_EMBEDDING_FIRST = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)

// Each input gets a distinct fill value (0.1 * (inputIndex + 1)) so batch
// slicing can be verified — identical fills would mask offset errors.
vi.mock("@huggingface/transformers", () => {
  const embeddingPipe = vi.fn().mockImplementation((texts: string | string[]) => {
    const count = Array.isArray(texts) ? texts.length : 1
    const data = new Float32Array(count * EMBEDDING_DIMENSIONS)
    for (let inputIndex = 0; inputIndex < count; inputIndex++) {
      const fillValue = 0.1 * (inputIndex + 1)
      for (let dim = 0; dim < EMBEDDING_DIMENSIONS; dim++) {
        data[inputIndex * EMBEDDING_DIMENSIONS + dim] = fillValue
      }
    }
    return Promise.resolve({ data })
  })

  return { pipeline: vi.fn().mockResolvedValue(embeddingPipe) }
})

describe("createEmbedder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Import inside the test so the mock is active
  const loadEmbedder = async () => {
    const { createEmbedder } = await import("../embedder.js")
    return createEmbedder(logger)
  }

  describe("embedText", () => {
    it("returns a Float32Array with the correct dimensions", async () => {
      const embedder = await loadEmbedder()
      const result = await embedder.embedText("hello world")

      expect(result).toBeInstanceOf(Float32Array)
      expect(result).toHaveLength(EMBEDDING_DIMENSIONS)
    })

    it("returns the embedding values from the pipeline", async () => {
      const embedder = await loadEmbedder()
      const result = await embedder.embedText("hello world")

      expect(result).toEqual(MOCK_EMBEDDING_FIRST)
    })

    it("logs model load time on first call only", async () => {
      const infoSpy = vi.spyOn(logger, "info")
      onTestFinished(() => infoSpy.mockRestore())
      const embedder = await loadEmbedder()
      await embedder.embedText("hello")
      await embedder.embedText("again")

      expect(infoSpy).toHaveBeenCalledTimes(1)
      expect(infoSpy).toHaveBeenCalledWith(
        "embedding model loaded",
        // The load time varies run to run; its presence and type are the contract.
        { model: "Xenova/bge-small-en-v1.5", elapsedMs: expect.any(Number) },
      )
    })

    it("pins ONNX to single-threaded execution to prevent CPU saturation", async () => {
      const transformers = await import("@huggingface/transformers")
      const mockedPipeline = vi.mocked(transformers.pipeline)

      const embedder = await loadEmbedder()
      await embedder.embedText("trigger load")

      expect(mockedPipeline).toHaveBeenCalledTimes(1)
      expect(mockedPipeline).toHaveBeenCalledWith(
        "feature-extraction",
        "Xenova/bge-small-en-v1.5",
        {
          dtype: "q8",
          session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
        },
      )
    })

    it("throws a descriptive error when pipeline returns non-Float32Array data", async () => {
      const transformers = await import("@huggingface/transformers")
      const mockedPipeline = vi.mocked(transformers.pipeline)
      // A pipeline that returns Float64Array data trips the toFloat32Array guard.
      // vi.fn() can't satisfy the pipeline's 24-member union type, so cast through unknown.
      const badPipeline = vi.fn().mockResolvedValue({
        data: new Float64Array(EMBEDDING_DIMENSIONS).fill(0.1),
      }) as unknown as Awaited<ReturnType<typeof mockedPipeline>>
      mockedPipeline.mockResolvedValueOnce(badPipeline)

      const embedder = await loadEmbedder()
      await expect(embedder.embedText("test")).rejects.toThrow(
        new Error("expected Float32Array from embedding pipeline, got Float64Array"),
      )
    })

    it("retries after a pipeline load failure", async () => {
      const transformers = await import("@huggingface/transformers")
      const mockedPipeline = vi.mocked(transformers.pipeline)
      mockedPipeline.mockRejectedValueOnce(new Error("model download failed"))

      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())
      const embedder = await loadEmbedder()

      await expect(embedder.embedText("test")).rejects.toThrow(new Error("model download failed"))
      expect(warnSpy).toHaveBeenCalledWith("embedding model failed to load", {
        model: "Xenova/bge-small-en-v1.5",
        error: "[Error]: model download failed",
      })

      // pipelineLoading was reset in the catch block, allowing retry.
      // The pipeline mock reverts to its default (success), proving retry works.
      const result = await embedder.embedText("retry text")
      expect(result).toEqual(MOCK_EMBEDDING_FIRST)
    })
  })

  describe("embedBatch", () => {
    it("returns one Float32Array per input text", async () => {
      const embedder = await loadEmbedder()
      const results = await embedder.embedBatch(["hello", "world", "test"])

      expect(results).toHaveLength(3)
      for (const result of results) {
        expect(result).toBeInstanceOf(Float32Array)
        expect(result).toHaveLength(EMBEDDING_DIMENSIONS)
      }
    })

    it("returns an empty array for empty input", async () => {
      const embedder = await loadEmbedder()
      const results = await embedder.embedBatch([])

      expect(results).toEqual([])
    })

    it("slices the pipeline output correctly per input", async () => {
      const embedder = await loadEmbedder()
      const results = await embedder.embedBatch(["a", "b"])

      expect(results).toEqual([
        new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1),
        new Float32Array(EMBEDDING_DIMENSIONS).fill(0.2),
      ])
    })
  })
})

describe("contentHash", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = contentHash("hello world")

    // The published SHA-256 digest of "hello world".
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
  })

  it("returns the same hash for the same input", () => {
    const hash1 = contentHash("test content")
    const hash2 = contentHash("test content")

    expect(hash1).toBe(hash2)
  })

  it("returns different hashes for different input", () => {
    const hash1 = contentHash("content a")
    const hash2 = contentHash("content b")

    expect(hash1).not.toBe(hash2)
  })
})

describe("EMBEDDING_DIMENSIONS", () => {
  it("is 384 (bge-small-en-v1.5 output dimension)", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384)
  })
})
