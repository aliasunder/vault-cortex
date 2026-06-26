/** Throws when a vault note path does not end in ".md". The note tools (read,
 *  write, patch, replace, delete, move, backlinks, outgoing links) operate only
 *  on markdown notes, so a bare path like "Projects/Plan" is a malformed input —
 *  not a missing note. Folder, glob, and memory-file inputs are not note paths
 *  and must not use this. */
export const assertMarkdownPath = (path: string): void => {
  if (path.endsWith(".md")) return
  throw new Error(`note path must end in ".md" (received "${path}")`)
}
