/**
 * Worker-thread entry that runs `parseBodyTags` off the main thread.
 * `body-tag-parser.ts` starts it and owns its protocol: the worker posts
 * `{ kind: "ready" }` once loaded, then answers each `{ requestId, body }`
 * with the tags or the parser's error message.
 */
import { parentPort } from "node:worker_threads"
import { parseBodyTags } from "../obsidian-markdown/body-tags.js"
import { describeError } from "../../utils/describe-error.js"

type ParseRequest = { requestId: number; body: string }

const isParseRequest = (message: unknown): message is ParseRequest => {
  if (typeof message !== "object" || message === null) return false
  if (!("requestId" in message) || typeof message.requestId !== "number") return false
  return "body" in message && typeof message.body === "string"
}

if (!parentPort) throw new Error("body-tag-worker.ts must run as a worker thread")

const port = parentPort

port.on("message", (message: unknown) => {
  if (!isParseRequest(message)) return

  const { requestId, body } = message

  // A parser throw (a stack overflow on deep nesting, a defect) is reported
  // back, so the host can log it against the note and keep the worker.
  try {
    port.postMessage({ kind: "parsed", requestId, tags: parseBodyTags(body) })
  } catch (error) {
    port.postMessage({ kind: "failed", requestId, reason: describeError(error) })
  }
})

port.postMessage({ kind: "ready" })
