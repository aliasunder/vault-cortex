import { describe, it, expect } from "vitest"
import { extractPdfText } from "../pdf.js"
import {
  buildPdf,
  buildMinimalPdf,
  buildEmptyStreamPdf,
  toPdfData,
} from "./pdf-fixture.js"

const HEADER = "Title: (untitled) | Pages: 1"

describe("extractPdfText", () => {
  it("extracts text from a valid PDF", async () => {
    const result = await extractPdfText(toPdfData(buildMinimalPdf()))
    expect(result).toEqual({ text: `${HEADER}\n\nHello PDF`, totalPages: 1 })
  })

  it("returns empty text with page count for a PDF with no extractable text", async () => {
    const result = await extractPdfText(toPdfData(buildEmptyStreamPdf()))
    expect(result).toEqual({ text: "", totalPages: 1 })
  })

  describe("heading levels", () => {
    it("keeps the volume-dominant size as body even when smaller sizes exist", async () => {
      const pdfBuffer = buildPdf([
        { text: "Tanisha Aberdeen", x: 72, y: 720, fontSize: 18 },
        { text: "Senior Engineer", x: 72, y: 690, fontSize: 13 },
        {
          text: "This is the body of the letter with plenty of text in it.",
          x: 72,
          y: 660,
          fontSize: 11,
        },
        {
          text: "It keeps going with more words than any other size has.",
          x: 72,
          y: 640,
          fontSize: 11,
        },
        { text: "toronto@example.com", x: 72, y: 610, fontSize: 9 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` +
          "# Tanisha Aberdeen\n" +
          "## Senior Engineer\n" +
          "This is the body of the letter with plenty of text in it.\n" +
          "It keeps going with more words than any other size has.\n" +
          "toronto@example.com",
      )
    })

    it("produces no headings when the document has a single font size", async () => {
      const pdfBuffer = buildPdf([
        { text: "First line", x: 72, y: 720, fontSize: 12 },
        { text: "Second line", x: 72, y: 700, fontSize: 12 },
        { text: "Third line", x: 72, y: 680, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\nFirst line\nSecond line\nThird line`,
      )
    })

    it("resolves a volume tie by treating the larger size as body", async () => {
      const pdfBuffer = buildPdf([
        { text: "AAAA", x: 72, y: 720, fontSize: 14 },
        { text: "BBBB", x: 72, y: 690, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nAAAA\nBBBB`)
    })

    it("classifies a line by its dominant size, not one oversized glyph", async () => {
      const pdfBuffer = buildPdf([
        { text: "Heading", x: 72, y: 720, fontSize: 18 },
        {
          text: "The body text of this line keeps its size dominant",
          x: 72,
          y: 680,
          fontSize: 11,
        },
        { text: "!", x: 420, y: 680, fontSize: 18 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` +
          "# Heading\n" +
          "The body text of this line keeps its size dominant !",
      )
    })

    it("renders sizes smaller than body as plain text, never headings", async () => {
      const pdfBuffer = buildPdf([
        {
          text: "Body copy long enough to dominate the character count.",
          x: 72,
          y: 720,
          fontSize: 11,
        },
        { text: "small footer", x: 72, y: 690, fontSize: 9 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n` +
          "Body copy long enough to dominate the character count.\n" +
          "small footer",
      )
    })
  })

  describe("within-line ordering and joining", () => {
    it("renders same-line items in x order even when the stream order differs", async () => {
      const pdfBuffer = buildPdf([
        { text: "world", x: 300, y: 700, fontSize: 12 },
        { text: "Hello", x: 100, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nHello world`)
    })

    it("collapses letter-spaced caps but keeps real word gaps and lowercase prose", async () => {
      // "SUMMARY" and "SECTION" as per-glyph ops with 0.3em tracking (pdfjs
      // merges each into one item with literal spaces baked in), separated by
      // a 1em word gap (pdfjs breaks items there). Helvetica AFM widths at
      // 12pt drive the x positions.
      const pdfBuffer = buildPdf([
        { text: "S", x: 100, y: 700, fontSize: 12 },
        { text: "U", x: 111.6, y: 700, fontSize: 12 },
        { text: "M", x: 123.87, y: 700, fontSize: 12 },
        { text: "M", x: 137.46, y: 700, fontSize: 12 },
        { text: "A", x: 151.06, y: 700, fontSize: 12 },
        { text: "R", x: 162.66, y: 700, fontSize: 12 },
        { text: "Y", x: 174.93, y: 700, fontSize: 12 },
        { text: "S", x: 195, y: 700, fontSize: 12 },
        { text: "E", x: 206.6, y: 700, fontSize: 12 },
        { text: "C", x: 218.21, y: 700, fontSize: 12 },
        { text: "T", x: 230.47, y: 700, fontSize: 12 },
        { text: "I", x: 241.4, y: 700, fontSize: 12 },
        { text: "O", x: 248.34, y: 700, fontSize: 12 },
        { text: "N", x: 261.28, y: 700, fontSize: 12 },
        { text: "on a to", x: 100, y: 660, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nSUMMARY SECTION\non a to`)
    })

    it("joins items separated by a word-sized gap with exactly one space", async () => {
      const pdfBuffer = buildPdf([
        { text: "foo", x: 100, y: 700, fontSize: 12 },
        { text: "bar", x: 200, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nfoo bar`)
    })
  })

  describe("monospace rendering", () => {
    it("fences consecutive fully-monospace lines as one code block", async () => {
      const pdfBuffer = buildPdf([
        { text: "const x = 1", x: 72, y: 700, fontSize: 12, font: "courier" },
        { text: "return x", x: 72, y: 680, fontSize: 12, font: "courier" },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n\`\`\`\nconst x = 1\nreturn x\n\`\`\``,
      )
    })

    it("wraps a monospace run inside a mixed line in inline backticks, not a fence", async () => {
      const pdfBuffer = buildPdf([
        { text: "Run", x: 100, y: 700, fontSize: 12 },
        {
          text: "kubectl apply",
          x: 125.6,
          y: 700,
          fontSize: 12,
          font: "courier",
        },
        { text: "now", x: 222.8, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nRun \`kubectl apply\` now`)
    })

    it("closes an open fence before a mixed line and reopens after it", async () => {
      const pdfBuffer = buildPdf([
        { text: "line one", x: 72, y: 700, fontSize: 12, font: "courier" },
        { text: "see", x: 72, y: 660, fontSize: 12 },
        { text: "cmd", x: 100, y: 660, fontSize: 12, font: "courier" },
        { text: "line two", x: 72, y: 620, fontSize: 12, font: "courier" },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(
        `${HEADER}\n\n\`\`\`\nline one\n\`\`\`\nsee \`cmd\`\n\`\`\`\nline two\n\`\`\``,
      )
    })
  })

  describe("orphaned list markers", () => {
    it("rejoins numeric markers emitted before their items in the stream", async () => {
      const pdfBuffer = buildPdf([
        { text: "1.", x: 100, y: 700, fontSize: 12 },
        { text: "2.", x: 100, y: 660, fontSize: 12 },
        { text: "First thing", x: 115, y: 700, fontSize: 12 },
        { text: "Second thing", x: 115, y: 660, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n1. First thing\n2. Second thing`)
    })

    it("rejoins lettered markers to their items", async () => {
      // The marker and its item are separated in the stream by another line,
      // so only the rejoin pass — not plain sequential grouping — can merge
      // them (same shape as the numeric-marker test).
      const pdfBuffer = buildPdf([
        { text: "a.", x: 100, y: 700, fontSize: 12 },
        { text: "closing line", x: 72, y: 660, fontSize: 12 },
        { text: "Alpha item", x: 115, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nclosing line\na. Alpha item`)
    })

    it("rejoins bullet-glyph markers to their items", async () => {
      const pdfBuffer = buildPdf([
        { text: "•", x: 100, y: 700, fontSize: 12 },
        { text: "closing line", x: 72, y: 660, fontSize: 12 },
        { text: "Bullet item", x: 112, y: 700, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\nclosing line\n• Bullet item`)
    })

    it("leaves non-marker short lines and partnerless markers untouched", async () => {
      const pdfBuffer = buildPdf([
        { text: "3.14", x: 100, y: 700, fontSize: 12 },
        { text: "middle", x: 72, y: 660, fontSize: 12 },
        { text: "pi value", x: 150, y: 700, fontSize: 12 },
        { text: "7.", x: 100, y: 500, fontSize: 12 },
      ])
      const result = await extractPdfText(toPdfData(pdfBuffer))
      expect(result.text).toBe(`${HEADER}\n\n3.14\nmiddle\npi value\n7.`)
    })
  })
})
