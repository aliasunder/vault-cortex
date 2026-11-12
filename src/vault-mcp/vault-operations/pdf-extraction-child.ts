import { writeFile } from "node:fs/promises"
import { logger } from "../../logger.js"
import { describeError, describeErrorRelativeTo } from "../../utils/describe-error.js"
import { getUtf8BytePrefix } from "../../utils/get-utf8-byte-prefix.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import {
  extractPdfIndexText,
  extractPdfText,
  MAX_INDEXED_PDF_BYTES,
  toPdfData,
} from "../obsidian-markdown/pdf.js"
import { vaultFs } from "./vault-filesystem.js"
import { buildPdfTextResult, describePdfOpenFailure } from "./asset-text.js"
import { pdfRequestSchema, type PdfRequest, type PdfReply } from "./pdf-extraction-protocol.js"

/**
 * The PDF extraction child process. The parent (`pdf-extractor.ts`) spawns it, sends one request
 * at a time over IPC and waits for the reply before sending the next; this process reads the PDF,
 * extracts its text and replies with the result or the error. The parent discards this process's
 * stdout and stderr and sets `LOG_DIR=none`, so its logger writes nowhere; anything worth logging
 * travels in a reply for the parent to log.
 */

// Prefer the disposable child as a victim during host memory pressure.
const CHILD_OOM_SCORE_ADJUSTMENT = "1000"
/** Matches a bracketed error name followed by a colon at the start of a formatted error. */
const FORMATTED_ERROR_NAME_PREFIX = /^\[[^\]]+\]: /

/** The errno code and syscall of an error that names one, so the parent can rebuild an error
 *  whose path and remedy text match an in-process failure. */
const getSystemErrorDetails = (error: unknown): { code: string; syscall: string } | undefined => {
  if (!isErrnoException(error)) return undefined
  const { syscall } = error

  if (typeof syscall !== "string") return undefined
  return { code: error.code, syscall }
}

/** Sends a reply to the parent. A parent that has gone has nothing to reply to, so this process
 *  exits instead, with 0 because no parent is left to read a crash. */
const sendReply = (reply: PdfReply): void => {
  if (!process.connected || !process.send) process.exit(0)
  process.send(reply, (error) => {
    if (error) process.exit(0)
  })
}

/** Extracts the PDF's text. When pdfjs cannot open the file at all (password-protected, or not
 *  a PDF), the error becomes the server's own message; other failures pass through. */
const extractTextOrDescribeOpenFailure = async (params: {
  request: PdfRequest
  pdfData: Uint8Array
  fileBytes: number
}) => {
  const { request, pdfData, fileBytes } = params
  const extractText = request.kind === "index" ? extractPdfIndexText : extractPdfText
  try {
    return await extractText(pdfData)
  } catch (error) {
    const openFailureMessage = describePdfOpenFailure({ error, path: request.path, fileBytes })

    if (openFailureMessage) throw new Error(openFailureMessage, { cause: error })
    throw error
  }
}

const extractAndReply = async (request: PdfRequest): Promise<void> => {
  // readAsset requires a logger; this one writes nowhere (see the header).
  const requestLogger = logger.child({ extractionRequestId: request.requestId })
  const asset = await vaultFs.readAsset(
    { vaultPath: request.vaultPath, path: request.path, maxBytes: request.maxFileBytes },
    requestLogger,
  )
  const result = await extractTextOrDescribeOpenFailure({
    request,
    pdfData: toPdfData(asset.buffer),
    fileBytes: asset.bytes,
  })

  if (request.kind === "index") {
    // Index extraction stops after the page that reaches MAX_INDEXED_PDF_BYTES, so its text can
    // run past the cap by one page. The cut happens here so the parent never receives more than
    // it indexes.
    const text = getUtf8BytePrefix(result.text, MAX_INDEXED_PDF_BYTES)
    sendReply({ kind: "index-result", requestId: request.requestId, result: { ...result, text } })
    return
  }
  const textResult = buildPdfTextResult({
    ...result,
    path: request.path,
    fileBytes: asset.bytes,
    startLine: request.startLine,
    limit: request.limit,
  })
  sendReply({ kind: "read-result", requestId: request.requestId, result: textResult })
}

/** The error as a reply the parent can rebuild into the error a tool handler would have seen. */
const errorToFailureReply = (params: { error: unknown; request: PdfRequest }): PdfReply => {
  const { error, request } = params
  // The formatter is used for its vault-relative path rewrite; the name it prepends is sent as
  // its own field instead, so it is stripped off the message.
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
    // Reported through the ready reply, for the parent to log.
    return { oomPreference: "unavailable", oomPreferenceError: describeError(error) }
  }
}

const main = async (): Promise<void> => {
  const preference = await requestOomPreference()
  // With the parent gone, nobody would kill this process at the parent's deadline, so it exits.
  process.on("disconnect", () => process.exit(0))
  // The parent sends one request at a time, so one handler runs at a time.
  process.on("message", async (message: unknown) => {
    const parsed = pdfRequestSchema.safeParse(message)

    // A message outside the protocol did not come from this module's parent; exit 1, and the
    // parent fails its active request on the exit.
    if (!parsed.success) process.exit(1)
    const request = parsed.data
    try {
      await extractAndReply(request)
    } catch (error) {
      sendReply(errorToFailureReply({ error, request }))
    }
  })
  // Sent after the listeners exist, so a request that follows it at once is not missed.
  sendReply({ kind: "ready", ...preference })
}

await main()
