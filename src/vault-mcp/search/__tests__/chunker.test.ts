import { describe, it, expect } from "vitest"
import { chunkNoteContent } from "../chunker.js"

/** Generate a string of approximately N whitespace-separated tokens. */
const generateTokens = (count: number): string =>
  Array.from({ length: count }, (_, i) => `word${i}`).join(" ")

describe("chunkNoteContent", () => {
  describe("short notes (below threshold)", () => {
    it("returns a single chunk for a short note", () => {
      const chunks = chunkNoteContent("My Note", "Short body text here.")

      expect(chunks).toEqual([
        { index: 0, text: "My Note\n\nShort body text here." },
      ])
    })

    it("prefixes the chunk with the note title", () => {
      const chunks = chunkNoteContent("Title", "Body content.")

      expect(chunks[0].text).toBe("Title\n\nBody content.")
    })

    it("returns a single chunk for exactly 499 tokens", () => {
      const body = generateTokens(499)
      const chunks = chunkNoteContent("Note", body)

      expect(chunks).toHaveLength(1)
    })

    it("handles empty body", () => {
      const chunks = chunkNoteContent("Title", "")

      expect(chunks).toHaveLength(1)
      expect(chunks[0].text).toBe("Title")
    })
  })

  describe("heading-based splitting", () => {
    it("splits a long note at heading boundaries", () => {
      const section1 = generateTokens(200)
      const section2 = generateTokens(200)
      const section3 = generateTokens(200)
      const body = `## Section 1\n${section1}\n\n## Section 2\n${section2}\n\n## Section 3\n${section3}`

      const chunks = chunkNoteContent("My Note", body)

      expect(chunks).toHaveLength(3)
      for (const chunk of chunks) {
        expect(chunk.text).toContain("My Note")
      }
    })

    it("assigns sequential indices to chunks", () => {
      const body = `## A\n${generateTokens(200)}\n\n## B\n${generateTokens(200)}\n\n## C\n${generateTokens(200)}`
      const chunks = chunkNoteContent("Note", body)

      const indices = chunks.map((chunk) => chunk.index)
      expect(indices).toEqual(indices.map((_, i) => i))
    })

    it("preserves preamble content before the first heading", () => {
      // Use unique token names so preamble content is distinguishable from section content
      const preamble = Array.from(
        { length: 300 },
        (_, i) => `preamble${i}`,
      ).join(" ")
      const section = generateTokens(300)
      const body = `${preamble}\n\n## Section\n${section}`

      const chunks = chunkNoteContent("Note", body)

      // Total tokens > 500 → heading-based path, preamble becomes its own chunk
      expect(chunks).toHaveLength(2)
      expect(chunks[0].text).toContain("preamble0")
      expect(chunks[0].text).toContain("preamble299")
    })
  })

  describe("tiny section merging", () => {
    it("merges a tiny section with its neighbor", () => {
      const tinySection = generateTokens(20)
      const normalSection = generateTokens(250)
      // Total tokens > 500 so heading-based path is entered
      const body = `## Tiny\n${tinySection}\n\n## Normal\n${normalSection}\n\n## Another\n${generateTokens(250)}`

      const chunks = chunkNoteContent("Note", body)

      // 3 heading sections, but the tiny one (20 tokens < MIN_CHUNK_TOKENS)
      // merges with its neighbor — result is 2, not 3
      expect(chunks).toHaveLength(2)
    })
  })

  describe("paragraph sub-splitting", () => {
    it("splits an oversized section at paragraph boundaries", () => {
      // Create a single section with ~900 tokens (well above 450 max)
      const paragraphs = Array.from(
        { length: 6 },
        (_, i) => `Paragraph ${i}: ${generateTokens(150)}`,
      )
      const body = `## Big Section\n${paragraphs.join("\n\n")}`

      const chunks = chunkNoteContent("Note", body)

      // 6 paragraphs of ~152 tokens in a single section → 3 sub-chunks
      expect(chunks).toHaveLength(3)
      for (const chunk of chunks) {
        const tokenCount = chunk.text.split(/\s+/).filter(Boolean).length
        // Each chunk (including title prefix) stays within the budget
        expect(tokenCount).toBeLessThanOrEqual(500)
      }
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

      // 8 paragraphs of ~102 tokens each, no headings → paragraph-boundary split into 2 chunks
      expect(chunks).toHaveLength(2)
    })
  })

  describe("markdown stripping in chunks", () => {
    it("strips wikilinks in chunk text", () => {
      const body = `Some text with [[Target|display text]] and more ${generateTokens(10)}`
      const chunks = chunkNoteContent("Note", body)

      expect(chunks[0].text).toContain("display text")
      expect(chunks[0].text).not.toContain("[[")
    })

    it("strips bold/italic markers in chunk text", () => {
      const body = `This has **bold** and *italic* text ${generateTokens(10)}`
      const chunks = chunkNoteContent("Note", body)

      expect(chunks[0].text).toContain("bold")
      expect(chunks[0].text).toContain("italic")
      expect(chunks[0].text).not.toContain("**")
      expect(chunks[0].text).not.toContain("*italic*")
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
      expect(chunks).toHaveLength(1)
    })
  })
})
