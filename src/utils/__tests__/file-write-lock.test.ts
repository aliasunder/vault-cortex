import { describe, it, expect, onTestFinished } from "vitest"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  withFileLock,
  withExclusiveFileLock,
  withExclusiveMultiFileLock,
} from "../file-write-lock.js"

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

describe("withExclusiveFileLock", () => {
  const testDir = join(
    import.meta.dirname,
    "__fixtures__",
    `exclusive-lock-${randomUUID()}`,
  )

  it("rejects immediately when a write is already in progress on the same file", async () => {
    const filePath = join(testDir, "busy.txt")

    // Hold the lock for 50ms so the second call arrives while it's held.
    const firstWrite = withExclusiveFileLock(filePath, async () => {
      await delay(50)
      return "first"
    })

    // The second call should throw synchronously — no waiting.
    expect(() => withExclusiveFileLock(filePath, async () => "second")).toThrow(
      "concurrent write in progress",
    )

    // The first write should still complete successfully.
    const result = await firstWrite
    expect(result).toBe("first")
  })

  it("allows a write after the previous one completes", async () => {
    const filePath = join(testDir, "sequential.txt")

    const first = await withExclusiveFileLock(filePath, async () => "first")
    expect(first).toBe("first")

    const second = await withExclusiveFileLock(filePath, async () => "second")
    expect(second).toBe("second")
  })

  it("allows concurrent writes to different files", async () => {
    const pathA = join(testDir, "a.txt")
    const pathB = join(testDir, "b.txt")

    const [resultA, resultB] = await Promise.all([
      withExclusiveFileLock(pathA, async () => {
        await delay(20)
        return "a"
      }),
      withExclusiveFileLock(pathB, async () => {
        await delay(20)
        return "b"
      }),
    ])

    expect(resultA).toBe("a")
    expect(resultB).toBe("b")
  })

  it("releases the lock when the operation fails", async () => {
    const filePath = join(testDir, "fail-release.txt")

    await expect(
      withExclusiveFileLock(filePath, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    // Lock should be released — a new write should succeed.
    const result = await withExclusiveFileLock(
      filePath,
      async () => "recovered",
    )
    expect(result).toBe("recovered")
  })

  it("returns the operation result", async () => {
    const filePath = join(testDir, "result.txt")
    const result = await withExclusiveFileLock(filePath, async () => 42)
    expect(result).toBe(42)
  })

  it("canonicalizes paths so equivalent paths share the same lock", async () => {
    const filePath = join(testDir, "canon.txt")
    const redundantPath = `${testDir}/phantom/../canon.txt`

    const firstWrite = withExclusiveFileLock(filePath, async () => {
      await delay(50)
      return "first"
    })

    // The redundant path resolves to the same file — should fail.
    expect(() =>
      withExclusiveFileLock(redundantPath, async () => "second"),
    ).toThrow("concurrent write in progress")

    await firstWrite
  })
})

describe("withExclusiveMultiFileLock", () => {
  const testDir = join(
    import.meta.dirname,
    "__fixtures__",
    `multi-lock-${randomUUID()}`,
  )

  it("locks every path for the duration of the operation", async () => {
    const pathA = join(testDir, "a.txt")
    const pathB = join(testDir, "b.txt")

    const multiWrite = withExclusiveMultiFileLock([pathA, pathB], async () => {
      await delay(50)
      return "multi"
    })

    expect(() => withExclusiveFileLock(pathA, async () => "a")).toThrow(
      "concurrent write in progress",
    )
    expect(() => withExclusiveFileLock(pathB, async () => "b")).toThrow(
      "concurrent write in progress",
    )

    expect(await multiWrite).toBe("multi")
  })

  it("rejects without locking anything when any path is already busy", async () => {
    const busyPath = join(testDir, "busy.txt")
    const freePath = join(testDir, "free.txt")

    const holdBusyPath = withExclusiveFileLock(busyPath, async () => {
      await delay(50)
      return "busy"
    })

    expect(() =>
      withExclusiveMultiFileLock([freePath, busyPath], async () => "multi"),
    ).toThrow("concurrent write in progress")

    // All-or-nothing: the failed acquisition must not have locked freePath.
    const freeResult = await withExclusiveFileLock(
      freePath,
      async () => "still free",
    )
    expect(freeResult).toBe("still free")

    expect(await holdBusyPath).toBe("busy")
  })

  it("releases every path when the operation completes", async () => {
    const pathA = join(testDir, "release-a.txt")
    const pathB = join(testDir, "release-b.txt")

    const multiWrite = withExclusiveMultiFileLock(
      [pathA, pathB],
      async () => "first",
    )
    // Prove the locks were actually acquired — otherwise "released after" would
    // pass vacuously if the lock never registered anything.
    expect(() => withExclusiveFileLock(pathA, async () => "held")).toThrow(
      "concurrent write in progress",
    )
    expect(await multiWrite).toBe("first")

    expect(await withExclusiveFileLock(pathA, async () => "a")).toBe("a")
    expect(await withExclusiveFileLock(pathB, async () => "b")).toBe("b")
  })

  it("releases every path when the operation fails", async () => {
    const pathA = join(testDir, "fail-a.txt")
    const pathB = join(testDir, "fail-b.txt")

    const multiWrite = withExclusiveMultiFileLock([pathA, pathB], async () => {
      throw new Error("boom")
    })
    // Prove the locks were actually acquired before the operation rejected —
    // the operation is deferred to a microtask, so this synchronous check runs
    // while the locks are still held.
    expect(() => withExclusiveFileLock(pathA, async () => "held")).toThrow(
      "concurrent write in progress",
    )
    await expect(multiWrite).rejects.toThrow("boom")

    expect(await withExclusiveFileLock(pathA, async () => "a")).toBe("a")
    expect(await withExclusiveFileLock(pathB, async () => "b")).toBe("b")
  })

  it("rejects an overlapping multi-file lock and allows a disjoint one", async () => {
    const pathA = join(testDir, "overlap-a.txt")
    const pathB = join(testDir, "overlap-b.txt")
    const pathC = join(testDir, "overlap-c.txt")
    const pathD = join(testDir, "overlap-d.txt")

    const multiWrite = withExclusiveMultiFileLock([pathA, pathB], async () => {
      await delay(50)
      return "first"
    })

    // [pathB, pathC] shares pathB with the in-flight lock — rejected.
    expect(() =>
      withExclusiveMultiFileLock([pathB, pathC], async () => "overlap"),
    ).toThrow("concurrent write in progress")

    // [pathC, pathD] shares nothing — runs concurrently.
    const disjointResult = await withExclusiveMultiFileLock(
      [pathC, pathD],
      async () => "disjoint",
    )
    expect(disjointResult).toBe("disjoint")

    expect(await multiWrite).toBe("first")
  })

  it("rejects when a serializing lock is in flight on any member path", async () => {
    const memberPath = join(testDir, "serialized-member.txt")
    const otherPath = join(testDir, "serialized-other.txt")

    const serializingWrite = withFileLock(memberPath, async () => {
      await delay(50)
      return "serialized"
    })

    expect(() =>
      withExclusiveMultiFileLock([otherPath, memberPath], async () => "multi"),
    ).toThrow("concurrent write in progress")

    expect(await serializingWrite).toBe("serialized")
  })

  it("queues a serializing lock behind the multi-file lock on a member path", async () => {
    const fixtureDir = join(
      import.meta.dirname,
      "__fixtures__",
      `multi-queue-${randomUUID()}`,
    )
    await mkdir(fixtureDir, { recursive: true })
    onTestFinished(async () => {
      await rm(fixtureDir, { recursive: true, force: true })
    })

    const counterPath = join(fixtureDir, "counter.txt")
    const otherPath = join(fixtureDir, "other.txt")
    await writeFile(counterPath, "0", "utf8")

    // The delay makes a lost update detectable: without queueing, the
    // serializing write would read "0" while the multi write is still
    // sleeping, and the final value would be "1" instead of "2".
    const multiWrite = withExclusiveMultiFileLock(
      [counterPath, otherPath],
      async () => {
        const current = Number(await readFile(counterPath, "utf8"))
        await delay(20)
        await writeFile(counterPath, String(current + 1), "utf8")
      },
    )
    const serializingWrite = withFileLock(counterPath, async () => {
      const current = Number(await readFile(counterPath, "utf8"))
      await writeFile(counterPath, String(current + 1), "utf8")
    })

    await Promise.all([multiWrite, serializingWrite])

    expect(await readFile(counterPath, "utf8")).toBe("2")
  })

  it("collapses duplicate and equivalent paths to a single lock", async () => {
    const canonicalPath = join(testDir, "canon.txt")
    const redundantPath = `${testDir}/phantom/../canon.txt`

    // Duplicate redundant forms of the same file must not self-conflict…
    // Only redundant forms go in the list, so the canonical-form check below
    // can pass only if the lock canonicalized them — not because the canonical
    // path was locked literally.
    const multiWrite = withExclusiveMultiFileLock(
      [redundantPath, redundantPath],
      async () => {
        await delay(50)
        return "ran"
      },
    )

    // …and while held, the canonical form is locked.
    expect(() =>
      withExclusiveFileLock(canonicalPath, async () => "second"),
    ).toThrow("concurrent write in progress")

    expect(await multiWrite).toBe("ran")
  })

  it("returns the operation result", async () => {
    const pathA = join(testDir, "result-a.txt")
    const pathB = join(testDir, "result-b.txt")

    const result = await withExclusiveMultiFileLock(
      [pathA, pathB],
      async () => 42,
    )
    expect(result).toBe(42)
  })

  it("registers every lock before the operation's first statement runs", async () => {
    const filePath = join(testDir, "pre-registered.txt")
    const operationEvents: string[] = []

    const multiWrite = withExclusiveMultiFileLock([filePath], async () => {
      operationEvents.push("operation started")
      return "done"
    })

    // Synchronously after invocation the lock must already be held while the
    // operation body has not run — if the operation started before its keys
    // registered, its synchronous prefix could re-enter another lock helper
    // on the same paths and observe them as unlocked.
    expect(() => withExclusiveFileLock(filePath, async () => "x")).toThrow(
      "concurrent write in progress",
    )
    expect(operationEvents).toEqual([])

    expect(await multiWrite).toBe("done")
    expect(operationEvents).toEqual(["operation started"])
  })
})

describe("cross-mode interaction", () => {
  const testDir = join(
    import.meta.dirname,
    "__fixtures__",
    `cross-mode-${randomUUID()}`,
  )

  it("exclusive lock rejects when a serializing lock is held on the same file", async () => {
    const filePath = join(testDir, "cross.txt")

    const serializingWrite = withFileLock(filePath, async () => {
      await delay(50)
      return "serialized"
    })

    // Exclusive call should see the serializing lock and reject.
    expect(() =>
      withExclusiveFileLock(filePath, async () => "exclusive"),
    ).toThrow("concurrent write in progress")

    await serializingWrite
  })

  it("serializing lock queues behind an exclusive lock on the same file", async () => {
    const fixtureDir = join(
      import.meta.dirname,
      "__fixtures__",
      `cross-queue-${randomUUID()}`,
    )
    await mkdir(fixtureDir, { recursive: true })
    onTestFinished(async () => {
      await rm(fixtureDir, { recursive: true, force: true })
    })

    const counterPath = join(fixtureDir, "cross-queue.txt")
    await writeFile(counterPath, "0", "utf8")

    const filePath = join(fixtureDir, "cross-queue.txt")

    const exclusiveWrite = withExclusiveFileLock(filePath, async () => {
      const current = Number(await readFile(counterPath, "utf8"))
      await writeFile(counterPath, String(current + 1), "utf8")
    })

    // Serializing call should queue behind the exclusive lock and run after.
    const serializingWrite = withFileLock(filePath, async () => {
      const current = Number(await readFile(counterPath, "utf8"))
      await writeFile(counterPath, String(current + 1), "utf8")
    })

    await Promise.all([exclusiveWrite, serializingWrite])

    const finalValue = await readFile(counterPath, "utf8")
    expect(finalValue).toBe("2")
  })
})
