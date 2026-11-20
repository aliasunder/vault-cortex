// Linux's PATH_MAX is 4,096 bytes and counts the terminating NUL, so no
// filesystem accepts a longer path than this.
const MAX_PATH_BYTES = 4095

/** A path longer than any Linux filesystem accepts.
 *  - Its message copies the filesystem's own ENAMETOOLONG text, and the class
 *    keeps Error's name, so describeError gives a client the same
 *    `[Error]: ENAMETOOLONG: …` text whether the server or the filesystem
 *    refused the path.
 *  - It has no `code`, so describeErrorRelativeTo leaves the quoted path as
 *    the caller sent it. */
export class PathTooLongError extends Error {}

/** Throws a PathTooLongError when `path` is longer than any Linux filesystem
 *  accepts (4,095 bytes of UTF-8).
 *  - Call it before any other work on the path, because normalizing,
 *    resolving and case-folding a path cost more than linear time on some
 *    crafted inputs. */
export const assertPathWithinMaxLength = (path: string): void => {
  if (Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES) return
  throw new PathTooLongError(`ENAMETOOLONG: name too long, '${path}'`)
}
