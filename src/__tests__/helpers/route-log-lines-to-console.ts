/**
 * Vitest setup file that keeps src/logger.ts's lines out of passing tests' output.
 * - The logger writes each JSON line straight to process.stdout or
 *   process.stderr, which vitest prints for every test.
 * - This wrapper sends those lines through console instead, so vitest files
 *   each line under the test that wrote it, and `silent: "passed-only"` prints
 *   the line only when that test fails.
 * - A test that spies on process.stdout.write puts its spy in front of the
 *   wrapper, so the spy still sees every line it asserts on.
 * - Under vitest's default isolation, each test file runs in its own process,
 *   so the wrappers last until that process exits and need no restore.
 */

/** Every line src/logger.ts writes opens with its timestamp field. */
const LOG_LINE_START = '{"timestamp":'

type WriteCallback = (error?: Error | null) => void

type StreamWrite = (
  chunk: Uint8Array | string,
  encodingOrCallback?: BufferEncoding | WriteCallback,
  callback?: WriteCallback,
) => boolean

export const createLogLineRoutingWrite = (
  stream: Pick<NodeJS.WriteStream, "write">,
  logToConsole: (line: string) => void,
): StreamWrite => {
  const originalWrite = stream.write.bind(stream)

  return (chunk, encodingOrCallback, callback) => {
    // src/logger.ts passes neither an encoding nor a callback, so a write that
    // carries one is never a log line. logger.test.ts pins this write shape.
    const isLogLine =
      typeof chunk === "string" &&
      chunk.startsWith(LOG_LINE_START) &&
      !encodingOrCallback &&
      !callback

    if (isLogLine) {
      // The logger's line ends in a newline, and console adds its own.
      logToConsole(chunk.trimEnd())
      return true
    }

    // The callback sits second or third in write's overloads, so each position
    // needs its own call to type-check. Node handles both calls the same way.
    if (typeof encodingOrCallback === "function") return originalWrite(chunk, encodingOrCallback)
    return originalWrite(chunk, encodingOrCallback, callback)
  }
}

// vitest captures console per test, unlike process.stdout, and its console never
// writes to process.stdout, so a routed line cannot loop back through the wrapper.
// eslint-disable-next-line no-console
process.stdout.write = createLogLineRoutingWrite(process.stdout, (line) => console.log(line))
// eslint-disable-next-line no-console
process.stderr.write = createLogLineRoutingWrite(process.stderr, (line) => console.error(line))
