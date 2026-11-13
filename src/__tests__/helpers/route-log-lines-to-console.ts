/**
 * Vitest setup file that keeps server log lines out of passing tests' output.
 * - The logger writes each JSON line straight to process.stdout or
 *   process.stderr, which vitest prints for every test.
 * - This wrapper sends those lines through console instead, so vitest files
 *   each line under the test that wrote it, and `silent: "passed-only"` prints
 *   the line only when that test fails.
 * - A test that spies on process.stdout.write replaces the wrapper while its
 *   spy is active, so it still captures every line it asserts on.
 */

/** Every line the logger emits, including its console warnings, opens with its timestamp field. */
const LOG_LINE_START = '{"timestamp":'

type WriteCallback = (error?: Error | null) => void

const routeLogLinesToConsole = (
  stream: NodeJS.WriteStream,
  logToConsole: (line: string) => void,
): void => {
  const writeToStream = stream.write.bind(stream)

  stream.write = (
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    // The logger passes neither an encoding nor a callback, so a write that carries one is never a log line.
    const isLogLine =
      typeof chunk === "string" &&
      chunk.startsWith(LOG_LINE_START) &&
      !encodingOrCallback &&
      !callback

    if (isLogLine) {
      logToConsole(chunk.trimEnd())
      return true
    }
    if (typeof encodingOrCallback === "function") return writeToStream(chunk, encodingOrCallback)
    return writeToStream(chunk, encodingOrCallback, callback)
  }
}

// console is the destination here: vitest captures it per test, which process.stdout is not.
// eslint-disable-next-line no-console
routeLogLinesToConsole(process.stdout, (line) => console.log(line))
// eslint-disable-next-line no-console
routeLogLinesToConsole(process.stderr, (line) => console.error(line))
