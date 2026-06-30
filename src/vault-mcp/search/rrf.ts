// ── Reciprocal Rank Fusion ─────────────────────────────────────

/** Reciprocal Rank Fusion (RRF) — merges two independently ranked result
 *  lists (FTS keyword + vector semantic) into a single relevance score.
 *
 *  Algorithm:
 *  1. For each result in each list, compute 1 / (k + rank) where rank is
 *     1-indexed and k (default 60) dampens the influence of low ranks
 *  2. Sum scores per path across both lists — a path in both gets a higher
 *     combined score than one appearing in only one list
 *  3. Add top-rank bonuses: +0.05 for rank 1, +0.02 for ranks 2–3 in either
 *     list, rewarding results that either system placed highly
 *  4. Sort by combined score descending
 *
 *  Reference: Cormack, Clarke & Butt (2009) "Reciprocal Rank Fusion
 *  outperforms Condorcet and individual Rank Learning Methods"
 *  https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf */
export const computeRrfScores = (params: {
  ftsRanked: readonly { path: string }[]
  vectorRanked: readonly { path: string }[]
  k?: number
}): { path: string; score: number }[] => {
  const k = params.k ?? 60

  const scoresByPath = new Map<string, number>()

  const accumulateScores = (rankedItems: readonly { path: string }[]): void => {
    for (const [index, item] of rankedItems.entries()) {
      const rank = index + 1
      const rrfScore = 1 / (k + rank)
      const bonus = rank === 1 ? 0.05 : rank <= 3 ? 0.02 : 0
      const previousScore = scoresByPath.get(item.path) ?? 0
      scoresByPath.set(item.path, previousScore + rrfScore + bonus)
    }
  }

  accumulateScores(params.ftsRanked)
  accumulateScores(params.vectorRanked)

  return [...scoresByPath.entries()]
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .map(([path, score]) => ({
      path,
      score: Number(score.toPrecision(4)),
    }))
}
