import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { stripMarkdownSyntax } from "../plaintext.js"
import { createScannerDocuments, scannerCorpora, legacyPlaintext } from "./link-scanner-corpus.js"

describe("stripMarkdownSyntax", () => {
  it.each([
    { variant: "plaintext-alias", expectedBytes: [20_015, 40_015, 80_015] },
    { variant: "plaintext-wiki", expectedBytes: [20_009, 40_009, 80_009] },
    { variant: "plaintext-markdown", expectedBytes: [20_012, 40_012, 80_012] },
    { variant: "callout", expectedBytes: [20_009, 40_009, 80_009] },
  ])(
    "bounds repeated failing $variant openers in an externally killed child",
    ({ variant, expectedBytes }) => {
      const fixturePath = new URL("./link-scanner-adversary.ts", import.meta.url)
      // SIGKILL bounds a synchronous regex even when the child's event loop cannot run timers.
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", fixturePath.pathname, variant],
        {
          encoding: "utf8",
          timeout: 30_000,
          killSignal: "SIGKILL",
        },
      )
      const result = JSON.parse(output)

      expect(result.variant).toBe(variant)
      expect(
        result.measurements.map((measurement: { bytes: number }) => measurement.bytes),
      ).toEqual(expectedBytes)
      for (const [index, measurement] of result.measurements.entries()) {
        expect(measurement.median).toBeLessThan(1_000)
        const previous = result.measurements[index - 1]

        if (previous?.median > 10) expect(measurement.median / previous.median).toBeLessThan(3)
      }
    },
    35_000,
  )

  it.each(scannerCorpora.slice(3))(
    "preserves the complete legacy text for 10,000 $label documents",
    ({ alphabet }) => {
      for (const document of createScannerDocuments(alphabet, 10_000)) {
        expect(stripMarkdownSyntax(document)).toBe(legacyPlaintext(document))
      }
    },
  )

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
      name: "heading markers with leading spaces stripped (CommonMark §4.2)",
      input: " ## Spaced\n   ### Deep",
      expected: "Spaced\nDeep",
    },
    {
      name: "heading with 4+ leading spaces is not stripped (indented code block)",
      input: "    ## Not a heading",
      expected: "    ## Not a heading",
    },
    {
      name: "heading with tab separator stripped (CommonMark §4.2)",
      input: "##\tSection Title",
      expected: "Section Title",
    },
    {
      name: "empty heading markers stripped (hashes only, no text)",
      input: "##\nSome content",
      expected: "\nSome content",
    },
    {
      name: "setext H1 underline stripped (===)",
      input: "Title\n===\nBody",
      expected: "Title\n\nBody",
    },
    {
      name: "setext H2 underline stripped (---)",
      input: "Title\n---\nBody",
      expected: "Title\n\nBody",
    },
    {
      name: "setext underline with leading spaces stripped",
      input: "Title\n  ===\nBody",
      expected: "Title\n\nBody",
    },
    {
      name: "setext underline with 4+ leading spaces not stripped",
      input: "Title\n    ===\nBody",
      expected: "Title\n    ===\nBody",
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
      expected: "My Note\n\nBold and display with `code`\n\nA tip\nSome advice\n\n",
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
