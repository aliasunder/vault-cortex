import { describe, expect, it } from "vitest"

import { hasHiddenPathSegment } from "../has-hidden-path-segment.js"

describe("hasHiddenPathSegment", () => {
  it.each([
    [".obsidian/app.json", true],
    ["notes/.trash/x.md", true],
    [".hidden.md", true],
    [".obsidian", true],
    ["a/.b/c", true],
    ["notes/plan.md", false],
    ["a.b/c.md", false],
    ["dir./file", false],
    ["", false],
  ])("returns %s → %s", (relativePath, expected) => {
    expect(hasHiddenPathSegment(relativePath)).toBe(expected)
  })
})
