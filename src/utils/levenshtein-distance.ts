/** Reads one cell of a distance row, throwing instead of silently degrading
 *  if an index ever falls outside the row. */
const readCell = (row: readonly number[], columnIndex: number): number => {
  const cell = row[columnIndex]

  if (cell === undefined) throw new Error("edit distance cell access out of bounds")
  return cell
}

/**
 * Reports whether two strings are within `maxDistance` Levenshtein edits of
 * each other — insertions, deletions or substitutions of one UTF-16 code unit
 * each. Case-sensitive: callers comparing case-insensitively fold case first.
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

  // Turning one string into the other takes at least as many edits as their
  // length difference. Past this check, the last row's band also reaches
  // column second.length, the cell the final read returns.
  if (Math.abs(first.length - second.length) > maxDistance) return false

  // Every distance above maxDistance is capped at this value: the answer only
  // depends on whether a cell exceeds maxDistance, never by how much.
  const overBudget = maxDistance + 1

  const bandForRow = (rowIndex: number): { start: number; end: number } => {
    return {
      start: Math.max(0, rowIndex - maxDistance),
      end: Math.min(second.length, rowIndex + maxDistance),
    }
  }

  // The walk keeps two rows of distances, each cell derived from the row
  // above and the cell to its left, and swaps them after every row.
  let previousRow = Array.from({ length: second.length + 1 }, (unusedCell, columnIndex) => {
    return Math.min(columnIndex, overBudget)
  })
  let currentRow = Array.from({ length: second.length + 1 }, () => overBudget)

  for (let rowIndex = 1; rowIndex <= first.length; rowIndex++) {
    const band = bandForRow(rowIndex)
    const previousBand = bandForRow(rowIndex - 1)

    // The smallest distance in this row; once it passes maxDistance, no later
    // row can come back under it.
    let rowMinimum = overBudget

    for (let columnIndex = band.start; columnIndex <= band.end; columnIndex++) {
      if (columnIndex === 0) {
        const emptyPrefixDistance = Math.min(rowIndex, overBudget)

        currentRow[0] = emptyPrefixDistance
        rowMinimum = Math.min(rowMinimum, emptyPrefixDistance)
        continue
      }

      // A row writes only its band, so a cell outside a band still holds a
      // value from an older row and counts as over budget instead. The
      // previous row's band covers this row's band shifted one column left,
      // so the substitution read always lands inside it.
      const deletionInBand = columnIndex <= previousBand.end
      const insertionInBand = columnIndex - 1 >= band.start
      const deletionBase = deletionInBand ? readCell(previousRow, columnIndex) : overBudget
      const insertionBase = insertionInBand ? readCell(currentRow, columnIndex - 1) : overBudget
      const substitutionBase = readCell(previousRow, columnIndex - 1)
      const substitutionCost = first[rowIndex - 1] === second[columnIndex - 1] ? 0 : 1
      const cellDistance = Math.min(
        deletionBase + 1,
        insertionBase + 1,
        substitutionBase + substitutionCost,
        overBudget,
      )

      currentRow[columnIndex] = cellDistance
      rowMinimum = Math.min(rowMinimum, cellDistance)
    }

    if (rowMinimum > maxDistance) return false

    const finishedRow = currentRow
    currentRow = previousRow
    previousRow = finishedRow
  }

  return readCell(previousRow, second.length) <= maxDistance
}
