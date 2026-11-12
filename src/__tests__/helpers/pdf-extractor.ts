import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { onTestFinished } from "vitest"
import { extractPdfText } from "../../vault-mcp/obsidian-markdown/pdf.js"
import {
  createPdfExtractor,
  type PdfExtractor,
} from "../../vault-mcp/vault-operations/pdf-extractor.js"

export const unusedPdfExtractor: PdfExtractor = {
  extractForIndex: async () => {
    throw new Error("unexpected PDF extraction")
  },
  readText: async () => {
    throw new Error("unexpected PDF read")
  },
  close: async () => {},
  startIndexing: () => {},
}

/** The real extractor with its child process, closed when the test finishes. */
export const createTestPdfExtractor = (vaultPath: string): PdfExtractor => {
  const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 50 * 1024 * 1024 })
  onTestFinished(() => extractor.close())
  extractor.startIndexing()
  return extractor
}

/** Extracts index text in the test process, for tests that inspect the index rather than
 *  process isolation. Index requests are served at once; full reads are outside its callers'
 *  scope and fail loudly. */
export const createInProcessPdfExtractor = (vaultPath: string): PdfExtractor => ({
  extractForIndex: async ({ path }) => {
    const bytes = await readFile(join(vaultPath, path))
    const result = await extractPdfText(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    )
    return { status: "extracted", result }
  },
  readText: async () => {
    throw new Error("an index test must not read a PDF asset")
  },
  close: async () => {},
  startIndexing: () => {},
})

/** The in-process extractor with the real one's queue rules, for tests of what happens before
 *  the server listens: index requests wait until `startIndexing()`, and a coalescing request
 *  cancels the request still waiting for the same path. */
export const createHeldPdfExtractor = (vaultPath: string): PdfExtractor => {
  const indexingStarted = Promise.withResolvers<undefined>()
  const servedAtOnce = createInProcessPdfExtractor(vaultPath)
  const waitingByPath = new Map<string, PromiseWithResolvers<"run" | "cancelled">>()

  return {
    ...servedAtOnce,
    extractForIndex: async (params, logger) => {
      const waiting = Promise.withResolvers<"run" | "cancelled">()

      if (params.coalesce) waitingByPath.get(params.path)?.resolve("cancelled")
      waitingByPath.set(params.path, waiting)
      // Settled by startIndexing unless a coalescing request cancels it first.
      void indexingStarted.promise.then(() => waiting.resolve("run"))

      if ((await waiting.promise) === "cancelled") return { status: "cancelled" }
      return servedAtOnce.extractForIndex(params, logger)
    },
    startIndexing: () => indexingStarted.resolve(undefined),
  }
}
