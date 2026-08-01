/**
 * Computes the Levenshtein edit distance between two strings — the minimum
 * number of single-character insertions, deletions, or substitutions that
 * turn one into the other. Case-sensitive: callers comparing
 * case-insensitively fold case before calling.
 *
 * @see https://en.wikipedia.org/wiki/Levenshtein_distance — definition and
 * the (iterative two-row) dynamic-programming algorithm implemented here
 */
export const levenshteinDistance = (first: string, second: string): number => {
  if (first === second) return 0
  if (first.length === 0) return second.length
  if (second.length === 0) return first.length

  // Classic two-row dynamic-programming walk. Mutation is required here: the
  // algorithm threads a rolling row of distances character by character, each
  // cell derived from the row above and the cell to its left.
  let previousRow = Array.from(
    { length: second.length + 1 },
    (unusedCell, columnIndex) => columnIndex,
  )
  for (let rowIndex = 1; rowIndex <= first.length; rowIndex++) {
    const currentRow: number[] = [rowIndex]
    for (let columnIndex = 1; columnIndex <= second.length; columnIndex++) {
      const deletionBase = previousRow[columnIndex]
      const insertionBase = currentRow[columnIndex - 1]
      const substitutionBase = previousRow[columnIndex - 1]
      // Rows are constructed dense with length second.length + 1, so the three
      // reads can never miss — throw instead of silently degrading if that
      // invariant ever breaks.
      if (
        deletionBase === undefined ||
        insertionBase === undefined ||
        substitutionBase === undefined
      ) {
        throw new Error("levenshtein distance row access out of bounds")
      }
      const substitutionCost =
        first[rowIndex - 1] === second[columnIndex - 1] ? 0 : 1
      currentRow.push(
        Math.min(
          deletionBase + 1,
          insertionBase + 1,
          substitutionBase + substitutionCost,
        ),
      )
    }
    previousRow = currentRow
  }

  const distance = previousRow[second.length]
  if (distance === undefined) {
    throw new Error("levenshtein distance final row access out of bounds")
  }
  return distance
}
