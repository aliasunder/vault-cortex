/** A path holding a NUL character, which no filesystem accepts in a name.
 *  - Its message takes the filesystem-error form, and the class keeps Error's
 *    name, so describeError gives a client `[Error]: EINVAL: …` with no
 *    remedy appended.
 *  - It has no `code`, so describeErrorRelativeTo leaves the quoted path as
 *    the caller sent it. */
export class PathHasNulError extends Error {}

/** Throws a PathHasNulError when `path` holds a NUL character. Call it after
 *  assertPathWithinMaxLength and before any filesystem call that uses the
 *  path, because Node refuses such a path with a TypeError about its
 *  arguments rather than a filesystem error. */
export const assertPathHasNoNul = (path: string): void => {
  if (!path.includes("\u0000")) return
  throw new PathHasNulError(`EINVAL: a path cannot contain a NUL character, '${path}'`)
}
