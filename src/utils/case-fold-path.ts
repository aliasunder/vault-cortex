const foldOnce = (text: string): string => text.toUpperCase().toLowerCase().normalize("NFD")

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
 *  the pairs a bare toLowerCase misses ("ς"/"σ", "ß"/"ss"). Folded values are
 *  for comparison only and never name a file on disk; the search index stores
 *  them as trash-entry keys. */
export const caseFoldPath = (path: string): string => {
  // - The map runs on decomposed text because NFC merges a combining iota
  //   subscript (U+0345) into its vowel. The iota the map makes from it would
  //   then land before the vowel's other marks in one spelling and after them
  //   in another, giving one name two keys.
  // - The final NFC gives every key one form.
  return foldToFixedPoint(path.normalize("NFD")).normalize("NFC")
}
