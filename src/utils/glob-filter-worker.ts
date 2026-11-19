/**
 * Worker-thread entry that matches paths against a glob off the main thread.
 * `glob-filter.ts` starts one per call with `{ glob, paths, replyPort }` as
 * `workerData`, and this worker posts `{ matches }` on that port. A throw here
 * reaches `glob-filter.ts` as the worker's error, which fails only that call.
 */
import { MessagePort, workerData } from "node:worker_threads"
import picomatch from "picomatch"

type GlobRequest = { glob: string; paths: readonly string[]; replyPort: MessagePort }

const isGlobRequest = (data: unknown): data is GlobRequest => {
  if (typeof data !== "object" || data === null) return false
  if (!("glob" in data) || typeof data.glob !== "string") return false
  if (!("paths" in data) || !Array.isArray(data.paths)) return false
  if (!data.paths.every((path: unknown) => typeof path === "string")) return false
  return "replyPort" in data && data.replyPort instanceof MessagePort
}

if (!isGlobRequest(workerData))
  throw new Error("glob-filter-worker.ts needs { glob, paths, replyPort }")

const { glob, paths, replyPort } = workerData
const isMatch = picomatch(glob)

// The arrow keeps filter's index argument away from picomatch's second
// parameter, which takes options
replyPort.postMessage({ matches: paths.filter((path) => isMatch(path)) })
