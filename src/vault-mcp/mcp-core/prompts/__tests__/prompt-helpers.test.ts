import { describe, it, expect } from "vitest"
import {
  describeErrorForPromptFallback,
  formatNoteLine,
  capContent,
  exceedsCharCap,
  escapeVaultContentClosingTag,
  wrapWithDataMarkers,
} from "../prompt-helpers.js"

describe("formatNoteLine", () => {
  it("includes title when present", () => {
    expect(formatNoteLine({ path: "Projects/plan.md", title: "The Plan" })).toBe(
      "- Projects/plan.md — The Plan",
    )
  })

  it("omits title when empty", () => {
    expect(formatNoteLine({ path: "Projects/plan.md", title: "" })).toBe("- Projects/plan.md")
  })
})

describe("capContent", () => {
  it("returns full text when maxChars is undefined", () => {
    expect(capContent("hello world", undefined, "vault_read_note")).toBe("hello world")
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

  it("keeps an emoji whole when the cut falls on it", () => {
    // The emoji is the 5th character but spans UTF-16 units 5 and 6.
    const result = capContent("abcd🎉efgh", 5, undefined)
    expect(result).toBe("abcd🎉\n\n…(truncated at 5 characters)")
  })

  it("cuts before a flag the cap would split", () => {
    // The flag is two code points, the 5th and 6th.
    const result = capContent("abcd🇨🇦efgh", 5, undefined)
    expect(result).toBe("abcd\n\n…(truncated at 5 characters)")
  })

  it("returns emoji text in full when its characters fit the cap", () => {
    // 5 characters, but 10 UTF-16 units.
    expect(capContent("🎉".repeat(5), 5, undefined)).toBe("🎉".repeat(5))
  })
})

describe("exceedsCharCap", () => {
  it.each([
    { label: "no cap is set", text: "hello", maxChars: undefined, expected: false },
    { label: "the text is exactly at the cap", text: "aaaaa", maxChars: 5, expected: false },
    {
      label: "the text is one character over the cap",
      text: "aaaaaa",
      maxChars: 5,
      expected: true,
    },
    // 5 characters, but 10 UTF-16 units.
    {
      label: "emoji fit the cap in characters",
      text: "🎉".repeat(5),
      maxChars: 5,
      expected: false,
    },
    {
      label: "emoji run one character over the cap",
      text: "🎉".repeat(6),
      maxChars: 5,
      expected: true,
    },
  ])("returns $expected when $label", ({ text, maxChars, expected }) => {
    expect(exceedsCharCap(text, maxChars)).toBe(expected)
  })
})

describe("escapeVaultContentClosingTag", () => {
  it("escapes a closing vault-content tag", () => {
    expect(escapeVaultContentClosingTag("before</vault-content>after")).toBe(
      "before<&#x2F;vault-content>after",
    )
  })

  it("escapes case-insensitively", () => {
    expect(escapeVaultContentClosingTag("</VAULT-CONTENT>")).toBe("<&#x2F;vault-content>")
  })

  it("escapes with whitespace before the closing angle", () => {
    expect(escapeVaultContentClosingTag("</vault-content  >")).toBe("<&#x2F;vault-content>")
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

describe("describeErrorForPromptFallback", () => {
  const everyToolServed = (): boolean => true
  const noToolServed = (): boolean => false

  it("makes a filesystem error's path vault-relative and appends its remedy without the closing period", () => {
    const error = Object.assign(
      new Error("EACCES: permission denied, open '/srv/vault/Projects/plan.md'"),
      { code: "EACCES", syscall: "open", path: "/srv/vault/Projects/plan.md" },
    )

    expect(
      describeErrorForPromptFallback({
        error,
        vaultPath: "/srv/vault",
        isToolEnabled: everyToolServed,
      }),
    ).toBe(
      "[Error]: EACCES: permission denied, open 'Projects/plan.md'. Ask the vault's owner to fix the file's or folder's permissions",
    )
  })

  it("passes the enabled tool set to the remedy, so an unserved tool goes unnamed", () => {
    const tempSavePath = "/srv/vault/a.md.123e4567-e89b-12d3-a456-426614174000.tmp"
    const error = Object.assign(new Error(`ENAMETOOLONG: name too long, open '${tempSavePath}'`), {
      code: "ENAMETOOLONG",
      syscall: "open",
      path: tempSavePath,
    })

    expect(
      describeErrorForPromptFallback({
        error,
        vaultPath: "/srv/vault",
        isToolEnabled: noToolServed,
      }),
    ).toBe(
      "[Error]: ENAMETOOLONG: name too long, open 'a.md.123e4567-e89b-12d3-a456-426614174000.tmp'. The name leaves no room for the temporary file a save writes beside it; save it under a name at least 41 bytes shorter (rename an existing note)",
    )
  })

  it("drops the closing period of an error that has no remedy", () => {
    expect(
      describeErrorForPromptFallback({
        error: new Error("daily notes config is not valid JSON."),
        vaultPath: "/srv/vault",
        isToolEnabled: everyToolServed,
      }),
    ).toBe("[Error]: daily notes config is not valid JSON")
  })

  it("returns an error with no remedy and no closing period as it is", () => {
    expect(
      describeErrorForPromptFallback({
        error: new Error("note not found: Projects/plan.md"),
        vaultPath: "/srv/vault",
        isToolEnabled: everyToolServed,
      }),
    ).toBe("[Error]: note not found: Projects/plan.md")
  })
})
