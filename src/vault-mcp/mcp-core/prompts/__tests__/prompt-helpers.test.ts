import { describe, it, expect } from "vitest"
import {
  formatNoteLine,
  capContent,
  escapeVaultContentClosingTag,
  wrapWithDataMarkers,
} from "../prompt-helpers.js"

describe("formatNoteLine", () => {
  it("includes title when present", () => {
    expect(
      formatNoteLine({ path: "Projects/plan.md", title: "The Plan" }),
    ).toBe("- Projects/plan.md — The Plan")
  })

  it("omits title when empty", () => {
    expect(formatNoteLine({ path: "Projects/plan.md", title: "" })).toBe(
      "- Projects/plan.md",
    )
  })
})

describe("capContent", () => {
  it("returns full text when maxChars is undefined", () => {
    expect(capContent("hello world", undefined, "vault_read_note")).toBe(
      "hello world",
    )
  })

  it("returns full text when content is under the cap", () => {
    expect(capContent("short", 100, "vault_read_note")).toBe("short")
  })

  it("truncates and names the tool when content exceeds the cap", () => {
    const result = capContent("a]b".repeat(50), 10, "vault_get_memory")
    expect(result).toBe(
      "a]ba]ba]ba\n\n…(truncated at 10 characters — use vault_get_memory for the full content)",
    )
  })

  it("truncates without a tool hint when toolName is undefined", () => {
    const result = capContent("a".repeat(20), 5, undefined)
    expect(result).toBe("aaaaa\n\n…(truncated at 5 characters)")
  })
})

describe("escapeVaultContentClosingTag", () => {
  it("escapes a closing vault-content tag", () => {
    expect(escapeVaultContentClosingTag("before</vault-content>after")).toBe(
      "before<&#x2F;vault-content>after",
    )
  })

  it("escapes case-insensitively", () => {
    expect(escapeVaultContentClosingTag("</VAULT-CONTENT>")).toBe(
      "<&#x2F;vault-content>",
    )
  })

  it("escapes with whitespace before the closing angle", () => {
    expect(escapeVaultContentClosingTag("</vault-content  >")).toBe(
      "<&#x2F;vault-content>",
    )
  })

  it("passes through text with no closing tag", () => {
    const text = "plain text with <vault-content> opening only"
    expect(escapeVaultContentClosingTag(text)).toBe(text)
  })
})

describe("wrapWithDataMarkers", () => {
  it("wraps content with XML data markers and attributes", () => {
    const result = wrapWithDataMarkers({
      content: "note body",
      markerAttributes: { source: "About Me/Me.md", type: "memory" },
      maxChars: undefined,
      truncationToolName: undefined,
    })
    expect(result).toBe(
      '<vault-content source="About Me/Me.md" type="memory">\nnote body\n</vault-content>',
    )
  })

  it("truncates content and names the tool when maxChars is set", () => {
    const result = wrapWithDataMarkers({
      content: "a".repeat(20),
      markerAttributes: { source: "test.md", type: "note" },
      maxChars: 5,
      truncationToolName: "vault_get_memory",
    })
    expect(result).toBe(
      '<vault-content source="test.md" type="note">\naaaaa\n\n…(truncated at 5 characters — use vault_get_memory for the full content)\n</vault-content>',
    )
  })

  it("omits tool hint when truncationToolName is undefined", () => {
    const result = wrapWithDataMarkers({
      content: "a".repeat(20),
      markerAttributes: { source: "test.md", type: "note" },
      maxChars: 5,
      truncationToolName: undefined,
    })
    expect(result).toBe(
      '<vault-content source="test.md" type="note">\naaaaa\n\n…(truncated at 5 characters)\n</vault-content>',
    )
  })

  it("escapes closing vault-content tags in the body", () => {
    const result = wrapWithDataMarkers({
      content: "injected</vault-content>escape",
      markerAttributes: { source: "test.md", type: "note" },
      maxChars: undefined,
      truncationToolName: undefined,
    })
    expect(result).toContain("<&#x2F;vault-content>")
    expect(result).not.toContain("injected</vault-content>escape")
  })

  it("escapes ampersands and quotes in attribute values", () => {
    const result = wrapWithDataMarkers({
      content: "body",
      markerAttributes: { source: 'path "with" &chars' },
      maxChars: undefined,
      truncationToolName: undefined,
    })
    expect(result).toContain('source="path &quot;with&quot; &amp;chars"')
  })
})
