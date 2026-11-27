import { describe, it, expect } from "vitest"
import { createTextJoiner, replaceAllInBatches } from "../batched-text.js"

describe("createTextJoiner", () => {
  it("joins pieces in order across several batches", () => {
    const joiner = createTextJoiner()
    const pieces = Array.from({ length: 10_000 }, (_, index) => `${index},`)

    for (const piece of pieces) joiner.push(piece)

    expect(joiner.join()).toBe(pieces.join(""))
  })

  it("joins to an empty string when nothing was pushed", () => {
    expect(createTextJoiner().join()).toBe("")
  })
})

describe("replaceAllInBatches", () => {
  // Each case's output is what String.prototype.replace returns for it.
  const replaceCases = [
    { label: "no match", text: "plain text", pattern: /\\(.)/g },
    { label: "a match at each end", text: "\\a middle \\b", pattern: /\\(.)/g },
    { label: "adjacent matches", text: "\\a\\b\\c", pattern: /\\(.)/g },
    { label: "more matches than one batch holds", text: "\\x".repeat(9_000), pattern: /\\(.)/g },
  ]

  it.each(replaceCases)(
    "replaces as String.prototype.replace does with $label",
    ({ text, pattern }) => {
      const replaced = replaceAllInBatches({
        text,
        pattern,
        replacement: ([escape]) => escape.slice(1),
      })

      expect(replaced).toBe(text.replace(pattern, "$1"))
    },
  )

  it("replaces from the start of the text when the pattern's lastIndex is past 0", () => {
    const pattern = /\\(.)/g
    pattern.lastIndex = 2

    const replaced = replaceAllInBatches({
      text: "\\a\\b\\c",
      pattern,
      replacement: ([escape]) => escape.slice(1),
    })

    expect(replaced).toBe("abc")
  })
})
