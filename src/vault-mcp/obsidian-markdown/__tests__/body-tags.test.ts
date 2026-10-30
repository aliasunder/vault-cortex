import { describe, it, expect } from "vitest"
import { hasTagCandidate, parseBodyTags } from "../body-tags.js"
import { parseNoteSkippingUnreadableBlock } from "../frontmatter.js"
import vectorFile from "./fixtures/obsidian-body-tag-vectors.json" with { type: "json" }

type BodyTagVector = { label: string; input: string; expected: string[] }

const { vectors }: { vectors: BodyTagVector[] } = vectorFile

/** The body tags of a whole note, split the way the indexer splits it. */
const parseNoteBodyTags = (noteText: string): string[] => {
  return parseBodyTags(parseNoteSkippingUnreadableBlock(noteText).content)
}

describe("parseBodyTags against Obsidian 1.14.4", () => {
  it.each(vectors)("$label", ({ input, expected }) => {
    expect(parseNoteBodyTags(input)).toEqual(expected)
  })
})

// The expected values below were read from Obsidian 1.14.4 through the
// black-box oracle (scripts/obsidian-tag-oracle.ts), like the vectors.
describe("parseBodyTags skipped contexts", () => {
  it.each([
    { label: "fenced code", body: "```\n#a\n```\n#b" },
    { label: "indented code", body: "    #a\n\n#b" },
    { label: "an inline code span", body: "`#a` #b" },
    { label: "an HTML block", body: "<div>\n#a\n</div>\n\n#b" },
    { label: "a wikilink", body: "[[note|#a]] #b" },
    { label: "a URL", body: "https://x.com/#a #b" },
    { label: "an escaped hash", body: "\\#a #b" },
  ])("reads no tag from $label", ({ body }) => {
    expect(parseBodyTags(body)).toEqual(["b"])
  })

  it("reads no tag from inline or display math", () => {
    expect(parseBodyTags("$#a$ $$#b$$ #c")).toEqual(["c"])
  })

  it("reads no tag from a link destination or title", () => {
    expect(parseBodyTags('[t](#a "#b") #c')).toEqual(["c"])
  })
})

describe("parseBodyTags tag starts", () => {
  it("starts a tag right after another inline token", () => {
    expect(parseBodyTags("**b**#tag")).toEqual(["tag"])
  })

  it("lets plain text before the hash block a tag", () => {
    expect(parseBodyTags("foo#bar")).toEqual([])
  })

  it("drops a name made of digits only, and keeps one with another character", () => {
    expect(parseBodyTags("#1984 #19-84 #y1984")).toEqual(["19-84", "y1984"])
  })

  it("removes one trailing slash from a name, and drops a name left empty", () => {
    expect(parseBodyTags("#a/ #b// #/")).toEqual(["a", "b/"])
  })

  it("lists an inline footnote's tags after every tag outside one", () => {
    expect(parseBodyTags("#a ^[#b] #c\n\n#d")).toEqual(["a", "c", "d", "b"])
  })
})

describe("hasTagCandidate", () => {
  it("is true for a hash followed by a tag-name character", () => {
    expect(hasTagCandidate("see #a")).toBe(true)
  })

  it("is false for a hash followed by a space or nothing", () => {
    expect(hasTagCandidate("# heading #")).toBe(false)
  })

  it.each(vectors)("never skips a body Obsidian finds tags in: $label", ({ input, expected }) => {
    const body = parseNoteSkippingUnreadableBlock(input).content
    // A body without a candidate is never parsed, so it gets no tags
    const tagsAfterShortcut = hasTagCandidate(body) ? expected : []

    expect(tagsAfterShortcut).toEqual(expected)
  })
})
