/** Throws when `path` holds a NUL character, which no filesystem accepts in a
 *  name.
 *  - Call it after assertPathWithinMaxLength, which must run before any other
 *    work on the path.
 *  - Call it before any filesystem call that uses the path, because Node
 *    refuses such a path with a TypeError about its arguments rather than a
 *    filesystem error.
 *  - The plain Error reaches a client in a filesystem error's form,
 *    `[Error]: EINVAL: …, '<path>'`, so the "another filesystem error" entry in
 *    each path tool's Errors list (FILESYSTEM_ERROR_ENTRY in
 *    mcp-core/tools/tool-helpers.ts) covers it.
 *  - It has no `code`, so describeErrorRelativeTo leaves the quoted path as the
 *    caller sent it, and remedyForCodedError (mcp-core/coded-error-remedy.ts)
 *    appends no remedy, because the message already names what to fix. */
export const assertPathHasNoNul = (path: string): void => {
  if (!path.includes("\u0000")) return
  throw new Error(`EINVAL: a path cannot contain a NUL character, '${path}'`)
}
