import { describe, expect, it } from "vitest"
import { escapeHtml } from "../escape-html.js"

describe("escapeHtml", () => {
  it("escapes the four characters that break out of text or a quoted attribute", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;",
    )
  })

  it("leaves text without those characters unchanged", () => {
    expect(escapeHtml("My Vault's notes (2026)")).toBe(
      "My Vault's notes (2026)",
    )
  })
})
