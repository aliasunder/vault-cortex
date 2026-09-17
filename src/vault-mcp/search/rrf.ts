// ── Reciprocal Rank Fusion ─────────────────────────────────────

/** Reciprocal Rank Fusion (RRF) — merges N independently ranked result
 *  lists into a single relevance score per unique identifier.
 *
 *  Algorithm:
 *  1. For each result in each list, compute 1 / (dampingConstant + rank)
 *     where rank is 1-indexed and dampingConstant (default 60) dampens
 *     the influence of low ranks
 *  2. Add top-rank bonuses: +0.05 for rank 1, +0.02 for ranks 2–3 in any
 *     list, rewarding results that any system placed highly
 *  3. Scale each list's whole contribution (base term + bonus) by its
 *     listWeights entry — the bonus must scale too, because at rank 1 it
 *     is ~3× the base term and would otherwise dominate a down-weighted list
 *  4. Sum contributions per identifier across all lists — an identifier in
 *     multiple lists gets a higher combined score than one appearing in
 *     only one list
 *  5. Sort by combined score descending, ties broken by identifier
 *     ascending so equal scores order deterministically
 *
 *  Inspired by qmd: https://github.com/tobi/qmd#score-normalization--fusion */
export const computeRrfScores = (params: {
  rankedLists: ReadonlyArray<readonly { identifier: string }[]>
  /** Per-list contribution multiplier, index-aligned with rankedLists.
   *  A missing entry means 1 (full weight). */
  listWeights?: readonly number[]
  dampingConstant?: number
}): { identifier: string; score: number }[] => {
  const dampingConstant = params.dampingConstant ?? 60

  const scoresByIdentifier = new Map<string, number>()

  const accumulateScores = (
    rankedItems: readonly { identifier: string }[],
    listWeight: number,
  ): void => {
    for (const [index, item] of rankedItems.entries()) {
      const rank = index + 1
      const rrfScore = 1 / (dampingConstant + rank)
      const nearTopBonus = rank <= 3 ? 0.02 : 0
      const bonus = rank === 1 ? 0.05 : nearTopBonus
      const previousScore = scoresByIdentifier.get(item.identifier) ?? 0
      scoresByIdentifier.set(
        item.identifier,
        previousScore + (rrfScore + bonus) * listWeight,
      )
    }
  }

  for (const [listIndex, rankedList] of params.rankedLists.entries()) {
    accumulateScores(rankedList, params.listWeights?.[listIndex] ?? 1)
  }

  return [...scoresByIdentifier.entries()]
    .toSorted(([identifierA, scoreA], [identifierB, scoreB]) => {
      return scoreB - scoreA || identifierA.localeCompare(identifierB)
    })
    .map(([identifier, score]) => ({
      identifier,
      score: Number(score.toPrecision(4)),
    }))
}
