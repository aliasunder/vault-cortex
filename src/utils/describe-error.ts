import { resolve, sep } from "node:path"
import { isErrnoException } from "./is-errno-exception.js"

/** The `[name]: message` form of an Error, for logs; anything else is
 *  stringified. To wrap an error, pass it as `cause` rather than copying this
 *  text into the new message: describeErrorRelativeTo rewrites paths only in
 *  Node's own errors, so a copied absolute path would reach the client. */
export const describeError = (error: unknown): string => {
  return error instanceof Error ? `[${error.name}]: ${error.message}` : String(error)
}

/** describeError's text, for an error message sent to a client.
 *  - A Node error quotes the absolute paths it failed on: each one under
 *    `directory` becomes relative to it, and `directory` itself becomes ".".
 *  - Any other error keeps its text, because it can quote input the caller
 *    sent, which must come back as sent. */
export const describeErrorRelativeTo = (params: { error: unknown; directory: string }): string => {
  const description = describeError(params.error)

  // A string `code` is how a Node error (a filesystem failure, an invalid
  // argument) is told apart: errors the server throws have none. This check
  // also admits other libraries' coded errors, such as SQLite's SQLITE_*
  // errors, whose text then gets the same rewrite.
  if (!isErrnoException(params.error)) return description

  // resolve() puts the directory in the form the server's own paths take
  // (absolute, no trailing separator), so a directory given as "/vault/"
  // still matches the "/vault/…" paths Node quotes
  const directoryPath = resolve(params.directory)

  // For the directory /vault the pattern reads
  // (?<=^|[\s'"`])/vault(?:/|(?=[\s'"`]|$)):
  // - The lookbehind starts a match only where a path starts: after a space,
  //   a quote, or the start of the text. A deeper folder that shares the
  //   directory's name is left alone. Backticks count as quotes because
  //   Node's inspect quotes a value holding both ' and " with them.
  // - The tail ends the match at a separator, for a path inside the
  //   directory, or just before the path's end, for the directory itself. A
  //   sibling such as /vault-backup matches neither.
  const pathBoundary = "[\\s'\"`]"
  const escapedDirectory = RegExp.escape(directoryPath)
  const escapedSeparator = RegExp.escape(sep)
  const directoryAtPathStart = new RegExp(
    `(?<=^|${pathBoundary})${escapedDirectory}(?:${escapedSeparator}|(?=${pathBoundary}|$))`,
    "g",
  )

  // Only a path inside the directory consumes the separator: removing
  // "/vault/" leaves that path relative, and the bare directory becomes "."
  return description.replaceAll(directoryAtPathStart, (match) => (match.endsWith(sep) ? "" : "."))
}
