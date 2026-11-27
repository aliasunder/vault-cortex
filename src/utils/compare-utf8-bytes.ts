/** Byte-order string comparison: the total order of SQLite's BINARY
 *  collation (UTF-8 bytes), which SQL ORDER BY uses on text.
 *  - links.ts's compareShortestPathFirst repeats it inline, so a change here
 *    needs the same change there.
 *  - localeCompare would order differently across deployments.
 *  - Raw UTF-16 comparison disagrees with UTF-8 when a BMP code point above
 *    the surrogate range meets a non-BMP character. */
export const compareByUtf8Bytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))
