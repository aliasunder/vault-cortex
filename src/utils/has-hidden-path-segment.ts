/**
 * True when any segment of a POSIX relative path is dot-prefixed — hidden
 * files and directories (".obsidian/", ".trash/", dotfiles).
 *
 * The single definition of "hidden" shared by listing filters, the file
 * watcher, index rebuilds, and the path-safety guard, so the layers can't
 * drift on what counts as hidden. Callers pass vault-relative paths with
 * "/" separators (path.relative output in this codebase is always POSIX —
 * the server runs in Linux Docker).
 */
export const hasHiddenPathSegment = (relativePath: string): boolean => {
  return relativePath.split("/").some((segment) => segment.startsWith("."))
}
