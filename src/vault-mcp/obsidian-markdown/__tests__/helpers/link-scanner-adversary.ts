import assert from "node:assert/strict"
import { links } from "../../links.js"
import { stripMarkdownSyntax } from "../../plaintext.js"

const variant = process.argv[2]
const sizes = [20_000, 40_000, 80_000]

const fixture = (size: number): { text: string; expected: unknown } => {
  if (variant === "wiki") {
    return {
      text: `[[Keep]] ${"[".repeat(size)}`,
      expected: [{ text: "[[Keep]]", start: 0, end: 8, kind: "wikilink" }],
    }
  }
  if (variant === "markdown") {
    return {
      text: `[Keep](Keep) ${"[".repeat(size)}](a`,
      expected: [{ text: "[Keep](Keep)", start: 0, end: 12, kind: "markdown" }],
    }
  }
  if (variant === "templater") {
    return { text: `[[Keep]] ${"<%".repeat(size / 2)}`, expected: ["Keep"] }
  }
  if (variant === "callout") {
    return {
      text: `[[Keep]] ${">[!\n".repeat(size / 4)}`,
      expected: `Keep >[!\n${"[!\n".repeat(size / 4 - 1)}`,
    }
  }
  if (variant === "plaintext-markdown") {
    const tail = `${"[".repeat(size)}](a`
    return { text: `[[Keep]] ${tail}`, expected: `Keep ${tail}` }
  }
  if (variant === "plaintext-alias") {
    const tail = "[[x|".repeat(size / 4)
    return { text: `[[Keep|alias]] ${tail}`, expected: `alias ${tail}` }
  }
  return { text: `[[Keep]] ${"[".repeat(size)}`, expected: `Keep ${"[".repeat(size)}` }
}

const parse = (text: string): unknown => {
  if (variant === "wiki" || variant === "markdown") return links.matchLinksInLine(text)
  if (variant === "templater") return links.extractFromBody(text)
  return stripMarkdownSyntax(text)
}

const measurements = sizes.map((size) => {
  const { text, expected } = fixture(size)
  assert.deepEqual(parse(text), expected)
  const samples = Array.from({ length: 5 }, () => {
    const started = performance.now()
    const result = parse(text)
    const elapsed = performance.now() - started
    assert.deepEqual(result, expected)
    return elapsed
  })
  const median = samples.toSorted((a, b) => a - b)[2]

  assert.notEqual(median, undefined)
  return { bytes: Buffer.byteLength(text), median }
})

process.stdout.write(JSON.stringify({ variant, measurements }))
