import { setTimeout as sleep } from "node:timers/promises"
import { Worker } from "node:worker_threads"
import { onTestFinished } from "vitest"

/** What a measured worker posts: "ready" once its input is built, then "done"
 *  once its operation returns. Either may carry numbers about the input or the
 *  result. */
type HeapWorkerMessage = { status: "ready" | "done"; [detail: string]: unknown }

const isHeapWorkerMessage = (message: unknown): message is HeapWorkerMessage => {
  return typeof message === "object" && message !== null && "status" in message
}

/** The number a worker's message carries under `key`. */
export const readNumberDetail = (message: HeapWorkerMessage, key: string): number => {
  const value = message[key]

  if (typeof value !== "number") throw new Error(`the worker's message has no number ${key}`)
  return value
}

/** Starts the worker, waits for its "ready", tells it "go" and samples its heap
 *  until it posts "done". Returns the peak growth over the heap it held when
 *  ready, with both messages. getHeapStatistics reads a worker's heap while it
 *  runs a synchronous call, and its external memory counts typed arrays and
 *  buffers. */
export const measureWorkerHeapGrowth = async (params: {
  workerUrl: URL
  workerData: unknown
}): Promise<{ peakGrowth: number; ready: HeapWorkerMessage; done: HeapWorkerMessage }> => {
  const worker = new Worker(params.workerUrl, {
    workerData: params.workerData,
    execArgv: ["--import", "tsx"],
  })
  onTestFinished(async () => {
    await worker.terminate()
  })

  const nextMessage = (): Promise<HeapWorkerMessage> => {
    return new Promise((resolve, reject) => {
      worker.once("error", reject)
      worker.once("message", (message: unknown) => {
        if (isHeapWorkerMessage(message)) resolve(message)
        else reject(new Error(`unexpected worker message: ${JSON.stringify(message)}`))
      })
    })
  }
  const sampleHeap = async (): Promise<number> => {
    const { used_heap_size, external_memory } = await worker.getHeapStatistics()
    return used_heap_size + external_memory
  }

  const ready = await nextMessage()

  if (ready.status !== "ready") throw new Error("the worker ran before it was ready")

  const baseline = await sampleHeap()
  const operated = nextMessage()
  // The sampling loop stops once the worker reports the operation's result.
  let operationFinished = false
  const finishedOperation = operated.finally(() => {
    operationFinished = true
  })
  const samples: number[] = []

  worker.postMessage("go")
  // Each sample leaves garbage in the worker's heap, and back-to-back
  // samples add up to about 1 MB of it to the peak.
  while (!operationFinished) {
    samples.push(await sampleHeap())
    await sleep(1)
  }

  const done = await finishedOperation

  if (done.status !== "done") throw new Error("the worker reported ready twice")
  return { peakGrowth: Math.max(baseline, ...samples) - baseline, ready, done }
}
