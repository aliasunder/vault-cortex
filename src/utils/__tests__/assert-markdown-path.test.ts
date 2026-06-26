import { describe, it, expect } from "vitest"
import { assertMarkdownPath } from "../assert-markdown-path.js"

describe("assertMarkdownPath", () => {
  it("rejects a path without an extension, naming the received value", () => {
    expect(() => assertMarkdownPath("Code Projects/CLAUDE")).toThrow(
      'note path must end in ".md" (received "Code Projects/CLAUDE")',
    )
  })

  it("rejects a path with a non-markdown extension", () => {
    expect(() => assertMarkdownPath("Diagrams/Map.canvas")).toThrow(
      'note path must end in ".md" (received "Diagrams/Map.canvas")',
    )
  })

  it("accepts a path ending in .md", () => {
    expect(() => assertMarkdownPath("Projects/Plan.md")).not.toThrow()
  })

  it("accepts a dotted note name ending in .md", () => {
    expect(() =>
      assertMarkdownPath("Code Projects/vault-cortex/CLAUDE.local.md"),
    ).not.toThrow()
  })
})
