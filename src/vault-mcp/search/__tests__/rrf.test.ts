import { describe, it, expect } from "vitest"
import { computeRrfScores } from "../rrf.js"

describe("computeRrfScores", () => {
  /** Rank-1 RRF score with default dampingConstant=60: 1/(60+1) + 0.05 bonus */
  const RANK_1_SCORE = Number((1 / 61 + 0.05).toPrecision(4))

  it("scores an identifier appearing in one list only", () => {
    const result = computeRrfScores({
      rankedLists: [[{ identifier: "a.md" }], []],
    })

    expect(result).toEqual([{ identifier: "a.md", score: RANK_1_SCORE }])
  })

  it("scores an identifier appearing in the second list only", () => {
    const result = computeRrfScores({
      rankedLists: [[], [{ identifier: "a.md" }]],
    })

    expect(result).toEqual([{ identifier: "a.md", score: RANK_1_SCORE }])
  })

  it("combines scores when an identifier appears in both lists", () => {
    const result = computeRrfScores({
      rankedLists: [[{ identifier: "a.md" }], [{ identifier: "a.md" }]],
    })

    // rank 1 in both lists: score doubles
    expect(result).toEqual([
      { identifier: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
    ])
  })

  it("applies +0.02 bonus for ranks 2-3", () => {
    const result = computeRrfScores({
      rankedLists: [
        [
          { identifier: "first.md" },
          { identifier: "second.md" },
          { identifier: "third.md" },
        ],
      ],
    })

    // Sorted by score descending — rank 1 has highest score
    expect(result).toEqual([
      { identifier: "first.md", score: RANK_1_SCORE },
      {
        identifier: "second.md",
        score: Number((1 / 62 + 0.02).toPrecision(4)),
      },
      { identifier: "third.md", score: Number((1 / 63 + 0.02).toPrecision(4)) },
    ])
  })

  it("applies no bonus for rank 4 and beyond", () => {
    const result = computeRrfScores({
      rankedLists: [
        [
          { identifier: "1.md" },
          { identifier: "2.md" },
          { identifier: "3.md" },
          { identifier: "4.md" },
        ],
      ],
    })

    // Fourth result has no bonus — raw RRF only
    expect(result[3]).toEqual({
      identifier: "4.md",
      score: Number((1 / 64).toPrecision(4)),
    })
  })

  it("handles disjoint lists with equal-rank identifiers", () => {
    const result = computeRrfScores({
      rankedLists: [
        [{ identifier: "fts-only.md" }],
        [{ identifier: "vec-only.md" }],
      ],
    })

    // Both are rank 1 in their respective lists — same score
    expect(result).toEqual([
      { identifier: "fts-only.md", score: RANK_1_SCORE },
      { identifier: "vec-only.md", score: RANK_1_SCORE },
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
      rankedLists: [
        [{ identifier: "a.md" }, { identifier: "b.md" }],
        [{ identifier: "a.md" }],
      ],
    })

    // a.md: rank 1 in both → 2 * (1/61 + 0.05)
    // b.md: rank 2 in first list only → 1/62 + 0.02
    expect(result).toEqual([
      { identifier: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
      { identifier: "b.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
    ])
  })

  it("accepts a custom dampingConstant", () => {
    const result = computeRrfScores({
      rankedLists: [[{ identifier: "a.md" }]],
      dampingConstant: 10,
    })

    // dampingConstant=10, rank=1: 1/(10+1) + top-rank bonus 0.05 = 0.1409
    expect(result).toEqual([
      { identifier: "a.md", score: Number((1 / 11 + 0.05).toPrecision(4)) },
    ])
  })

  it("scores an identifier in all 3 lists higher than one in 2", () => {
    // b.md ranks first in the first two lists; a.md ranks first only in the
    // third list — so an implementation that ignores the third list would
    // incorrectly rank b.md above a.md.
    const result = computeRrfScores({
      rankedLists: [
        [{ identifier: "b.md" }, { identifier: "a.md" }],
        [{ identifier: "b.md" }, { identifier: "a.md" }],
        [{ identifier: "a.md" }],
      ],
    })

    // a.md: rank 1 in list 3 (1/61 + 0.05) + rank 2 in lists 1,2 (2 * (1/62 + 0.02))
    // b.md: rank 1 in lists 1,2 (2 * (1/61 + 0.05))
    // Compute from raw values to avoid toPrecision(4) drift on intermediates
    const expectedScoreA = Number(
      (1 / 61 + 0.05 + 2 * (1 / 62 + 0.02)).toPrecision(4),
    )
    const expectedScoreB = Number((2 * (1 / 61 + 0.05)).toPrecision(4))
    expect(result).toEqual([
      { identifier: "a.md", score: expectedScoreA },
      { identifier: "b.md", score: expectedScoreB },
    ])
  })

  it("ignores empty lists among N without affecting scores", () => {
    const twoLists = computeRrfScores({
      rankedLists: [[{ identifier: "a.md" }], [{ identifier: "a.md" }]],
    })

    const twoListsWithEmpties = computeRrfScores({
      rankedLists: [
        [],
        [{ identifier: "a.md" }],
        [],
        [{ identifier: "a.md" }],
        [],
      ],
    })

    expect(twoListsWithEmpties).toEqual(twoLists)
  })

  it("produces identical 2-list scores to previous named-param signature", () => {
    // Regression: the old API was ftsRanked + vectorRanked; verify the
    // new rankedLists API produces identical scores.
    const result = computeRrfScores({
      rankedLists: [
        [{ identifier: "a.md" }, { identifier: "b.md" }],
        [{ identifier: "a.md" }],
      ],
    })

    expect(result).toEqual([
      { identifier: "a.md", score: Number((RANK_1_SCORE * 2).toPrecision(4)) },
      { identifier: "b.md", score: Number((1 / 62 + 0.02).toPrecision(4)) },
    ])
  })
})
