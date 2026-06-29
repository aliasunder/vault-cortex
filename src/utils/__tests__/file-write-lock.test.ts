import { describe, it, expect } from "vitest"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { withFileLock } from "../file-write-lock.js"

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

describe("withFileLock", () => {
  const testDir = join(
    import.meta.dirname,
    "__fixtures__",
    `file-write-lock-${randomUUID()}`,
  )

  const counterPath = join(testDir, "counter.txt")

  const setup = async (): Promise<void> => {
    await mkdir(testDir, { recursive: true })
  }

  const teardown = async (): Promise<void> => {
    await rm(testDir, { recursive: true, force: true })
  }

  it("serializes concurrent operations on the same key", async () => {
    await setup()
    try {
      await writeFile(counterPath, "0", "utf8")

      // Without serialization, all 5 would read "0", increment to "1", and
      // write "1" — last write wins, final value is 1. With the lock, each
      // reads the previous write's result, so the final value is 5.
      await Promise.all(
        Array.from({ length: 5 }, () =>
          withFileLock(counterPath, async () => {
            const current = Number(await readFile(counterPath, "utf8"))
            await writeFile(counterPath, String(current + 1), "utf8")
          }),
        ),
      )

      const finalValue = await readFile(counterPath, "utf8")
      expect(finalValue).toBe("5")
    } finally {
      await teardown()
    }
  })

  it("allows concurrent operations on different keys", async () => {
    await setup()
    try {
      const pathA = join(testDir, "a.txt")
      const pathB = join(testDir, "b.txt")
      await writeFile(pathA, "0", "utf8")
      await writeFile(pathB, "0", "utf8")

      await Promise.all([
        withFileLock(pathA, async () => {
          await delay(20)
          await writeFile(pathA, "done-a", "utf8")
        }),
        withFileLock(pathB, async () => {
          await delay(20)
          await writeFile(pathB, "done-b", "utf8")
        }),
      ])

      expect(await readFile(pathA, "utf8")).toBe("done-a")
      expect(await readFile(pathB, "utf8")).toBe("done-b")
    } finally {
      await teardown()
    }
  })

  it("does not block subsequent operations when one fails", async () => {
    const key = join(testDir, "fail-then-succeed")

    const failedWrite = withFileLock(key, async () => {
      throw new Error("intentional failure")
    })
    await expect(failedWrite).rejects.toThrow("intentional failure")

    const result = await withFileLock(key, async () => "recovered")
    expect(result).toBe("recovered")
  })

  it("propagates the operation error to the caller", async () => {
    const key = join(testDir, "propagate-error")

    const promise = withFileLock(key, async () => {
      throw new Error("operation failed")
    })

    await expect(promise).rejects.toThrow("operation failed")
  })

  it("returns the operation result", async () => {
    const key = join(testDir, "return-value")

    const result = await withFileLock(key, async () => 42)
    expect(result).toBe(42)
  })

  it("preserves operation order for the same key", async () => {
    const executionOrder: number[] = []

    // Queue 3 operations with decreasing delays: op1 sleeps 20ms, op2 sleeps
    // 10ms, op3 sleeps 0ms. Without serialization all three start immediately,
    // so op3 finishes first → [3, 2, 1]. With the lock each runs in queue
    // order, so the result is always [1, 2, 3].
    const operations = [1, 2, 3].map((order) =>
      withFileLock("order-test", async () => {
        await delay((3 - order) * 10)
        executionOrder.push(order)
      }),
    )

    await Promise.all(operations)
    expect(executionOrder).toEqual([1, 2, 3])
  })

  it("canonicalizes paths so equivalent paths with different segments share the same lock", async () => {
    await setup()
    try {
      await writeFile(counterPath, "0", "utf8")

      // Build a string-different path that resolves to the same file:
      // "/dir/phantom/../counter.txt" vs "/dir/counter.txt".
      // resolve() in withFileLock must collapse them to the same lock
      // key, otherwise the two operations race and the final value would
      // be "1" instead of "2".
      const redundantPath = `${testDir}/phantom/../counter.txt`

      await Promise.all([
        withFileLock(redundantPath, async () => {
          const current = Number(await readFile(counterPath, "utf8"))
          await writeFile(counterPath, String(current + 1), "utf8")
        }),
        withFileLock(counterPath, async () => {
          const current = Number(await readFile(counterPath, "utf8"))
          await writeFile(counterPath, String(current + 1), "utf8")
        }),
      ])

      const finalValue = await readFile(counterPath, "utf8")
      expect(finalValue).toBe("2")
    } finally {
      await teardown()
    }
  })
})
