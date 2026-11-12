import { describe, it, expect } from "vitest"
import {
  buildPdfTextResult,
  buildTextResult,
  describePdfOpenFailure,
  MAX_TEXT_OUTPUT_BYTES,
  requestsLineWindow,
} from "../asset-text.js"

describe("MAX_TEXT_OUTPUT_BYTES", () => {
  it("caps text output at 100 KiB", () => {
    expect(MAX_TEXT_OUTPUT_BYTES).toBe(102_400)
  })
})

describe("requestsLineWindow", () => {
  it("is false when neither paging param is given", () => {
    expect(requestsLineWindow({})).toBe(false)
  })

  it.each([
    { label: "startLine", params: { startLine: 0 } },
    { label: "limit", params: { limit: 0 } },
  ])("counts a $label of 0 as a line window request", ({ params }) => {
    expect(requestsLineWindow(params)).toBe(true)
  })
})

describe("buildTextResult", () => {
  it("returns the whole text unchanged without paging params", () => {
    expect(buildTextResult({ text: "one\ntwo", path: "notes.txt" })).toEqual({
      kind: "text",
      text: "one\ntwo",
      path: "notes.txt",
    })
  })

  it("returns the requested line window with its position in the whole text", () => {
    const result = buildTextResult({
      text: "one\ntwo\nthree\nfour",
      path: "notes.txt",
      startLine: 2,
      limit: 2,
    })

    expect(result).toEqual({
      kind: "text",
      text: "two\nthree",
      path: "notes.txt",
      lineWindow: { startLine: 2, endLine: 3, totalLines: 4 },
    })
  })

  it("returns whole text exactly at the cap", () => {
    const capText = "x".repeat(102_400)

    expect(buildTextResult({ text: capText, path: "big.txt" })).toEqual({
      kind: "text",
      text: capText,
      path: "big.txt",
    })
  })

  it("rejects whole text one byte over the cap with its byte count", () => {
    expect(() => buildTextResult({ text: "x".repeat(102_401), path: "big.txt" })).toThrow(
      new Error('text output too large: "big.txt" renders to 102401 bytes (cap 102400 bytes)'),
    )
  })

  it("rejects a line window over the cap with its lines and byte count", () => {
    const text = ["short", "y".repeat(102_401), "tail"].join("\n")

    expect(() => buildTextResult({ text, path: "big.txt", startLine: 2, limit: 1 })).toThrow(
      new Error(
        'text output too large: "big.txt" lines 2–2 render to 102401 bytes (cap 102400 bytes)',
      ),
    )
  })
})

describe("describePdfOpenFailure", () => {
  it("names a password-protected PDF for pdf.js's PasswordException", () => {
    const error = Object.assign(new Error("No password given"), { name: "PasswordException" })

    expect(describePdfOpenFailure({ error, path: "papers/locked.pdf", fileBytes: 14 })).toBe(
      'PDF is password-protected: "papers/locked.pdf" exists (14 bytes) but cannot be opened without its password',
    )
  })

  it("names a damaged PDF for pdf.js's InvalidPDFException", () => {
    const error = Object.assign(new Error("Invalid PDF structure."), {
      name: "InvalidPDFException",
    })

    expect(describePdfOpenFailure({ error, path: "papers/broken.pdf", fileBytes: 14 })).toBe(
      'PDF is damaged or not a PDF: "papers/broken.pdf" exists (14 bytes) but cannot be parsed',
    )
  })

  it("returns undefined for an Error with any other name", () => {
    const error = new Error("PDF reader could not start")

    expect(describePdfOpenFailure({ error, path: "doc.pdf", fileBytes: 14 })).toBeUndefined()
  })

  it("returns undefined for a thrown value that is not an Error", () => {
    const error = { name: "PasswordException", message: "No password given" }

    expect(describePdfOpenFailure({ error, path: "doc.pdf", fileBytes: 14 })).toBeUndefined()
  })
})

describe("buildPdfTextResult", () => {
  it("rejects empty text as a PDF with no extractable text, naming its bytes and pages", () => {
    const buildEmptyResult = () => {
      return buildPdfTextResult({
        text: "",
        totalPages: 12,
        path: "scans/receipt.pdf",
        fileBytes: 5_000_000,
      })
    }

    expect(buildEmptyResult).toThrow(
      new Error(
        'PDF has no extractable text: "scans/receipt.pdf" exists ' +
          "(5000000 bytes, 12 pages) but contains no text content " +
          "— it may be a scanned document or image-only PDF",
      ),
    )
  })

  // Extraction drops whitespace-only items itself, so text arriving here is
  // never blank; this pins that the check is for emptiness alone
  it("returns whitespace-only text as text", () => {
    expect(
      buildPdfTextResult({ text: "  \n\t", totalPages: 1, path: "blank.pdf", fileBytes: 1_000 }),
    ).toEqual({ kind: "text", text: "  \n\t", path: "blank.pdf" })
  })

  it("returns the whole rendition without paging params", () => {
    const result = buildPdfTextResult({
      text: "Title: Doc | Pages: 1\n\nHello",
      totalPages: 1,
      path: "doc.pdf",
      fileBytes: 1_000,
    })

    expect(result).toEqual({
      kind: "text",
      text: "Title: Doc | Pages: 1\n\nHello",
      path: "doc.pdf",
    })
  })

  it("passes paging params through to the line window", () => {
    const result = buildPdfTextResult({
      text: "Title: Doc | Pages: 1\n\nHello\nWorld",
      totalPages: 1,
      path: "doc.pdf",
      fileBytes: 1_000,
      startLine: 3,
      limit: 1,
    })

    expect(result).toEqual({
      kind: "text",
      text: "Hello",
      path: "doc.pdf",
      lineWindow: { startLine: 3, endLine: 3, totalLines: 4 },
    })
  })
})
