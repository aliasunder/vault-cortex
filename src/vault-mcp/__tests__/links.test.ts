import { describe, it, expect } from "vitest"
import { links } from "../links.js"

// ── classifyLines ────────────────────────────────────────────────

describe("classifyLines", () => {
  it("tags a plain line as not code", () => {
    expect([...links.classifyLines("hello world")]).toEqual([
      { text: "hello world", inCode: false },
    ])
  })

  it("tags fence delimiters and interior lines as code, then resumes after the close", () => {
    const content = ["before", "```", "inside", "```", "after"].join("\n")
    expect([...links.classifyLines(content)]).toEqual([
      { text: "before", inCode: false },
      { text: "```", inCode: true },
      { text: "inside", inCode: true },
      { text: "```", inCode: true },
      { text: "after", inCode: false },
    ])
  })

  it("does not let a tilde fence close a backtick fence", () => {
    const content = ["```", "~~~", "still inside", "```", "out"].join("\n")
    expect([...links.classifyLines(content)]).toEqual([
      { text: "```", inCode: true },
      { text: "~~~", inCode: true },
      { text: "still inside", inCode: true },
      { text: "```", inCode: true },
      { text: "out", inCode: false },
    ])
  })

  it("closes on a fence at least as long as the opener", () => {
    const content = ["```", "``", "````", "after"].join("\n")
    expect([...links.classifyLines(content)]).toEqual([
      { text: "```", inCode: true },
      { text: "``", inCode: true },
      { text: "````", inCode: true },
      { text: "after", inCode: false },
    ])
  })

  it("does not close on a fence shorter than the opener", () => {
    const content = ["````", "```", "````", "out"].join("\n")
    expect([...links.classifyLines(content)]).toEqual([
      { text: "````", inCode: true },
      { text: "```", inCode: true },
      { text: "````", inCode: true },
      { text: "out", inCode: false },
    ])
  })

  it("does not close on a fence line carrying a trailing info string", () => {
    const content = ["```", "``` extra", "```", "out"].join("\n")
    expect([...links.classifyLines(content)]).toEqual([
      { text: "```", inCode: true },
      { text: "``` extra", inCode: true },
      { text: "```", inCode: true },
      { text: "out", inCode: false },
    ])
  })

  it("marks all trailing lines as code for an unterminated fence", () => {
    const content = ["text", "```", "code one", "code two"].join("\n")
    expect([...links.classifyLines(content)]).toEqual([
      { text: "text", inCode: false },
      { text: "```", inCode: true },
      { text: "code one", inCode: true },
      { text: "code two", inCode: true },
    ])
  })
})

// ── matchLinksInLine ─────────────────────────────────────────────

describe("matchLinksInLine", () => {
  it("finds a wikilink with its offsets and kind", () => {
    expect(links.matchLinksInLine("see [[Note A]] end")).toEqual([
      { text: "[[Note A]]", start: 4, end: 14, kind: "wikilink" },
    ])
  })

  it("finds a markdown link with its offsets and kind", () => {
    expect(links.matchLinksInLine("see [x](a/b.md) end")).toEqual([
      { text: "[x](a/b.md)", start: 4, end: 15, kind: "markdown" },
    ])
  })

  it("finds both link kinds in one line", () => {
    expect(links.matchLinksInLine("[[A]] and [x](b.md)")).toEqual([
      { text: "[[A]]", start: 0, end: 5, kind: "wikilink" },
      { text: "[x](b.md)", start: 10, end: 19, kind: "markdown" },
    ])
  })

  it("returns an empty array when the line has no links", () => {
    expect(links.matchLinksInLine("just plain text")).toEqual([])
  })

  it("does not match external, mailto, or anchor links", () => {
    expect(
      links.matchLinksInLine("[g](https://x.com) [m](mailto:a@b.c) [a](#h)"),
    ).toEqual([])
  })
})

// ── inlineCodeSpans ──────────────────────────────────────────────

describe("inlineCodeSpans", () => {
  it("returns the character range of an inline code span", () => {
    expect(links.inlineCodeSpans("use `code` here")).toEqual([
      { start: 4, end: 10 },
    ])
  })

  it("returns every span on the line", () => {
    expect(links.inlineCodeSpans("`a` and `bb`")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 12 },
    ])
  })

  it("returns an empty array when the line has no inline code", () => {
    expect(links.inlineCodeSpans("plain text")).toEqual([])
  })
})

// ── splitWikilink ────────────────────────────────────────────────

