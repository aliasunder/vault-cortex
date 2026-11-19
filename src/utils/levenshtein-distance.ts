/** Reads one computed cell, throwing instead of silently degrading if a
 *  band-index invariant ever breaks. */
const readCell = (row: readonly number[], columnIndex: number): number => {
  const cell = row[columnIndex]

  if (cell === undefined) throw new Error("edit distance cell access out of bounds")
  return cell
}

/**
 * Reports whether two strings are within `maxDistance` Levenshtein edits of
 * each other — single-character insertions, deletions or substitutions.
 * Case-sensitive: callers comparing case-insensitively fold case first.
 *
 * Only cells within `maxDistance` of the distance table's diagonal can hold a
 * value of `maxDistance` or less, so each row computes that band alone. The
 * walk takes time proportional to the strings' length times `maxDistance`,
 * not to the product of their lengths, and stops once a whole row is past
 * `maxDistance`.
 *
 * @see https://en.wikipedia.org/wiki/Levenshtein_distance — definition and
 * the two-row dynamic-programming walk this narrows to a band
 */
export const isWithinEditDistance = (params: {
  first: string
  second: string
  maxDistance: number
}): boolean => {
  const { first, second, maxDistance } = params

  if (first === second) return true
  if (Math.abs(first.length - second.length) > maxDistance) return false

  // Every distance above maxDistance is capped at this value: the answer only
  // depends on whether a cell exceeds maxDistance, never by how much.
  const unreachable = maxDistance + 1

  const firstRow = Array.from({ length: second.length + 1 }, (unusedCell, columnIndex) => {
    return Math.min(columnIndex, unreachable)
  })
  const scratchRow = Array.from({ length: second.length + 1 }, () => unreachable)

  // The walk threads two rows of distances, each cell derived from the row
  // above and the cell to its left, and swaps them after every row. A row
  // writes only its band, so a read outside the previous row's band is treated
  // as unreachable instead of trusting a cell left over from an older row.
  let [previousRow, currentRow] = [firstRow, scratchRow]

  for (let rowIndex = 1; rowIndex <= first.length; rowIndex++) {
    const bandStart = Math.max(0, rowIndex - maxDistance)
    const bandEnd = Math.min(second.length, rowIndex + maxDistance)
    const previousBandEnd = rowIndex - 1 + maxDistance

    // The smallest distance in this row; once it passes maxDistance, no later
    // row can come back under it.
    let rowMinimum = unreachable

    for (let columnIndex = bandStart; columnIndex <= bandEnd; columnIndex++) {
      if (columnIndex === 0) {
        currentRow[0] = Math.min(rowIndex, unreachable)
        rowMinimum = Math.min(rowMinimum, readCell(currentRow, 0))
        continue
      }

      const deletionBase =
        columnIndex <= previousBandEnd ? readCell(previousRow, columnIndex) : unreachable
      const insertionBase =
        columnIndex - 1 >= bandStart ? readCell(currentRow, columnIndex - 1) : unreachable
      const substitutionBase = readCell(previousRow, columnIndex - 1)
      const substitutionCost = first[rowIndex - 1] === second[columnIndex - 1] ? 0 : 1
      const cellDistance = Math.min(
        deletionBase + 1,
        insertionBase + 1,
        substitutionBase + substitutionCost,
        unreachable,
      )

      currentRow[columnIndex] = cellDistance
      rowMinimum = Math.min(rowMinimum, cellDistance)
    }

    if (rowMinimum > maxDistance) return false
    ;[previousRow, currentRow] = [currentRow, previousRow]
  }

  return readCell(previousRow, second.length) <= maxDistance
}
