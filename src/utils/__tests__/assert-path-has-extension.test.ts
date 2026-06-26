import { describe, it, expect } from "vitest"
import { assertPathHasExtension } from "../assert-path-has-extension.js"

describe("assertPathHasExtension", () => {
  it("rejects a path without the extension, naming the received value", () => {
    expect(() => assertPathHasExtension("Code Projects/CLAUDE", ".md")).toThrow(
      'path must end in ".md" (received "Code Projects/CLAUDE")',
    )
  })

  it("rejects a path with a different extension", () => {
    expect(() => assertPathHasExtension("Diagrams/Map.canvas", ".md")).toThrow(
      'path must end in ".md" (received "Diagrams/Map.canvas")',
    )
  })

  it("accepts a path ending in the extension", () => {
    expect(() =>
      assertPathHasExtension("Projects/Plan.md", ".md"),
    ).not.toThrow()
  })

  it("accepts a dotted name ending in the extension", () => {
    expect(() =>
      assertPathHasExtension(
        "Code Projects/vault-cortex/CLAUDE.local.md",
        ".md",
      ),
    ).not.toThrow()
  })
})
