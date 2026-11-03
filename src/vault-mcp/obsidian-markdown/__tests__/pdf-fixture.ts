/** Non-ASCII characters the fixture supports, mapped to their WinAnsi byte as
 *  an octal escape — the buffer is ASCII-encoded, so these are the only way
 *  to express them in a content stream (fonts declare /WinAnsiEncoding). */
const WINANSI_OCTAL_ESCAPES: ReadonlyMap<string, string> = new Map([["•", "\\225"]])

/** Escapes the three characters with special meaning inside a PDF literal
 *  string — backslash first so the escapes it introduces aren't re-escaped —
 *  then swaps supported non-ASCII characters for their WinAnsi octal form. */
const escapePdfString = (text: string): string => {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  return [...escaped]
    .map((character) => {
      const winAnsiEscape = WINANSI_OCTAL_ESCAPES.get(character)

      if (winAnsiEscape) return winAnsiEscape
      // The buffer is ASCII-encoded, which truncates code points to their low
      // byte — reject unsupported characters instead of silently corrupting.
      if (character.charCodeAt(0) > 126) {
        throw new Error(
          `escapePdfString: unsupported non-ASCII character "${character}" — add it to WINANSI_OCTAL_ESCAPES`,
        )
      }
      return character
    })
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
 *  correct xref table and trailer; `extraTrailerEntries` go into the trailer
 *  dictionary after /Root. */
const assemblePdf = (
  objects: readonly string[],
  options: { extraTrailerEntries?: string } = {},
): Buffer => {
  const { extraTrailerEntries = "" } = options
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
    ...objectOffsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
  ]

  const trailer = [
    "xref",
    `0 ${xrefEntries.length}`,
    ...xrefEntries,
    "trailer",
    `<< /Size ${xrefEntries.length} /Root 1 0 R${extraTrailerEntries} >>`,
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
    ["4 0 obj", `<< /Length ${streamBytes} >>`, "stream", stream, "endstream", "endobj"].join("\n"),
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

/** Builds a single-page PDF with no text: a red fill over the whole page,
 *  clipped to the 200×200 square at (100, 100). pdf.js draws the clip and the
 *  fill as Path2D objects, so this page renders only when the canvas accepts
 *  the global Path2D. */
export const buildClippedFillPdf = (): Buffer => {
  const stream = "q 100 100 200 200 re W n 1 0 0 rg 0 0 612 792 re f Q"
  return assemblePdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj",
    [
      "4 0 obj",
      `<< /Length ${Buffer.byteLength(stream, "ascii")} >>`,
      "stream",
      stream,
      "endstream",
      "endobj",
    ].join("\n"),
  ])
}

/** One page of a linked fixture PDF: a line of Helvetica text, plus a URI
 *  link annotation for each URL, in order. */
export type PdfLinkedPage = Readonly<{
  text: string
  linkUrls: readonly string[]
}>

/** Builds a multi-page PDF with a title in its Info dictionary. Object
 *  numbers run in this order:
 *  - 1–4: the catalog, page tree, font and Info dictionary
 *  - then, per page: its page object, its content stream, one per link */
export const buildLinkedPdf = (params: {
  title: string
  pages: readonly PdfLinkedPage[]
}): Buffer => {
  const FIRST_PAGE_OBJECT = 5
  const pageObjectNumbers = params.pages.map((_, pageIndex) => {
    const earlierPages = params.pages.slice(0, pageIndex)
    return earlierPages.reduce(
      (number, page) => number + 2 + page.linkUrls.length,
      FIRST_PAGE_OBJECT,
    )
  })

  const pageObjects = params.pages.flatMap((page, pageIndex) => {
    const pageNumber = pageObjectNumbers[pageIndex] ?? FIRST_PAGE_OBJECT
    const contentNumber = pageNumber + 1
    const linkObjectNumber = (linkIndex: number): number => contentNumber + 1 + linkIndex
    const annotRefs = page.linkUrls
      .map((_, linkIndex) => `${linkObjectNumber(linkIndex)} 0 R`)
      .join(" ")
    const stream = `BT /F1 12 Tf 1 0 0 1 100 700 Tm (${escapePdfString(page.text)}) Tj ET`
    const linkObjects = page.linkUrls.map((url, linkIndex) => {
      const bottom = 600 - linkIndex * 20
      return [
        `${linkObjectNumber(linkIndex)} 0 obj`,
        `<< /Type /Annot /Subtype /Link /Rect [100 ${bottom} 300 ${bottom + 15}]`,
        `   /Border [0 0 0] /A << /S /URI /URI (${escapePdfString(url)}) >> >>`,
        "endobj",
      ].join("\n")
    })
    return [
      [
        `${pageNumber} 0 obj`,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]",
        `   /Contents ${contentNumber} 0 R /Annots [${annotRefs}]`,
        "   /Resources << /Font << /F1 3 0 R >> >> >>",
        "endobj",
      ].join("\n"),
      [
        `${contentNumber} 0 obj`,
        `<< /Length ${Buffer.byteLength(stream, "ascii")} >>`,
        "stream",
        stream,
        "endstream",
        "endobj",
      ].join("\n"),
      ...linkObjects,
    ]
  })

  const kids = pageObjectNumbers.map((pageNumber) => `${pageNumber} 0 R`).join(" ")
  return assemblePdf(
    [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${params.pages.length} >>\nendobj`,
      "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj",
      `4 0 obj\n<< /Title (${escapePdfString(params.title)}) >>\nendobj`,
      ...pageObjects,
    ],
    { extraTrailerEntries: " /Info 4 0 R" },
  )
}

/** Builds a PDF whose page tree is empty: it opens, but has no page to render. */
export const buildZeroPagePdf = (): Buffer => {
  return assemblePdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj",
  ])
}

/** Builds a PDF that needs a user password to open. Its standard security
 *  handler (RC4, revision 2) holds password hashes that no password matches,
 *  so pdf.js asks for one even with the empty password tried first. The
 *  content is never decrypted, so it stays a plain one-page catalog. */
export const buildPasswordProtectedPdf = (): Buffer => {
  const unmatchableHash = `<${"ab".repeat(32)}>`
  const documentId = `<${"cd".repeat(16)}>`
  return assemblePdf(
    [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj",
      `4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O ${unmatchableHash} /U ${unmatchableHash} /P -44 >>\nendobj`,
    ],
    { extraTrailerEntries: ` /Encrypt 4 0 R /ID [${documentId} ${documentId}]` },
  )
}

/** Wraps a fixture buffer as the Uint8Array view extractPdfText expects —
 *  shared so each test doesn't repeat the three-arg view construction. */
export const toPdfData = (pdfBuffer: Buffer): Uint8Array => {
  return new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength)
}
