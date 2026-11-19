import { describe, expect, it, onTestFinished, vi } from "vitest"

import { createLogLineRoutingWrite } from "./helpers/route-log-lines-to-console.js"

type WriteCallback = (error?: Error | null) => void

/** A line in the shape src/logger.ts writes, trailing newline included. */
const LOG_LINE = '{"timestamp":"2026-11-12T21:00:00.000-05:00","level":"info","message":"probe"}\n'

/** LOG_LINE as the console receives it. */
const ROUTED_LOG_LINE =
  '{"timestamp":"2026-11-12T21:00:00.000-05:00","level":"info","message":"probe"}'

const writeCallback: WriteCallback = () => undefined

const createRoutingWrite = () => {
  // The stub returns false, which a real stream returns when the caller should
  // wait, so a wrapper that returns true instead of the stream's result fails.
  const streamWrite = vi.fn<(...writeArgs: unknown[]) => boolean>(() => false)
  const logToConsole = vi.fn<(line: string) => void>()
  const routingWrite = createLogLineRoutingWrite({ write: streamWrite }, logToConsole)

  return { streamWrite, logToConsole, routingWrite }
}

describe("createLogLineRoutingWrite", () => {
  it("sends a log line to the console without its trailing newline and never to the stream", () => {
    const { streamWrite, logToConsole, routingWrite } = createRoutingWrite()

    expect(routingWrite(LOG_LINE)).toBe(true)
    expect(logToConsole).toHaveBeenCalledTimes(1)
    expect(logToConsole).toHaveBeenCalledWith(ROUTED_LOG_LINE)
    expect(streamWrite).not.toHaveBeenCalled()
  })

  type PassThroughCase = {
    label: string
    chunk: Uint8Array | string
    encodingOrCallback?: BufferEncoding | WriteCallback
    callback?: WriteCallback
    expectedStreamArgs: ReadonlyArray<unknown>
  }

  const passThroughCases: ReadonlyArray<PassThroughCase> = [
    {
      label: "text that does not open with a timestamp field",
      chunk: "plain output\n",
      expectedStreamArgs: ["plain output\n", undefined, undefined],
    },
    {
      label: "a log line written as bytes",
      chunk: Buffer.from(LOG_LINE),
      expectedStreamArgs: [Buffer.from(LOG_LINE), undefined, undefined],
    },
    {
      label: "a log line with an encoding",
      chunk: LOG_LINE,
      encodingOrCallback: "utf8",
      expectedStreamArgs: [LOG_LINE, "utf8", undefined],
    },
    {
      label: "a log line with a callback in second place",
      chunk: LOG_LINE,
      encodingOrCallback: writeCallback,
      expectedStreamArgs: [LOG_LINE, writeCallback],
    },
    {
      label: "a log line with an encoding and a callback",
      chunk: LOG_LINE,
      encodingOrCallback: "utf8",
      callback: writeCallback,
      expectedStreamArgs: [LOG_LINE, "utf8", writeCallback],
    },
  ]

  it.each(passThroughCases)(
    "passes $label to the stream and returns the stream's result",
    ({ chunk, encodingOrCallback, callback, expectedStreamArgs }) => {
      const { streamWrite, logToConsole, routingWrite } = createRoutingWrite()

      expect(routingWrite(chunk, encodingOrCallback, callback)).toBe(false)
      expect(streamWrite).toHaveBeenCalledTimes(1)
      expect(streamWrite).toHaveBeenCalledWith(...expectedStreamArgs)
      expect(logToConsole).not.toHaveBeenCalled()
    },
  )
})

describe("the routing the setup file installs", () => {
  const installedRoutingCases = [
    { label: "process.stdout to console.log", stream: process.stdout, consoleMethod: "log" },
    { label: "process.stderr to console.error", stream: process.stderr, consoleMethod: "error" },
  ] as const

  it.each(installedRoutingCases)(
    "sends a log line written to $label",
    ({ stream, consoleMethod }) => {
      const consoleSpy = vi.spyOn(console, consoleMethod).mockImplementation(() => undefined)
      onTestFinished(() => consoleSpy.mockRestore())

      stream.write(LOG_LINE)

      expect(consoleSpy).toHaveBeenCalledTimes(1)
      expect(consoleSpy).toHaveBeenCalledWith(ROUTED_LOG_LINE)
    },
  )
})
