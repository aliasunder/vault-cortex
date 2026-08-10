import { describe, it, expect } from "vitest"
import { computeRrfScores } from "../rrf.js"

describe("computeRrfScores", () => {
  /** Rank-1 RRF score with default k=60: 1/(60+1) + 0.05 bonus */
  const RANK_1_SCORE = Number((1 / 61 + 0.05).toPrecision(4))

  it("scores an id appearing in one list only", () => {
    const result = computeRrfScores({
      rankedLists: [[{ id: "a.md" }], []],
    })

    expect(result).toEqual([{ id: "a.md", score: RANK_1_SCORE }])
  })

  it("scores an id appearing in the second list only", () => {
    const result = computeRrfScores({
      rankedLists: [[], [{ id: "a.md" }]],
    })

    expect(result).toEqual([{ id: "a.md", score: RANK_1_SCORE }])
  })

  it("combines scores when an id appears in both lists", () => {
    const result = computeRrfScores({
      rankedLists: [[{ id: "a.md" }], [{ id: "a.md" }]],
    })

    // rank 1 in both lists: score doubles
    expect(result).toEqual([
      { id: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
    ])
  })

  it("applies +0.02 bonus for ranks 2-3", () => {
    const result = computeRrfScores({
      rankedLists: [
        [{ id: "first.md" }, { id: "second.md" }, { id: "third.md" }],
      ],
    })

    // Sorted by score descending — rank 1 has highest score
    expect(result).toEqual([
      { id: "first.md", score: RANK_1_SCORE },
      { id: "second.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
      { id: "third.md", score: Number((1 / 63 + 0.02).toPrecision(4)) },
    ])
  })

  it("applies no bonus for rank 4 and beyond", () => {
    const result = computeRrfScores({
      rankedLists: [
        [{ id: "1.md" }, { id: "2.md" }, { id: "3.md" }, { id: "4.md" }],
      ],
    })

    // Fourth result has no bonus — raw RRF only
    expect(result[3]).toEqual({
      id: "4.md",
      score: Number((1 / 64).toPrecision(4)),
    })
  })

  it("handles disjoint lists with equal-rank ids", () => {
    const result = computeRrfScores({
      rankedLists: [[{ id: "fts-only.md" }], [{ id: "vec-only.md" }]],
    })

    // Both are rank 1 in their respective lists — same score
    expect(result).toEqual([
      { id: "fts-only.md", score: RANK_1_SCORE },
      { id: "vec-only.md", score: RANK_1_SCORE },
    ])
  })

  it("returns empty array for empty inputs", () => {
    const result = computeRrfScores({
      rankedLists: [[], []],
    })
    expect(result).toEqual([])
  })

  it("returns empty array for no lists", () => {
    const result = computeRrfScores({
      rankedLists: [],
    })
    expect(result).toEqual([])
  })

  it("sorts results by score descending", () => {
    const result = computeRrfScores({
      rankedLists: [[{ id: "a.md" }, { id: "b.md" }], [{ id: "a.md" }]],
    })

    // a.md: rank 1 in both → 2 * (1/61 + 0.05)
    // b.md: rank 2 in first list only → 1/62 + 0.02
    expect(result).toEqual([
      { id: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
      { id: "b.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
    ])
  })

  it("accepts a custom k value", () => {
    const result = computeRrfScores({
      rankedLists: [[{ id: "a.md" }]],
      k: 10,
    })

    // k=10, rank=1: 1/(10+1) + top-rank bonus 0.05 = 0.1409
    expect(result).toEqual([
      { id: "a.md", score: Number((1 / 11 + 0.05).toPrecision(4)) },
    ])
  })

  it("scores an id in all 3 lists higher than one in 2", () => {
    const result = computeRrfScores({
      rankedLists: [
        [{ id: "a.md" }, { id: "b.md" }],
        [{ id: "a.md" }, { id: "b.md" }],
        [{ id: "a.md" }],
      ],
    })

    // a.md: rank 1 in all 3 lists → 3 * (1/61 + 0.05)
    // b.md: rank 2 in 2 lists → 2 * (1/62 + 0.02)
    expect(result[0]?.id).toBe("a.md")
    expect(result[1]?.id).toBe("b.md")
    const scoreA = result[0]?.score ?? 0
    const scoreB = result[1]?.score ?? 0
    expect(scoreA).toBeGreaterThan(scoreB)
  })

  it("ignores empty lists among N without affecting scores", () => {
    const twoLists = computeRrfScores({
      rankedLists: [[{ id: "a.md" }], [{ id: "a.md" }]],
    })

    const twoListsWithEmpties = computeRrfScores({
      rankedLists: [[], [{ id: "a.md" }], [], [{ id: "a.md" }], []],
    })

    expect(twoListsWithEmpties).toEqual(twoLists)
  })

  it("produces identical 2-list scores to previous named-param signature", () => {
    // Regression: the old API was ftsRanked + vectorRanked; verify the
    // new rankedLists API produces identical scores.
    const result = computeRrfScores({
      rankedLists: [[{ id: "a.md" }, { id: "b.md" }], [{ id: "a.md" }]],
    })

    expect(result).toEqual([
      { id: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
      { id: "b.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
    ])
  })
})
