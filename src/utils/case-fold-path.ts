const foldOnce = (text: string): string => text.toUpperCase().toLowerCase().normalize("NFC")

/** Repeats the map until the text stops changing, so every spelling of a name
 *  shares one key. One map is not always a fixed point: capital sharp s
 *  (U+1E9E) lowers to "ß", which only the next map expands to "ss". */
const foldToFixedPoint = (text: string): string => {
  const folded = foldOnce(text)

  if (folded === text) return text
  return foldToFixedPoint(folded)
}

/** Case- and Unicode-normalization-folds a path for comparison, so two
 *  spellings that name the same file on a case-insensitive filesystem
 *  (macOS/Windows bind mounts) compare equal. The upper-then-lower map folds
 *  the pairs a bare toLowerCase misses ("ς"/"σ", "ß"/"ss"); the trailing NFC
 *  re-normalizes because case mapping does not always preserve normalization
 *  form. Folded values are for comparison only and never touch disk. */
export const caseFoldPath = (path: string): string => foldToFixedPoint(path.normalize("NFC"))
