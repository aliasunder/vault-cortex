import { describe, it, expect, vi, beforeEach } from "vitest"
import { contentHash, EMBEDDING_DIMENSIONS } from "../embedder.js"
import { logger } from "../../../logger.js"

const MOCK_EMBEDDING = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.5)

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockImplementation((texts: string | string[]) => {
      const count = Array.isArray(texts) ? texts.length : 1
      const data = new Float32Array(count * EMBEDDING_DIMENSIONS)
      for (let i = 0; i < count * EMBEDDING_DIMENSIONS; i++) {
        data[i] = 0.5
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

      expect(result).toEqual(MOCK_EMBEDDING)
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

      expect(results[0]).toEqual(MOCK_EMBEDDING)
      expect(results[1]).toEqual(MOCK_EMBEDDING)
    })
  })
})

describe("contentHash", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = contentHash("hello world")

    expect(hash).toMatch(/^[a-f0-9]{64}$/)
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
