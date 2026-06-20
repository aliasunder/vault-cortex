import { describe, it, expect } from "vitest"
import { mapWithConcurrency } from "../map-with-concurrency.js"

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of per-item completion order", async () => {
    // Earlier items resolve later, so a result ordered by completion would differ.
    const results = await mapWithConcurrency({
      items: [40, 10, 30, 5],
      concurrency: 4,
      mapper: async (ms) => {
        await delay(ms)
        return ms * 2
      },
    })

    expect(results).toEqual([80, 20, 60, 10])
  })

  it("passes each item to the mapper exactly once", async () => {
    const seen: number[] = []
    await mapWithConcurrency({
      items: [1, 2, 3],
      concurrency: 2,
      mapper: async (item) => {
        seen.push(item)
        return item
      },
    })

    expect(seen.sort()).toEqual([1, 2, 3])
  })

  it("returns an empty array and never calls the mapper for empty input", async () => {
    let callCount = 0
    const results = await mapWithConcurrency({
      items: [],
      concurrency: 3,
      mapper: async (item) => {
        callCount += 1
        return item
      },
    })

    expect(results).toEqual([])
    expect(callCount).toBe(0)
  })

  it("runs every item in a single batch when concurrency exceeds the item count", async () => {
    const results = await mapWithConcurrency({
      items: [1, 2, 3],
      concurrency: 10,
      mapper: async (item) => item * 10,
    })

    expect(results).toEqual([10, 20, 30])
  })

  it("never runs more than `concurrency` mappers at once", async () => {
    // Each mapper records how many are in flight; the peak must equal the cap.
    const inFlight = { current: 0, max: 0 }
    await mapWithConcurrency({
      items: [1, 2, 3, 4, 5, 6],
      concurrency: 2,
      mapper: async (item) => {
        inFlight.current += 1
        inFlight.max = Math.max(inFlight.max, inFlight.current)
        await delay(10)
        inFlight.current -= 1
        return item
      },
    })

    expect(inFlight.max).toBe(2)
  })

  it("waits for a whole batch to finish before starting the next (head-of-line blocking)", async () => {
    // Batch 1 is [slow, fast]; the next batch's item must not start until BOTH
    // finish, even though the fast one in batch 1 completed long before.
    const events: string[] = []
    await mapWithConcurrency({
      items: ["slow", "fast", "next"],
      concurrency: 2,
      mapper: async (label) => {
        events.push(`start:${label}`)
        await delay(label === "slow" ? 40 : 5)
        events.push(`end:${label}`)
        return label
      },
    })

    expect(events).toEqual([
      "start:slow",
      "start:fast",
      "end:fast",
      "end:slow",
      "start:next",
      "end:next",
    ])
  })

  it("rejects and starts no further batch when a mapper rejects", async () => {
    const started: string[] = []
    await expect(
      mapWithConcurrency({
        items: ["ok", "boom", "never"],
        concurrency: 1,
        mapper: async (label) => {
          started.push(label)
          if (label === "boom") throw new Error("mapper failed")
          return label
        },
      }),
    ).rejects.toThrow("mapper failed")

    // "never" is in the batch after "boom", so it must not have started.
    expect(started).toEqual(["ok", "boom"])
  })

  it("rejects when concurrency is not a positive integer", async () => {
    const mapper = async (item: number): Promise<number> => item
    await expect(
      mapWithConcurrency({ items: [1], concurrency: 0, mapper }),
    ).rejects.toThrow("concurrency must be a positive integer, got 0")
    await expect(
      mapWithConcurrency({ items: [1], concurrency: -1, mapper }),
    ).rejects.toThrow("concurrency must be a positive integer, got -1")
    await expect(
      mapWithConcurrency({ items: [1], concurrency: 1.5, mapper }),
    ).rejects.toThrow("concurrency must be a positive integer, got 1.5")
  })
})