describe("splitWikilink", () => {
  it("splits a bare wikilink", () => {
    expect(links.splitWikilink("[[A]]")).toEqual({
      embed: "",
      target: "A",
      heading: "",
      alias: "",
    })
  })

  it("splits a wikilink with an alias", () => {
    expect(links.splitWikilink("[[A|x]]")).toEqual({
      embed: "",
      target: "A",
      heading: "",
      alias: "|x",
    })
  })

  it("splits a wikilink with a heading", () => {
    expect(links.splitWikilink("[[A#h]]")).toEqual({
      embed: "",
      target: "A",
      heading: "#h",
      alias: "",
    })
  })

  it("splits a wikilink with a heading and an alias", () => {
    expect(links.splitWikilink("[[A#h|x]]")).toEqual({
      embed: "",
      target: "A",
      heading: "#h",
      alias: "|x",
    })
  })

  it("preserves the embed marker", () => {
    expect(links.splitWikilink("![[A]]")).toEqual({
      embed: "!",
      target: "A",
      heading: "",
      alias: "",
    })
  })

  it("returns null for text that is not a well-formed wikilink", () => {
    expect(links.splitWikilink("[[A")).toBeNull()
  })
})

// ── splitMarkdownLink ────────────────────────────────────────────

describe("splitMarkdownLink", () => {
  it("splits a plain markdown link, stripping .md", () => {
    expect(links.splitMarkdownLink("[t](a/b.md)")).toEqual({
      prefix: "[t](",
      path: "a/b",
      heading: "",
      closeParen: ")",
    })
  })

  it("splits a markdown link with a heading", () => {
    expect(links.splitMarkdownLink("[t](a/b.md#sec)")).toEqual({
      prefix: "[t](",
      path: "a/b",
      heading: "#sec",
      closeParen: ")",
    })
  })

  it("decodes a percent-encoded path", () => {
    expect(links.splitMarkdownLink("[t](My%20Note.md)")).toEqual({
      prefix: "[t](",
      path: "My Note",
      heading: "",
      closeParen: ")",
    })
  })

  it("falls back to the raw path when percent-encoding is malformed", () => {
    expect(links.splitMarkdownLink("[t](100%zzcomplete.md)")).toEqual({
      prefix: "[t](",
      path: "100%zzcomplete",
      heading: "",
      closeParen: ")",
    })
  })

  it("returns null for an external link", () => {
    expect(links.splitMarkdownLink("[t](https://x.com)")).toBeNull()
  })

  it("returns null for a non-.md link", () => {
    expect(links.splitMarkdownLink("[t](file.txt)")).toBeNull()
  })
})

// ── extractFromBody ──────────────────────────────────────────────

