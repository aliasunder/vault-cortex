import { resolve, sep } from "node:path"

/** The `[name]: message` form of an Error, for logs and for wrapping in
 *  another error; anything else is stringified. */
export const describeError = (error: unknown): string => {
  return error instanceof Error ? `[${error.name}]: ${error.message}` : String(error)
}

/** Node's own errors (filesystem failures, invalid arguments) carry a string
 *  `code`; errors thrown by application code do not. */
const isNodeError = (error: unknown): error is Error & { code: string } => {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

/** describeError's text for a message that leaves the process.
 *  - A Node error quotes the absolute paths it failed on: each one under
 *    `directory` becomes relative to it, and `directory` itself becomes ".".
 *  - Any other error keeps its text, because it can quote input the caller
 *    sent, which must come back as sent. */
export const describeErrorRelativeTo = (params: { error: unknown; directory: string }): string => {
  const description = describeError(params.error)

  if (!isNodeError(params.error)) return description

  const directoryPath = resolve(params.directory)
  // A path starts after a quote, a space, or the start of the text, so a folder
  // deeper in the path that shares the directory's name is left alone. Backticks
  // count as quotes: Node's inspect uses them for a value holding both ' and "
  const directoryAtPathStart = new RegExp(
    `(?<=^|[\\s'"\`])${RegExp.escape(directoryPath)}(?:${RegExp.escape(sep)}|(?=[\\s'"\`]|$))`,
    "g",
  )
  return description.replaceAll(directoryAtPathStart, (match) => (match.endsWith(sep) ? "" : "."))
}
