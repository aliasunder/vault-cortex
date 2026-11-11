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
}

/** The real extractor with its child process, closed when the test finishes. */
export const createTestPdfExtractor = (vaultPath: string): PdfExtractor => {
  const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 50 * 1024 * 1024 })
  onTestFinished(() => extractor.close())
  return extractor
}

/** Extracts index text in the test process, for tests that inspect the index rather than
 *  process isolation. Full reads are outside its callers' scope and fail loudly. */
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
})
