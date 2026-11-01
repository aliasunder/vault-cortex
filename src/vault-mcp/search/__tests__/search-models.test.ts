import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest"
import { logger } from "../../../logger.js"

// What the transformers.js mock saw: how many times the library was imported,
// the cache folder it holds, and whether setting that folder should fail.
const transformersState = vi.hoisted(() => {
  const state: { imports: number; cacheDir: string; failSetup: boolean } = {
    imports: 0,
    cacheDir: "/library-default-cache/",
    failSetup: false,
  }
  return state
})

vi.mock("@huggingface/transformers", () => {
  transformersState.imports += 1
  return {
    env: {
      get cacheDir(): string {
        return transformersState.cacheDir
      },
      set cacheDir(folder: string) {
        if (transformersState.failSetup) throw new Error("runtime unavailable")
        transformersState.cacheDir = folder
      },
    },
  }
})

const EMBEDDER_API = { embedText: expect.any(Function), embedBatch: expect.any(Function) }
const RERANKER_API = { rerankPairs: expect.any(Function) }

describe("createSearchModels", () => {
  beforeEach(() => {
    // A fresh module registry per test, so each test counts its own library imports.
    vi.resetModules()
    transformersState.imports = 0
    transformersState.cacheDir = "/library-default-cache/"
    transformersState.failSetup = false
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
    expect(transformersState.cacheDir).toBe("/library-default-cache/")
  })

  it("logs a failed model runtime setup and still returns the models", async () => {
    transformersState.failSetup = true
    const errorSpy = vi.spyOn(logger, "error")
    onTestFinished(() => errorSpy.mockRestore())
    const createSearchModels = await loadCreateSearchModels()

    const models = await createSearchModels(
      { embeddingEnabled: true, rerankMode: "blended", modelCacheDir: "/test-data/models" },
      logger,
    )

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      "search model runtime failed to load, falling back to keyword-only search",
      { error: "[Error]: runtime unavailable" },
    )
    expect(models).toEqual({ embedder: EMBEDDER_API, reranker: RERANKER_API })
  })
})
