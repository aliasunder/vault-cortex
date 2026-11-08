import { pageTextByLines } from "../obsidian-markdown/lines.js"
import type { LineWindow } from "../obsidian-markdown/lines.js"

export type AssetTextResult = Readonly<{
  kind: "text"
  text: string
  path: string
  lineWindow?: LineWindow
}>

/** Fixed cap on text output (text files, canvas renditions and
 *  PDF-extracted text) so a huge text asset can't blow a client's response
 *  limit. Deliberately not an env var — the image budget is the tunable
 *  surface; text past this size is read in line windows, not raised into a
 *  bigger blob. */
export const MAX_TEXT_OUTPUT_BYTES = 102_400

/** Compares with undefined, not truthiness, so a 0 still counts as a line
 *  window request and is rejected rather than ignored. */
export const requestsLineWindow = (params: {
  startLine?: number | undefined
  limit?: number | undefined
}): boolean => {
  return params.startLine !== undefined || params.limit !== undefined
}

/** Rejects text output past the fixed cap — an explicit error beats silent
 *  truncation, and states the actual size so the caller knows what exists. */
const assertTextWithinCap = (params: {
  text: string
  path: string
  lineWindow?: LineWindow | undefined
}): void => {
  const { text, path, lineWindow } = params
  const textBytes = Buffer.byteLength(text, "utf8")

  if (textBytes <= MAX_TEXT_OUTPUT_BYTES) return

  const renderedSubject = lineWindow
    ? `"${path}" lines ${lineWindow.startLine}–${lineWindow.endLine} render`
    : `"${path}" renders`
  throw new Error(
    `text output too large: ${renderedSubject} to ${textBytes} bytes ` +
      `(cap ${MAX_TEXT_OUTPUT_BYTES} bytes)`,
  )
}

/**
 * Builds the text result for a rendition — whole or paged. Without paging
 * params the full text returns byte-identical, within the text output cap. With
 * paging, delegates line splitting, validation, and slicing to the shared
 * pageTextByLines primitive, then enforces the asset-specific byte cap on
 * the resulting window.
 */
export const buildTextResult = (params: {
  text: string
  path: string
  startLine?: number | undefined
  limit?: number | undefined
}): AssetTextResult => {
  const { text, path, startLine, limit } = params
  const isPagedRead = requestsLineWindow({ startLine, limit })

  if (!isPagedRead) {
    assertTextWithinCap({ text, path })
    return { kind: "text", text, path }
  }

  const { text: windowText, lineWindow } = pageTextByLines({
    text,
    path,
    startLine,
    limit,
  })

  assertTextWithinCap({ text: windowText, path, lineWindow })
  return { kind: "text", text: windowText, path, lineWindow }
}

/** The server's message for pdf.js refusing to open a vault file, worded like
 *  the other read errors; undefined for any other failure. The match is on
 *  `name`:
 *  - pdf.js's PasswordException and InvalidPDFException constructors set
 *    these names.
 *  - Importing those classes for instanceof would load pdf.js at server
 *    start, so a pdf.js load failure would stop the server rather than fail
 *    only PDF reads. */
export const describePdfOpenFailure = (params: {
  error: unknown
  path: string
  bytes: number
}): string | undefined => {
  const { error, path, bytes } = params

  if (!(error instanceof Error)) return undefined

  switch (error.name) {
    case "PasswordException":
      return `PDF is password-protected: "${path}" exists (${bytes} bytes) but cannot be opened without its password`
    case "InvalidPDFException":
      return `PDF is damaged or not a PDF: "${path}" exists (${bytes} bytes) but cannot be parsed`
    default:
      return undefined
  }
}

/** Empty extraction is a read error even when the document has valid pages. */
export const buildPdfTextResult = (params: {
  text: string
  totalPages: number
  path: string
  bytes: number
  startLine?: number | undefined
  limit?: number | undefined
}): AssetTextResult => {
  const { text, totalPages, path, bytes, startLine, limit } = params

  if (!text) {
    throw new Error(
      `PDF has no extractable text: "${path}" exists ` +
        `(${bytes} bytes, ${totalPages} pages) but ` +
        `contains no text content — it may be a scanned document or ` +
        `image-only PDF`,
    )
  }
  return buildTextResult({ text, path, startLine, limit })
}
