import { describe, it, expect } from "vitest"
import { levenshteinDistance } from "../levenshtein-distance.js"

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("working style", "working style")).toBe(0)
  })

  it("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0)
  })

  it("returns the other string's length when one side is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3)
    expect(levenshteinDistance("abc", "")).toBe(3)
  })

  it("counts a single substitution as 1", () => {
    expect(levenshteinDistance("scope", "scobe")).toBe(1)
  })

  it("counts a single insertion as 1", () => {
    expect(levenshteinDistance("career", "careers")).toBe(1)
  })

  it("counts a single deletion as 1", () => {
    expect(levenshteinDistance("styles", "style")).toBe(1)
  })

  it("counts an adjacent transposition as 2", () => {
    expect(levenshteinDistance("scope", "scpoe")).toBe(2)
  })

  it("computes multi-edit distances exactly", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3)
  })

  it("is case-sensitive", () => {
    expect(levenshteinDistance("Scope", "scope")).toBe(1)
  })
})
