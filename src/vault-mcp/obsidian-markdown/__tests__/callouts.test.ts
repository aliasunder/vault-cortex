import { describe, it, expect } from "vitest"
import { parseLeadingCallout } from "../callouts.js"

describe("parseLeadingCallout", () => {
  it("parses a callout that is the first body line (before any heading)", () => {
    const lines = [
      "> [!info] Scope of this file",
      "> **Contains:** identity facts.",
      "",
      "## Identity",
    ]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "info",
      title: "Scope of this file",
      body: "**Contains:** identity facts.",
    })
  })

  it("skips a single leading H1 and blank lines before the callout", () => {
    const lines = [
      "",
      "# Me",
      "",
      "> [!info] Scope of this file",
      "> line one",
      "> line two",
      "",
      "## Section",
    ]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "info",
      title: "Scope of this file",
      body: "line one\nline two",
    })
  })

  it("returns null when there is no callout", () => {
    const lines = ["# Title", "", "Just prose, no callout.", "", "## Section"]
    expect(parseLeadingCallout(lines)).toBeNull()
  })

  it("returns null when a callout appears after real body content", () => {
    const lines = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "> [!note] Too late",
      "> not a leading callout",
    ]
    expect(parseLeadingCallout(lines)).toBeNull()
  })

  it("returns null when a deeper heading precedes the callout", () => {
    // Only a single leading H1 is skipped; an H2 is body content.
    const lines = ["## Section", "> [!info] Not leading", "> body"]
    expect(parseLeadingCallout(lines)).toBeNull()
  })

  it("collects only the first of two stacked callouts", () => {
    const lines = [
      "> [!info] First",
      "> first body",
      "> [!warning] Second",
      "> second body",
    ]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "info",
      title: "First",
      body: "first body",
    })
  })

  it("strips the fold marker and lowercases the type", () => {
    const lines = ["> [!INFO]- Folded", "> body"]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "info",
      title: "Folded",
      body: "body",
    })
  })

  it("returns null when the first significant line is a code fence, not a callout opener", () => {
    const lines = ["```md", "> [!info] inside a fence", "> body", "```"]
    expect(parseLeadingCallout(lines)).toBeNull()
  })

  it("allows an empty title", () => {
    const lines = ["> [!warning]", "> heads up"]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "warning",
      title: "",
      body: "heads up",
    })
  })

  it("stops the body at the first non-blockquote line", () => {
    const lines = [
      "> [!info] Scope",
      "> kept",
      "plain text ends the callout",
      "> not part of it",
    ]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "info",
      title: "Scope",
      body: "kept",
    })
  })

  it("trims trailing blank body lines", () => {
    const lines = ["> [!info] Scope", "> content", ">", ">  ", "", "## Next"]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "info",
      title: "Scope",
      body: "content",
    })
  })

  it("returns null for an empty or whitespace-only body", () => {
    expect(parseLeadingCallout([])).toBeNull()
    expect(parseLeadingCallout(["", "   ", ""])).toBeNull()
  })

  it("handles CRLF line endings without leaking carriage returns", () => {
    // A CRLF file split on "\n" leaves a trailing "\r" on every line.
    const lines =
      "# Me\r\n> [!info] Scope\r\n> line one\r\n> line two\r\n\r\n## H\r".split(
        "\n",
      )
    const leadingCallout = parseLeadingCallout(lines)
    expect(leadingCallout).toEqual({
      type: "info",
      title: "Scope",
      body: "line one\nline two",
    })
    expect(leadingCallout?.body).not.toContain("\r")
    expect(leadingCallout?.title).not.toContain("\r")
  })

  it("handles a callout with no space after the blockquote marker", () => {
    const lines = [">[!tip] Tight", "> body"]
    expect(parseLeadingCallout(lines)).toEqual({
      type: "tip",
      title: "Tight",
      body: "body",
    })
  })
})
