import { describe, it, expect } from "vitest"
import { extractPdfText } from "../pdf.js"
import { buildMinimalPdf, buildEmptyStreamPdf } from "./pdf-fixture.js"

describe("extractPdfText", () => {
  it("extracts text from a valid PDF", async () => {
    const pdfBuffer = buildMinimalPdf()
    const pdfData = new Uint8Array(
      pdfBuffer.buffer,
      pdfBuffer.byteOffset,
      pdfBuffer.byteLength,
    )
    const result = await extractPdfText(pdfData)
    expect(result.text).toBe("Title: (untitled) | Pages: 1\n\nHello PDF")
    expect(result.totalPages).toBe(1)
  })

  it("returns empty text with page count for a PDF with no extractable text", async () => {
    const emptyStreamPdf = buildEmptyStreamPdf()
    const pdfData = new Uint8Array(
      emptyStreamPdf.buffer,
      emptyStreamPdf.byteOffset,
      emptyStreamPdf.byteLength,
    )
    const result = await extractPdfText(pdfData)
    expect(result.text).toBe("")
    expect(result.totalPages).toBe(1)
  })
})
