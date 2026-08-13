/**
 * True when any segment of a POSIX vault-relative path is dot-prefixed
 * (".obsidian/", ".trash/", dotfiles). The single definition of "hidden",
 * shared by listings, the watcher, index rebuilds, and the path-safety
 * guard so they can't drift.
 */
export const hasHiddenPathSegment = (relativePath: string): boolean => {
  return relativePath.split("/").some((segment) => segment.startsWith("."))
}
