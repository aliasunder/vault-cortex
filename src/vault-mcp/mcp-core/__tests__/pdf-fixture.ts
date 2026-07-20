/** Builds a minimal valid PDF 1.4 buffer containing "Hello PDF" — just enough
 *  structure for unpdf's text extraction to return readable content. */
export const buildMinimalPdf = (): Buffer => {
  const textContent = "Hello PDF"
  const stream = `BT /F1 12 Tf 100 700 Td (${textContent}) Tj ET`
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
    "   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "endobj",
    "",
    "4 0 obj",
    `<< /Length ${streamBytes} >>`,
    "stream",
    stream,
    "endstream",
    "endobj",
    "",
    "5 0 obj",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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
    `${String(body.indexOf("5 0 obj")).padStart(10, "0")} 00000 n `,
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
