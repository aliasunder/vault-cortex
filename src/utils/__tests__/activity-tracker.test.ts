import { afterEach, describe, expect, it, vi } from "vitest"
import { createActivityTracker } from "../activity-tracker.js"

/** A deadline far beyond any test's runtime, so only the count can release a waiter */
const NEVER_EXPIRES_MS = 60_000

/** Settles every pending promise callback before the test reads a waiter's state */
const flushPendingCallbacks = (): Promise<void> => {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Reports whether a promise has resolved, without waiting for it */
const watchSettlement = (promise: Promise<void>): (() => boolean) => {
  // Set by the callback below; the test reads it without awaiting the promise
  let settled = false
  // .then observes the promise without making the test wait on it
  void promise.then(() => {
    settled = true
  })
  return () => settled
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createActivityTracker", () => {
  it("resolves whenIdle at once when nothing is tracked", async () => {
    const tracker = createActivityTracker()

    const isIdle = watchSettlement(tracker.whenIdle({ maxWaitMs: NEVER_EXPIRES_MS }))
    await flushPendingCallbacks()

    expect(isIdle()).toBe(true)
  })

  it("keeps a waiter pending until the tracked work settles", async () => {
    const tracker = createActivityTracker()
    const work = Promise.withResolvers<string>()

    const trackedResult = tracker.track(() => work.promise)
    const isIdle = watchSettlement(tracker.whenIdle({ maxWaitMs: NEVER_EXPIRES_MS }))
    await flushPendingCallbacks()

    expect(isIdle()).toBe(false)

    work.resolve("done")

    expect(await trackedResult).toBe("done")
    await flushPendingCallbacks()
    expect(isIdle()).toBe(true)
  })

  it("keeps a waiter pending until every overlapping call settles", async () => {
    const tracker = createActivityTracker()
    const firstWork = Promise.withResolvers<undefined>()
    const secondWork = Promise.withResolvers<undefined>()

    const firstCall = tracker.track(() => firstWork.promise)
    const secondCall = tracker.track(() => secondWork.promise)
    const isIdle = watchSettlement(tracker.whenIdle({ maxWaitMs: NEVER_EXPIRES_MS }))

    firstWork.resolve(undefined)
    await firstCall
    await flushPendingCallbacks()

    expect(isIdle()).toBe(false)

    secondWork.resolve(undefined)
    await secondCall
    await flushPendingCallbacks()

    expect(isIdle()).toBe(true)
  })

  it("rethrows a rejected call and still releases the waiter", async () => {
    const tracker = createActivityTracker()
    const work = Promise.withResolvers<undefined>()

    const trackedResult = tracker.track(() => work.promise)
    const isIdle = watchSettlement(tracker.whenIdle({ maxWaitMs: NEVER_EXPIRES_MS }))
    work.reject(new Error("handler failed"))

    await expect(trackedResult).rejects.toThrow(new Error("handler failed"))
    await flushPendingCallbacks()
    expect(isIdle()).toBe(true)
  })

  it("resolves a waiter at maxWaitMs while tracked work is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const tracker = createActivityTracker()
    const work = Promise.withResolvers<undefined>()

    void tracker.track(() => work.promise)
    const isIdle = watchSettlement(tracker.whenIdle({ maxWaitMs: 5000 }))

    await vi.advanceTimersByTimeAsync(4999)
    expect(isIdle()).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(isIdle()).toBe(true)

    work.resolve(undefined)
  })

  it("lets a later waiter wait again after an earlier one timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const tracker = createActivityTracker()
    const work = Promise.withResolvers<undefined>()

    const trackedResult = tracker.track(() => work.promise)
    const earlierWaiter = tracker.whenIdle({ maxWaitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await earlierWaiter
    const isLaterWaiterIdle = watchSettlement(tracker.whenIdle({ maxWaitMs: NEVER_EXPIRES_MS }))
    await vi.advanceTimersByTimeAsync(0)

    expect(isLaterWaiterIdle()).toBe(false)

    work.resolve(undefined)
    await trackedResult
    await vi.advanceTimersByTimeAsync(0)
    expect(isLaterWaiterIdle()).toBe(true)
  })
})
