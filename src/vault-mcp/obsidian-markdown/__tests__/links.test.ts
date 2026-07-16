import { describe, it, expect } from "vitest"
import { links } from "../links.js"

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

  it("does not match scheme-prefixed or anchor targets even when they end in .md", () => {
    // .md targets so the scheme/anchor guard — not the .md filter — excludes them.
    expect(
      links.matchLinksInLine(
        "[g](https://x.com/g.md) [m](mailto:m@x.md) [a](#a.md)",
      ),
    ).toEqual([])
  })

  it("finds a markdown asset embed with kind markdown, offsets excluding the embed marker", () => {
    expect(links.matchLinksInLine("see ![alt](image.png) end")).toEqual([
      { text: "[alt](image.png)", start: 5, end: 21, kind: "markdown" },
    ])
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
  const scenarios = [
    {
      name: "splits a bare wikilink",
      input: "[[A]]",
      expected: { embed: "", target: "A", heading: "", alias: "" },
    },
    {
      name: "splits a wikilink with an alias",
      input: "[[A|x]]",
      expected: { embed: "", target: "A", heading: "", alias: "|x" },
    },
    {
      name: "splits a wikilink with a heading",
      input: "[[A#h]]",
      expected: { embed: "", target: "A", heading: "#h", alias: "" },
    },
    {
      name: "splits a wikilink with a heading and an alias",
      input: "[[A#h|x]]",
      expected: { embed: "", target: "A", heading: "#h", alias: "|x" },
    },
    {
      name: "preserves the embed marker",
      input: "![[A]]",
      expected: { embed: "!", target: "A", heading: "", alias: "" },
    },
    {
      name: "strips the escaped pipe backslash and shifts it into the alias",
      input: "[[sessions/log-a\\|log-a]]",
      expected: {
        embed: "",
        target: "sessions/log-a",
        heading: "",
        alias: "\\|log-a",
      },
    },
    {
      name: "strips the escaped pipe backslash from a nested path",
      input: "[[Projects/Foo\\|display]]",
      expected: {
        embed: "",
        target: "Projects/Foo",
        heading: "",
        alias: "\\|display",
      },
    },
    {
      name: "strips the escaped pipe backslash from an embedded wikilink",
      input: "![[Photo\\|thumbnail]]",
      expected: {
        embed: "!",
        target: "Photo",
        heading: "",
        alias: "\\|thumbnail",
      },
    },
    {
      name: "strips a trailing backslash even when there is no alias",
      input: "[[path\\]]",
      expected: { embed: "", target: "path", heading: "", alias: "\\" },
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(links.splitWikilink(input)).toEqual(expected)
  })

  it("returns null for text that is not a well-formed wikilink", () => {
    expect(links.splitWikilink("[[A")).toBeNull()
  })
})

// ── splitMarkdownLink ────────────────────────────────────────────

