/** Case- and Unicode-normalization-folds a path for comparison, so two
 *  spellings that name the same file on a case-insensitive filesystem
 *  (macOS/Windows bind mounts) compare equal. The upper-then-lower double map
 *  folds the pairs a bare toLowerCase misses ("ς"/"σ", "ß"/"ss"); the trailing
 *  NFC re-normalizes because case mapping does not always preserve
 *  normalization form. Folded values are for comparison only and never touch
 *  disk. */
export const caseFoldPath = (path: string): string =>
  path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")
