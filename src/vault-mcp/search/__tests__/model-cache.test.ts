import { describe, it, expect, vi } from "vitest"

vi.mock("@huggingface/transformers", () => ({
  env: { cacheDir: "/library-default-cache/" },
}))

describe("setModelCacheDir", () => {
  it("points transformers.js's process-wide cache folder at the given folder", async () => {
    const transformers = await import("@huggingface/transformers")
    const { setModelCacheDir } = await import("../model-cache.js")

    await setModelCacheDir("/test-data/models")

    expect(transformers.env.cacheDir).toBe("/test-data/models")
  })
})
