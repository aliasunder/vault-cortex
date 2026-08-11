// ── Reciprocal Rank Fusion ─────────────────────────────────────

/** Reciprocal Rank Fusion (RRF) — merges N independently ranked result
 *  lists into a single relevance score per unique identifier.
 *
 *  Algorithm:
 *  1. For each result in each list, compute 1 / (dampingConstant + rank)
 *     where rank is 1-indexed and dampingConstant (default 60) dampens
 *     the influence of low ranks
 *  2. Sum scores per identifier across all lists — an identifier in
 *     multiple lists gets a higher combined score than one appearing in
 *     only one list
 *  3. Add top-rank bonuses: +0.05 for rank 1, +0.02 for ranks 2–3 in any
 *     list, rewarding results that any system placed highly
 *  4. Sort by combined score descending
 *
 *  Inspired by qmd: https://github.com/tobi/qmd#score-normalization--fusion */
export const computeRrfScores = (params: {
  rankedLists: ReadonlyArray<readonly { identifier: string }[]>
  dampingConstant?: number
}): { identifier: string; score: number }[] => {
  const dampingConstant = params.dampingConstant ?? 60

  const scoresByIdentifier = new Map<string, number>()

  const accumulateScores = (
    rankedItems: readonly { identifier: string }[],
  ): void => {
    for (const [index, item] of rankedItems.entries()) {
      const rank = index + 1
      const rrfScore = 1 / (dampingConstant + rank)
      const bonus = rank === 1 ? 0.05 : rank <= 3 ? 0.02 : 0
      const previousScore = scoresByIdentifier.get(item.identifier) ?? 0
      scoresByIdentifier.set(item.identifier, previousScore + rrfScore + bonus)
    }
  }

  for (const rankedList of params.rankedLists) {
    accumulateScores(rankedList)
  }

  return [...scoresByIdentifier.entries()]
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .map(([identifier, score]) => ({
      identifier,
      score: Number(score.toPrecision(4)),
    }))
}
