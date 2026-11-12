type ActivityTracker = {
  /** Runs `work`, counting it as in flight until it settles. */
  track: <T>(work: () => Promise<T>) => Promise<T>
  /** Resolves once no tracked work is in flight, or after `maxWaitMs`,
   *  whichever comes first. */
  waitUntilIdle: (params: { maxWaitMs: number }) => Promise<void>
}

/** Counts async work in flight and lets other code wait until none is
 *  running, up to a deadline. */
export const createActivityTracker = (): ActivityTracker => {
  // Every track call changes the count and every waitUntilIdle call reads it.
  let activeCount = 0
  const idleWaiters = new Set<() => void>()

  const releaseIdleWaiters = (): void => {
    // Each waiter removes itself from the set as it runs, so the loop walks a copy.
    for (const releaseWaiter of [...idleWaiters]) releaseWaiter()
  }

  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    activeCount += 1
    try {
      return await work()
    } finally {
      activeCount -= 1

      if (activeCount === 0) releaseIdleWaiters()
    }
  }

  const waitUntilIdle = (params: { maxWaitMs: number }): Promise<void> => {
    if (activeCount === 0) return Promise.resolve()

    return new Promise((resolve) => {
      // The deadline and the idle release share one waiter, so whichever comes first releases
      // it and the other is cancelled. The timer is unref'd, so a waiter never keeps the
      // process alive at shutdown.
      const deadline = setTimeout(() => releaseWaiter(), params.maxWaitMs).unref()
      const releaseWaiter = (): void => {
        clearTimeout(deadline)
        idleWaiters.delete(releaseWaiter)
        resolve()
      }
      idleWaiters.add(releaseWaiter)
    })
  }

  return { track, waitUntilIdle }
}