describe("extractFromBody", () => {
  it("extracts basic wikilinks", () => {
    const targets = links.extractFromBody("See [[Note A]] and [[Note B]].")
    expect(targets).toEqual(["Note A", "Note B"])
  })

  it("extracts wikilinks with display text", () => {
    const targets = links.extractFromBody("See [[Note A|my note]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks with heading anchors", () => {
    const targets = links.extractFromBody("See [[Note A#Section One]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks with heading and display text", () => {
    const targets = links.extractFromBody("See [[Note A#Section|display]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks with folder paths", () => {
    const targets = links.extractFromBody("See [[Projects/vault-cortex]].")
    expect(targets).toEqual(["Projects/vault-cortex"])
  })

  it("extracts embeds as links", () => {
    const targets = links.extractFromBody("![[Embedded Note]]")
    expect(targets).toEqual(["Embedded Note"])
  })

  it("extracts markdown internal links", () => {
    const targets = links.extractFromBody("[click here](Projects/plan.md)")
    expect(targets).toEqual(["Projects/plan"])
  })

  it("excludes external URLs", () => {
    const targets = links.extractFromBody(
      "[Google](https://google.com) and [[Internal]]",
    )
    expect(targets).toEqual(["Internal"])
  })

  it("excludes mailto links", () => {
    const targets = links.extractFromBody("[email](mailto:test@example.com)")
    expect(targets).toEqual([])
  })

  it("excludes same-page anchors", () => {
    const targets = links.extractFromBody("[section](#heading)")
    expect(targets).toEqual([])
  })

  it("deduplicates repeated targets", () => {
    const targets = links.extractFromBody("[[Note A]] and again [[Note A]]")
    expect(targets).toEqual(["Note A"])
  })

  it("skips links inside fenced code blocks", () => {
    const content = [
      "before [[Real Link]]",
      "```",
      "[[Fake Link]]",
      "```",
      "after [[Another Real Link]]",
    ].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link", "Another Real Link"])
  })

  it("skips links inside tilde fenced blocks", () => {
    const content = ["~~~", "[[Fake]]", "~~~"].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual([])
  })

  it("handles nested fences correctly", () => {
    const content = [
      "````",
      "```",
      "[[Inside Nested]]",
      "```",
      "````",
      "[[Outside]]",
    ].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Outside"])
  })

  it("returns empty for content with no links", () => {
    expect(links.extractFromBody("Just plain text.")).toEqual([])
  })

  it("skips wikilinks inside inline code spans", () => {
    const targets = links.extractFromBody(
      "Use the `[[Note Name]]` syntax to link.",
    )
    expect(targets).toEqual([])
  })

  it("skips markdown links inside inline code spans", () => {
    const targets = links.extractFromBody("Pattern `[text](file.md)` does X.")
    expect(targets).toEqual([])
  })

  it("skips links inside indented fences (CommonMark §4.5)", () => {
    const content = [
      "- list item:",
      "  ```",
      "  [[Fake Link]]",
      "  ```",
      "[[Real Link]]",
    ].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link"])
  })

  it("excludes non-.md assets (images, PDFs)", () => {
    const targets = links.extractFromBody(
      "![photo](pics/photo.png) and [doc](papers/report.pdf)",
    )
    expect(targets).toEqual([])
  })

  it("falls back to raw target when percent-encoding is malformed", () => {
    const targets = links.extractFromBody("[done](100%zzcomplete.md)")
    expect(targets).toEqual(["100%zzcomplete"])
  })
})

// ── extractFromFrontmatter ───────────────────────────────────────

describe("extractFromFrontmatter", () => {
  it("extracts a wikilink from a string property value", () => {
    expect(links.extractFromFrontmatter({ up: "[[Parent Note]]" })).toEqual([
      "Parent Note",
    ])
  })

  it("extracts wikilinks from an array property (e.g. related)", () => {
    expect(
      links.extractFromFrontmatter({ related: ["[[Note A]]", "[[Note B]]"] }),
    ).toEqual(["Note A", "Note B"])
  })

  it("strips alias and heading from a frontmatter wikilink", () => {
    expect(
      links.extractFromFrontmatter({ related: ["[[Note A#Section|display]]"] }),
    ).toEqual(["Note A"])
  })

  it("extracts a wikilink embedded in surrounding text", () => {
    expect(
      links.extractFromFrontmatter({ note: "see [[Note A]] for context" }),
    ).toEqual(["Note A"])
  })

  it("walks nested object property values", () => {
    expect(
      links.extractFromFrontmatter({ meta: { parent: "[[Note A]]" } }),
    ).toEqual(["Note A"])
  })

  it("returns empty for plain-string values with no wikilinks", () => {
    expect(
      links.extractFromFrontmatter({ related: ["Routines", "Career"] }),
    ).toEqual([])
  })

  it("ignores non-string scalar values", () => {
    expect(
      links.extractFromFrontmatter({ count: 3, draft: true, missing: null }),
    ).toEqual([])
  })

  it("deduplicates a target repeated across properties", () => {
    expect(
      links.extractFromFrontmatter({
        up: "[[Note A]]",
        related: ["[[Note A]]"],
      }),
    ).toEqual(["Note A"])
  })
})

// ── resolve ──────────────────────────────────────────────────────

describe("resolve", () => {
  const allPaths = [
    "Projects/vault-cortex.md",
    "About Me/Principles.md",
    "notes/random.md",
    "deep/nested/note.md",
    "note.md",
  ]

  it("resolves exact path match", () => {
    expect(links.resolve("Projects/vault-cortex", allPaths)).toBe(
      "Projects/vault-cortex.md",
    )
  })

  it("resolves exact path with .md extension", () => {
    expect(links.resolve("Projects/vault-cortex.md", allPaths)).toBe(
      "Projects/vault-cortex.md",
    )
  })

  it("resolves basename match", () => {
    expect(links.resolve("Principles", allPaths)).toBe("About Me/Principles.md")
  })

  it("resolves to shortest path when multiple basename matches exist", () => {
    expect(links.resolve("note", allPaths)).toBe("note.md")
  })

  it("returns null for unresolvable target", () => {
    expect(links.resolve("NonExistent", allPaths)).toBeNull()
  })

  it("resolves an upward relative path against the source note's directory", () => {
    const paths = ["A/C/target.md", "A/B/note.md"]
    expect(links.resolve("../C/target", paths, "A/B/note.md")).toBe(
      "A/C/target.md",
    )
  })

  it("resolves a descending relative path to the source's own subfolder over a shorter same-named path elsewhere", () => {
    // "X/sub/target.md" is the shorter basename/suffix match, but the link is
    // relative to Areas/note.md, so it must resolve into Areas/sub/.
    const paths = ["Areas/sub/target.md", "X/sub/target.md", "Areas/note.md"]
    expect(links.resolve("sub/target", paths, "Areas/note.md")).toBe(
      "Areas/sub/target.md",
    )
  })

  it("prefers an exact vault-absolute path over a relative-to-source match", () => {
    const paths = ["Projects/other.md", "A/B/Projects/other.md", "A/B/note.md"]
    expect(links.resolve("Projects/other", paths, "A/B/note.md")).toBe(
      "Projects/other.md",
    )
  })

  it("cannot resolve an upward relative path without a source note", () => {
    expect(links.resolve("../C/target", ["A/C/target.md"])).toBeNull()
  })

  it("does not let an upward ../ path escape to a same-named vault-root note", () => {
    // "secret.md" exists at the vault root, but "../secret" from a root note
    // points above the vault — it must stay unresolved, not collapse onto it.
    expect(links.resolve("../secret", ["secret.md"], "note.md")).toBeNull()
  })
})
