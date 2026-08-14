/** Non-ASCII characters the fixture supports, mapped to their WinAnsi byte as
 *  an octal escape — the buffer is ASCII-encoded, so these are the only way
 *  to express them in a content stream (fonts declare /WinAnsiEncoding). */
const WINANSI_OCTAL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["•", "\\225"],
])

/** Escapes the three characters with special meaning inside a PDF literal
 *  string — backslash first so the escapes it introduces aren't re-escaped —
 *  then swaps supported non-ASCII characters for their WinAnsi octal form. */
const escapePdfString = (text: string): string => {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
  return [...escaped]
    .map((character) => WINANSI_OCTAL_ESCAPES.get(character) ?? character)
    .join("")
}

/** One positioned text-showing operation in a fixture PDF's content stream. */
export type PdfTextOp = Readonly<{
  text: string
  x: number
  y: number
  fontSize: number
  font?: "helvetica" | "courier"
}>

/** Maps the fixture's font choice to the resource name declared in the page's
 *  Resources dictionary — /F1 Helvetica (reported by pdfjs as "sans-serif"),
 *  /F2 Courier (reported as "monospace"). */
const FONT_RESOURCE_NAMES: Record<NonNullable<PdfTextOp["font"]>, string> = {
  helvetica: "/F1",
  courier: "/F2",
}

/** Assembles numbered PDF objects (each a full "N 0 obj … endobj" block, in
 *  object-number order starting at 1) into a valid PDF 1.4 buffer with a
 *  correct xref table and trailer. */
const assemblePdf = (objects: readonly string[]): Buffer => {
  const header = "%PDF-1.4\n\n"

  // The xref table needs each object's byte offset, so the body is built
  // object by object while offsets accumulate sequentially.
  const objectOffsets: number[] = []
  let body = header
  for (const object of objects) {
    objectOffsets.push(Buffer.byteLength(body, "ascii"))
    body += `${object}\n\n`
  }

  const xrefOffset = Buffer.byteLength(body, "ascii")
  const xrefEntries = [
    "0000000000 65535 f ",
    ...objectOffsets.map(
      (offset) => `${String(offset).padStart(10, "0")} 00000 n `,
    ),
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

/** Builds a valid single-page PDF 1.4 buffer whose content stream draws each
 *  op at absolute page coordinates. Uses `Tm` (absolute text matrix), not `Td`
 *  (relative), so extracted items report `x`/`y` exactly as written; the `Tf`
 *  size comes back exactly via pdfjs's transform-derived fontSize. Each op is
 *  its own BT/ET block so pdfjs emits it as a separate text item. */
export const buildPdf = (textOps: readonly PdfTextOp[]): Buffer => {
  const streamOps = textOps.map((op) => {
    const fontResourceName = FONT_RESOURCE_NAMES[op.font ?? "helvetica"]
    const position = `1 0 0 1 ${op.x} ${op.y} Tm`
    return `BT ${fontResourceName} ${op.fontSize} Tf ${position} (${escapePdfString(op.text)}) Tj ET`
  })
  const stream = streamOps.join("\n")
  const streamBytes = Buffer.byteLength(stream, "ascii")

  return assemblePdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
    [
      "3 0 obj",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]",
      "   /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
      "endobj",
    ].join("\n"),
    [
      "4 0 obj",
      `<< /Length ${streamBytes} >>`,
      "stream",
      stream,
      "endstream",
      "endobj",
    ].join("\n"),
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj",
    "6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\nendobj",
  ])
}

/** Builds a minimal valid PDF 1.4 buffer containing "Hello PDF" — just enough
 *  structure for unpdf's text extraction to return readable content. */
export const buildMinimalPdf = (): Buffer => {
  return buildPdf([{ text: "Hello PDF", x: 100, y: 700, fontSize: 12 }])
}

/** Builds a minimal valid PDF with an empty content stream — no text
 *  operators, so extractTextItems returns items with no content. */
export const buildEmptyStreamPdf = (): Buffer => {
  return assemblePdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
    [
      "3 0 obj",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]",
      "   /Contents 4 0 R /Resources << >> >>",
      "endobj",
    ].join("\n"),
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj",
  ])
}

/** Wraps a fixture buffer as the Uint8Array view extractPdfText expects —
 *  shared so each test doesn't repeat the three-arg view construction. */
export const toPdfData = (pdfBuffer: Buffer): Uint8Array => {
  return new Uint8Array(
    pdfBuffer.buffer,
    pdfBuffer.byteOffset,
    pdfBuffer.byteLength,
  )
}
