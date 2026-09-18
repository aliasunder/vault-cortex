import { describe, it, expect } from "vitest"
import { buildChunkMetadataPrefix, chunkContent } from "../chunker.js"

/** Generate a string of approximately N whitespace-separated tokens. */
const generateTokens = (count: number): string => {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ")
}

/** Generate N whitespace-separated tokens with a distinguishing label prefix,
 *  so each section's content is distinguishable in assertions. */
const generateLabeledTokens = (count: number, label: string): string => {
  return Array.from({ length: count }, (_, i) => `${label}${i}`).join(" ")
}

describe("chunkContent", () => {
  describe("short notes (below threshold)", () => {
    it("returns a single chunk for a short note", () => {
      const chunks = chunkContent("My Note", "Short body text here.")

      expect(chunks).toEqual([{ index: 0, text: "My Note\n\nShort body text here." }])
    })

    it("prefixes the chunk with the note title", () => {
      const chunks = chunkContent("Title", "Body content.")

      expect(chunks).toEqual([{ index: 0, text: "Title\n\nBody content." }])
    })

    it("returns a single chunk for exactly 499 tokens", () => {
      const body = generateTokens(499)
      const chunks = chunkContent("Note", body)

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${body}` }])
    })

    it("enters the splitting path at exactly 500 tokens (the threshold)", () => {
      const bodyWords = generateTokens(500).split(" ")
      const chunks = chunkContent("Note", bodyWords.join(" "))

      // 500 tokens is NOT < CHUNK_THRESHOLD_TOKENS (500), so the splitting
      // path activates: a 449-token budget (450 minus the title) yields a
      // 449-token fragment plus a 51-token tail (over MIN, so not merged)
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${bodyWords.slice(0, 449).join(" ")}` },
        { index: 1, text: `Note\n\n${bodyWords.slice(449).join(" ")}` },
      ])
    })

    it("handles empty body", () => {
      const chunks = chunkContent("Title", "")

      expect(chunks).toEqual([{ index: 0, text: "Title" }])
    })

    it("keeps a short note with headings on the single-chunk path with no Section line", () => {
      // Heading text stays inline in the stripped body — the hash-stability
      // contract: short notes are byte-identical to the historical output
      const chunks = chunkContent("Note", "## Alpha\n\nalpha one two")

      expect(chunks).toEqual([{ index: 0, text: "Note\n\nAlpha\n\nalpha one two" }])
    })
  })

  describe("heading-based splitting", () => {
    it("splits a long note into per-section chunks, each carrying its Section line", () => {
      const section1 = generateLabeledTokens(200, "first")
      const section2 = generateLabeledTokens(200, "second")
      const section3 = generateLabeledTokens(200, "third")
      const body = `## Section 1\n${section1}\n\n## Section 2\n${section2}\n\n## Section 3\n${section3}`

      const chunks = chunkContent("My Note", body)

      expect(chunks).toEqual([
        { index: 0, text: "My Note\n\nSection 1\nSection 2\nSection 3" },
        { index: 1, text: `My Note\nSection: Section 1\n\n${section1}` },
        { index: 2, text: `My Note\nSection: Section 2\n\n${section2}` },
        { index: 3, text: `My Note\nSection: Section 3\n\n${section3}` },
      ])
    })

    it("assigns sequential indices to chunks", () => {
      const body = `## A\n${generateTokens(200)}\n\n## B\n${generateTokens(200)}\n\n## C\n${generateTokens(200)}`
      const chunks = chunkContent("Note", body)

      const indices = chunks.map((chunk) => chunk.index)
      expect(indices).toEqual(indices.map((_, i) => i))
    })

    it("emits preamble content as its own chunk with the base prefix", () => {
      const preamble = generateLabeledTokens(300, "preamble")
      const section = generateLabeledTokens(300, "section")
      const body = `${preamble}\n\n## Section\n${section}`

      const chunks = chunkContent("Note", body)

      // A singleton top-level heading gets no Section line (see the
      // singleton-wrapper tests) — the preamble still emits standalone
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nSection" },
        { index: 1, text: `Note\n\n${preamble}` },
        { index: 2, text: `Note\n\n${section}` },
      ])
    })

    it("emits a tiny preamble standalone rather than merging it into the first section", () => {
      const mainWords = generateLabeledTokens(520, "main").split(" ")
      const body = `intro line before headings\n\n## Main\n${mainWords.join(" ")}`

      const chunks = chunkContent("Note", body)

      // Main is a singleton top-level heading (no Section line), so its
      // budget is 449 (450 minus the title): 520 tokens split 449 + 71
      // (over MIN, not merged)
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nMain" },
        { index: 1, text: "Note\n\nintro line before headings" },
        { index: 2, text: `Note\n\n${mainWords.slice(0, 449).join(" ")}` },
        { index: 3, text: `Note\n\n${mainWords.slice(449).join(" ")}` },
      ])
    })
  })

  describe("nested headings", () => {
    it("gives a top-level section an aggregate spanning its children, and each child a disjoint path-attributed chunk", () => {
      const alphaIntro = generateLabeledTokens(80, "alphaIntro")
      const childOne = generateLabeledTokens(120, "childOne")
      const childTwo = generateLabeledTokens(120, "childTwo")
      const beta = generateLabeledTokens(200, "beta")
      const body = `## Alpha\n${alphaIntro}\n\n### AlphaChildOne\n${childOne}\n\n### AlphaChildTwo\n${childTwo}\n\n## Beta\n${beta}`

      const chunks = chunkContent("Probe", body)

      // Exact equality pins the two-view design: child text embeds once in
      // the top-level aggregate and once in its own disjoint chunk, and the
      // parent emits no separate intro-only chunk
      expect(chunks).toEqual([
        { index: 0, text: "Probe\n\nAlpha\nAlphaChildOne\nAlphaChildTwo\nBeta" },
        {
          index: 1,
          text: `Probe\nSection: Alpha\n\n${alphaIntro}\n\nAlphaChildOne\n${childOne}\n\nAlphaChildTwo\n${childTwo}`,
        },
        { index: 2, text: `Probe\nSection: Alpha > AlphaChildOne\n\n${childOne}` },
        { index: 3, text: `Probe\nSection: Alpha > AlphaChildTwo\n\n${childTwo}` },
        { index: 4, text: `Probe\nSection: Beta\n\n${beta}` },
      ])
    })

    it("keeps deeper parent headings disjoint — only top-level headings aggregate", () => {
      const middleIntro = generateLabeledTokens(250, "middleIntro")
      const leafContent = generateLabeledTokens(250, "leaf")
      const body = `# Doc\n\n## Middle\n${middleIntro}\n\n### Leaf\n${leafContent}`

      const chunks = chunkContent("Note", body)

      // The singleton H1 aggregates the whole note (title-only prefix,
      // 502 tokens split at the paragraph boundary); Middle — a parent
      // but not top-level — keeps only its own intro
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nDoc\nMiddle\nLeaf" },
        { index: 1, text: `Note\n\nMiddle\n${middleIntro}` },
        { index: 2, text: `Note\n\nLeaf\n${leafContent}` },
        { index: 3, text: `Note\nSection: Doc > Middle\n\n${middleIntro}` },
        { index: 4, text: `Note\nSection: Doc > Middle > Leaf\n\n${leafContent}` },
      ])
    })

    it("emits an aggregate for a top-level parent with no own body, keeping its name in the TOC and in descendants' paths", () => {
      const childContent = generateLabeledTokens(400, "child")
      const otherContent = generateLabeledTokens(150, "other")
      const body = `## Parent\n### Child\n${childContent}\n\n## Other\n${otherContent}`

      const chunks = chunkContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nParent\nChild\nOther" },
        { index: 1, text: `Note\nSection: Parent\n\nChild\n${childContent}` },
        { index: 2, text: `Note\nSection: Parent > Child\n\n${childContent}` },
        { index: 3, text: `Note\nSection: Other\n\n${otherContent}` },
      ])
    })

    it("aggregates the whole note under a singleton wrapper heading, with sub-chunks crossing child boundaries", () => {
      const introContent = generateLabeledTokens(50, "intro")
      const firstContent = generateLabeledTokens(300, "first")
      const secondContent = generateLabeledTokens(300, "second")
      const body = `# Guide\n${introContent}\n\n## First\n${firstContent}\n\n## Second\n${secondContent}`

      const chunks = chunkContent("Note", body)

      // The 652-token wrapper span splits at paragraph boundaries against
      // its 449-token title-only budget: intro + First land in one chunk
      // (351 tokens) — a content-anchored boundary no heading-anchored
      // chunk produces — and Second fills the next
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nGuide\nFirst\nSecond" },
        { index: 1, text: `Note\n\n${introContent}\n\nFirst\n${firstContent}` },
        { index: 2, text: `Note\n\nSecond\n${secondContent}` },
        { index: 3, text: `Note\nSection: Guide > First\n\n${firstContent}` },
        { index: 4, text: `Note\nSection: Guide > Second\n\n${secondContent}` },
      ])
    })

    it("skips empty heading text in the Section path", () => {
      const contentWords = generateLabeledTokens(520, "content").split(" ")
      const body = `##\n${contentWords.join(" ")}`

      const chunks = chunkContent("Note", body)

      // A bare `##` heading has no text: the path is empty, so no Section
      // line and no TOC chunk are emitted, and the budget is 449 (450
      // minus the title)
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

      const chunks = chunkContent("Note", body)

      // Sub-MIN sections are no longer merged across headings — the tiny
      // section keeps its own chunk and its own Section attribution
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nTiny\nNormal\nAnother" },
        { index: 1, text: `Note\nSection: Tiny\n\n${tinySection}` },
        { index: 2, text: `Note\nSection: Normal\n\n${normalSection}` },
        { index: 3, text: `Note\nSection: Another\n\n${anotherSection}` },
      ])
    })

    it("emits no section chunk for an empty section, keeping its name in the TOC", () => {
      const notesWords = generateLabeledTokens(500, "notes").split(" ")
      const body = `## Active\ncard one alpha\ncard two beta\n\n## Done\n\n## Notes\n${notesWords.join(" ")}`

      const chunks = chunkContent("Note", body)

      // "Done" has no body → no section chunk, but its name stays in the
      // TOC; Notes' 500 tokens split 447 + 53 against its 3-token prefix
      // budget
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nActive\nDone\nNotes" },
        { index: 1, text: "Note\nSection: Active\n\ncard one alpha\ncard two beta" },
        { index: 2, text: `Note\nSection: Notes\n\n${notesWords.slice(0, 447).join(" ")}` },
        { index: 3, text: `Note\nSection: Notes\n\n${notesWords.slice(447).join(" ")}` },
      ])
    })

    it("emits only a TOC chunk, its name list truncated at the budget, when every section is empty", () => {
      // 100 headings of 5 words each: ≥500 stripped tokens, so the split
      // path runs, but no heading has an own body. The TOC name list
      // truncates at its 449-token budget (450 minus the title): 89
      // five-token names fit, the 90th would overflow.
      const headingLines = Array.from(
        { length: 100 },
        (_, i) => `## heading${i} alpha beta gamma delta`,
      )
      const body = headingLines.join("\n")

      const chunks = chunkContent("Note", body)

      const expectedHeadingNames = Array.from(
        { length: 89 },
        (_, i) => `heading${i} alpha beta gamma delta`,
      ).join("\n")
      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${expectedHeadingNames}` }])
    })
  })

  describe("table of contents chunk", () => {
    it("prepends the note's folder segments to the TOC title line, leaving section chunks bare", () => {
      const activeContent = generateLabeledTokens(300, "active")
      const doneContent = generateLabeledTokens(300, "done")
      const body = `## Active\n${activeContent}\n\n## Done\n${doneContent}`

      const chunks = chunkContent("TASKS", body, {
        sourcePath: "Code Projects/my-repo/TASKS.md",
      })

      // Folder segments reach only the TOC line — boards sharing standard
      // lane names emit distinct TOC chunks instead of byte-identical ones
      expect(chunks).toEqual([
        { index: 0, text: "Code Projects > my-repo > TASKS\n\nActive\nDone" },
        { index: 1, text: `TASKS\nSection: Active\n\n${activeContent}` },
        { index: 2, text: `TASKS\nSection: Done\n\n${doneContent}` },
      ])
    })

    it("keeps the bare title on the TOC line for a root-level note path", () => {
      const activeContent = generateLabeledTokens(300, "active")
      const doneContent = generateLabeledTokens(300, "done")
      const body = `## Active\n${activeContent}\n\n## Done\n${doneContent}`

      const chunks = chunkContent("TASKS", body, { sourcePath: "TASKS.md" })

      expect(chunks).toEqual([
        { index: 0, text: "TASKS\n\nActive\nDone" },
        { index: 1, text: `TASKS\nSection: Active\n\n${activeContent}` },
        { index: 2, text: `TASKS\nSection: Done\n\n${doneContent}` },
      ])
    })

    it("omits the TOC chunk when the folder-enriched title exhausts the heading-name budget", () => {
      const section1 = generateLabeledTokens(300, "first")
      const section2 = generateLabeledTokens(300, "second")
      const body = `## S1\n${section1}\n\n## S2\n${section2}`
      // 449 words as a single directory name → titleLine is 451 tokens
      // (449 folder + ">" + "Note"), leaving -1 budget for heading names
      const longFolderPath = `${generateTokens(449)}/note.md`

      const chunks = chunkContent("Note", body, { sourcePath: longFolderPath })

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: S1\n\n${section1}` },
        { index: 1, text: `Note\nSection: S2\n\n${section2}` },
      ])
    })

    it("omits empty-text headings from the TOC name list", () => {
      const bareSectionContent = generateLabeledTokens(300, "bare")
      const namedSectionContent = generateLabeledTokens(300, "named")
      const body = `##\n${bareSectionContent}\n\n## Named\n${namedSectionContent}`

      const chunks = chunkContent("Note", body)

      // The bare `##` section still emits its body (with no Section line),
      // but only the named heading appears in the TOC
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nNamed" },
        { index: 1, text: `Note\n\n${bareSectionContent}` },
        { index: 2, text: `Note\nSection: Named\n\n${namedSectionContent}` },
      ])
    })
  })

  describe("paragraph sub-splitting", () => {
    it("splits an oversized section at paragraph boundaries", () => {
      // Six ~152-token paragraphs (~912 tokens) in one singleton section
      // (no Section line), against a 449-token budget (450 minus the
      // title) → three 2-paragraph sub-chunks
      const paragraphs = Array.from(
        { length: 6 },
        (_, i) => `Paragraph ${i}: ${generateTokens(150)}`,
      )
      const body = `## Big Section\n${paragraphs.join("\n\n")}`

      const chunks = chunkContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nBig Section" },
        { index: 1, text: `Note\n\n${paragraphs[0]}\n\n${paragraphs[1]}` },
        { index: 2, text: `Note\n\n${paragraphs[2]}\n\n${paragraphs[3]}` },
        { index: 3, text: `Note\n\n${paragraphs[4]}\n\n${paragraphs[5]}` },
      ])
    })

    it("merges a sub-MIN trailing fragment backward into its predecessor", () => {
      const bigParagraph = generateLabeledTokens(440, "big")
      const tailParagraph = generateLabeledTokens(30, "tail")
      const padSection = generateLabeledTokens(60, "pad")
      const body = `## Big\n${bigParagraph}\n\n${tailParagraph}\n\n## Pad\n${padSection}`

      const chunks = chunkContent("Note", body)

      // 440 + 30 exceeds the 447-token budget, so the section splits — but
      // the 30-token tail is under MIN and merges back, slightly over budget
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nBig\nPad" },
        { index: 1, text: `Note\nSection: Big\n\n${bigParagraph}\n\n${tailParagraph}` },
        { index: 2, text: `Note\nSection: Pad\n\n${padSection}` },
      ])
    })

    it("floors a section's budget at MIN_CHUNK_TOKENS when its heading path is huge", () => {
      const hugeHeading = generateLabeledTokens(419, "heading")
      const smallBodyWords = generateLabeledTokens(120, "body").split(" ")
      const normalSection = generateLabeledTokens(400, "normal")
      const body = `## ${hugeHeading}\n${smallBodyWords.join(" ")}\n\n## Normal\n${normalSection}`

      const chunks = chunkContent("Note", body)

      // The 421-token prefix would leave a 29-token budget; the 50-token
      // floor catches it: 120 tokens → 50 + 50 + 20, and the sub-MIN
      // 20-token tail merges backward → two fragments for that section.
      // The TOC keeps both names: 419 + 1 tokens fit its 449-token budget.
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${hugeHeading}\nNormal` },
        {
          index: 1,
          text: `Note\nSection: ${hugeHeading}\n\n${smallBodyWords.slice(0, 50).join(" ")}`,
        },
        {
          index: 2,
          text: `Note\nSection: ${hugeHeading}\n\n${smallBodyWords.slice(50, 100).join(" ")}\n\n${smallBodyWords.slice(100).join(" ")}`,
        },
        { index: 3, text: `Note\nSection: Normal\n\n${normalSection}` },
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

      const chunks = chunkContent("Note", body)

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
      const filler = generateTokens(10)
      const body = `Some text with [[Target|display text]] and more ${filler}`
      const chunks = chunkContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nSome text with display text and more ${filler}` },
      ])
    })

    it("strips bold/italic markers in chunk text", () => {
      const filler = generateTokens(10)
      const body = `This has **bold** and *italic* text ${filler}`
      const chunks = chunkContent("Note", body)

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nThis has bold and italic text ${filler}` },
      ])
    })

    it("strips heading markers in chunk text", () => {
      const firstSection = generateLabeledTokens(200, "first")
      const secondSection = generateLabeledTokens(200, "second")
      const body = `## My Section\n${firstSection}\n\n## Another\n${secondSection}`
      const chunks = chunkContent("Note", body)

      // 403 stripped tokens (< 500 threshold) → single chunk, no heading
      // splitting; heading markers removed, text preserved inline
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nMy Section\n${firstSection}\n\nAnother\n${secondSection}` },
      ])
    })
  })

  describe("chunk structure", () => {
    it("returns NoteChunk objects with index and text", () => {
      const chunks = chunkContent("Note", "Body text")

      expect(chunks).toEqual([{ index: 0, text: "Note\n\nBody text" }])
    })

    it("always returns at least one chunk", () => {
      const chunks = chunkContent("Note", "")
      expect(chunks).toEqual([{ index: 0, text: "Note" }])
    })
  })

  describe("metadata prefix enrichment", () => {
    it("prefixes every section chunk with title, Section line, then the metadata line, leaving the TOC chunk bare", () => {
      const section1 = generateLabeledTokens(300, "one")
      const section2 = generateLabeledTokens(300, "two")
      const body = `## One\n\n${section1}\n\n## Two\n\n${section2}`

      const chunks = chunkContent("Note", body, {
        metadataPrefix: "Type: session-log. Tags: project/vault-cortex.",
      })

      // The TOC chunk never carries the metadata line — on a chunk this
      // small the line would dominate the token average, and same-type
      // notes would all share it, washing out note-vs-note discrimination
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nOne\nTwo" },
        {
          index: 1,
          text: `Note\nSection: One\nType: session-log. Tags: project/vault-cortex.\n\n${section1}`,
        },
        {
          index: 2,
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

      expect(chunkContent("Note", body)).toEqual([{ index: 0, text: `Note\n\n${body}` }])
      expect(chunkContent("Note", body, { metadataPrefix: longPrefix })).toEqual([
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

      const chunks = chunkContent("Note", bodyWords.join(" "), {
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

      expect(chunkContent("Note", body, { metadataPrefix: null })).toEqual(
        chunkContent("Note", body),
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
