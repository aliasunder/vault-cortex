/** Counts async work in flight and lets other code wait until none is
 *  running, up to a deadline. */

type ActivityTracker = {
  /** Runs `work`, counting it as in flight until it settles. */
  track: <T>(work: () => Promise<T>) => Promise<T>
  /** Resolves once no tracked work is in flight, or after `maxWaitMs`,
   *  whichever comes first. */
  whenIdle: (params: { maxWaitMs: number }) => Promise<void>
}

export const createActivityTracker = (): ActivityTracker => {
  // Every track call changes the count and every whenIdle call reads it
  let activeCount = 0
  const idleWaiters = new Set<() => void>()

  const releaseIdleWaiters = (): void => {
    for (const releaseWaiter of idleWaiters) releaseWaiter()
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

  const whenIdle = (params: { maxWaitMs: number }): Promise<void> => {
    if (activeCount === 0) return Promise.resolve()

    return new Promise((resolve) => {
      const releaseWaiter = (): void => {
        clearTimeout(deadline)
        idleWaiters.delete(releaseWaiter)
        resolve()
      }
      // Unref'd, so a waiter never keeps the process alive at shutdown
      const deadline = setTimeout(releaseWaiter, params.maxWaitMs).unref()
      idleWaiters.add(releaseWaiter)
    })
  }

  return { track, whenIdle }
}
