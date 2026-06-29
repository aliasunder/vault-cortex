import { describe, it, expect, vi, beforeEach } from "vitest"
import { contentHash, EMBEDDING_DIMENSIONS } from "../embedder.js"
import { logger } from "../../../logger.js"

// First input gets fill 0.1, second gets 0.2, etc.
const MOCK_EMBEDDING_FIRST = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)

// Each input gets a distinct fill value (0.1 * (inputIndex + 1)) so batch
// slicing can be verified — identical fills would mask offset errors.
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockImplementation((texts: string | string[]) => {
      const count = Array.isArray(texts) ? texts.length : 1
      const data = new Float32Array(count * EMBEDDING_DIMENSIONS)
      for (let inputIndex = 0; inputIndex < count; inputIndex++) {
        const fillValue = 0.1 * (inputIndex + 1)
        for (let dim = 0; dim < EMBEDDING_DIMENSIONS; dim++) {
          data[inputIndex * EMBEDDING_DIMENSIONS + dim] = fillValue
        }
      }
      return Promise.resolve({ data })
    }),
  ),
}))

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

    it("logs model load time on first call", async () => {
      const infoSpy = vi.spyOn(logger, "info")
      const embedder = await loadEmbedder()
      await embedder.embedText("hello")

      expect(infoSpy).toHaveBeenCalledWith(
        "embedding model loaded",
        expect.objectContaining({ model: "Xenova/bge-small-en-v1.5" }),
      )
      infoSpy.mockRestore()
    })

    it("throws a descriptive error when pipeline returns non-Float32Array data", async () => {
      const transformers = await import("@huggingface/transformers")
      const mockedPipeline = vi.mocked(transformers.pipeline)
      // Override the pipeline factory to return a function that produces
      // Float64Array instead of Float32Array — triggers the toFloat32Array guard
      mockedPipeline.mockResolvedValueOnce(
        vi.fn().mockResolvedValue({
          data: new Float64Array(EMBEDDING_DIMENSIONS).fill(0.1),
        }) as ReturnType<typeof mockedPipeline>,
      )

      const embedder = await loadEmbedder()
      await expect(embedder.embedText("test")).rejects.toThrow(
        "expected Float32Array from embedding pipeline",
      )
    })

    it("retries after a pipeline load failure", async () => {
      const transformers = await import("@huggingface/transformers")
      const mockedPipeline = vi.mocked(transformers.pipeline)
      mockedPipeline.mockRejectedValueOnce(new Error("model download failed"))

      const warnSpy = vi.spyOn(logger, "warn")
      const embedder = await loadEmbedder()

      await expect(embedder.embedText("test")).rejects.toThrow(
        "model download failed",
      )
      expect(warnSpy).toHaveBeenCalledWith(
        "embedding model failed to load",
        expect.objectContaining({ model: "Xenova/bge-small-en-v1.5" }),
      )

      // pipelineLoading was reset in the catch block, allowing retry.
      // The pipeline mock reverts to its default (success), proving retry works.
      const result = await embedder.embedText("retry text")
      expect(result).toBeInstanceOf(Float32Array)
      expect(result).toHaveLength(EMBEDDING_DIMENSIONS)

      warnSpy.mockRestore()
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

/** Matches a 64-character lowercase hex string (SHA-256 digest). */
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/

describe("contentHash", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = contentHash("hello world")

    expect(hash).toMatch(SHA256_HEX_REGEX)
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
