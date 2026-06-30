import { describe, it, expect } from "vitest"
import { computeRrfScores } from "../rrf.js"

describe("computeRrfScores", () => {
  /** Rank-1 RRF score with default k=60: 1/(60+1) + 0.05 bonus */
  const RANK_1_SCORE = Number((1 / 61 + 0.05).toPrecision(4))

  it("scores a path appearing in FTS only", () => {
    const result = computeRrfScores({
      ftsRanked: [{ path: "a.md" }],
      vectorRanked: [],
    })

    expect(result).toEqual([{ path: "a.md", score: RANK_1_SCORE }])
  })

  it("scores a path appearing in vector only", () => {
    const result = computeRrfScores({
      ftsRanked: [],
      vectorRanked: [{ path: "a.md" }],
    })

    expect(result).toEqual([{ path: "a.md", score: RANK_1_SCORE }])
  })

  it("combines scores when a path appears in both lists", () => {
    const result = computeRrfScores({
      ftsRanked: [{ path: "a.md" }],
      vectorRanked: [{ path: "a.md" }],
    })

    // rank 1 in both lists: score doubles
    expect(result).toEqual([
      { path: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
    ])
  })

  it("applies +0.02 bonus for ranks 2-3", () => {
    const result = computeRrfScores({
      ftsRanked: [
        { path: "first.md" },
        { path: "second.md" },
        { path: "third.md" },
      ],
      vectorRanked: [],
    })

    // Sorted by score descending — rank 1 has highest score
    expect(result).toEqual([
      { path: "first.md", score: RANK_1_SCORE },
      { path: "second.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
      { path: "third.md", score: Number((1 / 63 + 0.02).toPrecision(4)) },
    ])
  })

  it("applies no bonus for rank 4 and beyond", () => {
    const result = computeRrfScores({
      ftsRanked: [
        { path: "1.md" },
        { path: "2.md" },
        { path: "3.md" },
        { path: "4.md" },
      ],
      vectorRanked: [],
    })

    // Fourth result has no bonus — raw RRF only
    expect(result[3]).toEqual({
      path: "4.md",
      score: Number((1 / 64).toPrecision(4)),
    })
  })

  it("handles disjoint lists with equal-rank paths", () => {
    const result = computeRrfScores({
      ftsRanked: [{ path: "fts-only.md" }],
      vectorRanked: [{ path: "vec-only.md" }],
    })

    // Both are rank 1 in their respective lists — same score
    expect(result).toEqual([
      { path: "fts-only.md", score: RANK_1_SCORE },
      { path: "vec-only.md", score: RANK_1_SCORE },
    ])
  })

  it("returns empty array for empty inputs", () => {
    const result = computeRrfScores({
      ftsRanked: [],
      vectorRanked: [],
    })
    expect(result).toEqual([])
  })

  it("sorts results by score descending", () => {
    const result = computeRrfScores({
      ftsRanked: [{ path: "a.md" }, { path: "b.md" }],
      vectorRanked: [{ path: "a.md" }],
    })

    // a.md: rank 1 in both → 2 * (1/61 + 0.05)
    // b.md: rank 2 in FTS only → 1/62 + 0.02
    expect(result).toEqual([
      { path: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
      { path: "b.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
    ])
  })

  it("accepts a custom k value", () => {
    const result = computeRrfScores({
      ftsRanked: [{ path: "a.md" }],
      vectorRanked: [],
      k: 10,
    })

    // k=10, rank=1: 1/(10+1) + top-rank bonus 0.05 = 0.1409
    expect(result).toEqual([
      { path: "a.md", score: Number((1 / 11 + 0.05).toPrecision(4)) },
    ])
  })
})
