// Linux's PATH_MAX is 4,096 bytes and counts the terminating NUL, so no
// filesystem accepts a longer path than this.
const MAX_PATH_BYTES = 4095

/** A path longer than any Linux filesystem accepts.
 *  - Its message reads like the filesystem's own ENAMETOOLONG error, and its
 *    name stays "Error", so a client sees the same text either way.
 *  - It has no `code`, so error formatting quotes the path as given. */
export class PathTooLongError extends Error {}

/** Throws a PathTooLongError when `path` is longer than any Linux filesystem
 *  accepts (4,095 bytes of UTF-8). Call it before any other work on the path. */
export const assertPathWithinMaxLength = (path: string): void => {
  if (Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES) return
  throw new PathTooLongError(`ENAMETOOLONG: name too long, '${path}'`)
}
