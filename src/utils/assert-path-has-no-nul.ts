/** A path holding a NUL character, which no filesystem accepts in a name.
 *  - The class keeps Error's name, so a client reads a filesystem error's
 *    form, `[Error]: EINVAL: …, '<path>'`, and the "another filesystem
 *    error" entry in each path tool's Errors list (FILESYSTEM_ERROR_ENTRY
 *    in mcp-core/tools/tool-helpers.ts) covers it.
 *  - remedyForCodedError (mcp-core/coded-error-remedy.ts) appends no remedy
 *    to it, because the message already names what to fix.
 *  - It has no `code`, so describeErrorRelativeTo leaves the quoted path as
 *    the caller sent it. */
export class PathHasNulError extends Error {}

/** Throws a PathHasNulError when `path` holds a NUL character.
 *  - Call it after assertPathWithinMaxLength, which must run before any other
 *    work on the path.
 *  - Call it before any filesystem call that uses the path, because Node
 *    refuses such a path with a TypeError about its arguments rather than a
 *    filesystem error. */
export const assertPathHasNoNul = (path: string): void => {
  if (!path.includes("\u0000")) return
  throw new PathHasNulError(`EINVAL: a path cannot contain a NUL character, '${path}'`)
}
