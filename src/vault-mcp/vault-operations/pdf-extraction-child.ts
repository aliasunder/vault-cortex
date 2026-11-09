import { writeFile } from "node:fs/promises"
import { logger } from "../../logger.js"
import { describeError, describeErrorRelativeTo } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { extractPdfIndexText, extractPdfText } from "../obsidian-markdown/pdf.js"
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
  if (!process.connected || !process.send) {
    process.exit(0)
    return
  }
  process.send(reply, (error) => {
    if (error) process.exit(0)
  })
}

const extract = async (request: PdfRequest): Promise<void> => {
  const requestLogger = logger.child({ extractionRequestId: request.requestId })
  const asset = await vaultFs.readAsset(
    { vaultPath: request.vaultPath, path: request.path, maxBytes: request.maxFileBytes },
    requestLogger,
  )
  const pdfData = new Uint8Array(
    asset.buffer.buffer,
    asset.buffer.byteOffset,
    asset.buffer.byteLength,
  )
  const extractText = request.kind === "index" ? extractPdfIndexText : extractPdfText
  const result = await (async () => {
    try {
      return await extractText(pdfData)
    } catch (error) {
      const message = describePdfOpenFailure({ error, path: request.path, bytes: asset.bytes })

      if (message) throw new Error(message, { cause: error })
      throw error
    }
  })()

  if (request.kind === "index") {
    send({ kind: "index-result", requestId: request.requestId, result })
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

const main = async (): Promise<void> => {
  const oomPreference = await (async () => {
    if (process.platform !== "linux") return "unsupported"
    try {
      await writeFile("/proc/self/oom_score_adj", CHILD_OOM_SCORE_ADJUSTMENT)
      return "applied"
    } catch (error) {
      logger.warn("PDF child OOM preference unavailable", { error: describeError(error) })
      return "unavailable"
    }
  })()
  // A disconnected parent has no deadline left; the child exits at its next event turn.
  process.on("disconnect", () => process.exit(0))
  process.on("message", (message: unknown) => {
    const parsed = pdfRequestSchema.safeParse(message)

    if (!parsed.success) {
      process.exit(1)
      return
    }
    const request = parsed.data
    void extract(request).catch((error: unknown) => {
      const description = describeErrorRelativeTo({ error, directory: request.vaultPath })
      const message = description.replace(FORMATTED_ERROR_NAME_PREFIX, "")
      // vaultFs.readAsset prefixes byte-cap failures with this text, preserving their size code.
      const code = message.startsWith("file too large:") ? "size" : "read"
      const systemError = getSystemErrorDetails(error)
      send({
        kind: "failure",
        requestId: request.requestId,
        code,
        message,
        ...(error instanceof Error && error.cause !== undefined
          ? { cause: describeError(error.cause) }
          : {}),
        ...(systemError ? { systemError } : {}),
      })
    })
  })
  send({ kind: "ready", oomPreference })
}

await main()
