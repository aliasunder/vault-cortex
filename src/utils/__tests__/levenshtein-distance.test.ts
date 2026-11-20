import { describe, it, expect } from "vitest"
import { isWithinEditDistance } from "../levenshtein-distance.js"

/** The full-table Levenshtein distance, written here as the test's oracle so
 *  the banded walk is never checked against itself. */
const fullTableDistance = (first: string, second: string): number => {
  // The table's first row and column hold the cost of building a prefix from
  // nothing; every other cell is filled in by the walk below.
  const initialCell = (rowIndex: number, columnIndex: number): number => {
    if (rowIndex === 0) return columnIndex
    if (columnIndex === 0) return rowIndex
    return 0
  }
  const rows = Array.from({ length: first.length + 1 }, (unusedRow, rowIndex) => {
    return Array.from({ length: second.length + 1 }, (unusedCell, columnIndex) => {
      return initialCell(rowIndex, columnIndex)
    })
  })

  for (let rowIndex = 1; rowIndex <= first.length; rowIndex++) {
    for (let columnIndex = 1; columnIndex <= second.length; columnIndex++) {
      const substitutionCost = first[rowIndex - 1] === second[columnIndex - 1] ? 0 : 1
      const row = rows[rowIndex] ?? []
      const rowAbove = rows[rowIndex - 1] ?? []
      row[columnIndex] = Math.min(
        (rowAbove[columnIndex] ?? Infinity) + 1,
        (row[columnIndex - 1] ?? Infinity) + 1,
        (rowAbove[columnIndex - 1] ?? Infinity) + substitutionCost,
      )
    }
  }
  return rows[first.length]?.[second.length] ?? Infinity
}

/** A fixed-seed generator, so a failing pair can be reproduced. */
const createSeededRandom = (seed: number): (() => number) => {
  // The generator's state advances on every call; a fold cannot hand it back
  // to the caller between draws.
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

describe("isWithinEditDistance", () => {
  it("accepts identical strings at a distance of 0", () => {
    expect(
      isWithinEditDistance({ first: "working style", second: "working style", maxDistance: 0 }),
    ).toBe(true)
  })

  it("accepts two empty strings", () => {
    expect(isWithinEditDistance({ first: "", second: "", maxDistance: 0 })).toBe(true)
  })

  it("measures an empty side by the other string's length", () => {
    expect(isWithinEditDistance({ first: "", second: "abc", maxDistance: 3 })).toBe(true)
    expect(isWithinEditDistance({ first: "abc", second: "", maxDistance: 2 })).toBe(false)
  })

  it("counts a single substitution as 1", () => {
    expect(isWithinEditDistance({ first: "scope", second: "scobe", maxDistance: 1 })).toBe(true)
    expect(isWithinEditDistance({ first: "scope", second: "scobe", maxDistance: 0 })).toBe(false)
  })

  it("counts a single insertion as 1", () => {
    expect(isWithinEditDistance({ first: "career", second: "careers", maxDistance: 1 })).toBe(true)
    expect(isWithinEditDistance({ first: "career", second: "careers", maxDistance: 0 })).toBe(false)
  })

  it("counts a single deletion as 1", () => {
    expect(isWithinEditDistance({ first: "styles", second: "style", maxDistance: 1 })).toBe(true)
    expect(isWithinEditDistance({ first: "styles", second: "style", maxDistance: 0 })).toBe(false)
  })

  it("counts an adjacent transposition as 2", () => {
    expect(isWithinEditDistance({ first: "scope", second: "scpoe", maxDistance: 2 })).toBe(true)
    expect(isWithinEditDistance({ first: "scope", second: "scpoe", maxDistance: 1 })).toBe(false)
  })

  it("decides a multi-edit pair exactly at its distance", () => {
    expect(isWithinEditDistance({ first: "kitten", second: "sitting", maxDistance: 3 })).toBe(true)
    expect(isWithinEditDistance({ first: "kitten", second: "sitting", maxDistance: 2 })).toBe(false)
  })

  it("is case-sensitive", () => {
    expect(isWithinEditDistance({ first: "Scope", second: "scope", maxDistance: 0 })).toBe(false)
    expect(isWithinEditDistance({ first: "Scope", second: "scope", maxDistance: 1 })).toBe(true)
  })

  it("rejects strings whose lengths differ by more than the budget", () => {
    expect(isWithinEditDistance({ first: "ab", second: "abcde", maxDistance: 2 })).toBe(false)
  })

  it("agrees with the full-table distance on random pairs at every budget from 0 to 3", () => {
    const random = createSeededRandom(20261118)
    const alphabet = ["a", "b", "c"]
    const randomWord = (): string => {
      const length = Math.floor(random() * 9)
      return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("")
    }
    const pairs = Array.from({ length: 2_000 }, () => ({
      first: randomWord(),
      second: randomWord(),
    }))
    const disagreements = pairs.flatMap(({ first, second }) => {
      const distance = fullTableDistance(first, second)
      return [0, 1, 2, 3].flatMap((maxDistance) => {
        const banded = isWithinEditDistance({ first, second, maxDistance })
        const withinBudget = distance <= maxDistance
        return banded === withinBudget ? [] : [{ first, second, maxDistance }]
      })
    })

    expect(disagreements).toEqual([])
  })
})
