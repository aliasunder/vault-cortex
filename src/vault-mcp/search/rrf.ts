// ── Reciprocal Rank Fusion ─────────────────────────────────────

/** Reciprocal Rank Fusion (RRF) — merges N independently ranked result
 *  lists into a single relevance score per unique identifier.
 *
 *  Algorithm:
 *  1. For each result in each list, compute 1 / (k + rank) where rank is
 *     1-indexed and k (default 60) dampens the influence of low ranks
 *  2. Sum scores per id across all lists — an id in multiple lists gets a
 *     higher combined score than one appearing in only one list
 *  3. Add top-rank bonuses: +0.05 for rank 1, +0.02 for ranks 2–3 in any
 *     list, rewarding results that any system placed highly
 *  4. Sort by combined score descending
 *
 *  Inspired by qmd: https://github.com/tobi/qmd#score-normalization--fusion */
export const computeRrfScores = (params: {
  rankedLists: ReadonlyArray<readonly { id: string }[]>
  k?: number
}): { id: string; score: number }[] => {
  const k = params.k ?? 60

  const scoresById = new Map<string, number>()

  const accumulateScores = (rankedItems: readonly { id: string }[]): void => {
    for (const [index, item] of rankedItems.entries()) {
      const rank = index + 1
      const rrfScore = 1 / (k + rank)
      const bonus = rank === 1 ? 0.05 : rank <= 3 ? 0.02 : 0
      const previousScore = scoresById.get(item.id) ?? 0
      scoresById.set(item.id, previousScore + rrfScore + bonus)
    }
  }

  for (const rankedList of params.rankedLists) {
    accumulateScores(rankedList)
  }

  return [...scoresById.entries()]
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .map(([id, score]) => ({
      id,
      score: Number(score.toPrecision(4)),
    }))
}
