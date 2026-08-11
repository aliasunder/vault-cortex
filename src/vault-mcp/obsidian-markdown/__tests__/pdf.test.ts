import { describe, it, expect } from "vitest"
import { extractPdfText } from "../pdf.js"
import { buildMinimalPdf } from "../../mcp-core/__tests__/pdf-fixture.js"

describe("extractPdfText", () => {
  it("extracts text from a valid PDF", async () => {
    const pdfBuffer = buildMinimalPdf()
    const pdfData = new Uint8Array(
      pdfBuffer.buffer,
      pdfBuffer.byteOffset,
      pdfBuffer.byteLength,
    )
    const text = await extractPdfText(pdfData)
    expect(text).toContain("Hello PDF")
    expect(text).toContain("Title:")
    expect(text).toContain("Pages: 1")
  })

  it("returns empty string for a PDF with no extractable text", async () => {
    // Minimal PDF with an empty content stream (no text operators)
    const emptyStreamPdf = buildEmptyStreamPdf()
    const pdfData = new Uint8Array(
      emptyStreamPdf.buffer,
      emptyStreamPdf.byteOffset,
      emptyStreamPdf.byteLength,
    )
    const text = await extractPdfText(pdfData)
    expect(text).toBe("")
  })
})

/** Builds a minimal valid PDF with an empty content stream — no text
 *  operators, so extractTextItems returns items with no content. */
const buildEmptyStreamPdf = (): Buffer => {
  const stream = ""
  const streamBytes = Buffer.byteLength(stream, "ascii")

  const lines = [
    "%PDF-1.4",
    "",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]",
    `   /Contents 4 0 R /Resources << >> >>`,
    "endobj",
    "",
    "4 0 obj",
    `<< /Length ${streamBytes} >>`,
    "stream",
    stream,
    "endstream",
    "endobj",
    "",
  ]

  const body = lines.join("\n")
  const xrefOffset = Buffer.byteLength(body, "ascii")

  const xrefEntries = [
    "0000000000 65535 f ",
    `${String(body.indexOf("1 0 obj")).padStart(10, "0")} 00000 n `,
    `${String(body.indexOf("2 0 obj")).padStart(10, "0")} 00000 n `,
    `${String(body.indexOf("3 0 obj")).padStart(10, "0")} 00000 n `,
    `${String(body.indexOf("4 0 obj")).padStart(10, "0")} 00000 n `,
  ]

  const trailer = [
    "xref",
    `0 ${xrefEntries.length}`,
    ...xrefEntries,
    "trailer",
    `<< /Size ${xrefEntries.length} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ].join("\n")

  return Buffer.from(body + trailer, "ascii")
}