describe("splitMarkdownLink", () => {
  const scenarios = [
    {
      name: "splits a plain markdown link, stripping .md",
      input: "[t](a/b.md)",
      expected: { prefix: "[t](", path: "a/b", heading: "", closeParen: ")" },
    },
    {
      name: "splits a markdown link with a heading",
      input: "[t](a/b.md#sec)",
      expected: {
        prefix: "[t](",
        path: "a/b",
        heading: "#sec",
        closeParen: ")",
      },
    },
    {
      name: "decodes a percent-encoded path",
      input: "[t](My%20Note.md)",
      expected: {
        prefix: "[t](",
        path: "My Note",
        heading: "",
        closeParen: ")",
      },
    },
    {
      name: "falls back to the raw path when percent-encoding is malformed",
      input: "[t](100%zzcomplete.md)",
      expected: {
        prefix: "[t](",
        path: "100%zzcomplete",
        heading: "",
        closeParen: ")",
      },
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(links.splitMarkdownLink(input)).toEqual(expected)
  })

  it("returns null for malformed link text (missing closing paren)", () => {
    expect(links.splitMarkdownLink("[t](path.md")).toBeNull()
  })

  it("returns null for a non-.md target — recognized links that moveNote does not rewrite", () => {
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

  it("extracts markdown internal links with the target as written", () => {
    const targets = links.extractFromBody("[click here](Projects/plan.md)")
    expect(targets).toEqual(["Projects/plan.md"])
  })

  it("excludes a scheme-prefixed URL even when it ends in .md", () => {
    // .md target so the https:// guard — not the .md filter — is what excludes it;
    // the [[Internal]] link proves extraction still happens.
    const targets = links.extractFromBody(
      "[Google](https://google.com/page.md) and [[Internal]]",
    )
    expect(targets).toEqual(["Internal"])
  })

  it("excludes a mailto target even when it ends in .md", () => {
    // .md target so the mailto: guard — not the .md filter — is what excludes it.
    const targets = links.extractFromBody(
      "[email](mailto:hi@example.md) and [[Reach Out]]",
    )
    expect(targets).toEqual(["Reach Out"])
  })

  it("excludes same-page anchors", () => {
    const targets = links.extractFromBody(
      "[section](#heading) — see [[Details]]",
    )
    expect(targets).toEqual(["Details"])
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
    const content = ["[[Before]]", "~~~", "[[Fake]]", "~~~", "[[After]]"].join(
      "\n",
    )
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Before", "After"])
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
      "See [[Live Note]] but not the `[[Code Note]]` example.",
    )
    expect(targets).toEqual(["Live Note"])
  })

  it("skips markdown links inside inline code spans", () => {
    const targets = links.extractFromBody(
      "Real [link](real.md) but `[code](code.md)` is inert.",
    )
    expect(targets).toEqual(["real.md"])
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

  it("skips wikilink-like patterns inside Templater expressions", () => {
    const content =
      "[[Real Link]] and <% tp.file.include('[[Daily Template]]') %>"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link"])
  })

  it("skips links inside <%+ output expressions", () => {
    const content =
      "[[Before]] <%+ tp.file.include('[[Template]]') %> [[After]]"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Before", "After"])
  })

  it("handles multiple Templater expressions on one line", () => {
    const content =
      "<% tp.file.include('[[Header]]') %> [[Real]] <% tp.file.include('[[Footer]]') %>"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real"])
  })

  it("does not suppress links when <% has no closing %>", () => {
    const content = "<% unclosed expression [[Real Link]]"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link"])
  })

  it("extracts markdown links and embeds to non-.md assets", () => {
    const targets = links.extractFromBody(
      "![photo](pics/photo.png), [doc](papers/report.pdf), and [[Caption]]",
    )
    expect(targets).toEqual(["Caption", "pics/photo.png", "papers/report.pdf"])
  })

  it("extracts extensionless markdown links, percent-decoded", () => {
    const targets = links.extractFromBody("[team notes](Some%20Note)")
    expect(targets).toEqual(["Some Note"])
  })

  it("percent-decodes markdown asset paths with folders and spaces", () => {
    const targets = links.extractFromBody("![shot](Trip%20Photos/pic%201.png)")
    expect(targets).toEqual(["Trip Photos/pic 1.png"])
  })

  it("excludes scheme-prefixed targets of any scheme, not just http and mailto", () => {
    // The control wikilink proves extraction ran — a wrong lookahead would
    // extract the scheme targets alongside it.
    const targets = links.extractFromBody(
      [
        "[o](obsidian://open?vault=v)",
        "[z](zotero://select/items/123)",
        "[f](ftp://host/file.pdf)",
        "[u](HTTPS://x.com/a.png)",
        "[[Control]]",
      ].join(" "),
    )
    expect(targets).toEqual(["Control"])
  })

  it("falls back to raw target when percent-encoding is malformed", () => {
    const targets = links.extractFromBody("[done](100%zzcomplete.md)")
    expect(targets).toEqual(["100%zzcomplete.md"])
  })

  it("strips the escaped pipe backslash from wikilink targets in table cells", () => {
    const content = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[sessions/log-a\\|log-a]] | First session |",
      "| [[sessions/log-b\\|log-b]] | Second session |",
    ].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["sessions/log-a", "sessions/log-b"])
  })

  it("strips the escaped pipe backslash from aliased wikilinks outside tables", () => {
    const targets = links.extractFromBody("See [[Note A\\|display text]].")
    expect(targets).toEqual(["Note A"])
  })

  it("does not alter wikilinks that use a plain pipe alias", () => {
    const targets = links.extractFromBody("See [[Note A|display]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks to non-markdown assets alongside note links", () => {
    const targets = links.extractFromBody(
      "![[photo.png]] and ![[report.pdf]] and ![[song.mp3]] and [[Note A]]",
    )
    expect(targets).toEqual(["photo.png", "report.pdf", "song.mp3", "Note A"])
  })

  it("extracts embedded assets with folder paths", () => {
    const targets = links.extractFromBody(
      "![[attachments/diagram.svg]] and [[Real Note]]",
    )
    expect(targets).toEqual(["attachments/diagram.svg", "Real Note"])
  })

  it("keeps wikilinks to notes with dots in the name", () => {
    const targets = links.extractFromBody("[[v2.0]] and [[release-1.3]]")
    expect(targets).toEqual(["v2.0", "release-1.3"])
  })

  it("keeps wikilinks with explicit .md extension", () => {
    const targets = links.extractFromBody("[[Projects/plan.md]]")
    expect(targets).toEqual(["Projects/plan.md"])
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

  it("strips the escaped pipe backslash from frontmatter wikilinks", () => {
    expect(
      links.extractFromFrontmatter({
        related: ["[[sessions/log-a\\|log-a]]"],
      }),
    ).toEqual(["sessions/log-a"])
  })

  it("extracts wikilinks to non-markdown assets in frontmatter", () => {
    expect(
      links.extractFromFrontmatter({
        related: ["[[diagram.png]]", "[[Note A]]"],
      }),
    ).toEqual(["diagram.png", "Note A"])
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
