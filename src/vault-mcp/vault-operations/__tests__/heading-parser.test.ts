import { describe, it, expect } from "vitest"
import { parseHeadings, findHeading } from "../heading-parser.js"

describe("parseHeadings", () => {
  it("parses H1–H6 with each section spanning to the next same-or-higher heading", () => {
    const lines = [
      "# Top", // 0
      "intro", // 1
      "## Sub A", // 2
      "a body", // 3
      "## Sub B", // 4
      "b body", // 5
    ]
    const headings = parseHeadings(lines)
    // "Top" (H1) has no later H1-or-higher heading, so its span runs to EOF
    // and includes both H2 children. Each H2 stops at the next H2.
    expect(headings).toEqual([
      { text: "Top", level: 1, startLine: 0, bodyStartLine: 1, bodyEndLine: 6 },
      {
        text: "Sub A",
        level: 2,
        startLine: 2,
        bodyStartLine: 3,
        bodyEndLine: 4,
      },
      {
        text: "Sub B",
        level: 2,
        startLine: 4,
        bodyStartLine: 5,
        bodyEndLine: 6,
      },
    ])
  })

  it("includes child headings in a parent section's span", () => {
    const lines = ["## Parent", "x", "### Child", "y", "## Sibling", "z"]
    const parent = parseHeadings(lines).find((h) => h.text === "Parent")
    // bodyEndLine stops at "## Sibling" (line 4), so "### Child" is included.
    expect(parent).toMatchObject({ startLine: 0, bodyEndLine: 4 })
  })

  it("ignores ATX headings inside fenced code blocks", () => {
    const lines = ["# Real", "```", "# Not a heading", "```", "## Also real"]
    expect(parseHeadings(lines).map((h) => h.text)).toEqual([
      "Real",
      "Also real",
    ])
  })

  it("strips trailing closing hashes from heading text", () => {
    expect(parseHeadings(["## Title ##"]).map((h) => h.text)).toEqual(["Title"])
  })

  it("stops the final section before a trailing Kanban %% settings block", () => {
    const lines = [
      "## Active", // 0
      "- card", // 1
      "", // 2
      "%% kanban:settings", // 3
      "{}", // 4
      "%%", // 5
    ]
    // bodyEndLine absorbs the blank line before %% → ends at line 2.
    expect(parseHeadings(lines)[0].bodyEndLine).toBe(2)
  })

  it("returns an empty array when there are no headings", () => {
    expect(parseHeadings(["just", "prose"])).toEqual([])
  })
})

describe("findHeading", () => {
  const headings = parseHeadings([
    "# Board",
    "## Active",
    "## Done",
    "### Active",
  ])

  it("returns the single matching heading", () => {
    expect(findHeading(headings, "Board").level).toBe(1)
  })

  it("disambiguates duplicate text by level", () => {
    expect(findHeading(headings, "Active", 3).level).toBe(3)
  })

  it("throws and lists available headings when none match", () => {
    expect(() => findHeading(headings, "Missing")).toThrow(
      'heading not found: "Missing". Available headings: # Board, ## Active, ## Done, ### Active',
    )
  })

  it("throws ambiguous when more than one heading matches", () => {
    expect(() => findHeading(headings, "Active")).toThrow(
      'ambiguous heading: "Active"',
    )
  })

  it("throws when the heading text is empty or whitespace", () => {
    expect(() => findHeading(headings, "   ")).toThrow(
      "heading cannot be empty",
    )
  })
})
