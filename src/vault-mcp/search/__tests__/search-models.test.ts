import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest"
import { logger } from "../../../logger.js"

const LIBRARY_DEFAULT_CACHE_DIR = "/library-default-cache/"

// What the transformers.js mock saw: how many times the library was imported,
// and the cache folder it holds.
const transformersState = { imports: 0, cacheDir: LIBRARY_DEFAULT_CACHE_DIR }

const mockTransformers = () => {
  transformersState.imports += 1

  return {
    env: {
      get cacheDir(): string {
        return transformersState.cacheDir
      },
      set cacheDir(folder: string) {
        transformersState.cacheDir = folder
      },
    },
  }
}

const EMBEDDER_API = { embedText: expect.any(Function), embedBatch: expect.any(Function) }
const RERANKER_API = { rerankPairs: expect.any(Function) }

describe("createSearchModels", () => {
  beforeEach(() => {
    vi.resetModules()
    transformersState.imports = 0
    transformersState.cacheDir = LIBRARY_DEFAULT_CACHE_DIR
    // vi.resetModules keeps a mocked module's first result, so the mock is registered again
    // per test. Otherwise only the file's first test would count its library import.
    vi.doMock("@huggingface/transformers", mockTransformers)
  })

  const loadCreateSearchModels = async () => {
    const { createSearchModels } = await import("../search-models.js")
    return createSearchModels
  }

  it("points transformers.js's cache folder at the given folder before returning the models", async () => {
    const createSearchModels = await loadCreateSearchModels()

    const models = await createSearchModels(
      { embeddingEnabled: true, rerankMode: "blended", modelCacheDir: "/test-data/models" },
      logger,
    )

    expect(transformersState.cacheDir).toBe("/test-data/models")
    expect(transformersState.imports).toBe(1)
    expect(models).toEqual({ embedder: EMBEDDER_API, reranker: RERANKER_API })
  })

  it("builds no reranker when the rerank mode is none", async () => {
    const createSearchModels = await loadCreateSearchModels()

    const models = await createSearchModels(
      { embeddingEnabled: true, rerankMode: "none", modelCacheDir: "/test-data/models" },
      logger,
    )

    expect(models).toEqual({ embedder: EMBEDDER_API, reranker: undefined })
  })

  it("imports nothing and builds no models with embeddings off", async () => {
    const createSearchModels = await loadCreateSearchModels()

    const models = await createSearchModels(
      { embeddingEnabled: false, rerankMode: "blended", modelCacheDir: "/test-data/models" },
      logger,
    )

    expect(models).toEqual({ embedder: undefined, reranker: undefined })
    expect(transformersState.imports).toBe(0)
    expect(transformersState.cacheDir).toBe(LIBRARY_DEFAULT_CACHE_DIR)
  })

  it("logs a failed model runtime import and still returns the models", async () => {
    // Importing the library fails the way it does when the ONNX runtime can't load.
    vi.doMock("@huggingface/transformers", () => {
      transformersState.imports += 1
      throw new Error("runtime unavailable")
    })
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    onTestFinished(() => errorSpy.mockRestore())
    const createSearchModels = await loadCreateSearchModels()

    const models = await createSearchModels(
      { embeddingEnabled: true, rerankMode: "blended", modelCacheDir: "/test-data/models" },
      logger,
    )

    expect(transformersState.imports).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    // Vitest wraps an error thrown by a mock factory in its own error, whose text it owns.
    expect(errorSpy).toHaveBeenCalledWith(
      "search model runtime failed to load, falling back to keyword-only search",
      {
        error: expect.stringMatching(
          /^\[Error\]: \[vitest\] There was an error when mocking a module\./,
        ),
      },
    )
    expect(models).toEqual({ embedder: EMBEDDER_API, reranker: RERANKER_API })
  })
})
