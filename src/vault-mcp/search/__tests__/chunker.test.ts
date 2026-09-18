import { describe, it, expect } from "vitest"
import { buildChunkMetadataPrefix, chunkNoteContent } from "../chunker.js"

/** Generate a string of approximately N whitespace-separated tokens. */
const generateTokens = (count: number): string => {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ")
}

/** Generate N whitespace-separated tokens with a distinguishing label prefix,
 *  so each section's content is distinguishable in assertions. */
const generateLabeledTokens = (count: number, label: string): string => {
  return Array.from({ length: count }, (_, i) => `${label}${i}`).join(" ")
}

describe("chunkNoteContent", () => {
  describe("short notes (below threshold)", () => {
    it("returns a single chunk for a short note", () => {
      const chunks = chunkNoteContent("My Note", "Short body text here.")

      expect(chunks).toEqual([{ index: 0, text: "My Note\n\nShort body text here." }])
    })

    it("prefixes the chunk with the note title", () => {
      const chunks = chunkNoteContent("Title", "Body content.")

      expect(chunks[0]?.text).toBe("Title\n\nBody content.")
    })

    it("returns a single chunk for exactly 499 tokens", () => {
      const body = generateTokens(499)
      const chunks = chunkNoteContent("Note", body)

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${body}` }])
    })

    it("enters the splitting path at exactly 500 tokens (the threshold)", () => {
      const bodyWords = generateTokens(500).split(" ")
      const chunks = chunkNoteContent("Note", bodyWords.join(" "))

      // 500 tokens is NOT < CHUNK_THRESHOLD_TOKENS (500), so the splitting
      // path activates: a 449-token budget (450 minus the title) yields a
      // 449-token fragment plus a 51-token tail (over MIN, so not merged)
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${bodyWords.slice(0, 449).join(" ")}` },
        { index: 1, text: `Note\n\n${bodyWords.slice(449).join(" ")}` },
      ])
    })

    it("handles empty body", () => {
      const chunks = chunkNoteContent("Title", "")

      expect(chunks).toEqual([{ index: 0, text: "Title" }])
    })

    it("keeps a short note with headings on the single-chunk path with no Section line", () => {
      // Heading text stays inline in the stripped body — the hash-stability
      // contract: short notes are byte-identical to the historical output
      const chunks = chunkNoteContent("Note", "## Alpha\n\nalpha one two")

      expect(chunks).toEqual([{ index: 0, text: "Note\n\nAlpha\n\nalpha one two" }])
    })
  })

  describe("heading-based splitting", () => {
    it("splits a long note into per-section chunks, each carrying its Section line", () => {
      const section1 = generateLabeledTokens(200, "first")
      const section2 = generateLabeledTokens(200, "second")
      const section3 = generateLabeledTokens(200, "third")
      const body = `## Section 1\n${section1}\n\n## Section 2\n${section2}\n\n## Section 3\n${section3}`

      const chunks = chunkNoteContent("My Note", body)

      expect(chunks).toEqual([
        { index: 0, text: `My Note\nSection: Section 1\n\n${section1}` },
        { index: 1, text: `My Note\nSection: Section 2\n\n${section2}` },
        { index: 2, text: `My Note\nSection: Section 3\n\n${section3}` },
      ])
    })

    it("assigns sequential indices to chunks", () => {
      const body = `## A\n${generateTokens(200)}\n\n## B\n${generateTokens(200)}\n\n## C\n${generateTokens(200)}`
      const chunks = chunkNoteContent("Note", body)

      const indices = chunks.map((chunk) => chunk.index)
      expect(indices).toEqual(indices.map((_, i) => i))
    })

    it("emits preamble content as its own chunk with the base prefix", () => {
      const preamble = generateLabeledTokens(300, "preamble")
      const section = generateLabeledTokens(300, "section")
      const body = `${preamble}\n\n## Section\n${section}`

      const chunks = chunkNoteContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${preamble}` },
        { index: 1, text: `Note\nSection: Section\n\n${section}` },
      ])
    })

    it("emits a tiny preamble standalone rather than merging it into the first section", () => {
      const mainWords = generateLabeledTokens(520, "main").split(" ")
      const body = `intro line before headings\n\n## Main\n${mainWords.join(" ")}`

      const chunks = chunkNoteContent("Note", body)

      // Main's budget is 447 (450 minus the 3-token prefix), so its 520
      // tokens split 447 + 73 (over MIN, not merged)
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nintro line before headings" },
        { index: 1, text: `Note\nSection: Main\n\n${mainWords.slice(0, 447).join(" ")}` },
        { index: 2, text: `Note\nSection: Main\n\n${mainWords.slice(447).join(" ")}` },
      ])
    })
  })

  describe("nested headings", () => {
    it("gives nested sections disjoint bodies and ancestor-chain paths", () => {
      const alphaIntro = generateLabeledTokens(80, "alphaIntro")
      const childOne = generateLabeledTokens(120, "childOne")
      const childTwo = generateLabeledTokens(120, "childTwo")
      const beta = generateLabeledTokens(200, "beta")
      const body = `## Alpha\n${alphaIntro}\n\n### AlphaChildOne\n${childOne}\n\n### AlphaChildTwo\n${childTwo}\n\n## Beta\n${beta}`

      const chunks = chunkNoteContent("Probe", body)

      // Exact equality doubles as the duplication regression check: the
      // parent's chunk holds ONLY its intro, never its children's text
      expect(chunks).toEqual([
        { index: 0, text: `Probe\nSection: Alpha\n\n${alphaIntro}` },
        { index: 1, text: `Probe\nSection: Alpha > AlphaChildOne\n\n${childOne}` },
        { index: 2, text: `Probe\nSection: Alpha > AlphaChildTwo\n\n${childTwo}` },
        { index: 3, text: `Probe\nSection: Beta\n\n${beta}` },
      ])
    })

    it("emits nothing for a parent heading with no own body, keeping its path segment alive in descendants", () => {
      const childContent = generateLabeledTokens(400, "child")
      const otherContent = generateLabeledTokens(150, "other")
      const body = `## Parent\n### Child\n${childContent}\n\n## Other\n${otherContent}`

      const chunks = chunkNoteContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Parent > Child\n\n${childContent}` },
        { index: 1, text: `Note\nSection: Other\n\n${otherContent}` },
      ])
    })

    it("skips empty heading text in the Section path", () => {
      const contentWords = generateLabeledTokens(520, "content").split(" ")
      const body = `##\n${contentWords.join(" ")}`

      const chunks = chunkNoteContent("Note", body)

      // A bare `##` heading has no text: the path is empty, so no Section
      // line is emitted and the budget is 449 (450 minus the title)
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${contentWords.slice(0, 449).join(" ")}` },
        { index: 1, text: `Note\n\n${contentWords.slice(449).join(" ")}` },
      ])
    })
  })

  describe("small and empty sections", () => {
    it("emits a small section as its own chunk with its Section line", () => {
      const tinySection = generateLabeledTokens(20, "tiny")
      const normalSection = generateLabeledTokens(250, "normal")
      const anotherSection = generateLabeledTokens(250, "another")
      const body = `## Tiny\n${tinySection}\n\n## Normal\n${normalSection}\n\n## Another\n${anotherSection}`

      const chunks = chunkNoteContent("Note", body)

      // Sub-MIN sections are no longer merged across headings — the tiny
      // section keeps its own chunk and its own Section attribution
      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Tiny\n\n${tinySection}` },
        { index: 1, text: `Note\nSection: Normal\n\n${normalSection}` },
        { index: 2, text: `Note\nSection: Another\n\n${anotherSection}` },
      ])
    })

    it("emits nothing for an empty section", () => {
      const notesWords = generateLabeledTokens(500, "notes").split(" ")
      const body = `## Active\ncard one alpha\ncard two beta\n\n## Done\n\n## Notes\n${notesWords.join(" ")}`

      const chunks = chunkNoteContent("Note", body)

      // "Done" has no body → no chunk mentions it; Notes' 500 tokens split
      // 447 + 53 against its 3-token prefix budget
      expect(chunks).toEqual([
        { index: 0, text: "Note\nSection: Active\n\ncard one alpha\ncard two beta" },
        { index: 1, text: `Note\nSection: Notes\n\n${notesWords.slice(0, 447).join(" ")}` },
        { index: 2, text: `Note\nSection: Notes\n\n${notesWords.slice(447).join(" ")}` },
      ])
    })

    it("falls back to one whole-body chunk when every section is empty", () => {
      // 100 headings of 5 words each: ≥500 stripped tokens, so the split
      // path runs, but no heading has an own body
      const headingLines = Array.from(
        { length: 100 },
        (_, i) => `## heading${i} alpha beta gamma delta`,
      )
      const body = headingLines.join("\n")

      const chunks = chunkNoteContent("Note", body)

      const expectedStrippedBody = Array.from(
        { length: 100 },
        (_, i) => `heading${i} alpha beta gamma delta`,
      ).join("\n")
      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${expectedStrippedBody}` }])
    })
  })

  describe("paragraph sub-splitting", () => {
    it("splits an oversized section at paragraph boundaries", () => {
      // Six ~152-token paragraphs (~912 tokens) in one section, against a
      // 446-token budget (450 minus the 4-token prefix) → three 2-paragraph
      // sub-chunks
      const paragraphs = Array.from(
        { length: 6 },
        (_, i) => `Paragraph ${i}: ${generateTokens(150)}`,
      )
      const body = `## Big Section\n${paragraphs.join("\n\n")}`

      const chunks = chunkNoteContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Big Section\n\n${paragraphs[0]}\n\n${paragraphs[1]}` },
        { index: 1, text: `Note\nSection: Big Section\n\n${paragraphs[2]}\n\n${paragraphs[3]}` },
        { index: 2, text: `Note\nSection: Big Section\n\n${paragraphs[4]}\n\n${paragraphs[5]}` },
      ])
    })

    it("merges a sub-MIN trailing fragment backward into its predecessor", () => {
      const bigParagraph = generateLabeledTokens(440, "big")
      const tailParagraph = generateLabeledTokens(30, "tail")
      const padSection = generateLabeledTokens(60, "pad")
      const body = `## Big\n${bigParagraph}\n\n${tailParagraph}\n\n## Pad\n${padSection}`

      const chunks = chunkNoteContent("Note", body)

      // 440 + 30 exceeds the 447-token budget, so the section splits — but
      // the 30-token tail is under MIN and merges back, slightly over budget
      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Big\n\n${bigParagraph}\n\n${tailParagraph}` },
        { index: 1, text: `Note\nSection: Pad\n\n${padSection}` },
      ])
    })

    it("floors a section's budget at MIN_CHUNK_TOKENS when its heading path is huge", () => {
      const hugeHeading = generateLabeledTokens(419, "heading")
      const smallBodyWords = generateLabeledTokens(120, "body").split(" ")
      const normalSection = generateLabeledTokens(400, "normal")
      const body = `## ${hugeHeading}\n${smallBodyWords.join(" ")}\n\n## Normal\n${normalSection}`

      const chunks = chunkNoteContent("Note", body)

      // The 421-token prefix would leave a 29-token budget; the 50-token
      // floor catches it: 120 tokens → 50 + 50 + 20, and the sub-MIN
      // 20-token tail merges backward → two fragments for that section
      expect(chunks).toEqual([
        {
          index: 0,
          text: `Note\nSection: ${hugeHeading}\n\n${smallBodyWords.slice(0, 50).join(" ")}`,
        },
        {
          index: 1,
          text: `Note\nSection: ${hugeHeading}\n\n${smallBodyWords.slice(50, 100).join(" ")}\n\n${smallBodyWords.slice(100).join(" ")}`,
        },
        { index: 2, text: `Note\nSection: Normal\n\n${normalSection}` },
      ])
    })
  })

  describe("no-heading long notes", () => {
    it("splits at paragraph boundaries when no headings exist", () => {
      const paragraphs = Array.from(
        { length: 8 },
        (_, i) => `Paragraph ${i}: ${generateTokens(100)}`,
      )
      const body = paragraphs.join("\n\n")

      const chunks = chunkNoteContent("Note", body)

      // 8 paragraphs of ~102 tokens each against a 449-token budget → two
      // 4-paragraph chunks
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${paragraphs.slice(0, 4).join("\n\n")}` },
        { index: 1, text: `Note\n\n${paragraphs.slice(4).join("\n\n")}` },
      ])
    })
  })

  describe("markdown stripping in chunks", () => {
    it("strips wikilinks in chunk text", () => {
      const body = `Some text with [[Target|display text]] and more ${generateTokens(10)}`
      const chunks = chunkNoteContent("Note", body)

      expect(chunks[0]?.text).toContain("display text")
      expect(chunks[0]?.text).not.toContain("[[")
    })

    it("strips bold/italic markers in chunk text", () => {
      const body = `This has **bold** and *italic* text ${generateTokens(10)}`
      const chunks = chunkNoteContent("Note", body)

      expect(chunks[0]?.text).toContain("bold")
      expect(chunks[0]?.text).toContain("italic")
      expect(chunks[0]?.text).not.toContain("**")
      expect(chunks[0]?.text).not.toContain("*italic*")
    })

    it("strips heading markers in chunk text", () => {
      const section = generateTokens(200)
      const body = `## My Section\n${section}\n\n## Another\n${generateTokens(200)}`
      const chunks = chunkNoteContent("Note", body)

      const allText = chunks.map((chunk) => chunk.text).join("\n")
      expect(allText).toContain("My Section")
      expect(allText).not.toContain("## My Section")
    })
  })

  describe("chunk structure", () => {
    it("returns NoteChunk objects with index and text", () => {
      const chunks = chunkNoteContent("Note", "Body text")

      expect(chunks).toEqual([{ index: 0, text: "Note\n\nBody text" }])
    })

    it("always returns at least one chunk", () => {
      const chunks = chunkNoteContent("Note", "")
      expect(chunks).toEqual([{ index: 0, text: "Note" }])
    })
  })

  describe("metadata prefix enrichment", () => {
    it("prefixes every chunk with title, Section line, then the metadata line", () => {
      const section1 = generateLabeledTokens(300, "one")
      const section2 = generateLabeledTokens(300, "two")
      const body = `## One\n\n${section1}\n\n## Two\n\n${section2}`

      const chunks = chunkNoteContent("Note", body, {
        metadataPrefix: "Type: session-log. Tags: project/vault-cortex.",
      })

      expect(chunks).toEqual([
        {
          index: 0,
          text: `Note\nSection: One\nType: session-log. Tags: project/vault-cortex.\n\n${section1}`,
        },
        {
          index: 1,
          text: `Note\nSection: Two\nType: session-log. Tags: project/vault-cortex.\n\n${section2}`,
        },
      ])
    })

    it("counts the prefix against the chunk budget", () => {
      // 490 body tokens fit one chunk bare (short-note path never splits
      // without a prefix). "Note" plus the 15-token prefix costs 16 tokens,
      // leaving a 434-token budget (450 − 16), so the body splits at word
      // 434 into 434 + 56 (over MIN, so not merged).
      const body = generateTokens(490)
      const bodyWords = body.split(" ")
      const longPrefix = `Tags: ${generateTokens(14)}.`

      expect(chunkNoteContent("Note", body)).toEqual([{ index: 0, text: `Note\n\n${body}` }])
      expect(chunkNoteContent("Note", body, { metadataPrefix: longPrefix })).toEqual([
        {
          index: 0,
          text: `Note\n${longPrefix}\n\n${bodyWords.slice(0, 434).join(" ")}`,
        },
        {
          index: 1,
          text: `Note\n${longPrefix}\n\n${bodyWords.slice(434).join(" ")}`,
        },
      ])
    })

    it("floors the budget at MIN_CHUNK_TOKENS when the prefix is very large", () => {
      // A ~420-token prefix would shrink the budget to ~30 without the
      // floor, but MIN_CHUNK_TOKENS (50) catches it. 120 body tokens at a
      // 50-token floor → 50 + 50 + 20, and the sub-MIN 20-token tail
      // merges backward → 2 chunks.
      const hugePrefix = `Tags: ${generateTokens(419)}.`
      const bodyWords = generateTokens(120).split(" ")

      const chunks = chunkNoteContent("Note", bodyWords.join(" "), {
        metadataPrefix: hugePrefix,
      })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n${hugePrefix}\n\n${bodyWords.slice(0, 50).join(" ")}` },
        {
          index: 1,
          text: `Note\n${hugePrefix}\n\n${bodyWords.slice(50, 100).join(" ")}\n\n${bodyWords.slice(100).join(" ")}`,
        },
      ])
    })

    it("produces identical chunks with a null prefix as with no options", () => {
      const body = `## One\n\n${generateTokens(300)}\n\n## Two\n\n${generateTokens(300)}`

      expect(chunkNoteContent("Note", body, { metadataPrefix: null })).toEqual(
        chunkNoteContent("Note", body),
      )
    })
  })
})

describe("buildChunkMetadataPrefix", () => {
  it("joins type and tags into one line", () => {
    expect(
      buildChunkMetadataPrefix({
        type: "session-log",
        tags: ["session-log", "project/vault-cortex"],
      }),
    ).toBe("Type: session-log. Tags: session-log, project/vault-cortex.")
  })

  it("emits type alone when there are no tags", () => {
    expect(buildChunkMetadataPrefix({ type: "reference", tags: [] })).toBe("Type: reference.")
  })

  it("emits tags alone when type is null", () => {
    expect(buildChunkMetadataPrefix({ type: null, tags: ["daily-note"] })).toBe("Tags: daily-note.")
  })

  it("returns null when the note has neither type nor tags", () => {
    expect(buildChunkMetadataPrefix({ type: null, tags: [] })).toBeNull()
  })
})
