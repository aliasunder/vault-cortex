/** Compares strings in byte order, the total order of SQLite's BINARY
 *  collation (UTF-8 bytes), which SQL ORDER BY uses on text.
 *  - localeCompare would order differently across deployments.
 *  - Raw UTF-16 comparison disagrees with UTF-8 when a BMP code point above
 *    the surrogate range meets a non-BMP character. */
export const compareByUtf8Bytes = (left: string, right: string): number => {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}
