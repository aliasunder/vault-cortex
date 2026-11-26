import {
  CHILD_DEADLINE_MS,
  runScriptInChild,
} from "../../../__tests__/helpers/run-script-in-child.js"
import { describe, it, expect } from "vitest"
import { stripMarkdownSyntax } from "../../obsidian-markdown/plaintext.js"
import { buildChunkMetadataPrefix, chunkContent } from "../chunker.js"

/** A quadratic pass over input this long runs for minutes; a linear one takes
 *  well under a second. */
const LONG_RUN_LENGTH = 1_000_000

/** Generate a string of approximately N whitespace-separated tokens. */
const generateTokens = (count: number): string => {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ")
}

/** Generate N whitespace-separated tokens with a distinguishing label prefix,
 *  so each section's content is distinguishable in assertions. */
const generateLabeledTokens = (count: number, label: string): string => {
  return Array.from({ length: count }, (_, i) => `${label}${i}`).join(" ")
}

/** Generate N distinct tokens of at most four characters each (a one-letter
 *  label and a base-36 index), so a run of several hundred tokens stays under
 *  the 2,000-character cut on each chunk prefix part. */
const generateShortLabeledTokens = (count: number, label: string): string => {
  return Array.from({ length: count }, (_, i) => `${label}${i.toString(36)}`).join(" ")
}

