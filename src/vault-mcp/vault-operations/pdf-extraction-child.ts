import { writeFile } from "node:fs/promises"
import { logger } from "../../logger.js"
import { describeError, describeErrorRelativeTo } from "../../utils/describe-error.js"
import { getUtf8BytePrefix } from "../../utils/get-utf8-byte-prefix.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import {
  extractPdfIndexText,
  extractPdfText,
  MAX_INDEXED_PDF_BYTES,
} from "../obsidian-markdown/pdf.js"
import { vaultFs } from "./vault-filesystem.js"
import { buildPdfTextResult, describePdfOpenFailure } from "./asset-text.js"
import { pdfRequestSchema, type PdfRequest, type PdfReply } from "./pdf-extraction-protocol.js"

// Prefer the disposable child as a victim during host memory pressure.
const CHILD_OOM_SCORE_ADJUSTMENT = "1000"
/** Matches a bracketed error name followed by a colon at the start of a formatted error. */
const FORMATTED_ERROR_NAME_PREFIX = /^\[[^\]]+\]: /

const getSystemErrorDetails = (error: unknown): { code: string; syscall: string } | undefined => {
  if (!isErrnoException(error)) return undefined
  const { syscall } = error

  if (typeof syscall !== "string") return undefined
  return { code: error.code, syscall }
}

const send = (reply: PdfReply): void => {
  if (!process.connected || !process.send) process.exit(0)
  process.send(reply, (error) => {
    if (error) process.exit(0)
  })
}

/** pdfjs refuses a Node Buffer, so it gets a plain view over the same bytes. */
const toPdfData = (buffer: Buffer): Uint8Array => {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/** pdfjs's refusal to open the file becomes the server's own message; other failures pass through. */
const extractTextOrDescribeRefusal = async (params: {
  request: PdfRequest
  pdfData: Uint8Array
  bytes: number
}) => {
  const { request, pdfData, bytes } = params
  const extractText = request.kind === "index" ? extractPdfIndexText : extractPdfText
  try {
    return await extractText(pdfData)
  } catch (error) {
    const refusalMessage = describePdfOpenFailure({ error, path: request.path, bytes })

    if (refusalMessage) throw new Error(refusalMessage, { cause: error })
    throw error
  }
}

const extractAndReply = async (request: PdfRequest): Promise<void> => {
  // The child's logger has no sink, so this context never reaches a log; readAsset requires one.
  const requestLogger = logger.child({ extractionRequestId: request.requestId })
  const asset = await vaultFs.readAsset(
    { vaultPath: request.vaultPath, path: request.path, maxBytes: request.maxFileBytes },
    requestLogger,
  )
  const result = await extractTextOrDescribeRefusal({
    request,
    pdfData: toPdfData(asset.buffer),
    bytes: asset.bytes,
  })

  if (request.kind === "index") {
    // The last page read can carry the rendition past the budget; the cut happens here so the
    // parent never receives more than it indexes.
    const text = getUtf8BytePrefix(result.text, MAX_INDEXED_PDF_BYTES)
    send({ kind: "index-result", requestId: request.requestId, result: { ...result, text } })
    return
  }
  const textResult = buildPdfTextResult({
    ...result,
    path: request.path,
    bytes: asset.bytes,
    startLine: request.startLine,
    limit: request.limit,
  })
  send({ kind: "read-result", requestId: request.requestId, result: textResult })
}

const errorToFailureReply = (params: { error: unknown; request: PdfRequest }): PdfReply => {
  const { error, request } = params
  const description = describeErrorRelativeTo({ error, directory: request.vaultPath })
  const systemError = getSystemErrorDetails(error)
  const errorCause = error instanceof Error ? error.cause : undefined

  return {
    kind: "failure",
    requestId: request.requestId,
    name: error instanceof Error ? error.name : "Error",
    message: description.replace(FORMATTED_ERROR_NAME_PREFIX, ""),
    ...(errorCause !== undefined ? { cause: describeError(errorCause) } : {}),
    ...(systemError ? { systemError } : {}),
  }
}

const requestOomPreference = async (): Promise<
  | { oomPreference: "applied" | "unsupported" }
  | { oomPreference: "unavailable"; oomPreferenceError: string }
> => {
  if (process.platform !== "linux") return { oomPreference: "unsupported" }
  try {
    await writeFile("/proc/self/oom_score_adj", CHILD_OOM_SCORE_ADJUSTMENT)
    return { oomPreference: "applied" }
  } catch (error) {
    // Reported through the ready reply: the parent logs it, and this process's log has no sink.
    return { oomPreference: "unavailable", oomPreferenceError: describeError(error) }
  }
}

const main = async (): Promise<void> => {
  const preference = await requestOomPreference()
  // A disconnected parent has no deadline left; the child exits at its next event turn.
  process.on("disconnect", () => process.exit(0))
  process.on("message", async (message: unknown) => {
    const parsed = pdfRequestSchema.safeParse(message)

    if (!parsed.success) process.exit(1)
    const request = parsed.data
    try {
      await extractAndReply(request)
    } catch (error) {
      send(errorToFailureReply({ error, request }))
    }
  })
  send({ kind: "ready", ...preference })
}

await main()
