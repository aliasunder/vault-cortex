import assert from "node:assert/strict"
import { links } from "../../links.js"
import { stripMarkdownSyntax } from "../../plaintext.js"

const variant = process.argv[2]
const sizes = [20_000, 40_000, 80_000]

const KEEP = "[Keep](Keep) "
const KEEP_MATCH = { text: "[Keep](Keep)", start: 0, end: 12, kind: "markdown" }
const NO_BREAK_SPACE = String.fromCharCode(0xa0)

/** A one-link line followed by `unit` repeated to about `size` characters. */
const keepThenRepeat = (unit: string, size: number): string => {
  return `${KEEP}${unit.repeat(Math.floor(size / unit.length))}`
}

/** The links each block of the inner-title family yields: the bare inner
 *  link, whose title starts before the failed outer angle link's title. */
const innerTitleMatches = (text: string, block: string): unknown[] => {
  const innerLink = '[b](x.md "t")'
  const innerOffset = block.indexOf(innerLink)
  const blockCount = text.length / block.length

  return Array.from({ length: blockCount }, (_, blockIndex) => {
    const start = blockIndex * block.length + innerOffset
    return { text: innerLink, start, end: start + innerLink.length, kind: "markdown" }
  })
}

/** Markdown destination families. Each one builds a line where a scan that
 *  rereads text per attempt would cost quadratic time, with its exact
 *  matchLinksInLine output. */
const markdownFamilies: Record<string, (size: number) => { text: string; expected: unknown }> = {
  "unclosed bare parentheses": (size) => {
    return { text: keepThenRepeat("[a](b(", size), expected: [KEEP_MATCH] }
  },
  "unclosed angle brackets": (size) => {
    return { text: keepThenRepeat("[a](<b", size), expected: [KEEP_MATCH] }
  },
  "unclosed double-quoted titles": (size) => {
    return { text: keepThenRepeat('[a](b "t', size), expected: [KEEP_MATCH] }
  },
  "unclosed single-quoted titles": (size) => {
    return { text: keepThenRepeat("[a](b 't", size), expected: [KEEP_MATCH] }
  },
  "unclosed parenthesized titles": (size) => {
    return { text: keepThenRepeat("[a](b (t", size), expected: [KEEP_MATCH] }
  },
  "whitespace and no-break spaces after one shared `](`": (size) => {
    const whitespace = ` ${NO_BREAK_SPACE}`.repeat(size / 4)
    return { text: `${KEEP}${"[".repeat(size / 2)}](${whitespace}x`, expected: [KEEP_MATCH] }
  },
  "bare destinations sharing one whitespace run": (size) => {
    const openers = "[a](b(".repeat(size / 12)
    return { text: `${KEEP}${openers}${" ".repeat(size / 2)}x`, expected: [KEEP_MATCH] }
  },
  "parenthesized titles sharing one closer and whitespace run": (size) => {
    const openers = "[a](b (".repeat(size / 14)
    return { text: `${KEEP}${openers})${" ".repeat(size / 2)}x`, expected: [KEEP_MATCH] }
  },
  "angle destinations sharing one closer and whitespace run": (size) => {
    const openers = "[a](<b".repeat(size / 12)
    return { text: `${KEEP}${openers}>${" ".repeat(size / 2)}x`, expected: [KEEP_MATCH] }
  },
  "backslash runs before parentheses": (size) => {
    return { text: keepThenRepeat(`[a](${"\\".repeat(30)}(`, size), expected: [KEEP_MATCH] }
  },
  "nested URL openers": (size) => {
    const depth = Math.floor(size / 7)
    return { text: `${KEEP}${"[a](h:".repeat(depth)}${")".repeat(depth)}`, expected: [KEEP_MATCH] }
  },
  "nested heading openers": (size) => {
    const depth = Math.floor(size / 6)
    return { text: `${KEEP}${"[a](#".repeat(depth)}${")".repeat(depth)}`, expected: [KEEP_MATCH] }
  },
  "openers before one long rejected destination": (size) => {
    const text = `${KEEP}${"[".repeat(size / 2)}](${"a".repeat(size / 2)}`
    return { text, expected: [KEEP_MATCH] }
  },
  "outer angle links failing after an inner link's title": (size) => {
    const block = '[a](< [b](x.md "t") > "x'
    const text = block.repeat(Math.floor(size / block.length))
    return { text, expected: innerTitleMatches(text, block) }
  },
}

const markdownFamily = variant ? markdownFamilies[variant] : undefined

const fixture = (size: number): { text: string; expected: unknown } => {
  if (markdownFamily) return markdownFamily(size)
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
  const scansLine = variant === "wiki" || variant === "markdown" || Boolean(markdownFamily)

  if (scansLine) return links.matchLinksInLine(text)
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