describe("chunkContent", () => {
  describe("short notes (below threshold)", () => {
    it("returns a single chunk for a short note", () => {
      const chunks = chunkContent({ noteTitle: "My Note", bodyContent: "Short body text here." })

      expect(chunks).toEqual([{ index: 0, text: "My Note\n\nShort body text here." }])
    })

    it("prefixes the chunk with the note title", () => {
      const chunks = chunkContent({ noteTitle: "Title", bodyContent: "Body content." })

      expect(chunks).toEqual([{ index: 0, text: "Title\n\nBody content." }])
    })

    it("returns a single chunk for exactly 499 tokens", () => {
      const body = generateTokens(499)
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${body}` }])
    })

    it("enters the splitting path at exactly 500 tokens (the threshold)", () => {
      const bodyWords = generateTokens(500).split(" ")
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: bodyWords.join(" ") })

      // 500 tokens is NOT < CHUNK_THRESHOLD_TOKENS (500), so the splitting
      // path activates: a 449-token budget (450 minus the title) yields a
      // 449-token fragment plus a 51-token tail (over MIN, so not merged)
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${bodyWords.slice(0, 449).join(" ")}` },
        { index: 1, text: `Note\n\n${bodyWords.slice(449).join(" ")}` },
      ])
    })

    it("handles empty body", () => {
      const chunks = chunkContent({ noteTitle: "Title", bodyContent: "" })

      expect(chunks).toEqual([{ index: 0, text: "Title" }])
    })

    it("ignores sourcePath below the split threshold — the hash-stability contract", () => {
      // Short content must stay byte-identical with or without sourcePath,
      // or every short note and file re-embeds on upgrade
      expect(
        chunkContent({
          noteTitle: "Note",
          bodyContent: "Short body text here.",
          sourcePath: "Folder Alpha/Sub/Note.md",
        }),
      ).toEqual([{ index: 0, text: "Note\n\nShort body text here." }])
      expect(
        chunkContent({
          noteTitle: "data",
          bodyContent: "one short csv preview row",
          sourcePath: "Folder Alpha/data.csv",
        }),
      ).toEqual([{ index: 0, text: "data\n\none short csv preview row" }])
    })

    it("keeps a short note with headings on the single-chunk path with no Section line", () => {
      // Heading text stays inline in the stripped body — the hash-stability
      // contract: short notes are byte-identical to the historical output
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: "## Alpha\n\nalpha one two" })

      expect(chunks).toEqual([{ index: 0, text: "Note\n\nAlpha\n\nalpha one two" }])
    })
  })

  describe("heading-based splitting", () => {
    it("chunks heading counts above the engine's call-argument limit", () => {
      const bodyContent = "# h\n".repeat(150_000)

      expect(chunkContent({ noteTitle: "Many", bodyContent })).toEqual([
        { index: 0, text: `Many\n\n${Array.from({ length: 449 }, () => "h").join("\n")}` },
      ])
    })

    it("splits a long note into per-section chunks, each carrying its Section line", () => {
      const section1 = generateLabeledTokens(200, "first")
      const section2 = generateLabeledTokens(200, "second")
      const section3 = generateLabeledTokens(200, "third")
      const body = `## Section 1\n${section1}\n\n## Section 2\n${section2}\n\n## Section 3\n${section3}`

      const chunks = chunkContent({ noteTitle: "My Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `My Note\nSection: Section 1\n\n${section1}` },
        { index: 1, text: `My Note\nSection: Section 2\n\n${section2}` },
        { index: 2, text: `My Note\nSection: Section 3\n\n${section3}` },
        { index: 3, text: "My Note\n\nSection 1\nSection 2\nSection 3" },
      ])
    })

    it("assigns sequential indices to chunks", () => {
      const body = `## A\n${generateTokens(200)}\n\n## B\n${generateTokens(200)}\n\n## C\n${generateTokens(200)}`
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      const indices = chunks.map((chunk) => chunk.index)
      expect(indices).toEqual(indices.map((_, i) => i))
    })

    it("emits preamble content as its own chunk with the base prefix", () => {
      const preamble = generateLabeledTokens(300, "preamble")
      const section = generateLabeledTokens(300, "section")
      const body = `${preamble}\n\n## Section\n${section}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The preamble emits standalone, first, so chunk 0 stays title +
      // intro for the rerank fallback — and its presence means the lone
      // heading does not wrap the note, so it keeps its Section line
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${preamble}` },
        { index: 1, text: `Note\nSection: Section\n\n${section}` },
        { index: 2, text: "Note\n\nSection" },
      ])
    })

    it("sub-splits a large preamble and prefixes every fragment with the base prefix", () => {
      const preambleWords = generateLabeledTokens(900, "preamble").split(" ")
      const section = generateLabeledTokens(200, "section")
      const body = `${preambleWords.join(" ")}\n\n## Section\n${section}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // 900 tokens against a 449-token budget → first 449 in chunk 0, the
      // remaining 451 in chunk 1 (the sub-MIN tail merges backward into the
      // second fragment). Both carry the bare title prefix — a refactor that
      // drops the prefix from non-first preamble fragments ships chunks
      // without attribution.
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${preambleWords.slice(0, 449).join(" ")}` },
        {
          index: 1,
          text: `Note\n\n${preambleWords.slice(449, 898).join(" ")}\n\n${preambleWords.slice(898).join(" ")}`,
        },
        { index: 2, text: `Note\nSection: Section\n\n${section}` },
        { index: 3, text: "Note\n\nSection" },
      ])
    })

    it("emits a tiny preamble standalone rather than merging it into the first section", () => {
      const mainWords = generateLabeledTokens(520, "main").split(" ")
      const body = `intro line before headings\n\n## Main\n${mainWords.join(" ")}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The preamble means Main does not wrap the note, so it keeps its
      // Section line and a 447-token budget (450 minus the 3-token
      // prefix): 520 tokens split 447 + 73 (over MIN, not merged)
      expect(chunks).toEqual([
        { index: 0, text: "Note\n\nintro line before headings" },
        { index: 1, text: `Note\nSection: Main\n\n${mainWords.slice(0, 447).join(" ")}` },
        { index: 2, text: `Note\nSection: Main\n\n${mainWords.slice(447).join(" ")}` },
        { index: 3, text: "Note\n\nMain" },
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

      const chunks = chunkContent({ noteTitle: "Probe", bodyContent: body })

      // Exact equality pins the two-view design: child text embeds once in
      // the top-level aggregate and once in its own disjoint chunk, and the
      // parent emits no separate intro-only chunk
      expect(chunks).toEqual([
        {
          index: 0,
          text: `Probe\nSection: Alpha\n\n${alphaIntro}\n\nAlphaChildOne\n${childOne}\n\nAlphaChildTwo\n${childTwo}`,
        },
        { index: 1, text: `Probe\nSection: Alpha > AlphaChildOne\n\n${childOne}` },
        { index: 2, text: `Probe\nSection: Alpha > AlphaChildTwo\n\n${childTwo}` },
        { index: 3, text: `Probe\nSection: Beta\n\n${beta}` },
        { index: 4, text: "Probe\n\nAlpha\nAlphaChildOne\nAlphaChildTwo\nBeta" },
      ])
    })

    it("keeps deeper parent headings disjoint — only top-level headings aggregate", () => {
      const middleIntro = generateLabeledTokens(250, "middleIntro")
      const leafContent = generateLabeledTokens(250, "leaf")
      const body = `# Doc\n\n## Middle\n${middleIntro}\n\n### Leaf\n${leafContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The singleton H1 aggregates the whole note (title-only prefix,
      // 502 tokens split at the paragraph boundary); Middle — a parent
      // but not top-level — keeps only its own intro
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nMiddle\n${middleIntro}` },
        { index: 1, text: `Note\n\nLeaf\n${leafContent}` },
        { index: 2, text: `Note\nSection: Doc > Middle\n\n${middleIntro}` },
        { index: 3, text: `Note\nSection: Doc > Middle > Leaf\n\n${leafContent}` },
        { index: 4, text: "Note\n\nDoc\nMiddle\nLeaf" },
      ])
    })

    it("emits an aggregate for a top-level parent with no own body, keeping its name in the TOC and in descendants' paths", () => {
      const childContent = generateLabeledTokens(400, "child")
      const otherContent = generateLabeledTokens(150, "other")
      const body = `## Parent\n### Child\n${childContent}\n\n## Other\n${otherContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Parent\n\nChild\n${childContent}` },
        { index: 1, text: `Note\nSection: Parent > Child\n\n${childContent}` },
        { index: 2, text: `Note\nSection: Other\n\n${otherContent}` },
        { index: 3, text: "Note\n\nParent\nChild\nOther" },
      ])
    })

    it("aggregates the whole note under a singleton wrapper heading, with sub-chunks crossing child boundaries", () => {
      const introContent = generateLabeledTokens(50, "intro")
      const firstContent = generateLabeledTokens(300, "first")
      const secondContent = generateLabeledTokens(300, "second")
      const body = `# Guide\n${introContent}\n\n## First\n${firstContent}\n\n## Second\n${secondContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The 652-token wrapper span splits at paragraph boundaries against
      // its 449-token title-only budget: intro + First land in one chunk
      // (351 tokens) — a content-anchored boundary no heading-anchored
      // chunk produces — and Second fills the next
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${introContent}\n\nFirst\n${firstContent}` },
        { index: 1, text: `Note\n\nSecond\n${secondContent}` },
        { index: 2, text: `Note\nSection: Guide > First\n\n${firstContent}` },
        { index: 3, text: `Note\nSection: Guide > Second\n\n${secondContent}` },
        { index: 4, text: "Note\n\nGuide\nFirst\nSecond" },
      ])
    })

    it("keeps the Section line on a lone top-level heading that does not open the note", () => {
      const setupContent = generateLabeledTokens(300, "setup")
      const overviewContent = generateLabeledTokens(300, "overview")
      const body = `### Setup\n${setupContent}\n\n## Overview\n${overviewContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // Setup precedes the only top-level heading, so Overview does not
      // wrap the note and keeps its attribution
      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Setup\n\n${setupContent}` },
        { index: 1, text: `Note\nSection: Overview\n\n${overviewContent}` },
        { index: 2, text: "Note\n\nSetup\nOverview" },
      ])
    })

    it("skips empty heading text in the Section path", () => {
      const contentWords = generateLabeledTokens(520, "content").split(" ")
      const body = `##\n${contentWords.join(" ")}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

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

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // Sub-MIN sections are no longer merged across headings — the tiny
      // section keeps its own chunk and its own Section attribution
      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Tiny\n\n${tinySection}` },
        { index: 1, text: `Note\nSection: Normal\n\n${normalSection}` },
        { index: 2, text: `Note\nSection: Another\n\n${anotherSection}` },
        { index: 3, text: "Note\n\nTiny\nNormal\nAnother" },
      ])
    })

    it("emits no section chunk for an empty section, keeping its name in the TOC", () => {
      const notesWords = generateLabeledTokens(500, "notes").split(" ")
      const body = `## Active\ncard one alpha\ncard two beta\n\n## Done\n\n## Notes\n${notesWords.join(" ")}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // "Done" has no body → no section chunk, but its name stays in the
      // TOC; Notes' 500 tokens split 447 + 53 against its 3-token prefix
      // budget
      expect(chunks).toEqual([
        { index: 0, text: "Note\nSection: Active\n\ncard one alpha\ncard two beta" },
        { index: 1, text: `Note\nSection: Notes\n\n${notesWords.slice(0, 447).join(" ")}` },
        { index: 2, text: `Note\nSection: Notes\n\n${notesWords.slice(447).join(" ")}` },
        { index: 3, text: "Note\n\nActive\nDone\nNotes" },
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

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      const expectedHeadingNames = Array.from(
        { length: 89 },
        (_, i) => `heading${i} alpha beta gamma delta`,
      ).join("\n")
      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${expectedHeadingNames}` }])
    })

    it("falls back to one whole-body chunk when every section is empty and no heading name fits the TOC", () => {
      // Two 450-token heading names with no text under them: 900 stripped
      // tokens take the split path, neither section has text, and each name
      // is over the TOC's 449-token budget, so the split yields no chunk.
      const firstName = generateLabeledTokens(450, "first")
      const secondName = generateLabeledTokens(450, "second")

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: `## ${firstName}\n## ${secondName}`,
      })

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${firstName}\n${secondName}` }])
    })
  })

  describe("table of contents chunk", () => {
    it("prepends the note's folder segments to the TOC title line, leaving section chunks bare", () => {
      const activeContent = generateLabeledTokens(300, "active")
      const doneContent = generateLabeledTokens(300, "done")
      const body = `## Active\n${activeContent}\n\n## Done\n${doneContent}`

      const chunks = chunkContent({
        noteTitle: "TASKS",
        bodyContent: body,
        sourcePath: "Code Projects/my-repo/TASKS.md",
      })

      // Folder segments reach only the TOC line — boards sharing standard
      // lane names emit distinct TOC chunks instead of byte-identical ones
      expect(chunks).toEqual([
        { index: 0, text: `TASKS\nSection: Active\n\n${activeContent}` },
        { index: 1, text: `TASKS\nSection: Done\n\n${doneContent}` },
        { index: 2, text: "Code Projects > my-repo > TASKS\n\nActive\nDone" },
      ])
    })

    it("keeps the bare title on the TOC line for a root-level note path", () => {
      const activeContent = generateLabeledTokens(300, "active")
      const doneContent = generateLabeledTokens(300, "done")
      const body = `## Active\n${activeContent}\n\n## Done\n${doneContent}`

      const chunks = chunkContent({ noteTitle: "TASKS", bodyContent: body, sourcePath: "TASKS.md" })

      expect(chunks).toEqual([
        { index: 0, text: `TASKS\nSection: Active\n\n${activeContent}` },
        { index: 1, text: `TASKS\nSection: Done\n\n${doneContent}` },
        { index: 2, text: "TASKS\n\nActive\nDone" },
      ])
    })

    it("omits the TOC chunk when the folder-enriched title exhausts the heading-name budget", () => {
      const section1 = generateLabeledTokens(300, "first")
      const section2 = generateLabeledTokens(300, "second")
      const body = `## S1\n${section1}\n\n## S2\n${section2}`
      // 449 words as a single directory name → titleLine is 451 tokens
      // (449 folder + ">" + "Note"), leaving -1 budget for heading names
      const longFolderPath = `${generateTokens(449)}/note.md`

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: body,
        sourcePath: longFolderPath,
      })

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: S1\n\n${section1}` },
        { index: 1, text: `Note\nSection: S2\n\n${section2}` },
      ])
    })

    it("chunks non-markdown file content the same way, with folder segments from the file path", () => {
      const introSection = generateLabeledTokens(300, "intro")
      const methodsSection = generateLabeledTokens(300, "methods")
      const body = `## Introduction\n${introSection}\n\n## Methods\n${methodsSection}`

      const chunks = chunkContent({
        noteTitle: "Report",
        bodyContent: body,
        sourcePath: "assets/papers/Report.pdf",
      })

      // Extracted PDF and canvas text flows through the same chunker — the
      // file path's folder segments land on the TOC line, and a non-markdown
      // source keeps its full filename there so a same-stem note (Report.md)
      // cannot emit an identical TOC chunk
      expect(chunks).toEqual([
        { index: 0, text: `Report\nSection: Introduction\n\n${introSection}` },
        { index: 1, text: `Report\nSection: Methods\n\n${methodsSection}` },
        { index: 2, text: "assets > papers > Report.pdf\n\nIntroduction\nMethods" },
      ])
    })

    it("strips markdown from heading names in Section lines and the TOC", () => {
      const reviewContent = generateLabeledTokens(300, "review")
      const decisionsContent = generateLabeledTokens(300, "decisions")
      const body = `## [[Target|Quarterly review]]\n${reviewContent}\n\n## **Key decisions**\n${decisionsContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Quarterly review\n\n${reviewContent}` },
        { index: 1, text: `Note\nSection: Key decisions\n\n${decisionsContent}` },
        { index: 2, text: "Note\n\nQuarterly review\nKey decisions" },
      ])
    })

    it("skips an oversized heading name so later short names still land in the TOC", () => {
      const overviewContent = generateLabeledTokens(300, "overview")
      const risksContent = generateLabeledTokens(300, "risks")
      const oversizedHeading = generateLabeledTokens(450, "heading")
      const body = `## Overview\n${overviewContent}\n\n## ${oversizedHeading}\n\n## Risks\n${risksContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The 450-token name exceeds the 449-token budget and is dropped;
      // Risks still lands. The oversized heading has no body, so it emits
      // no section chunk either
      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Overview\n\n${overviewContent}` },
        { index: 1, text: `Note\nSection: Risks\n\n${risksContent}` },
        { index: 2, text: "Note\n\nOverview\nRisks" },
      ])
    })

    it("omits empty-text headings from the TOC name list", () => {
      const bareSectionContent = generateLabeledTokens(300, "bare")
      const namedSectionContent = generateLabeledTokens(300, "named")
      const body = `##\n${bareSectionContent}\n\n## Named\n${namedSectionContent}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The bare `##` section still emits its body (with no Section line),
      // but only the named heading appears in the TOC
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${bareSectionContent}` },
        { index: 1, text: `Note\nSection: Named\n\n${namedSectionContent}` },
        { index: 2, text: "Note\n\nNamed" },
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

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${paragraphs[0]}\n\n${paragraphs[1]}` },
        { index: 1, text: `Note\n\n${paragraphs[2]}\n\n${paragraphs[3]}` },
        { index: 2, text: `Note\n\n${paragraphs[4]}\n\n${paragraphs[5]}` },
        { index: 3, text: "Note\n\nBig Section" },
      ])
    })

    it("merges a sub-MIN trailing fragment backward into its predecessor", () => {
      const bigParagraph = generateLabeledTokens(440, "big")
      const tailParagraph = generateLabeledTokens(30, "tail")
      const padSection = generateLabeledTokens(60, "pad")
      const body = `## Big\n${bigParagraph}\n\n${tailParagraph}\n\n## Pad\n${padSection}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // 440 + 30 exceeds the 447-token budget, so the section splits — but
      // the 30-token tail is under MIN and merges back, slightly over budget
      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: Big\n\n${bigParagraph}\n\n${tailParagraph}` },
        { index: 1, text: `Note\nSection: Pad\n\n${padSection}` },
        { index: 2, text: "Note\n\nBig\nPad" },
      ])
    })

    it("floors a section's budget at MIN_CHUNK_TOKENS when its heading path is huge", () => {
      const hugeHeading = generateShortLabeledTokens(419, "h")
      const smallBodyWords = generateLabeledTokens(120, "body").split(" ")
      const normalSection = generateLabeledTokens(400, "normal")
      const body = `## ${hugeHeading}\n${smallBodyWords.join(" ")}\n\n## Normal\n${normalSection}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The 421-token prefix would leave a 29-token budget; the 50-token
      // floor catches it: 120 tokens → 50 + 50 + 20, and the sub-MIN
      // 20-token tail merges backward → two fragments for that section.
      // The TOC keeps both names: 419 + 1 tokens fit its 449-token budget.
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
        { index: 3, text: `Note\n\n${hugeHeading}\nNormal` },
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

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // 8 paragraphs of ~102 tokens each against a 449-token budget → two
      // 4-paragraph chunks
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${paragraphs.slice(0, 4).join("\n\n")}` },
        { index: 1, text: `Note\n\n${paragraphs.slice(4).join("\n\n")}` },
      ])
    })

    it("splits a body with CRLF line endings at its paragraph boundaries", () => {
      // Three 300-token paragraphs against a 449-token budget → one chunk each
      const firstParagraph = generateLabeledTokens(300, "first")
      const secondParagraph = generateLabeledTokens(300, "second")
      const thirdParagraph = generateLabeledTokens(300, "third")

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: `${firstParagraph}\r\n\r\n${secondParagraph}\r\n\r\n${thirdParagraph}`,
      })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${firstParagraph}` },
        { index: 1, text: `Note\n\n${secondParagraph}` },
        { index: 2, text: `Note\n\n${thirdParagraph}` },
      ])
    })

    describe("a body with an empty paragraph at either end", () => {
      // Three 300-token paragraphs against a 449-token budget → one chunk each
      const firstParagraph = generateLabeledTokens(300, "first")
      const secondParagraph = generateLabeledTokens(300, "second")
      const thirdParagraph = generateLabeledTokens(300, "third")
      const paragraphs = `${firstParagraph}\n\n${secondParagraph}\n\n${thirdParagraph}`
      const chunksWithoutEmptyParagraph = [
        { index: 0, text: `Note\n\n${firstParagraph}` },
        { index: 1, text: `Note\n\n${secondParagraph}` },
        { index: 2, text: `Note\n\n${thirdParagraph}` },
      ]

      it("drops the empty paragraph a leading comment leaves", () => {
        const chunks = chunkContent({
          noteTitle: "Note",
          bodyContent: `%%hidden%%\n\n${paragraphs}`,
        })

        expect(chunks).toEqual(chunksWithoutEmptyParagraph)
      })

      it("drops the empty paragraph leading blank lines leave", () => {
        const chunks = chunkContent({ noteTitle: "Note", bodyContent: `\n\n\n${paragraphs}` })

        expect(chunks).toEqual(chunksWithoutEmptyParagraph)
      })

      it("drops the empty paragraph a trailing comment leaves", () => {
        const chunks = chunkContent({
          noteTitle: "Note",
          bodyContent: `${paragraphs}\n\n%%hidden%%`,
        })

        expect(chunks).toEqual(chunksWithoutEmptyParagraph)
      })

      it("keeps a leading paragraph of spaces with the first paragraph", () => {
        const chunks = chunkContent({ noteTitle: "Note", bodyContent: `   \n\n${paragraphs}` })

        expect(chunks).toEqual([
          { index: 0, text: `Note\n\n   \n\n${firstParagraph}` },
          { index: 1, text: `Note\n\n${secondParagraph}` },
          { index: 2, text: `Note\n\n${thirdParagraph}` },
        ])
      })
    })
  })

  describe("markdown stripping in chunks", () => {
    it("strips wikilinks in chunk text", () => {
      const filler = generateTokens(10)
      const body = `Some text with [[Target|display text]] and more ${filler}`
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nSome text with display text and more ${filler}` },
      ])
    })

    it("strips bold/italic markers in chunk text", () => {
      const filler = generateTokens(10)
      const body = `This has **bold** and *italic* text ${filler}`
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nThis has bold and italic text ${filler}` },
      ])
    })

    it("strips heading markers in chunk text", () => {
      const firstSection = generateLabeledTokens(200, "first")
      const secondSection = generateLabeledTokens(200, "second")
      const body = `## My Section\n${firstSection}\n\n## Another\n${secondSection}`
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // 403 stripped tokens (< 500 threshold) → single chunk, no heading
      // splitting; heading markers removed, text preserved inline
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\nMy Section\n${firstSection}\n\nAnother\n${secondSection}` },
      ])
    })
  })

  describe("chunk structure", () => {
    it("returns NoteChunk objects with index and text", () => {
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: "Body text" })

      expect(chunks).toEqual([{ index: 0, text: "Note\n\nBody text" }])
    })

    it("always returns at least one chunk", () => {
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: "" })
      expect(chunks).toEqual([{ index: 0, text: "Note" }])
    })
  })

  describe("metadata prefix enrichment", () => {
    it("prefixes every section chunk with title, Section line, then the metadata line, leaving the TOC chunk bare", () => {
      const section1 = generateLabeledTokens(300, "one")
      const section2 = generateLabeledTokens(300, "two")
      const body = `## One\n\n${section1}\n\n## Two\n\n${section2}`

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: body,
        metadataPrefix: "Type: session-log. Tags: project/vault-cortex.",
      })

      // The TOC chunk never carries the metadata line — on a chunk this
      // small the line would dominate the token average, and same-type
      // notes would all share it, washing out note-vs-note discrimination
      expect(chunks).toEqual([
        {
          index: 0,
          text: `Note\nSection: One\nType: session-log. Tags: project/vault-cortex.\n\n${section1}`,
        },
        {
          index: 1,
          text: `Note\nSection: Two\nType: session-log. Tags: project/vault-cortex.\n\n${section2}`,
        },
        { index: 2, text: "Note\n\nOne\nTwo" },
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

      expect(chunkContent({ noteTitle: "Note", bodyContent: body })).toEqual([
        { index: 0, text: `Note\n\n${body}` },
      ])
      expect(
        chunkContent({ noteTitle: "Note", bodyContent: body, metadataPrefix: longPrefix }),
      ).toEqual([
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

    it("splits a short note with CRLF line endings at its paragraph boundary when the prefix pushes it over budget", () => {
      // Two 240-token paragraphs make a 480-token body: one chunk bare (under
      // the 500-token threshold), but over the 445-token budget left by "Note"
      // and the 4-token metadata line, so each paragraph gets its own chunk.
      const firstParagraph = generateLabeledTokens(240, "first")
      const secondParagraph = generateLabeledTokens(240, "second")
      const metadataPrefix = "Type: session-log. Tags: project/vault-cortex."

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: `${firstParagraph}\r\n\r\n${secondParagraph}`,
        metadataPrefix,
      })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n${metadataPrefix}\n\n${firstParagraph}` },
        { index: 1, text: `Note\n${metadataPrefix}\n\n${secondParagraph}` },
      ])
    })

    it("floors the budget at MIN_CHUNK_TOKENS when the prefix is very large", () => {
      // A ~420-token prefix would shrink the budget to ~30 without the
      // floor, but MIN_CHUNK_TOKENS (50) catches it. 120 body tokens at a
      // 50-token floor → 50 + 50 + 20, and the sub-MIN 20-token tail
      // merges backward → 2 chunks.
      const hugePrefix = `Tags: ${generateShortLabeledTokens(419, "t")}.`
      const bodyWords = generateTokens(120).split(" ")

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: bodyWords.join(" "),
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

      expect(chunkContent({ noteTitle: "Note", bodyContent: body, metadataPrefix: null })).toEqual(
        chunkContent({ noteTitle: "Note", bodyContent: body }),
      )
    })
  })

  describe("section-path budget cap", () => {
    const sectionLineOf = (chunkText: string): string | null => {
      const line = chunkText.split("\n").find((candidate) => candidate.startsWith("Section:"))
      return line ?? null
    }

    // Every test adds a second top-level heading to prevent the
    // singleton-wrapper path (which suppresses the Section line on the
    // sole top-level heading's aggregate chunk).
    const trailSection = `\n\n## Trail\n\n${generateLabeledTokens(100, "trail")}`

    // Find the leaf chunk for a heading by matching the Section line's
    // deepest segment. The aggregate chunk also contains the body content
    // but has a shorter (or absent) Section line, so this lookup is
    // unambiguous when the deepest heading name is unique.
    const findLeafChunk = (
      chunks: readonly { text: string }[],
      deepestHeadingName: string,
    ): { text: string } | undefined => {
      return chunks.find((chunk) => {
        const line = sectionLineOf(chunk.text)
        return line !== null && line.endsWith(deepestHeadingName)
      })
    }

    it("leaves a path under budget unchanged", () => {
      const body =
        `## Alpha\n\n${generateLabeledTokens(200, "a")}\n\n` +
        `### Beta\n\n${generateLabeledTokens(200, "b")}\n\n` +
        `#### Gamma\n\n${generateLabeledTokens(200, "c")}` +
        trailSection
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      const gammaChunk = findLeafChunk(chunks, "Gamma")

      if (!gammaChunk) {
        throw new Error("expected gamma chunk not found")
      }
      expect(sectionLineOf(gammaChunk.text)).toBe("Section: Alpha > Beta > Gamma")
    })

    it("drops leading ancestors when the path exceeds the budget, keeping deepest", () => {
      // 5 nested levels with ~80-token names produce a ~406-token Section
      // line, exceeding the ~399-token budget (title "N" = 1 token). The
      // cap drops h1, keeping h2 through h5.
      const longName = (label: string) => generateLabeledTokens(80, label)
      const h2 = longName("h2")
      const h3 = longName("h3")
      const h4 = longName("h4")
      const h5 = longName("h5")

      const body =
        `## ${longName("h1")}\n\n${generateLabeledTokens(100, "a")}\n\n` +
        `### ${h2}\n\n${generateLabeledTokens(100, "b")}\n\n` +
        `#### ${h3}\n\n${generateLabeledTokens(100, "c")}\n\n` +
        `##### ${h4}\n\n${generateLabeledTokens(100, "d")}\n\n` +
        `###### ${h5}\n\n${generateLabeledTokens(100, "e")}` +
        trailSection

      const chunks = chunkContent({ noteTitle: "N", bodyContent: body })

      const h5Chunk = findLeafChunk(chunks, h5)

      if (!h5Chunk) {
        throw new Error("expected h5 chunk not found")
      }
      expect(sectionLineOf(h5Chunk.text)).toBe(`Section: ${h2} > ${h3} > ${h4} > ${h5}`)
    })

    it("keeps a single-segment path even when it exceeds the budget", () => {
      const hugeName = generateShortLabeledTokens(400, "u")
      const body = `## ${hugeName}\n\n${generateLabeledTokens(200, "body")}${trailSection}`
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      const sectionChunk = findLeafChunk(chunks, hugeName)

      if (!sectionChunk) {
        throw new Error("expected section chunk not found")
      }
      expect(sectionLineOf(sectionChunk.text)).toBe(`Section: ${hugeName}`)
    })

    it("suppresses the Section line when the budget is zero", () => {
      // Title + metadata together exceed MAX - MIN, leaving zero budget.
      // The body must exceed CHUNK_THRESHOLD_TOKENS (500) so the
      // heading-based splitting path runs and capHeadingPath is called.
      const hugeTitle = generateLabeledTokens(200, "title")
      const hugeMetadata = `Tags: ${generateLabeledTokens(200, "tag")}.`
      const body = `## Heading\n\n${generateLabeledTokens(600, "body")}${trailSection}`

      const chunks = chunkContent({
        noteTitle: hugeTitle,
        bodyContent: body,
        metadataPrefix: hugeMetadata,
      })

      // The 401-token title and metadata leave a zero Section-line budget, so
      // both sections' chunks carry only the title and metadata, and each body
      // budget floors at 50 tokens: Heading's 600 words make 12 chunks and
      // Trail's 100 make 2.
      const fiftyWordRuns = (words: readonly string[]): string[] => {
        return Array.from({ length: words.length / 50 }, (_, run) => {
          return words.slice(run * 50, (run + 1) * 50).join(" ")
        })
      }
      const sectionRuns = [
        ...fiftyWordRuns(generateLabeledTokens(600, "body").split(" ")),
        ...fiftyWordRuns(generateLabeledTokens(100, "trail").split(" ")),
      ]
      expect(chunks).toEqual([
        ...sectionRuns.map((run, index) => ({
          index,
          text: `${hugeTitle}\n${hugeMetadata}\n\n${run}`,
        })),
        { index: sectionRuns.length, text: `${hugeTitle}\n\nHeading\nTrail` },
      ])
    })

    it("yields a body budget above the floor when the cap drops ancestors", () => {
      // 4 levels with 120-token names. The full path is ~485 tokens
      // ("Section: " 2 + 4×120 names + 3 separators). Budget is 399
      // (title "N" = 1 token). Dropping n1 (120 + 1 sep) gives ~364,
      // which fits — so the cap keeps n2, n3, and n4.
      const name1 = generateLabeledTokens(120, "n1")
      const name2 = generateLabeledTokens(120, "n2")
      const name3 = generateLabeledTokens(120, "n3")
      const name4 = generateLabeledTokens(120, "n4")
      const leafWords = generateLabeledTokens(300, "leaf").split(" ")

      const body =
        `## ${name1}\n\n${generateLabeledTokens(100, "a")}\n\n` +
        `### ${name2}\n\n${generateLabeledTokens(100, "b")}\n\n` +
        `#### ${name3}\n\n${generateLabeledTokens(100, "c")}\n\n` +
        `##### ${name4}\n\n${leafWords.join(" ")}` +
        trailSection

      const chunks = chunkContent({ noteTitle: "N", bodyContent: body })

      const deepestChunk = findLeafChunk(chunks, name4)

      if (!deepestChunk) {
        throw new Error("expected deepest chunk not found")
      }
      // The capped prefix costs 364 tokens (1 for the title, 363 for the
      // Section line), leaving an 86-token body budget, above the 50 floor.
      expect(deepestChunk.text).toBe(
        `N\nSection: ${name2} > ${name3} > ${name4}\n\n${leafWords.slice(0, 86).join(" ")}`,
      )
    })

    it("tightens the section-line budget when a metadata prefix is present", () => {
      // Budget without metadata: 450 - 50 - 1 (title "N") = 399
      // Budget with metadata:    450 - 50 - 1 - 5 (metadata) = 394
      // Outer (197) + inner (197) + "Section: " (2) + " > " (1) = 397.
      // Without metadata (budget 399): 397 ≤ 399 → fits.
      // With metadata (budget ~394): 397 > 394 → cap fires, drops outer.
      const outerName = generateLabeledTokens(197, "out")
      const innerName = generateLabeledTokens(197, "inn")
      const body =
        `## ${outerName}\n\n### ${innerName}\n\n${generateLabeledTokens(200, "body")}` +
        trailSection

      const chunksWithout = chunkContent({ noteTitle: "N", bodyContent: body })
      const chunksWith = chunkContent({
        noteTitle: "N",
        bodyContent: body,
        metadataPrefix: "Type: reference. Tags: code-standards, typescript.",
      })

      // Both segments fit without metadata
      const deepWithout = findLeafChunk(chunksWithout, innerName)

      if (!deepWithout) {
        throw new Error("expected chunk without metadata not found")
      }
      expect(sectionLineOf(deepWithout.text)).toBe(`Section: ${outerName} > ${innerName}`)

      // Metadata shrinks the budget, so the cap drops the outer segment
      const deepWith = findLeafChunk(chunksWith, innerName)

      if (!deepWith) {
        throw new Error("expected chunk with metadata not found")
      }
      expect(sectionLineOf(deepWith.text)).toBe(`Section: ${innerName}`)
    })

    it("preserves the full path when the section line fits exactly at the budget", () => {
      // Budget = 450 - 50 - 1 (title "N") = 399. "Section:" (1) + 198 +
      // ">" (1) + 199 = 399 tokens exactly, so the path must survive
      // unchanged; tightening the <= to < would drop the outer ancestor.
      const outerName = generateLabeledTokens(198, "ex")
      const innerName = generateLabeledTokens(199, "ey")
      const body =
        `## ${outerName}\n\n${generateLabeledTokens(200, "a")}\n\n` +
        `### ${innerName}\n\n${generateLabeledTokens(200, "b")}` +
        trailSection

      const chunks = chunkContent({ noteTitle: "N", bodyContent: body })

      const deepChunk = findLeafChunk(chunks, innerName)

      if (!deepChunk) {
        throw new Error("expected leaf chunk not found")
      }
      // Both segments fit — neither is dropped
      expect(sectionLineOf(deepChunk.text)).toBe(`Section: ${outerName} > ${innerName}`)
    })

    it("drops multiple leading ancestors when one drop is not enough", () => {
      // 3 levels with ~200-token names. Full path: "Section: " (1) +
      // 3×200 names + 2 separators = ~603 > 399. After 1 drop: ~402 > 399.
      // After 2 drops: ~201 ≤ 399 — only name3 survives. A regression
      // replacing the while loop with a single if/shift keeps ~402 tokens
      // and passes every single-drop test.
      const name1 = generateLabeledTokens(200, "d1")
      const name2 = generateLabeledTokens(200, "d2")
      const name3 = generateLabeledTokens(200, "d3")
      const body =
        `## ${name1}\n\n${generateLabeledTokens(200, "a")}\n\n` +
        `### ${name2}\n\n${generateLabeledTokens(200, "b")}\n\n` +
        `#### ${name3}\n\n${generateLabeledTokens(200, "c")}` +
        trailSection

      const chunks = chunkContent({ noteTitle: "N", bodyContent: body })

      const deepChunk = findLeafChunk(chunks, name3)

      if (!deepChunk) {
        throw new Error("expected deepest chunk not found")
      }
      expect(sectionLineOf(deepChunk.text)).toBe(`Section: ${name3}`)
    })

    it("keeps the deepest segment when the loop exhausts all ancestors", () => {
      // 2 segments of ~400 tokens each. The full path exceeds the ~399
      // budget, and the loop drops the outer segment — the remaining
      // deepest segment alone still exceeds the budget but survives.
      const outerName = generateShortLabeledTokens(400, "o")
      const innerName = generateShortLabeledTokens(400, "i")
      const body =
        `## ${outerName}\n\n${generateLabeledTokens(200, "a")}\n\n` +
        `### ${innerName}\n\n${generateLabeledTokens(200, "b")}` +
        trailSection

      const chunks = chunkContent({ noteTitle: "N", bodyContent: body })

      const innerChunk = findLeafChunk(chunks, innerName)

      if (!innerChunk) {
        throw new Error("expected inner chunk not found")
      }
      expect(sectionLineOf(innerChunk.text)).toBe(`Section: ${innerName}`)
    })

    it("preserves a moderately deep Section path within budget", () => {
      // 4 levels with short names (~25 total tokens) stay well under the
      // ~395-token budget, so the cap's early return preserves the path.
      const body =
        `## Getting Started Guide\n\n${generateLabeledTokens(200, "a")}\n\n` +
        `### Installation Steps\n\n${generateLabeledTokens(200, "b")}\n\n` +
        `#### Platform Requirements\n\n${generateLabeledTokens(200, "c")}\n\n` +
        `##### macOS Specific Notes\n\n${generateLabeledTokens(200, "d")}` +
        trailSection

      const chunks = chunkContent({ noteTitle: "Setup", bodyContent: body })

      const deepestChunk = findLeafChunk(chunks, "macOS Specific Notes")

      if (!deepestChunk) {
        throw new Error("expected deepest chunk not found")
      }
      expect(sectionLineOf(deepestChunk.text)).toBe(
        "Section: Getting Started Guide > Installation Steps > Platform Requirements > macOS Specific Notes",
      )
    })
  })

  describe("prefix parts cut to 2,000 characters", () => {
    const otherBody = generateTokens(300)
    const sectionsBody = `## Other\n${otherBody}`

    it("cuts a long single-word heading in the Section line and keeps it whole in the table of contents", () => {
      const longHeading = "h".repeat(5_000)
      const firstBody = generateLabeledTokens(300, "first")
      const body = `## ${longHeading}\n${firstBody}\n\n${sectionsBody}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: ${"h".repeat(2_000)}\n\n${firstBody}` },
        { index: 1, text: `Note\nSection: Other\n\n${otherBody}` },
        { index: 2, text: `Note\n\n${longHeading}\nOther` },
      ])
    })

    it("cuts a long multi-word heading in the Section line", () => {
      // The cut heading still passes the Section-line budget, so this section's
      // body budget floors at 50 tokens; 40 words stay one fragment. The whole
      // 1,000-token name is over the table of contents' budget, so only
      // "Other" lands there.
      const longHeading = generateShortLabeledTokens(1_000, "h")
      const firstBody = generateLabeledTokens(40, "first")
      const body = `## ${longHeading}\n${firstBody}\n\n${sectionsBody}`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([
        { index: 0, text: `Note\nSection: ${longHeading.slice(0, 2_000)}\n\n${firstBody}` },
        { index: 1, text: `Note\nSection: Other\n\n${otherBody}` },
        { index: 2, text: "Note\n\nOther" },
      ])
    })

    it("cuts a long title in every chunk prefix and keeps it whole in the table of contents", () => {
      const longTitle = "t".repeat(5_000)
      const firstBody = generateLabeledTokens(300, "first")
      const otherBody = generateLabeledTokens(300, "other")
      const body = `## First\n${firstBody}\n\n## Other\n${otherBody}`

      const chunks = chunkContent({ noteTitle: longTitle, bodyContent: body })

      const cutTitle = "t".repeat(2_000)
      expect(chunks).toEqual([
        { index: 0, text: `${cutTitle}\nSection: First\n\n${firstBody}` },
        { index: 1, text: `${cutTitle}\nSection: Other\n\n${otherBody}` },
        { index: 2, text: `${longTitle}\n\nFirst\nOther` },
      ])
    })

    it("cuts a long metadata line in a short note's one chunk", () => {
      const longMetadata = `Tags: ${"m".repeat(5_000)}.`
      const body = generateTokens(100)

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: body,
        metadataPrefix: longMetadata,
      })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n${longMetadata.slice(0, 2_000)}\n\n${body}` },
      ])
    })

    it("cuts a long metadata line in every chunk prefix of a split note, leaving the table of contents bare", () => {
      const longMetadata = `Tags: ${"m".repeat(5_000)}.`
      const preamble = generateLabeledTokens(300, "preamble")
      const firstBody = generateLabeledTokens(300, "first")
      const body = `${preamble}\n\n## First\n${firstBody}`

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: body,
        metadataPrefix: longMetadata,
      })

      const cutMetadata = longMetadata.slice(0, 2_000)
      expect(chunks).toEqual([
        { index: 0, text: `Note\n${cutMetadata}\n\n${preamble}` },
        { index: 1, text: `Note\nSection: First\n${cutMetadata}\n\n${firstBody}` },
        { index: 2, text: "Note\n\nFirst" },
      ])
    })
  })

  describe("per-note chunk text limit", () => {
    const totalChunkCharacters = (chunks: ReadonlyArray<{ text: string }>): number => {
      return chunks.map((chunk) => chunk.text.length).reduce((sum, length) => sum + length, 0)
    }

    // 390 short words: under 2,000 characters, so the cut leaves it whole, and
    // under the Section-line budget, so every child chunk repeats it.
    const longAncestor = generateShortLabeledTokens(390, "a")
    // A long title in short words: 1,000 tokens in 2,000 characters, so each
    // chunk's body budget floors at 50 tokens behind a 2,000-character prefix.
    const longWordyTitle = Array.from({ length: 1_000 }, () => "t").join(" ")

    it("stops a note of many one-line sections under a long ancestor at 50 times its body", () => {
      const childCount = 2_000
      const childSections = Array.from({ length: childCount }, (_, i) => `## c${i}\nw${i}`).join(
        "\n",
      )
      const body = `# ${longAncestor}\n${childSections}`
      const limit = 50 * stripMarkdownSyntax(body).length

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      // The note's chunk texts without the limit, in order. First come the
      // wrapper heading's aggregate chunks: its children's 4,000 stripped
      // words in 449-word runs under the bare title (the last run of 408
      // words is over the 50-word minimum, so it is not merged). One chunk
      // per child section follows.
      const childWords = Array.from({ length: childCount }, (_, i) => [`c${i}`, `w${i}`]).flat()
      const aggregateTexts = Array.from(
        { length: Math.ceil(childWords.length / 449) },
        (_, run) => `Note\n\n${childWords.slice(run * 449, (run + 1) * 449).join(" ")}`,
      )
      const childTexts = Array.from(
        { length: childCount },
        (_, i) => `Note\nSection: ${longAncestor} > c${i}\n\nw${i}`,
      )
      const unlimitedTexts = [...aggregateTexts, ...childTexts]

      // The table-of-contents chunk comes last and sits outside the limit. The
      // 390-token ancestor and 59 one-token child names fill its 449-token
      // budget.
      const bodyChunks = chunks.slice(0, -1)
      const keptCount = bodyChunks.length
      const tableOfContentsNames = [longAncestor, ...Array.from({ length: 59 }, (_, i) => `c${i}`)]
      expect(chunks).toEqual([
        ...unlimitedTexts.slice(0, keptCount).map((text, index) => ({ index, text })),
        { index: keptCount, text: `Note\n\n${tableOfContentsNames.join("\n")}` },
      ])

      // The kept texts fit the limit, and the first text left out would not.
      const keptCharacters = totalChunkCharacters(bodyChunks)
      expect(keptCharacters).toBeLessThanOrEqual(limit)
      expect(keptCharacters + (unlimitedTexts[keptCount]?.length ?? 0)).toBeGreaterThan(limit)
    })

    // Each note below has 1.5 million one-letter words under the long wordy
    // title and a metadata line as long, so each chunk is about 4,100
    // characters. Its chunks would total about 41 times its body, under the
    // 50-times limit, and reach 50 million characters at about 12,200 chunks,
    // under the chunk count cap, so the fixed bound applies first. The chunks
    // are compared as a count and their distinct texts, because a failing
    // toEqual on the whole array would print 50 MB.
    const longWordyMetadata = Array.from({ length: 1_000 }, () => "m").join(" ")
    const millionWordBody = Array.from({ length: 1_500_000 }, () => "b").join(" ")
    const metadataChunkText = `${longWordyTitle}\n${longWordyMetadata}\n\n${Array.from({ length: 50 }, () => "b").join(" ")}`
    const keptAtFixedBound = Math.floor(50_000_000 / metadataChunkText.length)

    it("stops a note with no headings at 50 million characters of chunk text", () => {
      const chunks = chunkContent({
        noteTitle: longWordyTitle,
        bodyContent: millionWordBody,
        metadataPrefix: longWordyMetadata,
      })

      expect({
        count: chunks.length,
        distinctTexts: [...new Set(chunks.map((chunk) => chunk.text))],
      }).toEqual({ count: keptAtFixedBound, distinctTexts: [metadataChunkText] })
    })

    it("stops one heading over a long body at 50 million characters of chunk text", () => {
      const chunks = chunkContent({
        noteTitle: longWordyTitle,
        bodyContent: `## Only\n${millionWordBody}`,
        metadataPrefix: longWordyMetadata,
      })

      // The 1,000-token title leaves no table-of-contents budget and the title
      // and metadata leave no Section-line budget, so every chunk here is a
      // body chunk counted against the bound one at a time, inside the one
      // section.
      expect({
        count: chunks.length,
        distinctTexts: [...new Set(chunks.map((chunk) => chunk.text))],
      }).toEqual({ count: keptAtFixedBound, distinctTexts: [metadataChunkText] })
    })

    it("keeps a short note's one chunk when its title alone passes 50 times the body", () => {
      const title = "t".repeat(2_000)

      const chunks = chunkContent({ noteTitle: title, bodyContent: "A short body." })

      expect(chunks).toEqual([{ index: 0, text: `${title}\n\nA short body.` }])
    })
  })

  describe("per-note chunk count", () => {
    /** A note of one-word top-level sections: each section is one chunk, and
     *  the table-of-contents chunk holds the first 449 one-token names. */
    const oneWordSections = (sectionCount: number): string => {
      return Array.from({ length: sectionCount }, (_, i) => `## s${i}\nw${i}`).join("\n")
    }
    const sectionChunk = (sectionIndex: number): { index: number; text: string } => {
      return { index: sectionIndex, text: `Note\nSection: s${sectionIndex}\n\nw${sectionIndex}` }
    }
    const tableOfContentsText = `Note\n\n${Array.from({ length: 449 }, (_, i) => `s${i}`).join("\n")}`

    it("keeps a note's first 16,384 chunks and its table-of-contents chunk", () => {
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: oneWordSections(20_000) })

      expect(chunks).toEqual([
        ...Array.from({ length: 16_384 }, (_, i) => sectionChunk(i)),
        { index: 16_384, text: tableOfContentsText },
      ])
    })

    it("keeps every chunk of a note under the count", () => {
      const chunks = chunkContent({ noteTitle: "Note", bodyContent: oneWordSections(16_000) })

      expect(chunks).toEqual([
        ...Array.from({ length: 16_000 }, (_, i) => sectionChunk(i)),
        { index: 16_000, text: tableOfContentsText },
      ])
    })
  })

  describe("chunk length cut", () => {
    const sixHundredWords = Array.from({ length: 600 }, (_, i) => `w${i}`)

    it("cuts a short note's one chunk to 32,768 code points", () => {
      const longWord = "x".repeat(100_000)

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: longWord })

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${longWord}`.slice(0, 32_768) }])
    })

    it("keeps a chunk of exactly 32,768 code points whole", () => {
      // The prefix "Note\n\n" is 6 code points.
      const body = "x".repeat(32_762)

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${body}` }])
    })

    it("cuts before a grapheme the limit would split", () => {
      // The thumbs-up emoji is code point 32,768 and its skin-tone modifier
      // 32,769, one grapheme, so the cut keeps neither.
      const body = `${"x".repeat(32_761)}👍🏽tail`

      const chunks = chunkContent({ noteTitle: "Note", bodyContent: body })

      expect(chunks).toEqual([{ index: 0, text: `Note\n\n${"x".repeat(32_761)}` }])
    })

    it("cuts a section chunk to 32,768 code points", () => {
      const longWord = "y".repeat(100_000)

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: `## Big\n${longWord}\n\n${sixHundredWords.join(" ")}`,
      })

      // The one heading opens the note, so its chunks carry no Section line.
      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${longWord}`.slice(0, 32_768) },
        { index: 1, text: `Note\n\n${sixHundredWords.slice(0, 449).join(" ")}` },
        { index: 2, text: `Note\n\n${sixHundredWords.slice(449).join(" ")}` },
        { index: 3, text: "Note\n\nBig" },
      ])
    })

    it("cuts a table-of-contents chunk to 32,768 code points", () => {
      const longHeading = "h".repeat(100_000)

      const chunks = chunkContent({
        noteTitle: "Note",
        bodyContent: `## ${longHeading}\n${sixHundredWords.join(" ")}`,
      })

      expect(chunks).toEqual([
        { index: 0, text: `Note\n\n${sixHundredWords.slice(0, 449).join(" ")}` },
        { index: 1, text: `Note\n\n${sixHundredWords.slice(449).join(" ")}` },
        { index: 2, text: `Note\n\n${longHeading}`.slice(0, 32_768) },
      ])
    })
  })

  describe("linear time on long input", () => {
    /** Runs a script that builds a note and checks chunkContent's output, in
     *  a child process with a deadline; returns what the script printed. */
    const runChunkerInChild = (script: string): string => {
      const chunkerUrl = new URL("../chunker.ts", import.meta.url).href
      return runScriptInChild(
        `import { chunkContent } from ${JSON.stringify(chunkerUrl)};\n${script}`,
      )
    }

    it(
      "splits a note with a million whitespace-only paragraphs within a child deadline",
      () => {
        // The 500 words split 449 + 51. The whitespace-only paragraphs and
        // "tail" form one 1-word fragment, which merges back into the 51; that
        // chunk is cut to its first 32,768 characters, all ASCII.
        const output = runChunkerInChild(`
          const words = Array.from({ length: 500 }, (_, i) => "w" + i);
          const bodyContent = words.join(" ") + " \\n\\n".repeat(${LONG_RUN_LENGTH}) + "tail";
          const chunks = chunkContent({ noteTitle: "Note", bodyContent });
          const expectedChunks = [
            { index: 0, text: "Note\\n\\n" + words.slice(0, 449).join(" ") },
            {
              index: 1,
              text: ("Note\\n\\n" + words.slice(449).join(" ") + "\\n\\n" + " \\n\\n".repeat(${LONG_RUN_LENGTH - 1}) + "tail").slice(0, 32768),
            },
          ];
          process.stdout.write(String(JSON.stringify(chunks) === JSON.stringify(expectedChunks)));
        `)

        expect(output).toBe("true")
      },
      CHILD_DEADLINE_MS + 5_000,
    )

    it(
      "chunks many sections under a million-character ancestor heading within a child deadline",
      () => {
        const output = runChunkerInChild(`
          const children = Array.from({ length: 20000 }, (_, i) => "## c" + i + "\\nw" + i).join("\\n");
          const bodyContent = "# " + "a".repeat(${LONG_RUN_LENGTH}) + "\\n" + children;
          const chunks = chunkContent({ noteTitle: "Note", bodyContent });
          const firstChildText = "Note\\nSection: " + "a".repeat(2000) + " > c0\\n\\nw0";
          process.stdout.write(String(chunks.some((chunk) => chunk.text === firstChildText)));
        `)

        expect(output).toBe("true")
      },
      CHILD_DEADLINE_MS + 5_000,
    )

    it(
      "chunks many sections under five long multi-word ancestor headings within a child deadline",
      () => {
        // Each ancestor name is a 2,000-character run of short words, so every
        // section's Section line is cut down to the section's own name.
        const output = runChunkerInChild(`
          const ancestorName = Array.from({ length: 1000 }, () => "a").join(" ");
          const ancestors = [1, 2, 3, 4, 5].map((level) => "#".repeat(level) + " " + ancestorName).join("\\n");
          const sections = Array.from({ length: 100000 }, () => "###### z\\ny").join("\\n");
          const chunks = chunkContent({ noteTitle: "Note", bodyContent: ancestors + "\\n" + sections });
          process.stdout.write(String(chunks.some((chunk) => chunk.text === "Note\\nSection: z\\n\\ny")));
        `)

        expect(output).toBe("true")
      },
      CHILD_DEADLINE_MS + 5_000,
    )
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
