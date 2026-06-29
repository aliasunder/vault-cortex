import { describe, it, expect } from "vitest"
import { stripMarkdownSyntax } from "../plaintext.js"

describe("stripMarkdownSyntax", () => {
  const scenarios = [
    {
      name: "wikilink with alias → display text",
      input: "See [[Projects/Plan|the plan]] for details",
      expected: "See the plan for details",
    },
    {
      name: "bare wikilink → target text",
      input: "Check [[Daily Notes]] today",
      expected: "Check Daily Notes today",
    },
    {
      name: "markdown link → link text",
      input: "Visit [the docs](https://example.com) now",
      expected: "Visit the docs now",
    },
    {
      name: "comment block removed",
      input: "before %% hidden content %% after",
      expected: "before  after",
    },
    {
      name: "multi-line comment removed",
      input: "before\n%% line 1\nline 2 %%\nafter",
      expected: "before\n\nafter",
    },
    {
      name: "heading markers stripped",
      input: "## Section Title\n### Subsection",
      expected: "Section Title\nSubsection",
    },
    {
      name: "bold markers stripped",
      input: "This is **bold text** here",
      expected: "This is bold text here",
    },
    {
      name: "italic markers stripped (asterisk)",
      input: "This is *italic text* here",
      expected: "This is italic text here",
    },
    {
      name: "italic markers stripped (underscore)",
      input: "This is _italic text_ here",
      expected: "This is italic text here",
    },
    {
      name: "bold italic markers stripped",
      input: "This is ***bold italic*** here",
      expected: "This is bold italic here",
    },
    {
      name: "callout marker stripped",
      input: "> [!info] Important note\n> Content here",
      expected: "Important note\nContent here",
    },
    {
      name: "block quote marker stripped",
      input: "> This is quoted\n> Second line",
      expected: "This is quoted\nSecond line",
    },
    {
      name: "mixed syntax all stripped",
      input:
        "## My Note\n\n**Bold** and [[link|display]] with `code`\n\n> [!tip] A tip\n> Some advice\n\n%% secret %%",
      expected:
        "My Note\n\nBold and display with `code`\n\nA tip\nSome advice\n\n",
    },
    {
      name: "plain text passes through unchanged",
      input: "Just some regular text with no markup",
      expected: "Just some regular text with no markup",
    },
    {
      name: "empty string returns empty",
      input: "",
      expected: "",
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    const result = stripMarkdownSyntax(input)
    expect(result).toBe(expected)
  })
})
