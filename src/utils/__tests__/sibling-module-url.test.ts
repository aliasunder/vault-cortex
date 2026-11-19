import { describe, expect, it } from "vitest"
import { siblingModuleUrl } from "../sibling-module-url.js"

describe("siblingModuleUrl", () => {
  it("names a .ts sibling beside a .ts module, as tsx and vitest run the sources", () => {
    const entry = siblingModuleUrl({
      name: "glob-filter-worker",
      besideModule: "file:///app/src/utils/glob-filter.ts",
    })

    expect(entry.href).toBe("file:///app/src/utils/glob-filter-worker.ts")
  })

  it("names a .js sibling beside a compiled .js module", () => {
    const entry = siblingModuleUrl({
      name: "pdf-extraction-child",
      besideModule: "file:///app/dist/src/vault-mcp/vault-operations/pdf-extractor.js",
    })

    expect(entry.href).toBe(
      "file:///app/dist/src/vault-mcp/vault-operations/pdf-extraction-child.js",
    )
  })

  it("keeps a folder name with spaces encoded", () => {
    const entry = siblingModuleUrl({
      name: "body-tag-worker",
      besideModule: "file:///home/user/My%20Server/src/vault-mcp/search/body-tag-parser.ts",
    })

    expect(entry.href).toBe("file:///home/user/My%20Server/src/vault-mcp/search/body-tag-worker.ts")
  })
})
