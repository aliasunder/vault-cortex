import { onTestFinished } from "vitest"
import {
  createPdfExtractor,
  type PdfExtractor,
} from "../vault-mcp/vault-operations/pdf-extractor.js"

export const unusedPdfExtractor: PdfExtractor = {
  extractForIndex: async () => {
    throw new Error("unexpected PDF extraction")
  },
  readText: async () => {
    throw new Error("unexpected PDF read")
  },
  close: async () => {},
}

export const createTestPdfExtractor = (vaultPath: string): PdfExtractor => {
  const extractor = createPdfExtractor({ vaultPath, maxFileBytes: 50 * 1024 * 1024 })
  onTestFinished(() => extractor.close())
  return extractor
}
